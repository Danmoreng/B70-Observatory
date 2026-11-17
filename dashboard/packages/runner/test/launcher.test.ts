import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SandboxConfigurationError,
  RUN_DEADLINE_POLICY,
  buildBubblewrapArguments,
  buildWorkspaceUtilityArguments,
  buildSystemdScopeArguments,
  unitNameFor,
} from '../src/launcher.js';

const tempDirs: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'b70-runner-unit-'));
  tempDirs.push(root);
  const workspace = join(root, 'workspace');
  const runtimeRoot = join(root, 'runtime');
  const profileRoot = join(root, 'profile');
  for (const directory of [workspace, runtimeRoot, profileRoot]) {
    mkdirSync(directory, { mode: 0o700 });
  }
  const executable = join(runtimeRoot, 'probe');
  writeFileSync(executable, '#!/usr/bin/env node\n', { mode: 0o700 });
  chmodSync(executable, 0o700);
  return {
    runId: '0123456789abcdef',
    workspace: {
      path: workspace,
      revision: '0'.repeat(40),
      runId: '0123456789abcdef',
      branch: 'agent/0123456789abcdef',
    },
    runtimeRoot,
    profileRoot,
    runtimeExecutable: 'probe',
  };
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('sandbox profile', () => {
  it('keeps desktop tools inside the fixed Durable worker without host display or network mounts', () => {
    const sample = fixture();
    writeFileSync(join(sample.runtimeRoot, 'durable-env-entry.js'), '');
    mkdirSync(join(sample.runtimeRoot, 'desktop/bin'), { recursive: true });
    writeFileSync(join(sample.runtimeRoot, 'desktop/bin/agent-workspace-linux'), '', {
      mode: 0o755,
    });
    mkdirSync(join(sample.runtimeRoot, 'desktop/etc'));
    for (const name of ['passwd', 'group', 'nsswitch.conf'])
      writeFileSync(join(sample.runtimeRoot, 'desktop/etc', name), '');
    const options = {
      runId: sample.runId,
      workspacePath: sample.workspace.path,
      runtimeRoot: sample.runtimeRoot,
      runtimeExecutable: 'durable-env-entry.js',
      desktopEnabled: true,
    };
    const args = buildWorkspaceUtilityArguments(options);
    expect(args).toContain('--unshare-all');
    expect(args).toContain('--disable-userns');
    expect(args).toContain('B70_DESKTOP_ROOT');
    expect(args).toContain('/runtime/desktop');
    for (const forbidden of [
      '/run/user',
      '/dev/dri',
      '/dev/uinput',
      '/tmp/.X11-unix',
      '--share-net',
      'DISPLAY',
      'DBUS_SESSION_BUS_ADDRESS',
    ])
      expect(args).not.toContain(forbidden);
    expect(() =>
      buildWorkspaceUtilityArguments({ ...options, runtimeExecutable: 'probe' })
    ).toThrow(/fixed Durable/);
  });
  it('mounts inspection workspaces read-only without changing normal utility mounts', () => {
    const sample = fixture();
    const options = {
      runId: sample.runId,
      workspacePath: sample.workspace.path,
      runtimeRoot: sample.runtimeRoot,
      runtimeExecutable: sample.runtimeExecutable,
    };
    const readonly = buildWorkspaceUtilityArguments({ ...options, readOnly: true });
    const writable = buildWorkspaceUtilityArguments(options);
    expect(readonly[readonly.indexOf(sample.workspace.path) - 1]).toBe('--ro-bind');
    expect(writable[writable.indexOf(sample.workspace.path) - 1]).toBe('--bind');
    expect(readonly).toContain('--unshare-all');
    expect(readonly).not.toContain('--share-net');
  });
  it('budgets browser and agent threads while bounding inherited test/build pools', () => {
    const options = fixture();
    const browserRuntimeRoot = join(dirname(options.runtimeRoot), 'browser');
    mkdirSync(browserRuntimeRoot);
    const withBrowser = { ...options, browserRuntimeRoot };
    expect(buildSystemdScopeArguments(withBrowser)).toContain('--property=TasksMax=512');
    expect(
      buildSystemdScopeArguments({
        ...withBrowser,
        limits: {
          memoryBytes: 4 * 1024 ** 3,
          cpuQuotaPercent: 200,
          tasksMax: 192,
          runtimeSeconds: 4200,
          tmpBytes: 512 * 1024 ** 2,
        },
      })
    ).toContain('--property=TasksMax=192');
    const args = buildBubblewrapArguments(withBrowser);
    for (const key of ['VITEST_MAX_WORKERS', 'RAYON_NUM_THREADS']) {
      const index = args.indexOf(key);
      expect(args[index - 1]).toBe('--setenv');
      expect(args[index + 1]).toBe('2');
    }
    expect(buildSystemdScopeArguments(withBrowser)).toEqual(
      expect.arrayContaining([
        '--property=MemoryMax=4294967296',
        '--property=CPUQuota=200%',
        '--property=RuntimeMaxSec=4200s',
      ])
    );
  });

  it('exposes browser and npm only to the fixed sandboxed Durable worker', () => {
    const fixtureOptions = fixture();
    const browserRuntimeRoot = join(dirname(fixtureOptions.runtimeRoot), 'browser');
    const socketRoot = join(dirname(fixtureOptions.runtimeRoot), 'sockets');
    mkdirSync(browserRuntimeRoot);
    mkdirSync(socketRoot);
    writeFileSync(join(fixtureOptions.runtimeRoot, 'durable-env-entry.js'), '');
    const options = {
      runId: fixtureOptions.runId,
      workspacePath: fixtureOptions.workspace.path,
      runtimeRoot: fixtureOptions.runtimeRoot,
      runtimeExecutable: 'durable-env-entry.js',
      browserRuntimeRoot,
      npm: { socketRoot, token: 'a'.repeat(64) },
    };
    const args = buildWorkspaceUtilityArguments(options);
    expect(args).toEqual(
      expect.arrayContaining([
        '--unshare-all',
        '--clearenv',
        '/browser',
        '/inference',
        'B70_NPM_TOKEN',
      ])
    );
    expect(args).not.toContain(fixtureOptions.profileRoot);
    expect(args.indexOf('B70_BROWSER_ROOT')).toBeGreaterThan(args.indexOf('--clearenv'));
    expect(() =>
      buildWorkspaceUtilityArguments({ ...options, runtimeExecutable: 'probe' })
    ).toThrow(SandboxConfigurationError);
    expect(() =>
      buildWorkspaceUtilityArguments({ ...options, browserRuntimeRoot: options.workspacePath })
    ).toThrow(SandboxConfigurationError);
  });

  it('allows npm with read-only project dependencies only for the fixed Durable worker', () => {
    const sample = fixture();
    const dependencyRoot = join(dirname(sample.runtimeRoot), 'dependencies');
    const socketRoot = join(dirname(sample.runtimeRoot), 'sockets');
    mkdirSync(dependencyRoot);
    mkdirSync(socketRoot);
    for (const name of ['durable-env-entry.js', 'npm-prepare.js'])
      writeFileSync(join(sample.runtimeRoot, name), '');
    const options = {
      runId: sample.runId,
      workspacePath: sample.workspace.path,
      runtimeRoot: sample.runtimeRoot,
      runtimeExecutable: 'durable-env-entry.js',
      dependencyRoot,
      dependencyTarget: 'dashboard/node_modules',
      npm: { socketRoot, token: 'a'.repeat(64) },
    };
    const args = buildWorkspaceUtilityArguments(options);
    const dependencyIndex = args.indexOf(dependencyRoot);
    expect(args.slice(dependencyIndex - 1, dependencyIndex + 2)).toEqual([
      '--ro-bind',
      dependencyRoot,
      '/workspace/dashboard/node_modules',
    ]);
    expect(args).toContain('B70_NPM_TOKEN');
    expect(args).toContain('--unshare-all');
    expect(args).not.toContain('--share-net');
    expect(() =>
      buildWorkspaceUtilityArguments({ ...options, runtimeExecutable: 'npm-prepare.js' })
    ).toThrow(/invalid npm utility capability/);
    expect(() =>
      buildWorkspaceUtilityArguments({ ...options, npm: { socketRoot, token: 'invalid' } })
    ).toThrow(/invalid npm utility capability/);
    expect(() =>
      buildWorkspaceUtilityArguments({ ...options, sourcePath: dependencyRoot })
    ).toThrow(/invalid npm utility capability/);
  });

  it('builds fixed namespace, mount, environment and cgroup limits', () => {
    const options = fixture();
    const bwrap = buildBubblewrapArguments(options);
    const scope = buildSystemdScopeArguments(options);

    expect(bwrap).toEqual(
      expect.arrayContaining([
        '--unshare-all',
        '--disable-userns',
        '--cap-drop',
        'ALL',
        '--clearenv',
        '/workspace',
        '/runtime',
        '/profile',
      ])
    );
    expect(bwrap).not.toContain('/home/operator');
    expect(scope).toEqual(
      expect.arrayContaining([
        '--property=MemoryMax=4294967296',
        '--property=MemorySwapMax=0',
        '--property=TasksMax=128',
        '--property=CPUQuota=200%',
        '--property=RuntimeMaxSec=4200s',
        '--property=KillMode=control-group',
      ])
    );
    expect(unitNameFor(options.runId)).toBe('local-ai-b70-job-0123456789abcdef.scope');
    expect(RUN_DEADLINE_POLICY).toEqual({
      firstWarningSeconds: 3_600,
      finalWarningSeconds: 3_900,
      hardCutoffSeconds: 4_200,
    });
  });

  it('rejects path traversal, nested trust roots and invalid resource values', () => {
    const options = fixture();
    expect(() => buildBubblewrapArguments({ ...options, runtimeExecutable: '../bin/sh' })).toThrow(
      SandboxConfigurationError
    );
    expect(() =>
      buildBubblewrapArguments({ ...options, profileRoot: options.workspace.path })
    ).toThrow(/disjoint/);
    const unrelatedProfile = join(options.profileRoot, 'nested');
    mkdirSync(unrelatedProfile);
    expect(() =>
      buildBubblewrapArguments({ ...options, profileRoot: unrelatedProfile, writableProfile: true })
    ).toThrow(/same private run/);
    expect(() =>
      buildSystemdScopeArguments({
        ...options,
        limits: {
          memoryBytes: 1,
          cpuQuotaPercent: 200,
          tasksMax: 128,
          runtimeSeconds: 30,
          tmpBytes: 64 * 1024 * 1024,
        },
      })
    ).toThrow(/memoryBytes/);
  });

  it('mounts only a same-run disposable profile writable', () => {
    const options = fixture();
    const bwrap = buildBubblewrapArguments({ ...options, writableProfile: true });
    const profileIndex = bwrap.indexOf(options.profileRoot);

    expect(bwrap[profileIndex - 1]).toBe('--bind');
    expect(bwrap[profileIndex + 1]).toBe('/profile');
  });

  it('enforces a read-only workspace for review runs', () => {
    const options = fixture();
    const bwrap = buildBubblewrapArguments({
      ...options,
      workspaceWritable: false,
      runMode: 'review',
    });
    const workspaceIndex = bwrap.indexOf(options.workspace.path);
    const modeIndex = bwrap.indexOf('B70_RUN_MODE');

    expect(bwrap[workspaceIndex - 1]).toBe('--ro-bind');
    expect(bwrap[workspaceIndex + 1]).toBe('/workspace');
    expect(bwrap[modeIndex + 1]).toBe('review');
  });

  it('mounts existing project dependencies read-only at a fixed workspace path', () => {
    const options = fixture();
    const dependencyRoot = join(dirname(options.workspace.path), 'dependencies');
    mkdirSync(dependencyRoot);
    const bwrap = buildBubblewrapArguments({
      ...options,
      dependencyRoot,
      dependencyTarget: 'dashboard/node_modules',
    });
    const dependencyIndex = bwrap.indexOf(dependencyRoot);

    expect(bwrap[dependencyIndex - 1]).toBe('--ro-bind');
    expect(bwrap[dependencyIndex + 1]).toBe('/workspace/dashboard/node_modules');
    expect(() =>
      buildBubblewrapArguments({
        ...options,
        dependencyRoot,
        dependencyTarget: '../operator-home',
      })
    ).toThrow(/dependencyTarget/);
  });
});
