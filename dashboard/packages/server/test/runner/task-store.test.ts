import { DatabaseSync } from 'node:sqlite';
import { deflateSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentRunSnapshotSchema,
  AgentStreamEventSchema,
  SERVICE_NAME,
} from '@observatory/contracts';
import { AgentTaskStore, TaskStoreError } from '../../src/runner/task-store.js';

const stores: AgentTaskStore[] = [];
const roots: string[] = [];

function createStore(budget?: number): AgentTaskStore {
  const store = new AgentTaskStore(new DatabaseSync(':memory:'), budget);
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const options = {
  profileId: 'coding-default-v1',
  baseRevision: 'a'.repeat(40),
  now: new Date('2026-09-13T12:00:00.000Z'),
};

describe('durable agent task store', () => {
  it('returns three recent tasks and projects by real activity, including projects without tasks', () => {
    const store = createStore();
    const at = (day: number) => new Date(Date.UTC(2026, 8, day));
    const register = (name: string, day: number, archived = false) =>
      store.registerProject(
        {
          name,
          repositoryPath: '/' + name,
          targetBranch: 'main',
          workdir: '.',
          editPaths: ['.'],
          checks: [],
          archived,
        },
        at(day)
      );
    const active = register('editor', 1);
    register('docs', 2);
    register('tools', 3);
    register('empty', 4);
    const archived = register('archive', 10, true);
    for (const day of [5, 6, 7, 8, 10]) {
      store.acceptRun(
        { task: 'task ' + day, name: 'task ' + day },
        {
          ...options,
          now: at(day),
          projectId: day === 10 ? archived.id : active.id,
          maxActiveRuns: 10,
        }
      );
    }
    register('docs', 12);
    const recent = store.recentWork();
    expect(recent.tasks.map((t) => t.title)).toEqual(['task 8', 'task 7', 'task 6']);
    expect(recent.projects.map((p) => p.name)).toEqual(['editor', 'empty', 'tools']);
    expect(recent.projects[0]?.updatedAt).toBe(at(8).toISOString());
  });

  it('distinguishes open questions, failures and unaccepted results for the workspace inbox', () => {
    const store = createStore();
    const owner = '25252525-2525-4525-8525-252525252525';
    const question = store.acceptRun({ task: 'Question' }, options);
    store.markStarting(question, owner, options.now);
    store.updateRunStatus(question.runId, 'running', undefined, options.now, owner);
    expect(store.listTasks().items.find((task) => task.id === question.taskId)?.attention).toBe(
      'none'
    );
    store.storeQuestion(question.taskId, question.runId, 'Which style?', options.now);
    store.updateRunStatus(question.runId, 'yielded', 'Waiting', options.now, owner);
    expect(store.listTasks().items.find((task) => task.id === question.taskId)?.attention).toBe(
      'question'
    );
    const failed = store.acceptRun({ task: 'Failure' }, options);
    store.markStarting(failed, owner, options.now);
    store.updateRunStatus(failed.runId, 'failed', 'Failure', options.now, owner);
    expect(store.listTasks().items.find((task) => task.id === failed.taskId)?.attention).toBe(
      'error'
    );
    const result = store.acceptRun({ task: 'Result' }, options);
    store.markStarting(result, owner, options.now);
    store.updateRunStatus(result.runId, 'running', undefined, options.now, owner);
    store.storeRunResult(
      result.runId,
      {
        resultRevision: 'b'.repeat(40),
        files: ['test.txt'],
        diff: '',
        diffTruncated: false,
        checkStatus: 'passed',
        checks: [],
      },
      '/tmp/result'
    );
    store.updateRunStatus(result.runId, 'completed', 'Done', options.now, owner);
    expect(store.listTasks().items.find((task) => task.id === result.taskId)?.attention).toBe(
      'review'
    );
    store.database
      .prepare('UPDATE agent_run_results SET accepted_at=? WHERE run_id=?')
      .run(options.now.toISOString(), result.runId);
    expect(store.listTasks().items.find((task) => task.id === result.taskId)?.attention).toBe(
      'none'
    );
  });
  it('preserves archived projects and their task history across seeding and reopen', () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-project-archive-'));
    roots.push(root);
    const path = join(root, 'tasks.sqlite');
    const first = new AgentTaskStore(path);
    const input = {
      name: 'Historical dashboard',
      repositoryPath: '/tmp/old-dashboard',
      targetBranch: 'main',
      workdir: '.',
      editPaths: ['.'],
      checks: [],
    };
    const project = first.registerProject(input);
    const accepted = first.acceptRun(
      { task: 'Historical work', projectId: project.id },
      { ...options, projectId: project.id }
    );
    first.registerProject({ ...input, archived: true });
    first.seedDefaultProject(input);
    expect(first.getProject(project.id).archived).toBe(true);
    expect(first.getTask(accepted.taskId).task.projectId).toBe(project.id);
    first.close();
    const reopened = new AgentTaskStore(path);
    stores.push(reopened);
    expect(reopened.listProjects().find((p) => p.id === project.id)?.archived).toBe(true);
    expect(reopened.getTask(accepted.taskId).task.projectName).toBe(input.name);
    reopened.registerProject({ ...input, archived: false });
    expect(reopened.getProject(project.id).archived).toBe(false);
  });

  it('keeps a map pin across database reopen, and binds it into start idempotency', () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-map-pin-'));
    roots.push(root);
    const path = join(root, 'tasks.sqlite');
    const first = new AgentTaskStore(path);
    const input = {
      task: 'Improve this area',
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
      architectureTarget: {
        mapId: 'observatory-v1',
        nodeId: 'projects',
        revision: options.baseRevision,
        label: 'Project overview',
        breadcrumbs: ['Observatory', 'Interface', 'Project overview'],
        sourcePaths: ['dashboard/packages/web/src/components/agent/AgentProjectBrowser.vue'],
      },
    };
    const accepted = first.acceptRun(input, options);
    expect(first.acceptRun(input, options).runId).toBe(accepted.runId);
    expect(() =>
      first.acceptRun(
        { ...input, architectureTarget: { ...input.architectureTarget, nodeId: 'task' } },
        options
      )
    ).toThrow('different task content');
    first.close();
    const reopened = new AgentTaskStore(path);
    stores.push(reopened);
    expect(reopened.getTask(accepted.taskId).task.architectureTarget).toEqual(
      input.architectureTarget
    );
    expect(reopened.listTasks().items[0]?.architectureTarget).toEqual(input.architectureTarget);
  });

  it('migrates and reopens an older empty database reproducibly', () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-task-db-'));
    roots.push(root);
    const path = join(root, 'tasks.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(
      'CREATE TABLE runner_schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);'
    );
    legacy
      .prepare('INSERT INTO runner_schema_migrations VALUES(0, ?)')
      .run(options.now.toISOString());
    legacy.close();

    const first = new AgentTaskStore(path);
    stores.push(first);
    expect(
      first.database.prepare('SELECT version FROM runner_schema_migrations ORDER BY version').all()
    ).toEqual([
      { version: 0 },
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
      { version: 8 },
      { version: 9 },
      { version: 10 },
      { version: 11 },
    ]);
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const reopened = new AgentTaskStore(path);
    stores.push(reopened);
    expect(reopened.listTasks().items).toEqual([]);
  });

  it('rolls back the complete acceptance when the dispatch write fails', () => {
    const store = createStore();
    store.database.exec(`
      CREATE TRIGGER reject_dispatch BEFORE INSERT ON agent_dispatches
      BEGIN SELECT RAISE(ABORT, 'simulated full database'); END;
    `);
    expect(() =>
      store.acceptRun(
        {
          task: 'Must be atomic',
          idempotencyKey: '10101010-1010-4010-8010-101010101010',
        },
        options
      )
    ).toThrowError(TaskStoreError);
    for (const table of ['agent_tasks', 'agent_turns', 'agent_runs', 'agent_messages']) {
      expect(
        (
          store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
            count: number;
          }
        ).count
      ).toBe(0);
    }
  });

  it('accepts task, turn, run and dispatch atomically and deduplicates retries', () => {
    const store = createStore();
    const input = {
      task: 'Fix the current view',
      name: 'Live view',
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    };
    const first = store.acceptRun(input, options);
    const retry = store.acceptRun(input, options);

    expect(first.created).toBe(true);
    expect(retry).toEqual({ ...first, created: false });
    expect(store.listTasks().items).toHaveLength(1);
    expect(() => store.acceptRun({ ...input, task: 'Different content' }, options)).toThrowError(
      TaskStoreError
    );
  });

  it('deduplicates the original request even when generated titles differ on retry', () => {
    const store = createStore();
    const original = {
      task: 'Generate a short task title',
      idempotencyKey: '15151515-1515-4515-8515-151515151515',
    };
    const first = store.acceptRun(
      { ...original, name: 'First generated title' },
      {
        ...options,
        digestInput: original,
      }
    );
    const retry = store.acceptRun(
      { ...original, name: 'Another generated title' },
      {
        ...options,
        digestInput: original,
      }
    );
    expect(retry).toEqual({ ...first, created: false });
    expect(store.listTasks().items).toHaveLength(1);
    expect(store.listTasks().items[0]?.title).toBe('First generated title');
  });

  it('exposes the original task text and replaces fallback titles for regeneration', () => {
    const store = createStore();
    const accepted = store.acceptRun(
      {
        task: 'Simplify the dashboard header layout\nKeep all KPI cards visible.',
        idempotencyKey: '16161616-1616-4616-8616-161616161616',
      },
      options
    );
    // Without an explicit name the first line became the legacy title.
    expect(store.listTasks().items[0]?.title).toBe('Simplify the dashboard header layout');

    expect(store.firstUserMessage(accepted.taskId)).toBe(
      'Simplify the dashboard header layout\nKeep all KPI cards visible.'
    );

    const version = store.getTask(accepted.taskId).task.version;
    const updatedAt = store.getTask(accepted.taskId).task.updatedAt;
    expect(store.setTaskTitle(accepted.taskId, 'Simplify dashboard header')).toBe(true);
    expect(store.getTask(accepted.taskId).task.title).toBe('Simplify dashboard header');
    expect(store.getTask(accepted.taskId).task.version).toBe(version + 1);
    expect(store.listTasks().items[0]?.title).toBe('Simplify dashboard header');
    // Renaming is cosmetic: it must not count as activity, so the task keeps
    // its position in the list (which sorts by the stored activity timestamp).
    expect(store.getTask(accepted.taskId).task.updatedAt).toBe(updatedAt);

    expect(store.setTaskTitle('20202020-2020-4020-8020-202020202020', 'Missing')).toBe(false);
  });

  it('binds a durable release job to exactly one merged result commit', () => {
    const store = createStore();
    const accepted = store.acceptRun(
      {
        task: 'Prepare a releasable result',
        idempotencyKey: '12121212-1212-4212-8212-121212121212',
      },
      options
    );
    const owner = '13131313-1313-4313-8313-131313131313';
    const revision = 'b'.repeat(40);
    store.markStarting(accepted, owner, options.now);
    store.updateRunStatus(accepted.runId, 'running', undefined, options.now, owner);
    store.storeRunResult(
      accepted.runId,
      {
        resultRevision: revision,
        files: ['dashboard/README.md'],
        diff: 'release fixture',
        diffTruncated: false,
        checkStatus: 'passed',
        checks: [],
      },
      '/tmp/release-source'
    );
    store.updateRunStatus(accepted.runId, 'completed', 'ready', options.now, owner);
    expect(() =>
      store.acceptRelease({
        taskId: accepted.taskId,
        runId: accepted.runId,
        revision,
        idempotencyKey: '14141414-1414-4414-8414-141414141414',
      })
    ).toThrowError('exact accepted');

    store.markAccepted(accepted.runId, revision, options.now);
    expect(() =>
      store.acceptRelease(
        {
          taskId: accepted.taskId,
          runId: accepted.runId,
          revision,
          idempotencyKey: '96969696-9696-4696-8696-969696969696',
        },
        options.now
      )
    ).toThrowError('already merged into the project');
    store.markMerged(accepted.runId, revision, options.now);
    const request = {
      taskId: accepted.taskId,
      runId: accepted.runId,
      revision,
      idempotencyKey: '15151515-1515-4515-8515-151515151515',
    };
    const first = store.acceptRelease(request, options.now);
    const retry = store.acceptRelease(request, options.now);
    expect(first.created).toBe(true);
    expect(retry).toEqual({ release: first.release, created: false });
    store.markReleaseBuilding(first.release.id, options.now);
    store.markReleasePrepared(
      first.release.id,
      '/var/lib/local-ai-b70-runner/releases/fixture',
      'c'.repeat(64),
      'tests passed',
      options.now
    );
    expect(store.getTask(accepted.taskId).releases[0]).toMatchObject({
      revision,
      status: 'prepared',
      checkStatus: 'passed',
      artifactDigest: 'c'.repeat(64),
    });
    store.markReleaseActivating(first.release.id, options.now);
    store.syncReleaseDeployment(first.release.id, 'active', undefined, options.now);
    expect(store.getRelease(first.release.id)).toMatchObject({
      status: 'active',
      activatedAt: options.now.toISOString(),
    });
    store.syncReleaseDeployment(first.release.id, 'rolled_back', undefined, options.now);
    expect(store.getRelease(first.release.id).status).toBe('rolled_back');
  });

  it('keeps approval and merge as separate durable states with idempotent retries', () => {
    const store = createStore();
    const run = store.acceptRun(
      {
        task: 'Approve and merge in two steps',
        idempotencyKey: '71717171-7171-4171-8171-717171717171',
      },
      options
    );
    const owner = '72727272-7272-4272-8272-727272727272';
    const revision = 'b'.repeat(40);
    store.markStarting(run, owner, options.now);
    store.updateRunStatus(run.runId, 'running', undefined, options.now, owner);
    store.storeRunResult(
      run.runId,
      {
        resultRevision: revision,
        files: ['README.md'],
        diff: 'two phase',
        diffTruncated: false,
        checkStatus: 'passed',
        checks: [],
      },
      '/tmp/two-phase'
    );
    store.updateRunStatus(run.runId, 'completed', 'ready', options.now, owner);
    expect(() => store.markMerged(run.runId, revision, options.now)).toThrowError(
      'accepted before merging'
    );

    const versionBefore = store.getTask(run.taskId).task.version;
    store.markAccepted(run.runId, revision, options.now);
    expect(store.getRunResult(run.runId)).toMatchObject({
      acceptedAt: options.now.toISOString(),
      acceptedRevision: revision,
    });
    expect(store.getRunResult(run.runId).mergedAt).toBeUndefined();
    expect(store.getTask(run.taskId).task.version).toBe(versionBefore + 1);

    // Retrying the same already approved revision is a durable no-op.
    store.markAccepted(run.runId, revision, options.now);
    expect(store.getTask(run.taskId).task.version).toBe(versionBefore + 1);

    store.markMerged(run.runId, 'c'.repeat(40), options.now);
    const merged = store.getRunResult(run.runId);
    expect(merged).toMatchObject({
      mergedAt: options.now.toISOString(),
      mergedRevision: 'c'.repeat(40),
      acceptedRevision: revision,
    });
    store.markMerged(run.runId, 'c'.repeat(40), options.now);
    expect(store.getRunResult(run.runId).mergedAt).toBe(merged.mergedAt);
  });

  it('reopens an approved-but-unmerged result without faking a merge', () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-task-db-'));
    roots.push(root);
    const path = join(root, 'tasks.sqlite');
    const store = new AgentTaskStore(path);
    stores.push(store);
    const run = store.acceptRun(
      {
        task: 'Approve only',
        idempotencyKey: '73737373-7373-4373-8373-737373737373',
      },
      options
    );
    store.storeRunResult(
      run.runId,
      {
        resultRevision: 'b'.repeat(40),
        files: [],
        diff: '',
        diffTruncated: false,
        checkStatus: 'passed',
        checks: [],
      },
      '/tmp/approval-only'
    );
    store.markAccepted(run.runId, 'b'.repeat(40), options.now);
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = new AgentTaskStore(path);
    stores.push(reopened);
    expect(reopened.getRunResult(run.runId)).toMatchObject({
      acceptedAt: options.now.toISOString(),
      acceptedRevision: 'b'.repeat(40),
    });
    expect(reopened.getRunResult(run.runId).mergedAt).toBeUndefined();
    expect(reopened.getRunResult(run.runId).mergedRevision).toBeUndefined();
  });

  it('backfills historical accepted rows when reopening a pre-merge-step database', () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-task-db-'));
    roots.push(root);
    const path = join(root, 'tasks.sqlite');
    const store = new AgentTaskStore(path);
    stores.push(store);
    const run = store.acceptRun(
      {
        task: 'Legacy accepted result',
        idempotencyKey: '74747474-7474-4474-8474-747474747474',
      },
      options
    );
    store.storeRunResult(
      run.runId,
      {
        resultRevision: 'b'.repeat(40),
        files: [],
        diff: '',
        diffTruncated: false,
        checkStatus: 'passed',
        checks: [],
      },
      '/tmp/legacy-accepted'
    );
    store.markAccepted(run.runId, 'b'.repeat(40), options.now);
    store.close();
    stores.splice(stores.indexOf(store), 1);

    // Simulate the pre-merge-step table shape of an existing production DB.
    const legacy = new DatabaseSync(path);
    legacy.exec('DELETE FROM runner_schema_migrations WHERE version=7;');
    legacy.exec('ALTER TABLE agent_run_results DROP COLUMN merged_at;');
    legacy.exec('ALTER TABLE agent_run_results DROP COLUMN merged_revision;');
    legacy.close();

    const reopened = new AgentTaskStore(path);
    stores.push(reopened);
    expect(reopened.getRunResult(run.runId)).toMatchObject({
      acceptedAt: options.now.toISOString(),
      acceptedRevision: 'b'.repeat(40),
      mergedAt: options.now.toISOString(),
      mergedRevision: 'b'.repeat(40),
    });
  });

  it('continues one task from its latest immutable checkpoint', () => {
    const store = createStore();
    const first = store.acceptRun(
      {
        task: 'Create the first version',
        idempotencyKey: '21212121-2121-4121-8121-212121212121',
      },
      options
    );
    const owner = '22222222-2222-4222-8222-222222222222';
    store.markStarting(first, owner, options.now);
    store.updateRunStatus(first.runId, 'running', undefined, options.now, owner);
    store.storeRunResult(
      first.runId,
      {
        resultRevision: 'b'.repeat(40),
        files: ['README.md'],
        diff: 'diff --git a/README.md b/README.md',
        diffTruncated: false,
        checkStatus: 'passed',
        checks: [
          {
            label: 'test',
            argv: ['/usr/bin/npm', 'test'],
            status: 'passed',
            exitCode: 0,
            durationMs: 1,
            output: 'ok',
          },
        ],
      },
      '/tmp/checkpoint'
    );
    store.updateRunStatus(first.runId, 'completed', 'checkpoint', options.now, owner);

    const next = store.acceptContinuation(
      {
        taskId: first.taskId,
        message: 'Add one more detail',
        idempotencyKey: '23232323-2323-4323-8323-232323232323',
      },
      { profileId: options.profileId, maxActiveRuns: 2, now: options.now }
    );
    expect(next.taskId).toBe(first.taskId);
    expect(next.inputRevision).toBe('b'.repeat(40));
    expect(next.sourceWorkspace).toBe('/tmp/checkpoint');
    const detail = store.getTask(first.taskId);
    expect(detail.runs).toHaveLength(2);
    expect(detail.messages.map((message) => message.text)).toEqual([
      'Create the first version',
      'Add one more detail',
    ]);
  });

  it('reopens an accepted task when the user continues its conversation', () => {
    const store = createStore();
    const first = store.acceptRun(
      {
        task: 'Create and accept the first version',
        idempotencyKey: '53535353-5353-4353-8353-535353535353',
      },
      options
    );
    const owner = '54545454-5454-4454-8454-545454545454';
    const revision = 'b'.repeat(40);
    store.markStarting(first, owner, options.now);
    store.updateRunStatus(first.runId, 'running', undefined, options.now, owner);
    store.storeRunResult(
      first.runId,
      {
        resultRevision: revision,
        files: ['README.md'],
        diff: 'accepted checkpoint',
        diffTruncated: false,
        checkStatus: 'passed',
        checks: [],
      },
      '/tmp/accepted-checkpoint'
    );
    store.updateRunStatus(first.runId, 'completed', 'checkpoint', options.now, owner);
    store.markAccepted(first.runId, revision, options.now);
    expect(store.getTask(first.taskId).task.status).toBe('accepted');

    const next = store.acceptContinuation(
      {
        taskId: first.taskId,
        message: 'Add another improvement',
        idempotencyKey: '55555555-5555-4555-8555-555555555555',
      },
      { profileId: options.profileId, maxActiveRuns: 2, now: options.now }
    );

    expect(next.inputRevision).toBe(revision);
    expect(next.sourceWorkspace).toBe('/tmp/accepted-checkpoint');
    expect(store.getTask(first.taskId).task.status).toBe('open');
  });

  it('starts an idempotent continuation on an explicit conflict-resolution base', () => {
    const store = createStore();
    const first = store.acceptRun(
      {
        task: 'Create a result that later conflicts',
        idempotencyKey: '24242424-2424-4424-8424-242424242424',
      },
      options
    );
    const owner = '25252525-2525-4525-8525-252525252525';
    store.markStarting(first, owner, options.now);
    store.updateRunStatus(first.runId, 'running', undefined, options.now, owner);
    store.updateRunStatus(first.runId, 'completed', 'checkpoint', options.now, owner);
    const expectedTaskVersion = store.getTask(first.taskId).task.version;
    const input = {
      taskId: first.taskId,
      message: 'Resolve the prepared merge conflicts',
      idempotencyKey: '26262626-2626-4626-8626-262626262626',
    };
    const resolutionOptions = {
      profileId: options.profileId,
      maxActiveRuns: 2,
      now: options.now,
      expectedTaskVersion,
      workspace: { baseRevision: 'c'.repeat(40), inputRevision: 'c'.repeat(40) },
    };

    const resolution = store.acceptContinuation(input, resolutionOptions);
    const retry = store.acceptContinuation(input, resolutionOptions);

    expect(resolution).toMatchObject({
      baseRevision: 'c'.repeat(40),
      inputRevision: 'c'.repeat(40),
      created: true,
    });
    expect(resolution.sourceWorkspace).toBeUndefined();
    expect(retry).toEqual({ ...resolution, created: false });
    expect(
      store.getTask(first.taskId).runs.find((run) => run.id === resolution.runId)?.baseRevision
    ).toBe('c'.repeat(40));
  });

  it('binds a structured review to one result and turns selected findings into a correction', () => {
    const store = createStore();
    const first = store.acceptRun(
      {
        task: 'Implement the formatter',
        idempotencyKey: '34343434-3434-4434-8434-343434343434',
      },
      options
    );
    const owner = '35353535-3535-4535-8535-353535353535';
    store.markStarting(first, owner, options.now);
    store.updateRunStatus(first.runId, 'running', undefined, options.now, owner);
    store.storeRunResult(
      first.runId,
      {
        resultRevision: 'b'.repeat(40),
        files: ['src/format.ts'],
        diff: 'diff --git a/src/format.ts b/src/format.ts',
        diffTruncated: false,
        checkStatus: 'passed',
        checks: [],
      },
      '/tmp/review-source'
    );
    store.updateRunStatus(first.runId, 'completed', 'checkpoint', options.now, owner);

    const review = store.acceptReview(
      {
        taskId: first.taskId,
        sourceRunId: first.runId,
        resultRevision: 'b'.repeat(40),
        instructions: 'Focus on edge cases.',
        idempotencyKey: '36363636-3636-4636-8636-363636363636',
      },
      { profileId: options.profileId, maxActiveRuns: 2, now: options.now }
    );
    expect(review.inputRevision).toBe('b'.repeat(40));
    expect(review.sourceWorkspace).toBe('/tmp/review-source');
    store.markStarting(review, owner, options.now);
    store.updateRunStatus(review.runId, 'running', undefined, options.now, owner);
    store.storeReviewSubmission(
      review.reviewId,
      {
        summary: 'One edge case is missing.',
        findings: [
          {
            severity: 'high',
            title: 'Overflow is not handled',
            file: 'src/format.ts',
            line: 12,
            reasoning: 'Large values produce an invalid duration.',
            evidence: 'The arithmetic loses precision.',
          },
        ],
      },
      options.now
    );
    store.updateRunStatus(review.runId, 'completed', 'review complete', options.now, owner);

    const persisted = store.getTask(first.taskId);
    expect(persisted.runs).toHaveLength(1);
    expect(persisted.reviews[0]).toMatchObject({
      id: review.reviewId,
      resultRevision: 'b'.repeat(40),
      status: 'completed',
      stale: false,
      findings: [expect.objectContaining({ title: 'Overflow is not handled' })],
    });
    const findingId = persisted.reviews[0]!.findings[0]!.id;
    const correctionMessage = store.prepareCorrection({
      taskId: first.taskId,
      reviewId: review.reviewId,
      findingIds: [findingId],
      idempotencyKey: '37373737-3737-4737-8737-373737373737',
    });
    expect(correctionMessage).toContain('Overflow is not handled');
    const correction = store.acceptContinuation(
      {
        taskId: first.taskId,
        message: correctionMessage,
        idempotencyKey: '37373737-3737-4737-8737-373737373737',
      },
      { profileId: options.profileId, maxActiveRuns: 2, now: options.now }
    );
    store.markStarting(correction, owner, options.now);
    store.updateRunStatus(correction.runId, 'running', undefined, options.now, owner);
    store.storeRunResult(
      correction.runId,
      {
        resultRevision: 'c'.repeat(40),
        files: ['src/format.ts'],
        diff: 'fixed',
        diffTruncated: false,
        checkStatus: 'passed',
        checks: [],
      },
      '/tmp/correction'
    );
    store.updateRunStatus(correction.runId, 'completed', 'fixed', options.now, owner);
    expect(store.getTask(first.taskId).reviews[0]).toMatchObject({ stale: true });
  });

  it('accepts an identical question answer retry even after the task version advanced', () => {
    const store = createStore();
    const accepted = store.acceptRun(
      {
        task: 'Ask before deciding',
        idempotencyKey: '24242424-2424-4424-8424-242424242424',
      },
      options
    );
    const owner = '25252525-2525-4525-8525-252525252525';
    store.markStarting(accepted, owner, options.now);
    store.updateRunStatus(accepted.runId, 'running', undefined, options.now, owner);
    store.storeQuestion(accepted.taskId, accepted.runId, 'Hours or days?', options.now);
    store.updateRunStatus(accepted.runId, 'yielded', 'Waiting for answer.', options.now, owner);
    const question = store.getTask(accepted.taskId).openQuestion!;
    const expectedVersion = store.getTask(accepted.taskId).task.version;

    store.answerQuestion(
      accepted.taskId,
      question.id,
      'Use days.',
      expectedVersion,
      '26262626-2626-4626-8626-262626262626',
      options.now
    );
    expect(() =>
      store.answerQuestion(
        accepted.taskId,
        question.id,
        'Use days.',
        expectedVersion,
        '27272727-2727-4727-8727-272727272727',
        options.now
      )
    ).not.toThrow();
    expect(() =>
      store.answerQuestion(
        accepted.taskId,
        question.id,
        'Use hours.',
        expectedVersion,
        '28282828-2828-4828-8828-282828282828',
        options.now
      )
    ).toThrow(/already answered differently/);
  });

  it('allows two bounded parallel runs and rejects a third atomically', () => {
    const store = createStore();
    const parallelOptions = { ...options, maxActiveRuns: 2 };
    const first = store.acceptRun(
      { task: 'First', idempotencyKey: '17171717-1717-4717-8717-171717171717' },
      parallelOptions
    );
    const second = store.acceptRun(
      { task: 'Second', idempotencyKey: '18181818-1818-4818-8818-181818181818' },
      parallelOptions
    );
    expect(first.runId).not.toBe(second.runId);
    expect(store.listTasks().activeTaskIds).toHaveLength(2);
    expect(() =>
      store.acceptRun(
        { task: 'Third', idempotencyKey: '19191919-1919-4919-8919-191919191919' },
        parallelOptions
      )
    ).toThrowError(/parallel agent limit/);
  });

  it('persists version-bound steering and cancellation without duplicate delivery', () => {
    const store = createStore();
    const accepted = store.acceptRun(
      { task: 'Long run', idempotencyKey: '20202020-2020-4020-8020-202020202020' },
      options
    );
    const owner = '21212121-2121-4121-8121-212121212121';
    store.markStarting(accepted, owner, options.now);
    const steeringInput = {
      runId: accepted.runId,
      expectedRunVersion: 2,
      expectedTaskVersion: 1,
      message: 'Inspect only the named file.',
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
    };
    const steering = store.acceptSteering(steeringInput, options.now);
    expect(store.acceptSteering(steeringInput, options.now)).toMatchObject({
      id: steering.id,
      created: false,
    });
    store.markSteeringStatus(steering.id, 'sent', undefined, options.now);
    store.markSteeringStatus(steering.id, 'acknowledged', undefined, options.now);
    store.confirmSteering(steering.id, options.now);
    store.confirmSteering(steering.id, new Date(options.now.getTime() + 60_000));
    expect(store.getTask(accepted.taskId).steering[0]?.confirmedAt).toBe(options.now.toISOString());

    const cancellation = store.acceptCancellation(
      {
        runId: accepted.runId,
        expectedRunVersion: steering.runVersion,
        expectedTaskVersion: steering.taskVersion,
        idempotencyKey: '23232323-2323-4323-8323-232323232323',
      },
      options.now
    );
    store.markCancellation(cancellation.id, 'stopping', undefined, options.now);
    store.updateRunStatus(accepted.runId, 'cancelled', 'Run stopped.', options.now, owner);
    store.markCancellation(cancellation.id, 'completed', 'Run stopped.', options.now);

    const detail = store.getTask(accepted.taskId);
    expect(detail.steering).toEqual([
      expect.objectContaining({
        id: steering.id,
        status: 'acknowledged',
        sentAt: options.now.toISOString(),
        acknowledgedAt: options.now.toISOString(),
        confirmedAt: options.now.toISOString(),
      }),
    ]);
    expect(detail.cancellations).toEqual([
      expect.objectContaining({ id: cancellation.id, status: 'completed' }),
    ]);
    expect(detail.runs[0]?.status).toBe('cancelled');
    expect(detail.latestSnapshot?.status).toBe('cancelled');
  });

  it('stores and reconstructs the complete normalized reasoning and tool trace', () => {
    const store = createStore();
    const accepted = store.acceptRun(
      {
        task: 'Inspect one file',
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
      },
      options
    );
    store.markStarting(accepted, '33333333-3333-4333-8333-333333333333', options.now);
    const snapshot = AgentRunSnapshotSchema.parse({
      service: SERVICE_NAME,
      enabled: true,
      status: 'starting',
      sequence: 1,
      runId: accepted.runId,
      name: 'Inspect one file',
      task: 'Inspect one file',
      provider: 'b70-vllm',
      model: 'Qwen3.8-27B',
      thinkingLevel: 'medium',
      startedAt: '2026-09-13T12:00:00.000Z',
      pendingSteering: 0,
      timeline: [],
    });
    const reset = AgentStreamEventSchema.parse({
      operation: 'reset',
      sequence: 1,
      snapshot,
    });
    const reasoning = AgentStreamEventSchema.parse({
      operation: 'append',
      sequence: 2,
      item: {
        id: '44444444-4444-4444-8444-444444444444',
        at: '2026-09-13T12:00:01.000Z',
        kind: 'thinking',
        title: 'Reasoning',
        text: 'Need to inspect the component.',
        state: 'complete',
      },
    });
    const tool = AgentStreamEventSchema.parse({
      operation: 'append',
      sequence: 3,
      item: {
        id: '55555555-5555-4555-8555-555555555555',
        at: '2026-09-13T12:00:02.000Z',
        kind: 'tool',
        title: 'read',
        argumentsText: '{"path":"src/App.vue"}',
        outputText: '<template>…</template>',
        state: 'complete',
      },
    });
    for (const event of [reset, reasoning, tool]) {
      store.recordTrace(accepted.runId, event, '33333333-3333-4333-8333-333333333333');
    }
    const { timeline: _timeline, ...runState } = snapshot;
    void _timeline;
    const staleOwnerEvent = AgentStreamEventSchema.parse({
      operation: 'state',
      sequence: 4,
      state: { ...runState, sequence: 4, status: 'running' },
    });
    expect(() =>
      store.recordTrace(accepted.runId, staleOwnerEvent, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    ).toThrowError(/ownership lease/);

    const detail = store.getTask(accepted.taskId);
    expect(detail.traceEventCount).toBe(3);
    expect(detail.latestSnapshot?.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'thinking', text: 'Need to inspect the component.' }),
        expect.objectContaining({
          kind: 'tool',
          argumentsText: '{"path":"src/App.vue"}',
          outputText: '<template>…</template>',
        }),
      ])
    );
    expect(
      store.database
        .prepare('SELECT latest_snapshot_sequence FROM agent_runs WHERE id=?')
        .get(accepted.runId)
    ).toEqual({ latest_snapshot_sequence: 1 });
    const firstPage = store.getRunTrace(accepted.runId, -1, 2);
    expect(firstPage.items.map((item) => item.event.operation)).toEqual(['reset', 'append']);
    expect(firstPage.hasMore).toBe(true);
    const finalPage = store.getRunTrace(accepted.runId, firstPage.nextAfterSequence, 2);
    expect(finalPage.items).toEqual([
      expect.objectContaining({
        sequence: 3,
        event: expect.objectContaining({
          operation: 'append',
          item: expect.objectContaining({
            kind: 'tool',
            argumentsText: '{"path":"src/App.vue"}',
            outputText: '<template>…</template>',
          }),
        }),
      }),
    ]);
    expect(finalPage.hasMore).toBe(false);
  });

  it('materializes an old trace once and reuses its durable snapshot checkpoint', () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-task-snapshot-'));
    roots.push(root);
    const path = join(root, 'tasks.sqlite');
    const first = new AgentTaskStore(path);
    stores.push(first);
    const accepted = first.acceptRun(
      {
        task: 'Legacy trace',
        idempotencyKey: '45454545-4545-4545-8545-454545454545',
      },
      options
    );
    const owner = '46464646-4646-4646-8646-464646464646';
    first.markStarting(accepted, owner, options.now);
    first.recordTrace(
      accepted.runId,
      AgentStreamEventSchema.parse({
        operation: 'reset',
        sequence: 1,
        snapshot: {
          service: SERVICE_NAME,
          enabled: true,
          status: 'running',
          sequence: 1,
          runId: accepted.runId,
          pendingSteering: 0,
          timeline: [],
        },
      }),
      owner
    );
    first.database
      .prepare(
        'UPDATE agent_runs SET latest_snapshot_json=NULL,latest_snapshot_sequence=NULL WHERE id=?'
      )
      .run(accepted.runId);
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const materializer = new AgentTaskStore(path);
    stores.push(materializer);
    expect(materializer.getTask(accepted.taskId).latestSnapshot?.sequence).toBe(1);
    materializer.close();
    stores.splice(stores.indexOf(materializer), 1);

    const raw = new DatabaseSync(path);
    raw
      .prepare("UPDATE agent_trace_events SET payload_json='not-json' WHERE run_id=?")
      .run(accepted.runId);
    raw.close();
    const reopened = new AgentTaskStore(path);
    stores.push(reopened);
    expect(reopened.getTask(accepted.taskId).latestSnapshot?.sequence).toBe(1);
  });

  it('marks ambiguous active work interrupted on recovery and never redispatches it', () => {
    const store = createStore();
    const accepted = store.acceptRun(
      {
        task: 'Crash fixture',
        idempotencyKey: '66666666-6666-4666-8666-666666666666',
      },
      options
    );
    store.markStarting(accepted, '77777777-7777-4777-8777-777777777777', options.now);
    const reset = AgentStreamEventSchema.parse({
      operation: 'reset',
      sequence: 1,
      snapshot: {
        service: SERVICE_NAME,
        enabled: true,
        status: 'running',
        sequence: 1,
        runId: accepted.runId,
        name: 'Crash fixture',
        task: 'Crash fixture',
        startedAt: options.now.toISOString(),
        pendingSteering: 0,
        timeline: [],
      },
    });
    const runningTool = AgentStreamEventSchema.parse({
      operation: 'append',
      sequence: 2,
      item: {
        id: '88888888-8888-4888-8888-888888888888',
        at: '2026-09-13T12:00:01.000Z',
        kind: 'tool',
        title: 'bash · sleep 60',
        argumentsText: '{"command":"sleep 60"}',
        state: 'running',
      },
    });
    for (const event of [reset, runningTool]) {
      store.recordTrace(accepted.runId, event, '77777777-7777-4777-8777-777777777777');
    }

    expect(store.recoverInterrupted(new Date('2026-09-13T12:01:00.000Z'))).toEqual([
      accepted.sandboxRunId,
    ]);
    const recovered = store.getTask(accepted.taskId);
    expect(recovered.runs[0]?.status).toBe('interrupted');
    expect(recovered.latestSnapshot).toMatchObject({
      status: 'failed',
      timeline: [expect.objectContaining({ kind: 'tool', state: 'error' })],
    });
    expect(store.listTasks().activeTaskId).toBeUndefined();
  });

  it('reclaims only interrupted Durable runs and transfers their owner', () => {
    const store = createStore();
    const accepted = store.acceptRun(
      { task: 'Persistent work' },
      { ...options, profileId: 'durable-v1' }
    );
    const owner = '21212121-2121-4121-8121-212121212121';
    store.markStarting(accepted, owner, options.now);
    expect(store.requeueDurableRun(accepted.runId)).toBe(false);
    store.recoverInterrupted(options.now);
    expect(store.requeueDurableRun(accepted.runId)).toBe(true);
    expect(store.requeueDurableRun(accepted.runId)).toBe(false);
    store.markStarting(accepted, '31313131-3131-4131-8131-313131313131', options.now);
    expect(store.getTask(accepted.taskId).task.latestRun.status).toBe('starting');
    store.recoverInterrupted(options.now);
    const legacy = store.acceptRun({ task: 'Legacy work' }, options);
    store.recoverInterrupted(options.now);
    expect(store.requeueDurableRun(legacy.runId)).toBe(false);
  });

  it('does not acknowledge a trace event when SQLite becomes read-only', () => {
    const store = createStore();
    const accepted = store.acceptRun(
      {
        task: 'Read-only fixture',
        idempotencyKey: '12121212-1212-4212-8212-121212121212',
      },
      options
    );
    store.markStarting(accepted, '13131313-1313-4313-8313-131313131313', options.now);
    store.database.exec('PRAGMA query_only=ON;');
    const event = AgentStreamEventSchema.parse({
      operation: 'reset',
      sequence: 1,
      snapshot: {
        service: SERVICE_NAME,
        enabled: true,
        status: 'starting',
        sequence: 1,
        runId: accepted.runId,
        pendingSteering: 0,
        timeline: [],
      },
    });
    expect(() =>
      store.recordTrace(accepted.runId, event, '13131313-1313-4313-8313-131313131313')
    ).toThrowError(TaskStoreError);
    expect(store.traceRows(accepted.runId)).toEqual([]);
  });

  it('does not acknowledge a trace event when SQLite reaches its page limit', () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-task-full-'));
    roots.push(root);
    const store = new AgentTaskStore(join(root, 'tasks.sqlite'));
    stores.push(store);
    const accepted = store.acceptRun(
      {
        task: 'Full database fixture',
        idempotencyKey: '14141414-1414-4414-8414-141414141414',
      },
      options
    );
    const owner = '15151515-1515-4515-8515-151515151515';
    store.markStarting(accepted, owner, options.now);
    const { page_count: pageCount } = store.database.prepare('PRAGMA page_count').get() as {
      page_count: number;
    };
    store.database.exec(`PRAGMA max_page_count=${pageCount}`);
    const event = AgentStreamEventSchema.parse({
      operation: 'append',
      sequence: 1,
      item: {
        id: '16161616-1616-4616-8616-161616161616',
        at: options.now.toISOString(),
        kind: 'tool',
        title: 'large tool result',
        outputText: 'x'.repeat(250_000),
        state: 'complete',
      },
    });

    expect(() => store.recordTrace(accepted.runId, event, owner)).toThrowError(
      /could not be stored durably/
    );
    expect(store.traceRows(accepted.runId)).toEqual([]);
  });

  it('rejects a corrupt database without replacing its bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-task-corrupt-'));
    roots.push(root);
    const path = join(root, 'tasks.sqlite');
    const corrupt = Buffer.from('not-a-sqlite-database\0keep-this-evidence');
    writeFileSync(path, corrupt, { mode: 0o600 });

    expect(() => new AgentTaskStore(path)).toThrow();
    expect(readFileSync(path)).toEqual(corrupt);
  });

  it('deletes exactly one task and cascades its private trace', () => {
    const store = createStore();
    const accepted = store.acceptRun(
      {
        task: 'Delete fixture',
        idempotencyKey: '88888888-8888-4888-8888-888888888888',
      },
      options
    );
    expect(store.deleteTask(accepted.taskId)).toBe(true);
    expect(store.listTasks(true).items).toHaveLength(0);
    expect(store.traceRows(accepted.runId)).toHaveLength(0);
  });
});

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

