import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { copyDesktopRuntime, verifyDesktopRuntime } from '../../../../ops/desktop/runtime.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'b70-desktop-integrity-'));
  roots.push(root);
  writeFileSync(join(root, 'backend'), 'pinned binary');
  symlinkSync('backend', join(root, 'link'));
  const files = [
    { path: 'backend', sha256: createHash('sha256').update('pinned binary').digest('hex') },
    { path: 'link', symlink: 'backend' },
  ];
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ version: 1, files }));
  return root;
}
it('checks every runtime file and relative symlink', () => {
  expect(() => verifyDesktopRuntime(fixture())).not.toThrow();
});
it('materializes library links for the regular-file-only release helper', () => {
  const root = fixture();
  const destination = root + '-copy';
  roots.push(destination);
  copyDesktopRuntime(root, destination);
  expect(lstatSync(join(destination, 'link')).isFile()).toBe(true);
  expect(() => verifyDesktopRuntime(destination)).not.toThrow();
});
it('rejects a prepared bundle whose native source no longer matches', () => {
  expect(() =>
    verifyDesktopRuntime(fixture(), { sourceDigest: 'changed', packageLockSha256: 'changed' })
  ).toThrow(/source or package/);
});
it('rejects modified or additional runtime files', () => {
  const root = fixture();
  writeFileSync(join(root, 'backend'), 'modified');
  expect(() => verifyDesktopRuntime(root)).toThrow(/integrity/);
  const other = fixture();
  writeFileSync(join(other, 'extra'), 'unlisted');
  expect(() => verifyDesktopRuntime(other)).toThrow(/Unlisted/);
});
it('rejects a link redirected outside the runtime', () => {
  const root = fixture();
  rmSync(join(root, 'link'));
  symlinkSync('/etc/passwd', join(root, 'link'));
  expect(() => verifyDesktopRuntime(root)).toThrow(/symlink/);
});
