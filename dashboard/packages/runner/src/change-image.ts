import { spawnSync } from 'node:child_process';
import { constants, closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
const MAX_BYTES = 32 * 1024 * 1024;
export function safeImagePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 1024 &&
    !path.startsWith('/') &&
    !path.includes('\0') &&
    !path.includes('\\') &&
    !path.split('/').some((part) => ['', '.', '..', '.git'].includes(part)) &&
    /\.(?:png|jpe?g|webp)$/i.test(path)
  );
}
function git(workspace: string, args: string[], maxBuffer = 8192) {
  return spawnSync(
    '/usr/bin/git',
    ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    {
      cwd: workspace,
      maxBuffer,
      timeout: 3000,
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
}
/** Fixed networkless read-only utility. Never follows file or parent symlinks. */
export function readChangeImage(workspace: string, path: string, revision?: string): Buffer {
  if (!safeImagePath(path)) throw new Error('Invalid image path.');
  const root = realpathSync(workspace);
  if (revision !== undefined) {
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid revision.');
    const tree = git(root, ['ls-tree', '-z', '--long', revision, '--', ':(literal)' + path]);
    const match = /^(100644|100755) blob ([a-f0-9]{40})\s+(\d+)\t([^\0]+)\0$/.exec(
      tree.stdout?.toString('utf8') ?? ''
    );
    if (tree.status !== 0 || !match || match[4] !== path || Number(match[3]) > MAX_BYTES)
      throw new Error('Image is not a bounded regular Git blob.');
    const result = git(root, ['cat-file', 'blob', match[2]!], MAX_BYTES);
    if (result.status !== 0 || result.stdout.length !== Number(match[3]))
      throw new Error('Image object is unavailable.');
    return result.stdout;
  }
  const target = join(root, path);
  if (realpathSync(dirname(target)) !== dirname(target))
    throw new Error('Image parent is a symlink.');
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (realpathSync('/proc/self/fd/' + fd) !== target) throw new Error('Image escaped workspace.');
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > MAX_BYTES) throw new Error('Image exceeds budget.');
    const data = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < data.length) {
      const count = readSync(fd, data, size, data.length - size, null);
      if (!count) break;
      size += count;
    }
    const after = fstatSync(fd);
    if (
      size !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('Image changed during capture.');
    return data.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}
export function createChangeImagePreview(
  workspace: string,
  path: string,
  revision?: string
): Buffer {
  const data = readChangeImage(workspace, path, revision);
  const format = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? 'png'
    : data[0] === 255 && data[1] === 216
      ? 'jpeg'
      : data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'
        ? 'webp'
        : undefined;
  if (!format) throw new Error('Unsupported image contents.');
  const result = spawnSync(
    '/usr/bin/magick',
    [
      '-limit',
      'thread',
      '1',
      '-limit',
      'memory',
      '128MiB',
      '-limit',
      'map',
      '128MiB',
      '-limit',
      'disk',
      '0',
      '-limit',
      'time',
      '5',
      format + ':-[0]',
      '-auto-orient',
      '-thumbnail',
      '1200x1200>',
      '-strip',
      '-quality',
      '78',
      'webp:-',
    ],
    {
      input: data,
      timeout: 6000,
      maxBuffer: 1024 * 1024,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/tmp',
        MAGICK_TEMPORARY_PATH: '/tmp',
        OMP_NUM_THREADS: '1',
      },
    }
  );
  if (result.status !== 0 || result.stdout.length === 0)
    throw new Error('Image preview could not be decoded within budget.');
  return result.stdout;
}
