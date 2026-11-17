import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AgentTaskStore } from '../../src/runner/task-store.js';
import { IsolatedAgentService } from '../../src/runner/service.js';
import { loadRunnerConfig } from '../../src/runner/config.js';

it('leaves saved work intact while vLLM is still starting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'b70-durable-recovery-'));
  const tasks = new AgentTaskStore(new DatabaseSync(':memory:'));
  const accepted = tasks.acceptRun(
    { task: 'Saved work' },
    { profileId: 'durable-v1', baseRevision: 'a'.repeat(40) }
  );
  tasks.recoverInterrupted();
  const config = loadRunnerConfig({
    B70_RUNNER_CONTROL_TOKEN: 'a'.repeat(64),
    B70_RUNNER_REPOSITORY: root,
    B70_RUNNER_STATE_ROOT: join(root, 'runs'),
    B70_RUNNER_SUPPORT_ROOT: root,
    B70_RUNNER_AGENT_RUNTIME_ROOT: root,
    B70_RUNNER_PROFILE_ROOT: root,
    B70_RUNNER_DEPENDENCY_ROOT: root,
    B70_RUNNER_REVISION: 'a'.repeat(40),
  });
  const relay = { register() {}, revoke() {}, async start() {}, async close() {} };
  const service = new IsolatedAgentService(config, relay, tasks);
  const health = vi.fn(async () => new Response('', { status: 503 }));
  vi.stubGlobal('fetch', health);
  try {
    await service.resumeDurableWork();
    await service.resumeDurableWork();
    expect(health).toHaveBeenCalledTimes(2);
    expect(tasks.getTask(accepted.taskId).task.latestRun.status).toBe('interrupted');
    expect(tasks.listTasks().activeTaskIds).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
