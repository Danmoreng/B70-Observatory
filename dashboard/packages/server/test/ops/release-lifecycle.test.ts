import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createReleaseLifecycle,
  normalizeReleasePermissions,
  restartReleaseServices,
  type HelperState,
  type ReleaseRef,
} from '../../../../ops/release-lifecycle.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const old: ReleaseRef = { releaseId: 'old', revision: 'a'.repeat(40), digest: 'a'.repeat(64) };
const next: ReleaseRef = { releaseId: 'next', revision: 'b'.repeat(40), digest: 'b'.repeat(64) };
const older: ReleaseRef = { releaseId: 'older', revision: 'c'.repeat(40), digest: 'c'.repeat(64) };

function fixture(health: boolean[] = [true]) {
  let state: HelperState = {
    version: 1,
    status: 'activating',
    current: old,
    previous: older,
    pending: next,
    updatedAt: '',
  };
  let target = 'releases/old';
  const commands: string[][] = [];
  let blocked = true;
  const systemctl = vi.fn(async (args: string[]) => {
    commands.push(args);
    if (args[0] === 'reset-failed') blocked = false;
    if (args[0] === 'restart') {
      if (blocked) throw new Error('start-limit-hit');
      blocked = true; // Simulate exhausting the start budget during each attempt.
    }
  });
  const healthy = vi.fn(async () => health.shift() ?? false);
  const prepare = vi.fn<(input: ReleaseRef) => void>();
  const hasRelease = vi.fn(() => true);
  const switchCurrent = vi.fn((value: string) => {
    target = value;
  });
  const controller = createReleaseLifecycle({
    readState: () => state,
    writeState: (value) => {
      state = { ...value, version: 1, updatedAt: '' };
    },
    currentTarget: () => target,
    switchCurrent,
    prepare,
    hasRelease,
    restartAndCheck: () => restartReleaseServices(systemctl, healthy),
  });
  return {
    controller,
    state: () => state,
    target: () => target,
    commands,
    prepare,
    hasRelease,
    systemctl,
    healthy,
    switchCurrent,
  };
}

describe('release installation access', () => {
  it('makes restrictive staged files readable to the service group without granting write access', () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-release-modes-'));
    roots.push(root);
    mkdirSync(join(root, 'runtime'), { mode: 0o700 });
    writeFileSync(join(root, 'server.cjs'), 'content unchanged', { mode: 0o600 });
    writeFileSync(join(root, 'runtime/helper'), '#!/bin/sh\n', { mode: 0o700 });
    normalizeReleasePermissions(root);
    expect(statSync(root).mode & 0o777).toBe(0o750);
    expect(statSync(join(root, 'runtime')).mode & 0o777).toBe(0o750);
    expect(statSync(join(root, 'server.cjs')).mode & 0o777).toBe(0o640);
    expect(statSync(join(root, 'runtime/helper')).mode & 0o777).toBe(0o750);
    expect(statSync(join(root, 'server.cjs')).gid).toBe(process.getgid!());
    expect(readFileSync(join(root, 'server.cjs'), 'utf8')).toBe('content unchanged');
  });
  it('refuses symlinks instead of changing the target permissions', () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-release-link-'));
    roots.push(root);
    const target = join(root, 'target');
    writeFileSync(target, 'private', { mode: 0o600 });
    const link = join(root, 'link');
    symlinkSync(target, link);
    expect(() => normalizeReleasePermissions(link)).toThrow('unsupported');
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });
});

describe('release recovery', () => {
  it('resets the failed-unit budget before starting a verified release', async () => {
    const f = fixture();
    await f.controller.activate(next);
    expect(f.state().status).toBe('active');
    expect(f.state().previous).toEqual(old);
    expect(f.commands.map((c) => c[0])).toEqual([
      'reset-failed',
      'restart',
      'is-active',
      'is-active',
    ]);
  });
  it('recovers and health checks the old version after a failed candidate', async () => {
    const f = fixture([false, true]);
    await f.controller.activate(next);
    expect(f.target()).toBe('releases/old');
    expect(f.state().current).toEqual(old);
    expect(f.state().status).toBe('failed');
    expect(f.state().message).toContain('Previous release restored and health checked');
    expect(f.commands.filter((c) => c[0] === 'reset-failed')).toHaveLength(2);
    expect(f.healthy).toHaveBeenCalledTimes(2);
  });
  it('reports a recovery failure rather than silently declaring the old version recovered', async () => {
    const f = fixture([false, false]);
    await f.controller.activate(next);
    expect(f.state().message).toContain('RECOVERY FAILED');
    expect(f.state().message).not.toContain('restored and health checked');
  });
  it('does not restart the live services when preflight verification fails', async () => {
    const f = fixture();
    f.prepare.mockImplementation(() => {
      throw new Error('checksum mismatch');
    });
    await f.controller.activate(next);
    expect(f.switchCurrent).not.toHaveBeenCalled();
    expect(f.commands).toEqual([]);
    expect(f.state().message).toContain('Live release was not changed');
  });
  it('checks both services, even when the web health endpoint succeeds', async () => {
    const systemctl = vi.fn(async (args: string[]) => {
      if (args[0] === 'is-active' && args[2] === 'local-ai-b70-runner.service')
        throw new Error('runner failed');
    });
    await expect(restartReleaseServices(systemctl, async () => true)).rejects.toThrow(
      'runner failed'
    );
  });
  it('keeps the older rollback target when reactivating the current release', async () => {
    const f = fixture();
    await f.controller.activate(old);
    expect(f.state().previous).toEqual(older);
  });
  it('restores and restarts the original version if an explicit rollback fails', async () => {
    const f = fixture([false, true]);
    await f.controller.rollback();
    expect(f.target()).toBe('releases/old');
    expect(f.state().current).toEqual(old);
    expect(f.state().message).toContain('restored and health checked');
    expect(f.commands.filter((c) => c[0] === 'restart')).toHaveLength(2);
  });
  it('health checks a successful explicit rollback', async () => {
    const f = fixture();
    await f.controller.rollback();
    expect(f.state().status).toBe('rolled_back');
    expect(f.state().current).toEqual(older);
    expect(f.healthy).toHaveBeenCalledOnce();
  });
  it('recovers interrupted activation by restarting services rather than just moving the symlink', async () => {
    const f = fixture();
    await f.controller.recoverInterrupted();
    expect(f.state().status).toBe('failed');
    expect(f.state().current).toEqual(old);
    expect(f.commands[0]?.[0]).toBe('reset-failed');
    expect(f.healthy).toHaveBeenCalledOnce();
  });
});
