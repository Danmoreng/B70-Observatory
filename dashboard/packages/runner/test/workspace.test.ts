import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceSnapshot } from '../src/workspace.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('isolated workspace snapshot', () => {
  it('creates an independent branch with history and no source writes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-workspace-test-'));
    roots.push(root);
    const repository = join(root, 'source');
    const stateRoot = join(root, 'state');
    mkdirSync(repository);
    mkdirSync(stateRoot);
    execFileSync('/usr/bin/git', ['init', '-q', repository]);
    execFileSync('/usr/bin/git', ['-C', repository, 'config', 'user.name', 'B70 Test']);
    execFileSync('/usr/bin/git', ['-C', repository, 'config', 'user.email', 'b70@example.invalid']);
    writeFileSync(join(repository, 'tracked.txt'), 'committed\n');
    execFileSync('/usr/bin/git', ['-C', repository, 'add', 'tracked.txt']);
    execFileSync('/usr/bin/git', ['-C', repository, 'commit', '-qm', 'fixture']);
    const revision = execFileSync('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    writeFileSync(join(repository, 'tracked.txt'), 'uncommitted user change\n');
    writeFileSync(join(repository, 'untracked.txt'), 'must stay outside\n');

    const snapshot = await createWorkspaceSnapshot({
      repository,
      revision,
      stateRoot,
      runId: '0123456789abcdef',
    });

    expect(snapshot.revision).toBe(revision);
    expect(readFileSync(join(snapshot.path, 'tracked.txt'), 'utf8')).toBe('committed\n');
    expect(() => readFileSync(join(snapshot.path, 'untracked.txt'))).toThrow();
    expect(snapshot.branch).toBe('agent/0123456789abcdef');
    expect(
      execFileSync('/usr/bin/git', ['-C', snapshot.path, 'branch', '--show-current'], {
        encoding: 'utf8',
      }).trim()
    ).toBe(snapshot.branch);
    expect(
      execFileSync('/usr/bin/git', ['-C', snapshot.path, 'remote'], { encoding: 'utf8' }).trim()
    ).toBe('');
    expect(
      execFileSync('/usr/bin/git', ['-C', snapshot.path, 'config', 'user.name'], {
        encoding: 'utf8',
      }).trim()
    ).toBe('Local B70 Agent');
    expect(
      execFileSync('/usr/bin/git', ['-C', snapshot.path, 'config', 'core.hooksPath'], {
        encoding: 'utf8',
      }).trim()
    ).toBe('/dev/null');
    expect(
      execFileSync('/usr/bin/git', ['-C', snapshot.path, 'rev-list', '--count', 'HEAD'], {
        encoding: 'utf8',
      }).trim()
    ).toBe('1');
    writeFileSync(join(snapshot.path, 'tracked.txt'), 'job change\n');
    execFileSync('/usr/bin/git', ['-C', snapshot.path, 'add', 'tracked.txt']);
    execFileSync('/usr/bin/git', ['-C', snapshot.path, 'commit', '-qm', 'agent change']);
    expect(readFileSync(join(repository, 'tracked.txt'), 'utf8')).toBe('uncommitted user change\n');
  });

  it('rejects non-commit revisions and state roots nested in the source', async () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-workspace-reject-'));
    roots.push(root);
    const repository = join(root, 'source');
    const nestedState = join(repository, 'runs');
    mkdirSync(repository);
    mkdirSync(nestedState);
    await expect(
      createWorkspaceSnapshot({
        repository,
        revision: 'HEAD',
        stateRoot: nestedState,
        runId: '0123456789abcdef',
      })
    ).rejects.toThrow(/disjoint|full lowercase commit hash/);
  });

  it('continues from an explicitly approved runner checkpoint below the state root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-workspace-continuation-'));
    roots.push(root);
    const stateRoot = join(root, 'state');
    const repository = join(stateRoot, 'previous-run', 'workspace');
    mkdirSync(repository, { recursive: true });
    execFileSync('/usr/bin/git', ['init', '-q', repository]);
    execFileSync('/usr/bin/git', ['-C', repository, 'config', 'user.name', 'B70 Test']);
    execFileSync('/usr/bin/git', ['-C', repository, 'config', 'user.email', 'b70@example.invalid']);
    writeFileSync(join(repository, 'checkpoint.txt'), 'continued state\n');
    execFileSync('/usr/bin/git', ['-C', repository, 'add', 'checkpoint.txt']);
    execFileSync('/usr/bin/git', ['-C', repository, 'commit', '-qm', 'checkpoint']);
    const revision = execFileSync('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();

    await expect(
      createWorkspaceSnapshot({
        repository,
        revision,
        stateRoot,
        runId: '1111111111111111',
      })
    ).rejects.toThrow('stateRoot and source repository must be disjoint');

    const snapshot = await createWorkspaceSnapshot({
      repository,
      revision,
      stateRoot,
      runId: '2222222222222222',
      allowSourceWithinStateRoot: true,
    });

    expect(readFileSync(join(snapshot.path, 'checkpoint.txt'), 'utf8')).toBe('continued state\n');
    expect(snapshot.revision).toBe(revision);
  });
});
