import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunnerConfig } from '../../src/runner/config.js';
import type { InferenceRelay } from '../../src/runner/inference-relay.js';
import { IsolatedAgentService } from '../../src/runner/service.js';
import { AgentTaskStore } from '../../src/runner/task-store.js';

const stores: AgentTaskStore[] = [];
const roots: string[] = [];

function repositoryWithDirtyTarget(): { path: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), 'b70-accept-merge-'));
  roots.push(root);
  const repository = join(root, 'repository');
  mkdirSync(repository, { mode: 0o700 });
  execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', repository]);
  execFileSync('/usr/bin/git', ['-C', repository, 'config', 'user.name', 'Fixture']);
  execFileSync('/usr/bin/git', ['-C', repository, 'config', 'user.email', 'fixture@invalid']);
  writeFileSync(join(repository, 'README.md'), '# Before\n');
  execFileSync('/usr/bin/git', ['-C', repository, 'add', '.']);
  execFileSync('/usr/bin/git', ['-C', repository, 'commit', '-qm', 'base']);
  // Foreign, uncommitted state in the target repository that must survive
  // the approval step byte-for-byte.
  writeFileSync(join(repository, 'local-notes.md'), 'uncommitted operator work\n');
  writeFileSync(join(repository, 'README.md'), '# Before with uncommitted edit\n');
  const head = execFileSync('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  return { path: repository, head };
}

