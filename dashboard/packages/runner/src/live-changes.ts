import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

const MAX_PATHS = 5_000;
const MAX_FILES = 500;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_READ_BYTES = 16 * 1024 * 1024;
const MAX_DIFF_BYTES = 256 * 1024;
const MAX_LIST_BYTES = 2 * 1024 * 1024;
const DEADLINE_MS = 8_000;

type ChangeStatus = 'added' | 'modified' | 'deleted' | 'untracked' | 'type_changed' | 'unknown';
interface TreeEntry {
  path: string;
  oid: string;
  mode: string;
  size: number;
}
interface FileSnapshot {
  data: Buffer;
  mode: string;
}
export interface WorkspaceChanges {
  files: Array<{ path: string; status: ChangeStatus }>;
  diff: string;
  truncated: boolean;
  message?: string;
}

function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !suffix.startsWith(sep))
  );
}
function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 1024 &&
    !path.startsWith('/') &&
    !path.includes('\0') &&
    !path.split('/').some((part) => part === '..' || part === '.git' || part === '')
  );
}

/**
 * Only called in the fixed, networkless utility sandbox with /workspace ro-bound.
 * Git reads object/index metadata only. Working files are opened without following
 * the final symlink, then their *opened descriptor* is checked before any bytes
 * are read. This also handles a parent-directory symlink being swapped mid-read.
 * Diff generation uses private copies in /tmp, outside the repository/config.
 */