/** Encodes a small real RGB PNG for persistence/quota fixtures. */
function pngBuffer(width: number, height: number): Buffer {
  const chunks: Buffer[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const push = (type: string, data: Buffer): void => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const payload = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    let checksum = 0xffffffff;
    for (const byte of payload) {
      checksum ^= byte;
      for (let bit = 0; bit < 8; bit += 1)
        checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
    }
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE((checksum ^ 0xffffffff) >>> 0);
    chunks.push(length, payload, crc);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  push('IHDR', ihdr);
  push('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height)));
  push('IEND', Buffer.alloc(0));
  return Buffer.concat(chunks);
}

function acceptRunFor(store: AgentTaskStore): string {
  const accepted = store.acceptRun(
    {
      task: 'Image fixture',
      idempotencyKey: '32323232-3232-4232-8232-323232323232',
    },
    options
  );
  return accepted.runId;
}

describe('durable agent images', () => {
  it('stores a validated PNG, deduplicates by content hash and returns strict metadata', () => {
    const store = createStore();
    const runId = acceptRunFor(store);
    const first = store.storeImage(runId, {
      mimeType: 'image/png',
      data: PNG_1X1,
      label: 'Vorschau',
    });
    expect(first).toMatchObject({
      runId,
      mimeType: 'image/png',
      width: 1,
      height: 1,
      label: 'Vorschau',
    });
    expect(first.byteLength).toBe(PNG_1X1.length);

    const second = store.storeImage(runId, {
      mimeType: 'image/png',
      data: PNG_1X1,
      label: 'Anders',
    });
    expect(second.id).toBe(first.id);

    expect(
      (
        store.database
          .prepare('SELECT COUNT(*) AS count FROM agent_images WHERE run_id=?')
          .get(runId) as { count: number }
      ).count
    ).toBe(1);

    const payload = store.getRunImage(runId, first.id);
    expect(payload.data.equals(PNG_1X1)).toBe(true);
    expect(payload.byteLength).toBe(PNG_1X1.length);
  });

  it('rejects malformed, foreign-format and oversized images with an honest error', () => {
    const store = createStore();
    const runId = acceptRunFor(store);
    expect(() =>
      store.storeImage(runId, { mimeType: 'image/png', data: Buffer.from('not a png') })
    ).toThrowError(/rejected/i);
    expect(() =>
      store.storeImage(runId, {
        mimeType: 'image/svg+xml',
        data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      })
    ).toThrowError(/not supported/);
    expect(() =>
      store.storeImage(runId, { mimeType: 'image/png', data: Buffer.alloc(2 * 1024 * 1024 + 1) })
    ).toThrowError(/limit/);
    expect(
      (
        store.database.prepare('SELECT COUNT(*) AS count FROM agent_images').get() as {
          count: number;
        }
      ).count
    ).toBe(0);
  });

  it('stores more than 64 distinct images while enforcing run binding', () => {
    const store = createStore();
    const runId = acceptRunFor(store);
    const otherRun = acceptRunForOther(store);
    for (let index = 1; index <= 150; index++) {
      const image = store.storeImage(runId, { mimeType: 'image/png', data: pngBuffer(index, 1) });
      expect(() => store.getRunImage(otherRun, image.id)).toThrowError(TaskStoreError);
    }
    expect(store.database.prepare('SELECT COUNT(*) AS count FROM agent_images').get()).toEqual({
      count: 150,
    });
  });

  it('shares one byte budget between trace and images, preserving deduplication and terminal reserve', () => {
    const store = createStore(1024 * 1024);
    const runId = acceptRunFor(store);
    const inserted = store.storeImage(runId, { mimeType: 'image/png', data: PNG_1X1 });
    const owner = '46464646-4646-4646-8646-464646464646';
    store.database
      .prepare(
        "UPDATE agent_runs SET status='running',owner_generation=?,trace_payload_bytes=? WHERE id=?"
      )
      .run(owner, 1024 * 1024 - 64 * 1024 - PNG_1X1.length - 1, runId);
    expect(store.storeImage(runId, { mimeType: 'image/png', data: PNG_1X1 }).id).toBe(inserted.id);
    expect(() =>
      store.storeImage(runId, { mimeType: 'image/png', data: pngBuffer(2, 1) })
    ).toThrowError(/Speicherbudget.*1 MiB Budget/);
    expect(store.database.prepare('SELECT COUNT(*) AS count FROM agent_images').get()).toEqual({
      count: 1,
    });
    const item = {
      id: '46464646-4646-4646-8646-464646464647',
      at: options.now.toISOString(),
      kind: 'notice' as const,
      title: 'Budget',
      text: 'Storage limit',
      state: 'complete' as const,
    };
    expect(() =>
      store.recordTrace(
        runId,
        AgentStreamEventSchema.parse({ runId, sequence: 1, operation: 'append', item }),
        owner
      )
    ).toThrowError(/Speicherbudget/);
    store.recordTrace(
      runId,
      AgentStreamEventSchema.parse({
        runId,
        sequence: 1,
        operation: 'append',
        item: { ...item, state: 'error' },
      }),
      owner
    );
    store.recordTrace(
      runId,
      AgentStreamEventSchema.parse({
        runId,
        sequence: 2,
        operation: 'state',
        state: {
          service: SERVICE_NAME,
          enabled: true,
          sequence: 2,
          runId,
          status: 'failed',
          pendingSteering: 0,
          reason: 'Storage limit',
          finishedAt: options.now.toISOString(),
        },
      }),
      owner
    );
    expect(store.traceRows(runId)).toHaveLength(2);
    expect(store.getRunImage(runId, inserted.id).data).toEqual(PNG_1X1);
  });

  it('deletes run images with the task (cascade) and survives a reload', () => {
    const store = createStore();
    const runId = acceptRunFor(store);
    const taskId = taskIdFor(store, runId);
    store.storeImage(runId, { mimeType: 'image/png', data: PNG_1X1 });
    store.storeImage(runId, { mimeType: 'image/png', data: pngBuffer(2, 1) });
    expect(
      (
        store.database
          .prepare('SELECT COUNT(*) AS count FROM agent_images WHERE run_id=?')
          .get(runId) as {
          count: number;
        }
      ).count
    ).toBe(2);
    expect(store.deleteTask(taskId)).toBe(true);
    expect(
      (
        store.database.prepare('SELECT COUNT(*) AS count FROM agent_images').get() as {
          count: number;
        }
      ).count
    ).toBe(0);
  });
});

function acceptRunForOther(store: AgentTaskStore): string {
  const accepted = store.acceptRun(
    {
      task: 'Other run',
      idempotencyKey: '33333333-3333-4333-8333-333333333333',
    },
    { ...options, maxActiveRuns: 4 }
  );
  return accepted.runId;
}

function taskIdFor(store: AgentTaskStore, runId: string): string {
  const row = store.database.prepare('SELECT task_id FROM agent_runs WHERE id=?').get(runId) as {
    task_id: string;
  };
  return row.task_id;
}

describe('durable user references', () => {
  it('keeps the latest reference set separate from tool images and other tasks', () => {
    const store = createStore();
    const first = store.acceptRun({ task: 'References' }, options);
    const reference = store.storeInputImage(first.runId, 0, {
      mimeType: 'image/png',
      data: PNG_1X1,
      label: 'Original',
    });
    store.storeImage(first.runId, {
      mimeType: 'image/png',
      data: pngBuffer(2, 2),
      label: 'Screenshot',
    });
    expect(store.getTaskInputImages(first.taskId)).toMatchObject([
      { id: reference.id, data: PNG_1X1 },
    ]);
    const other = store.acceptRun({ task: 'Other task' }, { ...options, maxActiveRuns: 4 });
    expect(store.getTaskInputImages(other.taskId)).toEqual([]);
    store.updateRunStatus(first.runId, 'failed', 'fixture');
    const next = store.acceptContinuation(
      {
        taskId: first.taskId,
        message: 'Continue',
        idempotencyKey: '37373737-3737-4737-8737-373737373737',
      },
      { ...options, maxActiveRuns: 4 }
    );
    expect(store.getTaskInputImages(first.taskId)[0]?.runId).toBe(first.runId);
    expect(
      store.storeConversationImage(next.runId, { mimeType: 'image/png', data: PNG_1X1 }).id
    ).toBe(reference.id);
    expect(
      store.storeConversationImage(other.runId, { mimeType: 'image/png', data: PNG_1X1 }).id
    ).not.toBe(reference.id);
    store.storeInputImage(next.runId, 0, {
      mimeType: 'image/png',
      data: pngBuffer(3, 3),
      label: 'Replacement',
    });
    expect(store.getTaskInputImages(first.taskId)).toMatchObject([
      { runId: next.runId, label: 'Replacement' },
    ]);
  });
  it('binds new-task and continuation retries to the exact image content', () => {
    const store = createStore();
    const images = [
      { mimeType: 'image/png' as const, data: PNG_1X1.toString('base64'), label: 'Ref' },
    ];
    const input = {
      task: 'Reference',
      images,
      idempotencyKey: '38383838-3838-4838-8838-383838383838',
    };
    const first = store.acceptRun(input, options);
    expect(store.acceptRun(input, options).created).toBe(false);
    expect(() =>
      store.acceptRun({ ...input, images: [{ ...images[0]!, label: 'Changed' }] }, options)
    ).toThrow('different task content');
    store.updateRunStatus(first.runId, 'failed', 'fixture');
    const continuation = {
      taskId: first.taskId,
      message: 'Continue',
      images,
      idempotencyKey: '39393939-3939-4939-8939-393939393939',
    };
    store.acceptContinuation(continuation, options);
    expect(store.acceptContinuation(continuation, options).created).toBe(false);
    expect(() =>
      store.acceptContinuation(
        { ...continuation, images: [{ ...images[0]!, data: pngBuffer(2, 2).toString('base64') }] },
        options
      )
    ).toThrow('different content');
  });
});
