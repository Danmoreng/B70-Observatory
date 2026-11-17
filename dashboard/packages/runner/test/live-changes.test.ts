import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureWorkspaceChanges } from '../src/live-changes.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'b70-live-changes-test-'));
  roots.push(root);
  const repository = join(root, 'repository');
  mkdirSync(repository);
  const git = (...args: string[]) =>
    execFileSync('/usr/bin/git', ['-C', repository, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@invalid');
  writeFileSync(join(repository, 'tracked.txt'), 'before\n');
  writeFileSync(join(repository, 'deleted.txt'), 'remove me\n');
  mkdirSync(join(repository, 'nested'));
  writeFileSync(join(repository, 'nested', 'inside.txt'), 'safe base\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  return { root, repository, git, base: git('rev-parse', 'HEAD').trim() };
}

describe('read-only working changes snapshot', () => {
  it('captures tracked, staged, untracked and deleted files without touching HEAD or index', () => {
    const { repository, git, base } = fixture();
    writeFileSync(join(repository, 'tracked.txt'), 'staged\n');
    writeFileSync(join(repository, 'added.txt'), 'staged addition\n');
    git('add', 'tracked.txt', 'added.txt');
    writeFileSync(
      join(repository, 'tracked.txt'),
      'latest unstaged\nliteral a/before/keep and b/after/keep\n'
    );
    writeFileSync(join(repository, 'space and ü.txt'), 'new file\n');
    rmSync(join(repository, 'deleted.txt'));
    const index = readFileSync(join(repository, '.git', 'index'));
    const result = captureWorkspaceChanges(repository, base);
    expect(result.truncated).toBe(false);
    expect(result.files).toEqual([
      { path: 'added.txt', status: 'added' },
      { path: 'deleted.txt', status: 'deleted' },
      { path: 'space and ü.txt', status: 'untracked' },
      { path: 'tracked.txt', status: 'modified' },
    ]);
    expect(result.diff).toContain('+latest unstaged');
    expect(result.diff).toContain('+literal a/before/keep and b/after/keep');
    expect(result.diff).toContain('+staged addition');
    expect(result.diff).toContain('-remove me');
    expect(result.diff).not.toContain('b70-live-diff-');
    expect(result.diff).toContain('diff --git a/tracked.txt b/tracked.txt');
    expect(readFileSync(join(repository, '.git', 'index'))).toEqual(index);
    expect(git('rev-parse', 'HEAD').trim()).toBe(base);
    expect(git('show', ':tracked.txt')).toBe('staged\n');
  });

  it('does not execute repository filters, diff drivers, hooks or fsmonitor', () => {
    const { root, repository, git, base } = fixture();
    const marker = join(root, 'executed');
    const command = `touch ${marker}`;
    git('config', 'filter.hostile.clean', command);
    git('config', 'diff.hostile.textconv', command);
    git('config', 'diff.external', command);
    git('config', 'core.fsmonitor', command);
    writeFileSync(join(repository, '.gitattributes'), '*.txt filter=hostile diff=hostile\n');
    writeFileSync(join(repository, 'tracked.txt'), 'changed\n');
    expect(captureWorkspaceChanges(repository, base).diff).toContain('+changed');
    expect(() => readFileSync(marker)).toThrow();
  });

  it('shows a symlink target as text but never follows a file or directory symlink', () => {
    const { root, repository, base } = fixture();
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'inside.txt'), 'HOST_PRIVATE_SENTINEL\n');
    rmSync(join(repository, 'nested'), { recursive: true });
    symlinkSync(outside, join(repository, 'nested'));
    symlinkSync(join(outside, 'inside.txt'), join(repository, 'link.txt'));
    const result = captureWorkspaceChanges(repository, base);
    expect(result.truncated).toBe(true);
    expect(result.files).toContainEqual({ path: 'nested/inside.txt', status: 'unknown' });
    expect(result.diff).not.toContain('HOST_PRIVATE_SENTINEL');
    expect(readFileSync(join(outside, 'inside.txt'), 'utf8')).toBe('HOST_PRIVATE_SENTINEL\n');
  });

  it('bounds UTF-8 diff bytes and reports large/binary previews honestly', () => {
    const { repository, base } = fixture();
    writeFileSync(join(repository, 'one.txt'), 'ä'.repeat(100_000));
    writeFileSync(join(repository, 'two.txt'), 'ß'.repeat(100_000));
    writeFileSync(join(repository, 'too-large.txt'), Buffer.alloc(300_000, 65));
    writeFileSync(join(repository, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    const result = captureWorkspaceChanges(repository, base);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.diff)).toBeLessThanOrEqual(262_144);
    expect(result.files).toContainEqual({ path: 'too-large.txt', status: 'unknown' });
    expect(result.diff).toContain('Binary files');
    expect(result.diff).not.toContain('\uFFFD');
  });

  it('returns an empty preview for a clean repository', () => {
    const { repository, base } = fixture();
    expect(captureWorkspaceChanges(repository, base)).toEqual({
      files: [],
      diff: '',
      truncated: false,
    });
  });

  it('preserves a staged deletion when the leftover working file is now ignored', () => {
    const { repository, git } = fixture();
    writeFileSync(join(repository, '.gitignore'), 'config.local\n');
    writeFileSync(join(repository, 'config.local'), 'tracked local setting\n');
    git('add', '.gitignore');
    git('add', '-f', 'config.local');
    git('commit', '-qm', 'tracked ignored file');
    const base = git('rev-parse', 'HEAD').trim();
    git('rm', '--cached', 'config.local');
    const index = readFileSync(join(repository, '.git', 'index'));
    const result = captureWorkspaceChanges(repository, base);
    expect(result.files).toEqual([{ path: 'config.local', status: 'deleted' }]);
    expect(result.diff).toContain('-tracked local setting');
    expect(result.truncated).toBe(false);
    expect(readFileSync(join(repository, 'config.local'), 'utf8')).toBe('tracked local setting\n');
    expect(readFileSync(join(repository, '.git', 'index'))).toEqual(index);
  });

  it('caps the changed-file list and marks omitted files', () => {
    const { repository, base } = fixture();
    for (let index = 0; index < 505; index++)
      writeFileSync(join(repository, `added-${index}.txt`), 'new\n');
    const result = captureWorkspaceChanges(repository, base);
    expect(result.files).toHaveLength(500);
    expect(result.truncated).toBe(true);
    expect(new Set(result.files.map((file) => file.path)).size).toBe(500);
  });
});