export function captureWorkspaceChanges(workspace: string, baseRevision: string): WorkspaceChanges {
  if (!/^[a-f0-9]{40}$/.test(baseRevision)) throw new Error('Invalid base revision.');
  const root = realpathSync(workspace);
  const started = Date.now();
  const deadline = (): number => Math.max(1, DEADLINE_MS - (Date.now() - started));
  const git = (args: string[], cwd = root, input?: string, maxBuffer = MAX_LIST_BYTES) => {
    if (Date.now() - started >= DEADLINE_MS) throw new Error('Snapshot time budget exhausted.');
    return spawnSync(
      '/usr/bin/git',
      [
        '--no-pager',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.quotePath=false',
        ...args,
      ],
      {
        cwd,
        input,
        maxBuffer,
        timeout: deadline(),
        env: {
          PATH: '/usr/bin:/bin',
          HOME: '/tmp',
          LANG: 'C.UTF-8',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_NO_REPLACE_OBJECTS: '1',
          GIT_TERMINAL_PROMPT: '0',
        },
      }
    );
  };
  const tree = git(['ls-tree', '-r', '-z', '--long', '--full-tree', baseRevision]);
  if (tree.status !== 0) throw new Error('Base tree is unavailable.');
  const listing = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (listing.status !== 0) throw new Error('Workspace file list is unavailable.');
  const staged = git(['ls-files', '-z', '--cached']);
  if (staged.status !== 0) throw new Error('Workspace index is unavailable.');
  const tracked = new Set(staged.stdout.toString('utf8').split('\0').filter(Boolean));
  const visibleWorkingPaths = new Set(listing.stdout.toString('utf8').split('\0').filter(Boolean));
  const base = new Map<string, TreeEntry>();
  let truncated = false;
  for (const record of tree.stdout.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d+) (blob|commit) ([a-f0-9]{40})\s+(\d+|-)\t([\s\S]+)$/.exec(record);
    if (!match || !safePath(match[5]!)) {
      truncated = true;
      continue;
    }
    if (base.size >= MAX_PATHS) {
      truncated = true;
      break;
    }
    base.set(match[5]!, {
      path: match[5]!,
      mode: match[1]!,
      oid: match[3]!,
      size: match[2] === 'blob' ? Number(match[4]) : -1,
    });
  }
  const paths = new Set([...base.keys()]);
  for (const path of listing.stdout.toString('utf8').split('\0').filter(Boolean)) {
    if (!safePath(path)) {
      truncated = true;
      continue;
    }
    if (paths.size >= MAX_PATHS && !paths.has(path)) {
      truncated = true;
      break;
    }
    paths.add(path);
  }

  // Batch only known, bounded blobs. No checkout, filters, hooks or index refresh.
  const blobs = new Map<string, Buffer>();
  const requestedIds = new Set<string>();
  const requested: TreeEntry[] = [];
  let budget = 0;
  for (const entry of base.values()) {
    if (entry.size < 0 || entry.size > MAX_FILE_BYTES || budget + entry.size > MAX_READ_BYTES)
      continue;
    if (requestedIds.has(entry.oid)) continue;
    budget += entry.size;
    requested.push(entry);
    requestedIds.add(entry.oid);
  }
  if (requested.length) {
    const batch = git(
      ['cat-file', '--batch'],
      root,
      requested.map((entry) => entry.oid).join('\n') + '\n',
      MAX_READ_BYTES + MAX_LIST_BYTES
    );
    if (batch.status !== 0) throw new Error('Base contents are unavailable.');
    let offset = 0;
    for (const entry of requested) {
      const end = batch.stdout.indexOf(10, offset);
      const header = batch.stdout.subarray(offset, end).toString('utf8').split(' ');
      const size = Number(header[2]);
      if (
        end < offset ||
        header[0] !== entry.oid ||
        header[1] !== 'blob' ||
        size !== entry.size ||
        end + size + 1 >= batch.stdout.length
      )
        throw new Error('Invalid base object response.');
      blobs.set(entry.oid, batch.stdout.subarray(end + 1, end + 1 + size));
      offset = end + size + 2;
    }
  }

  let readBytes = 0;
  const readWorking = (path: string): FileSnapshot | undefined => {
    const target = join(root, path);
    let info;
    try {
      info = lstatSync(target);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
        return undefined;
      throw error;
    }
    // Never walk a symlink directory, including a tracked directory replaced by one.
    const parent = realpathSync(dirname(target));
    if (!within(root, parent) || parent !== dirname(target))
      throw new Error('File parent is a symlink or escaped workspace.');
    if (info.isSymbolicLink()) {
      const data = Buffer.from(readlinkSync(target), 'utf8');
      if (data.length > MAX_FILE_BYTES) throw new Error('Symlink preview exceeds budget.');
      return { data, mode: '120000' };
    }
    if (!info.isFile() || info.size > MAX_FILE_BYTES || readBytes + info.size > MAX_READ_BYTES)
      throw new Error('File preview exceeds budget or is not regular.');
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (realpathSync(`/proc/self/fd/${fd}`) !== target)
        throw new Error('Opened file escaped its selected workspace path.');
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > MAX_FILE_BYTES)
        throw new Error('File changed while opening.');
      const buffer = Buffer.alloc(Math.min(MAX_FILE_BYTES + 1, opened.size + 1));
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      readBytes += length;
      if (length > MAX_FILE_BYTES || readBytes > MAX_READ_BYTES)
        throw new Error('File preview exceeds budget.');
      const after = fstatSync(fd);
      if (
        length !== opened.size ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs
      )
        throw new Error('File changed during capture.');
      return { data: buffer.subarray(0, length), mode: opened.mode & 0o111 ? '100755' : '100644' };
    } finally {
      closeSync(fd);
    }
  };
  const temporary = mkdtempSync(join(tmpdir(), 'b70-live-diff-'));
  const files: WorkspaceChanges['files'] = [];
  const modeNotes: string[] = [];
  try {
    mkdirSync(join(temporary, 'before'));
    mkdirSync(join(temporary, 'after'));
    for (const path of [...paths].sort()) {
      if (files.length >= MAX_FILES || Date.now() - started >= DEADLINE_MS - 1_000) {
        truncated = true;
        break;
      }
      const old = base.get(path);
      const oldData = old === undefined ? undefined : blobs.get(old.oid);
      try {
        if (old !== undefined && oldData === undefined)
          throw new Error('Base file exceeds preview budget.');
        // A tracked file removed from the index may remain on disk but now be
        // ignored. git add -A will keep that deletion; do not resurrect its old
        // bytes merely because the ignored local file still exists.
        const current = visibleWorkingPaths.has(path) ? readWorking(path) : undefined;
        if (current === undefined && old === undefined) continue;
        if (
          oldData !== undefined &&
          current !== undefined &&
          oldData.equals(current.data) &&
          old?.mode === current.mode
        )
          continue;
        const status: ChangeStatus =
          current === undefined
            ? 'deleted'
            : old === undefined
              ? tracked.has(path)
                ? 'added'
                : 'untracked'
              : old.mode !== current.mode
                ? 'type_changed'
                : 'modified';
        if (oldData !== undefined) {
          const output = join(temporary, 'before', path);
          mkdirSync(dirname(output), { recursive: true });
          writeFileSync(output, oldData, { mode: old?.mode === '100755' ? 0o755 : 0o644 });
        }
        if (current !== undefined) {
          const output = join(temporary, 'after', path);
          mkdirSync(dirname(output), { recursive: true });
          writeFileSync(output, current.data, { mode: current.mode === '100755' ? 0o755 : 0o644 });
        }
        if (
          old !== undefined &&
          current !== undefined &&
          old.mode !== current.mode &&
          (old.mode === '120000' || current.mode === '120000')
        ) {
          modeNotes.push(
            `diff --git a/${path} b/${path}\nold mode ${old.mode}\nnew mode ${current.mode}\n`
          );
        }
        files.push({ path, status });
      } catch {
        truncated = true;
        files.push({ path, status: 'unknown' });
      }
    }
    const result = git(
      [
        'diff',
        '--no-index',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--',
        'before',
        'after',
      ],
      temporary,
      undefined,
      MAX_DIFF_BYTES + 64 * 1024
    );
    const limited = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS';
    if (result.status !== 0 && result.status !== 1 && !limited)
      throw new Error('Snapshot diff could not be generated.');
    const output = result.stdout
      .toString('utf8')
      .split('\n')
      .map((line) =>
        /^(diff --git |--- |\+\+\+ |Binary files )/.test(line)
          ? line
              .replaceAll('a/before/', 'a/')
              .replaceAll('b/after/', 'b/')
              .replaceAll('a/after/', 'a/')
              .replaceAll('b/before/', 'b/')
          : line
      )
      .join('\n');
    const combined = Buffer.from(modeNotes.join('') + output);
    truncated ||= limited || combined.length > MAX_DIFF_BYTES;
    return {
      files,
      diff: new TextDecoder().decode(combined.subarray(0, MAX_DIFF_BYTES), { stream: true }),
      truncated,
      ...(truncated
        ? {
            message:
              'Preview limits reached; some files, unsafe paths or diff content are omitted.',
          }
        : {}),
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
