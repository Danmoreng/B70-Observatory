import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createChangeImagePreview, readChangeImage, safeImagePath } from '../src/change-image.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'b70-change-image-'));
  roots.push(root);
  const workspace = join(root, 'repo');
  mkdirSync(workspace);
  const git = (...args: string[]) =>
    execFileSync('/usr/bin/git', ['-C', workspace, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@invalid');
  execFileSync('/usr/bin/magick', [
    '-size',
    '1600x2400',
    'xc:red',
    join(workspace, 'portrait.png'),
  ]);
  git('add', '.');
  git('commit', '-qm', 'portrait');
  const revision = git('rev-parse', 'HEAD').trim();
  return { root, workspace, git, revision };
}
describe('bounded image changes previews', () => {
  it('reads the immutable revision rather than a later working file and never changes HEAD/index', () => {
    const f = fixture();
    const original = readFileSync(join(f.workspace, 'portrait.png'));
    const index = readFileSync(join(f.workspace, '.git', 'index'));
    writeFileSync(join(f.workspace, 'portrait.png'), 'changed later');
    expect(readChangeImage(f.workspace, 'portrait.png', f.revision)).toEqual(original);
    const preview = createChangeImagePreview(f.workspace, 'portrait.png', f.revision);
    expect(preview.toString('ascii', 0, 4)).toBe('RIFF');
    expect(preview.toString('ascii', 8, 12)).toBe('WEBP');
    const dimensions = execFileSync('/usr/bin/magick', ['webp:-', '-format', '%wx%h', 'info:'], {
      input: preview,
      encoding: 'utf8',
    });
    expect(dimensions).toBe('800x1200');
    expect(preview.length).toBeLessThan(1024 * 1024);
    expect(readFileSync(join(f.workspace, '.git', 'index'))).toEqual(index);
    expect(f.git('rev-parse', 'HEAD').trim()).toBe(f.revision);
  });
  it('rejects traversal, symlinks, fake image content and foreign Git symlink blobs', () => {
    const f = fixture();
    for (const path of ['/tmp/a.png', '../a.png', '.git/a.png', 'a/../b.png', 'a.svg', 'a\\b.png'])
      expect(safeImagePath(path)).toBe(false);
    writeFileSync(join(f.root, 'outside.png'), 'outside');
    symlinkSync(join(f.root, 'outside.png'), join(f.workspace, 'link.png'));
    expect(() => readChangeImage(f.workspace, 'link.png')).toThrow();
    mkdirSync(join(f.root, 'elsewhere'));
    symlinkSync(join(f.root, 'elsewhere'), join(f.workspace, 'parent'));
    expect(() => readChangeImage(f.workspace, 'parent/a.png')).toThrow();
    f.git('add', '.');
    f.git('commit', '-qm', 'links');
    expect(() =>
      readChangeImage(f.workspace, 'link.png', f.git('rev-parse', 'HEAD').trim())
    ).toThrow();
    writeFileSync(join(f.workspace, 'fake.png'), '<?xml arbitrary>');
    expect(() => createChangeImagePreview(f.workspace, 'fake.png')).toThrow();
  });
});
