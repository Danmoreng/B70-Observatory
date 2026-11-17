import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunSnapshot } from '@observatory/contracts';
import { IsolatedAgentService } from '../../src/runner/service.js';
import { AgentTaskStore, type AcceptedRun } from '../../src/runner/task-store.js';
import { loadRunnerConfig } from '../../src/runner/config.js';
import { taskCreationTools } from '../../src/runner/task-tools.js';

const roots: string[] = [];
const services: IsolatedAgentService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(images = false) {
  vi.setSystemTime(new Date('2026-11-12T14:00:00Z'));
  const root = mkdtempSync(join(tmpdir(), 'b70-queue-service-'));
  roots.push(root);
  const repository = join(root, 'repo');
  const stateRoot = join(root, 'runs');
  mkdirSync(repository);
  mkdirSync(stateRoot);
  execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', repository]);
  writeFileSync(join(repository, 'README.md'), 'Fixture\n');
  execFileSync('/usr/bin/git', ['-C', repository, 'add', '.']);
  execFileSync('/usr/bin/git', [
    '-C',
    repository,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@invalid',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-qm',
    'fixture',
  ]);
  const config = loadRunnerConfig({
    B70_RUNNER_CONTROL_TOKEN: 'a'.repeat(64),
    ...(images
      ? { B70_RUNNER_IMAGE_GENERATION_ENABLED: '1', B70_RUNNER_GATEWAY_TOKEN: 'test-gateway-token' }
      : {}),
    B70_RUNNER_REPOSITORY: repository,
    B70_RUNNER_STATE_ROOT: stateRoot,
    B70_RUNNER_SUPPORT_ROOT: root,
    B70_RUNNER_AGENT_RUNTIME_ROOT: root,
    B70_RUNNER_PROFILE_ROOT: root,
    B70_RUNNER_DEPENDENCY_ROOT: root,
    B70_RUNNER_REVISION: 'a'.repeat(40),
    B70_RUNNER_MAX_ACTIVE_RUNS: '2',
    B70_RUNNER_ENGINE: 'pi-durable',
  });
  const store = new AgentTaskStore(join(root, 'tasks.sqlite'));
  const project = store.registerProject({
    name: 'Fixture',
    repositoryPath: repository,
    targetBranch: 'main',
    workdir: '.',
    editPaths: ['.'],
    checks: [],
  });
  const relay = { register() {}, revoke() {}, async start() {}, async close() {} };
  const service = new IsolatedAgentService(config, relay, store);
  services.push(service);
  const health = vi.fn(async () => new Response('', { status: 503 }));
  vi.stubGlobal('fetch', health);
  return { root, config, store, project, service, health, relay };
}
// Model/tool execution is the boundary under test: stand in for the sandbox, keep real admission/storage/dispatch.
function captureLaunch(service: IsolatedAgentService, store: AgentTaskStore) {
  const launch = vi.spyOn(
    service as unknown as { launchAccepted: (run: AcceptedRun) => Promise<AgentRunSnapshot> },
    'launchAccepted'
  );
  launch.mockImplementation(async (accepted) => {
    store.database
      .prepare(
        "UPDATE agent_runs SET status='running' WHERE id=? AND status IN ('queued','starting')"
      )
      .run(accepted.runId);
    return store.snapshotForRun(accepted.runId);
  });
  return launch;
}
describe('task queue service', () => {
  it('acknowledges storage immediately without model or workspace work while the engine is unavailable', async () => {
    const { root, store, service, health } = fixture();
    const launch = captureLaunch(service, store);
    const key = randomUUID();
    const snapshot = await service.start({
      name: 'First',
      task: 'First task',
      idempotencyKey: key,
    });
    expect(snapshot.status).toBe('queued');
    expect(snapshot.activeRuns).toBe(0);
    expect(
      (await service.start({ name: 'First', task: 'First task', idempotencyKey: key })).runId
    ).toBe(snapshot.runId);
    await service.resumeDurableWork();
    expect(health).toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(store.occupiedRunCount()).toBe(0);
    expect(store.listTasks().items).toHaveLength(1);
    expect(readdirSync(join(root, 'runs'))).toEqual([]);
  });

  it('serializes competing dispatcher wakes, claims two FIFO, and fills a free slot without losing the backlog', async () => {
    const { store, service, health } = fixture();
    const launch = captureLaunch(service, store);
    const snapshots = [];
    for (let i = 0; i < 5; i++)
      snapshots.push(await service.start({ name: `Task ${i}`, task: `Task ${i}` }));
    health.mockImplementation(async () => new Response('ok'));
    await Promise.all([
      service.resumeDurableWork(),
      service.resumeDurableWork(),
      service.resumeDurableWork(),
    ]);
    expect(launch.mock.calls.map((call) => call[0].runId)).toEqual(
      snapshots.slice(0, 2).map((snapshot) => snapshot.runId)
    );
    expect(store.occupiedRunCount()).toBe(2);
    store.database
      .prepare("UPDATE agent_runs SET status='completed' WHERE id=?")
      .run(snapshots[0]!.runId!);
    await service.resumeDurableWork();
    expect(launch.mock.calls.map((call) => call[0].runId)).toEqual(
      snapshots.slice(0, 3).map((snapshot) => snapshot.runId)
    );
    expect(store.occupiedRunCount()).toBe(2);
  });

  it('cancels a queued request through the public service without a manager or sandbox', async () => {
    const { store, service, health } = fixture();
    const launch = captureLaunch(service, store);
    const snapshot = await service.start({ name: 'Cancel', task: 'Cancel' });
    const summary = store.listTasks().items[0]!;
    const request = {
      runId: snapshot.runId!,
      expectedRunVersion: summary.latestRun.version,
      expectedTaskVersion: summary.version,
      idempotencyKey: randomUUID(),
    };
    expect((await service.cancel(request)).status).toBe('cancelled');
    expect((await service.cancel(request)).status).toBe('cancelled');
    health.mockImplementation(async () => new Response('ok'));
    await service.resumeDurableWork();
    expect(launch).not.toHaveBeenCalled();
  });

  it('stores work after 22:45 but starts no work before the next working day', async () => {
    const { service, store, health } = fixture();
    const launch = captureLaunch(service, store);
    health.mockImplementation(async () => new Response('ok'));
    vi.setSystemTime(new Date('2026-11-12T21:46:00Z'));
    expect((await service.start({ name: 'Tomorrow', task: 'Tomorrow' })).status).toBe('queued');
    await service.resumeDurableWork();
    expect(health).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2026-11-13T08:00:00Z'));
    await service.resumeDurableWork();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(store.occupiedRunCount()).toBe(1);
  });

  it('recovers a claim interrupted before active.json was written and preserves the remaining queue on restart', async () => {
    const { root, config, service, store, relay } = fixture();
    const first = await service.start({ name: 'Interrupted claim', task: 'Keep me' });
    const second = await service.start({ name: 'Still waiting', task: 'Keep me too' });
    store.claimNextQueuedRun(2, 'old-owner');
    store.recoverInterrupted();
    await service.close();
    services.splice(services.indexOf(service), 1);
    const reopened = new AgentTaskStore(join(root, 'tasks.sqlite'));
    const next = new IsolatedAgentService(config, relay, reopened);
    services.push(next);
    const launch = captureLaunch(next, reopened);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok'))
    );
    await next.resumeDurableWork();
    expect(launch.mock.calls.map((call) => call[0].runId)).toEqual([first.runId, second.runId]);
    expect(reopened.occupiedRunCount()).toBe(2);
  });

  it('does not automatically resume an explicitly paused saved conversation', async () => {
    const { root, config, service, store, relay } = fixture();
    const first = await service.start({ name: 'Manually paused', task: 'Stay paused' });
    const queued = store.claimNextQueuedRun(2, 'old-owner')!;
    store.recoverInterrupted();
    const directory = join(root, 'durable', queued.accepted.taskId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'active.json'),
      JSON.stringify({
        accepted: queued.accepted,
        input: queued.input,
        projectId: queued.accepted.projectId,
        suspended: 'manual',
      })
    );
    await service.close();
    services.splice(services.indexOf(service), 1);
    const reopened = new AgentTaskStore(join(root, 'tasks.sqlite'));
    const next = new IsolatedAgentService(config, relay, reopened);
    services.push(next);
    const launch = captureLaunch(next, reopened);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok'))
    );
    await next.resumeDurableWork();
    expect(launch).not.toHaveBeenCalled();
    expect(reopened.snapshotForRun(first.runId!).status).toBe('failed');
    expect(reopened.occupiedRunCount()).toBe(0);
  });

  it('gives the agent a project-bound, retry-safe tool which creates distinct durable dashboard tasks', async () => {
    const { service, store, project } = fixture();
    const parent = await service.start({ name: 'Parent', task: 'Create my tasks' });
    const parentId = store.queuedRun(parent.runId!)!.accepted.taskId;
    const tools = taskCreationTools({
      projectId: project.id,
      taskId: parentId,
      create: (request) => service.start(request, parentId),
      taskIdForRun: (runId) => store.queuedRun(runId)!.accepted.taskId,
    });
    const tool = tools[0]!;
    const execute = tool.execute as (
      args: { name: string; task: string },
      api: never,
      context: never
    ) => Promise<unknown>;
    const first = await execute(
      { name: 'One', task: 'Independent work' },
      {} as never,
      {} as never
    );
    const repeated = await execute(
      { name: 'One', task: 'Independent work' },
      {} as never,
      {} as never
    );
    expect(repeated).toEqual(first);
    expect(store.listTasks().items).toHaveLength(2);
    const child = store.listTasks().items.find((task) => task.id !== parentId)!;
    expect(child.projectId).toBe(project.id);
    expect(store.isAgentCreatedTask(child.id)).toBe(true);
    expect(tool.replay).toBe('safe');
  });
});

it('Bildstudio blocks real runner task admission, follow-ups and automatic dispatch; text removes image tools', async () => {
  const { service, project, health } = fixture(true);
  await service.engineMode('studio');
  expect(await service.engineMode()).toMatchObject({
    mode: 'studio',
    agentsAllowed: false,
    imageTools: false,
  });
  await expect(service.start({ task: 'not allowed', projectId: project.id })).rejects.toThrow(
    'disabled'
  );
  await service.resumeDurableWork();
  expect(health).not.toHaveBeenCalled();
  await service.engineMode('hybrid');
  expect(await service.engineMode()).toMatchObject({ mode: 'hybrid', imageTools: true });
  await service.start({ task: 'allowed but queued', projectId: project.id });
  await service.engineMode('text');
  expect(await service.engineMode()).toMatchObject({
    mode: 'text',
    imageTools: false,
    agentsAllowed: true,
  });
});
