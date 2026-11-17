import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { launchWorkspaceUtility } from '@observatory/runner';
import { IsolatedAgentService } from '../../src/runner/service.js';
import { AgentTaskStore } from '../../src/runner/task-store.js';
import type { RunnerConfig } from '../../src/runner/config.js';
import type { InferenceRelay } from '../../src/runner/inference-relay.js';

vi.mock('@observatory/runner', async (original) => ({
  ...(await original<typeof import('@observatory/runner')>()),
  launchWorkspaceUtility: vi.fn(),
}));
const roots: string[] = [];
const stores: AgentTaskStore[] = [];
afterEach(() => {
  vi.mocked(launchWorkspaceUtility).mockReset();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(profileId = 'coding-default-v1') {
  const root = mkdtempSync(join(tmpdir(), 'b70-live-service-'));
  roots.push(root);
  const stateRoot = join(root, 'runs');
  mkdirSync(stateRoot);
  const store = new AgentTaskStore(':memory:');
  stores.push(store);
  const project = store.registerProject({
    name: 'Fixture',
    repositoryPath: join(root, 'repository'),
    targetBranch: 'main',
    workdir: '.',
    editPaths: ['.'],
    checks: [],
  });
  const accepted = store.acceptRun(
    { task: 'Example', idempotencyKey: '81818181-8181-4181-8181-818181818181' },
    {
      projectId: project.id,
      profileId,
      baseRevision: 'a'.repeat(40),
      maxActiveRuns: 2,
    }
  );
  const owner = '82828282-8282-4282-8282-828282828282';
  store.markStarting(accepted, owner);
  store.updateRunStatus(accepted.runId, 'running', undefined, new Date(), owner);
  const service = new IsolatedAgentService(
    {
      repository: project.repositoryPath,
      stateRoot,
      supportRoot: join(root, 'support'),
    } as RunnerConfig,
    {} as InferenceRelay,
    store
  );
  const path = join(stateRoot, accepted.sandboxRunId, 'workspace');
  mkdirSync(path, { recursive: true });
  const runs = (service as unknown as { runs: Map<string, unknown> }).runs;
  runs.set(accepted.runId, { workspace: { path } });
  const bindingPath = join(root, 'durable', accepted.taskId, 'workspace.json');
  const binding = {
    path,
    runId: accepted.sandboxRunId,
    revision: 'a'.repeat(40),
    branch: `agent/${accepted.sandboxRunId}`,
  };
  if (profileId === 'durable-v1') {
    mkdirSync(join(root, 'durable', accepted.taskId), { recursive: true });
    writeFileSync(bindingPath, JSON.stringify(binding));
  }
  return { root, store, service, accepted, owner, path, runs, binding, bindingPath };
}
function helper(duringCapture?: () => void) {
  vi.mocked(launchWorkspaceUtility).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    queueMicrotask(() => {
      duringCapture?.();
      child.stdout.write(
        JSON.stringify({
          ok: true,
          files: [{ path: 'app.ts', status: 'modified' }],
          diff: '+live',
          truncated: false,
        })
      );
      child.emit('exit', 0);
    });
    return { child, unitName: 'fixture.scope' } as unknown as ReturnType<
      typeof launchWorkspaceUtility
    >;
  });
}
describe('run-bound workspace changes service', () => {
  it('binds final image previews to the exact run/revision and rejects paths outside the result before launching', async () => {
    const { store, service, accepted, owner, path } = fixture();
    store.storeRunResult(
      accepted.runId,
      {
        resultRevision: 'b'.repeat(40),
        files: ['hero.png'],
        diff: '',
        diffTruncated: false,
        checkStatus: 'not_run',
        checks: [],
      },
      path
    );
    store.updateRunStatus(accepted.runId, 'completed', 'ready', new Date(), owner);
    await expect(
      service.getTaskChangeImage(accepted.taskId, accepted.runId, '../hero.png')
    ).rejects.toMatchObject({ code: 'protocol' });
    await expect(
      service.getTaskChangeImage(accepted.taskId, accepted.runId, 'secret.png')
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      service.getTaskChangeImage(
        accepted.taskId,
        '33333333-3333-4333-8333-333333333333',
        'hero.png'
      )
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(launchWorkspaceUtility).not.toHaveBeenCalled();
    vi.mocked(launchWorkspaceUtility).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      queueMicrotask(() => {
        child.stdout.write(
          JSON.stringify({
            ok: true,
            dataBase64: 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA',
          })
        );
        child.emit('exit', 0);
      });
      return { child, unitName: 'fixture.scope' } as unknown as ReturnType<
        typeof launchWorkspaceUtility
      >;
    });
    const image = await service.getTaskChangeImage(accepted.taskId, accepted.runId, 'hero.png');
    expect(image).toMatchObject({ mimeType: 'image/webp', width: 1, height: 1 });
    const options = vi.mocked(launchWorkspaceUtility).mock.calls[0]![0];
    expect(options).toMatchObject({
      workspacePath: path,
      readOnly: true,
      limits: { runtimeSeconds: 10, memoryBytes: 512 * 1024 ** 2 },
    });
    expect(JSON.parse(Buffer.from(options.args![0]!, 'base64url').toString())).toMatchObject({
      mode: 'change_image',
      imagePath: 'hero.png',
      imageRevision: 'b'.repeat(40),
    });
  });
  it('discards a live image when its Durable workspace binding changes during capture', async () => {
    const { service, accepted, binding, bindingPath, root } = fixture('durable-v1');
    vi.spyOn(service, 'getTaskChanges').mockResolvedValue({
      taskId: accepted.taskId,
      runId: accepted.runId,
      capturedAt: new Date().toISOString(),
      status: 'live',
      stale: false,
      truncated: false,
      diff: '',
      files: [{ path: 'hero.png', status: 'added' }],
    });
    const replacement = join(root, 'runs', 'replacement');
    mkdirSync(replacement);
    vi.mocked(launchWorkspaceUtility).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      queueMicrotask(() => {
        writeFileSync(bindingPath, JSON.stringify({ ...binding, path: replacement }));
        child.stdout.write(
          JSON.stringify({
            ok: true,
            dataBase64: 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA',
          })
        );
        child.emit('exit', 0);
      });
      return { child, unitName: 'fixture.scope' } as unknown as ReturnType<
        typeof launchWorkspaceUtility
      >;
    });
    await expect(
      service.getTaskChangeImage(accepted.taskId, accepted.runId, 'hero.png')
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('never loads full task/trace/telemetry data and allows immediate manual refresh', async () => {
    const { store, service, accepted } = fixture();
    helper();
    const detail = vi.spyOn(store, 'getTask').mockImplementation(() => {
      throw new Error('Full task must not be loaded');
    });
    const telemetry = vi.spyOn(store, 'getTaskTelemetry').mockImplementation(() => {
      throw new Error('Telemetry must not be loaded');
    });
    expect((await service.getTaskChanges(accepted.taskId)).diff).toBe('+live');
    expect((await service.getTaskChanges(accepted.taskId)).diff).toBe('+live');
    expect(launchWorkspaceUtility).toHaveBeenCalledTimes(1);
    expect((await service.getTaskChanges(accepted.taskId, accepted.runId, true)).diff).toBe(
      '+live'
    );
    expect(launchWorkspaceUtility).toHaveBeenCalledTimes(2);
    expect(detail).not.toHaveBeenCalled();
    expect(telemetry).not.toHaveBeenCalled();
  });

  it('discards a capture if a continuation takes over the same Durable workspace', async () => {
    const { store, service, accepted, owner, runs } = fixture('durable-v1');
    store.updateRunStatus(accepted.runId, 'failed', 'stopped', new Date(), owner);
    runs.delete(accepted.runId);
    helper(() => {
      store.acceptContinuation(
        {
          taskId: accepted.taskId,
          message: 'continue',
          idempotencyKey: '99999999-9999-4999-8999-999999999999',
        },
        { profileId: 'durable-v1', now: new Date(Date.now() + 1000) }
      );
    });
    const result = await service.getTaskChanges(accepted.taskId, accepted.runId);
    expect(launchWorkspaceUtility).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      runId: accepted.runId,
      status: 'unavailable',
      stale: true,
      files: [],
      diff: '',
    });
  });

  it('discards a changed Durable binding even when the selected run is unchanged', async () => {
    const { service, accepted, root, binding, bindingPath } = fixture('durable-v1');
    const replacement = join(root, 'runs', 'replacement');
    mkdirSync(replacement);
    helper(() => {
      writeFileSync(bindingPath, JSON.stringify({ ...binding, path: replacement }));
    });
    const result = await service.getTaskChanges(accepted.taskId, accepted.runId);
    expect(launchWorkspaceUtility).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'unavailable', stale: true, diff: '', files: [] });
  });
  it('runs the trusted short utility with a read-only workspace and coalesces requests', async () => {
    const { service, accepted, path } = fixture();
    helper();
    const [first, second] = await Promise.all([
      service.getTaskChanges(accepted.taskId),
      service.getTaskChanges(accepted.taskId, accepted.runId),
    ]);
    expect(first).toMatchObject({
      taskId: accepted.taskId,
      runId: accepted.runId,
      status: 'live',
      diff: '+live',
    });
    expect(second).toEqual(first);
    expect(launchWorkspaceUtility).toHaveBeenCalledTimes(1);
    const options = vi.mocked(launchWorkspaceUtility).mock.calls[0]![0];
    expect(options).toMatchObject({
      workspacePath: path,
      readOnly: true,
      runtimeExecutable: 'workspace-utility.js',
      limits: { runtimeSeconds: 10, tasksMax: 16 },
    });
    expect(JSON.parse(Buffer.from(options.args![0]!, 'base64url').toString('utf8'))).toEqual({
      mode: 'changes',
      baseRevision: 'a'.repeat(40),
    });
  });
  it('serves final stored changes without reading a mutable/reused workspace', async () => {
    const { store, service, accepted, owner, path } = fixture();
    helper();
    store.storeRunResult(
      accepted.runId,
      {
        resultRevision: 'b'.repeat(40),
        files: ['final.ts'],
        diff: '+final',
        diffTruncated: false,
        checkStatus: 'not_run',
        checks: [],
      },
      path
    );
    store.updateRunStatus(accepted.runId, 'completed', 'ready', new Date(), owner);
    expect(await service.getTaskChanges(accepted.taskId, accepted.runId)).toMatchObject({
      status: 'complete',
      stale: false,
      diff: '+final',
      files: [{ path: 'final.ts', status: 'unknown' }],
    });
    expect(launchWorkspaceUtility).not.toHaveBeenCalled();
  });
  it('rejects a foreign run and never launches for a workspace symlink outside stateRoot', async () => {
    const { root, service, accepted, path, runs } = fixture();
    helper();
    await expect(
      service.getTaskChanges(accepted.taskId, '33333333-3333-4333-8333-333333333333')
    ).rejects.toMatchObject({ code: 'not_found' });
    rmSync(path, { recursive: true });
    const outside = join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, path);
    runs.set(accepted.runId, { workspace: { path } });
    expect(await service.getTaskChanges(accepted.taskId)).toMatchObject({
      status: 'unavailable',
      stale: true,
      files: [],
      diff: '',
    });
    expect(launchWorkspaceUtility).not.toHaveBeenCalled();
  });
});
