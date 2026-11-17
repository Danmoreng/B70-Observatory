import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  desktopSourceDigest,
  stageApprovedDesktop,
  stageApprovedBrowsers,
} from '../src/desktop-artifact.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'b70-desktop-stage-'));
  roots.push(root);
  const approved = join(root, 'approved');
  const vendor = join(root, 'vendor');
  const prepared = join(root, 'build/desktop');
  const lock = join(root, 'packages.lock.json');
  mkdirSync(approved);
  mkdirSync(vendor);
  writeFileSync(join(vendor, 'source.rs'), 'reviewed source');
  writeFileSync(lock, 'reviewed package pins');
  writeFileSync(join(approved, 'backend'), 'reviewed binary');
  writeFileSync(
    join(approved, 'manifest.json'),
    JSON.stringify({
      sourceDigest: desktopSourceDigest(vendor),
      packageLockSha256: createHash('sha256').update('reviewed package pins').digest('hex'),
    })
  );
  return { approved, prepared, vendor, lock };
}
it('reuses the approved desktop only when native source and package pins match', () => {
  const f = fixture();
  stageApprovedDesktop(f.approved, f.prepared, f.vendor, f.lock);
  expect(readFileSync(join(f.prepared, 'backend'), 'utf8')).toBe('reviewed binary');
  expect(readFileSync(join(f.approved, 'backend'), 'utf8')).toBe('reviewed binary');
});
it('refuses stale source and package dependencies without creating a candidate', () => {
  for (const changed of ['source', 'packages']) {
    const f = fixture();
    writeFileSync(changed === 'source' ? join(f.vendor, 'source.rs') : f.lock, 'changed');
    expect(() => stageApprovedDesktop(f.approved, f.prepared, f.vendor, f.lock)).toThrow(
      /fresh reviewed/
    );
    expect(existsSync(f.prepared)).toBe(false);
  }
});
it('excludes local build/git state but binds the actual native source', () => {
  const f = fixture();
  const before = desktopSourceDigest(f.vendor);
  mkdirSync(join(f.vendor, 'target'));
  writeFileSync(join(f.vendor, 'target/cache'), 'local build cache');
  expect(desktopSourceDigest(f.vendor)).toBe(before);
  writeFileSync(join(f.vendor, 'source.rs'), 'modified source');
  expect(desktopSourceDigest(f.vendor)).not.toBe(before);
});

it('binds browser runtime reuse to the reviewed browser package lock', () => {
  const good = fixture();
  stageApprovedBrowsers(good.approved, good.prepared, good.lock);
  expect(readFileSync(join(good.prepared, 'backend'), 'utf8')).toBe('reviewed binary');
  const stale = fixture();
  writeFileSync(stale.lock, 'new Chromium pins');
  expect(() => stageApprovedBrowsers(stale.approved, stale.prepared, stale.lock)).toThrow(
    'fresh reviewed'
  );
  expect(existsSync(stale.prepared)).toBe(false);
});