function seedService(repository: { path: string; head: string }) {
  const store = new AgentTaskStore(':memory:');
  stores.push(store);
  const project = store.registerProject({
    name: 'Fixture project',
    repositoryPath: repository.path,
    targetBranch: 'main',
    workdir: '.',
    editPaths: ['.'],
    checks: [],
  });
  const accepted = store.acceptRun(
    {
      task: 'Change the README',
      idempotencyKey: '81818181-8181-4181-8181-818181818181',
    },
    {
      projectId: project.id,
      profileId: 'coding-default-v1',
      baseRevision: repository.head,
      maxActiveRuns: 2,
    }
  );
  const revision = 'b'.repeat(40);
  const owner = '82828282-8282-4282-8282-828282828282';
  store.markStarting(accepted, owner);
  store.updateRunStatus(accepted.runId, 'running', undefined, new Date(), owner);
  store.storeRunResult(
    accepted.runId,
    {
      resultRevision: revision,
      files: ['README.md'],
      diff: 'fixture result',
      diffTruncated: false,
      checkStatus: 'passed',
      checks: [],
    },
    join(repository.path, '..', 'result-workspace')
  );
  store.updateRunStatus(accepted.runId, 'completed', 'ready', new Date(), owner);
  const service = new IsolatedAgentService(
    {
      repository: repository.path,
      stateRoot: join(repository.path, '..', 'runs'),
      supportRoot: join(repository.path, '..', 'support'),
    } as unknown as RunnerConfig,
    {} as InferenceRelay,
    store
  );
  return { store, service, runId: accepted.runId, taskId: accepted.taskId, revision };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('separated result approval and project merge', () => {
  it('rejects new tasks on archived projects while keeping their old results readable', async () => {
    const repository = repositoryWithDirtyTarget();
    const { store, service, runId, taskId } = seedService(repository);
    const project = store.listProjects()[0]!;
    store.registerProject({ ...project, archived: true });
    await expect(service.start({ projectId: project.id, task: 'New work' })).rejects.toThrow(
      'project is archived'
    );
    expect(store.getTask(taskId).task.projectId).toBe(project.id);
    expect((await service.getRunResult(runId)).resultRevision).toBe('b'.repeat(40));
  });

  it('approves on a dirty target and keeps HEAD, index and markers byte-identical', async () => {
    const repository = repositoryWithDirtyTarget();
    const { store, service, runId, revision, taskId } = seedService(repository);
    const indexBefore = execFileSync('/usr/bin/git', ['-C', repository.path, 'ls-files'], {
      encoding: 'utf8',
    });
    const statusBefore = execFileSync(
      '/usr/bin/git',
      ['-C', repository.path, 'status', '--porcelain=v1'],
      { encoding: 'utf8' }
    );
    const expectedTaskVersion = store.getTask(taskId).task.version;

    const result = await service.acceptRunResult({
      runId,
      resultRevision: revision,
      expectedTaskVersion,
    });

    expect(result).toMatchObject({
      acceptedAt: expect.any(String),
      acceptedRevision: revision,
    });
    expect(result.mergedAt).toBeUndefined();
    expect(result.mergedRevision).toBeUndefined();
    expect(store.getTask(taskId).task.status).toBe('accepted');
    expect(
      execFileSync('/usr/bin/git', ['-C', repository.path, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim()
    ).toBe(repository.head);
    expect(
      execFileSync('/usr/bin/git', ['-C', repository.path, 'ls-files'], { encoding: 'utf8' })
    ).toBe(indexBefore);
    expect(
      execFileSync('/usr/bin/git', ['-C', repository.path, 'status', '--porcelain=v1'], {
        encoding: 'utf8',
      })
    ).toBe(statusBefore);
    expect(readFileSync(join(repository.path, 'README.md'), 'utf8')).toBe(
      '# Before with uncommitted edit\n'
    );
    expect(readFileSync(join(repository.path, 'local-notes.md'), 'utf8')).toBe(
      'uncommitted operator work\n'
    );
  });

  it('rejects merging before the result was approved', async () => {
    const repository = repositoryWithDirtyTarget();
    const { store, service, runId, revision, taskId } = seedService(repository);
    await expect(
      service.mergeRunResult({
        runId,
        resultRevision: revision,
        expectedTaskVersion: store.getTask(taskId).task.version,
      })
    ).rejects.toThrowError('Accept the result before merging');
  });

  it('rejects a stale task version and a wrong result revision on approval', async () => {
    const repository = repositoryWithDirtyTarget();
    const { store, service, runId, revision, taskId } = seedService(repository);
    const expectedTaskVersion = store.getTask(taskId).task.version;
    await expect(
      service.acceptRunResult({
        runId,
        resultRevision: revision,
        expectedTaskVersion: expectedTaskVersion + 5,
      })
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      service.acceptRunResult({
        runId,
        resultRevision: 'e'.repeat(40),
        expectedTaskVersion,
      })
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('treats a retry of the approved revision as idempotent', async () => {
    const repository = repositoryWithDirtyTarget();
    const { store, service, runId, revision, taskId } = seedService(repository);
    const expectedTaskVersion = store.getTask(taskId).task.version;
    const first = await service.acceptRunResult({
      runId,
      resultRevision: revision,
      expectedTaskVersion,
    });
    expect(first.acceptedRevision).toBe(revision);
    // The first response was lost: the retry still carries the old task
    // version but must return the durable approval without a new bump.
    const versionBeforeRetry = store.getTask(taskId).task.version;
    const retry = await service.acceptRunResult({
      runId,
      resultRevision: revision,
      expectedTaskVersion,
    });
    expect(retry.acceptedAt).toBe(first.acceptedAt);
    expect(retry.acceptedRevision).toBe(revision);
    expect(retry.mergedAt).toBeUndefined();
    expect(store.getTask(taskId).task.version).toBe(versionBeforeRetry);
  });

  it('does not mark an approval-only result as merged', async () => {
    const repository = repositoryWithDirtyTarget();
    const { store, service, runId, revision, taskId } = seedService(repository);
    await service.acceptRunResult({
      runId,
      resultRevision: revision,
      expectedTaskVersion: store.getTask(taskId).task.version,
    });
    expect(store.getRunResult(runId)).toMatchObject({ acceptedRevision: revision });
    expect(store.getRunResult(runId).mergedRevision).toBeUndefined();
  });

  describe('retry of an already merged result', () => {
    function seedMerged(repository: { path: string; head: string }) {
      const { store, service, runId, revision, taskId } = seedService(repository);
      const targetHead = 'c'.repeat(39) + '1';
      store.markAccepted(runId, revision);
      // The stored merge revision is the target HEAD after the real merge
      // commit, which differs from the approved source revision.
      store.markMerged(runId, targetHead);
      return { store, service, runId, revision, taskId, targetHead };
    }

    it('returns the merged result without git calls on a retry', async () => {
      const repository = repositoryWithDirtyTarget();
      const { store, service, runId, revision, taskId, targetHead } = seedMerged(repository);
      const statusBefore = execFileSync(
        '/usr/bin/git',
        ['-C', repository.path, 'status', '--porcelain=v1'],
        { encoding: 'utf8' }
      );
      const result = await service.mergeRunResult({
        runId,
        resultRevision: revision,
        expectedTaskVersion: store.getTask(taskId).task.version,
      });
      expect(result).toMatchObject({ mergedAt: expect.any(String), mergedRevision: targetHead });
      expect(store.getRunResult(runId).mergedRevision).toBe(targetHead);
      expect(
        execFileSync('/usr/bin/git', ['-C', repository.path, 'status', '--porcelain=v1'], {
          encoding: 'utf8',
        })
      ).toBe(statusBefore);
    });

    it('stays a no-op when the task version advanced and the target moved on', async () => {
      const repository = repositoryWithDirtyTarget();
      const { store, service, runId, revision, taskId, targetHead } = seedMerged(repository);
      const staleVersion = store.getTask(taskId).task.version - 3;
      const result = await service.mergeRunResult({
        runId,
        resultRevision: revision,
        expectedTaskVersion: staleVersion,
      });
      expect(result.mergedRevision).toBe(targetHead);
    });

    it('still rejects a wrong result revision or a not accepted result', async () => {
      const repository = repositoryWithDirtyTarget();
      const { store, service, runId, taskId } = seedMerged(repository);
      await expect(
        service.mergeRunResult({
          runId,
          resultRevision: 'd'.repeat(40),
          expectedTaskVersion: store.getTask(taskId).task.version,
        })
      ).rejects.toMatchObject({ code: 'conflict' });

      const fresh = seedService(repository);
      await expect(
        fresh.service.mergeRunResult({
          runId: fresh.runId,
          resultRevision: fresh.revision,
          expectedTaskVersion: fresh.store.getTask(fresh.taskId).task.version,
        })
      ).rejects.toThrowError('Accept the result before merging');
    });
  });
});
