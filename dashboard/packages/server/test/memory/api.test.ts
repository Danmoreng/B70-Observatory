import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../../src/app.js';
import { loadServerConfig } from '../../src/config.js';
import { AgentTaskStore } from '../../src/runner/task-store.js';
import { MemoryStore } from '../../src/memory/store.js';
import { memoryControl } from '../../src/memory/controller.js';
import { memoryEvidence } from '../../src/memory/evidence.js';
import { AgentRunSnapshotSchema, SERVICE_NAME } from '@observatory/contracts';
it('validates owner control requests at the public API boundary', async () => {
  const snapshot = AgentRunSnapshotSchema.parse({
    service: SERVICE_NAME,
    enabled: true,
    status: 'idle',
    sequence: 0,
    pendingSteering: 0,
    timeline: [],
  });
  const memoryCall = vi.fn(async () => ({ enabled: true, items: [] }));
  const app = buildApp({
    config: loadServerConfig(),
    version: 'memory-test',
    loggerLevel: 'silent',
    agent: {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      start: async () => snapshot,
      steer: async () => snapshot,
      close: async () => {},
      memoryCall,
    },
  });
  try {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/agent/memory',
          payload: { operation: 'list' },
        })
      ).statusCode
    ).toBe(200);
    expect(memoryCall).toHaveBeenCalledTimes(1);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/agent/memory',
          payload: { operation: 'list', owner: true },
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/agent/memory',
          payload: { operation: 'create', entry: { scope: 'project', content: 'missing source' } },
        })
      ).statusCode
    ).toBe(400);
    expect(memoryCall).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});
it('resolves run evidence without granting foreign-project or shared-client access to raw traces', async () => {
  const tasks = new AgentTaskStore(':memory:');
  const memory = new MemoryStore(':memory:');
  const a = tasks.registerProject({
    name: 'A',
    repositoryPath: '/tmp/mem-a',
    targetBranch: 'main',
    workdir: '.',
    editPaths: ['.'],
    checks: [],
  });
  const b = tasks.registerProject({
    name: 'B',
    repositoryPath: '/tmp/mem-b',
    targetBranch: 'main',
    workdir: '.',
    editPaths: ['.'],
    checks: [],
  });
  const run = tasks.acceptRun(
    { projectId: a.id, task: 'Source fixture' },
    { projectId: a.id, profileId: 'test', baseRevision: 'a'.repeat(40) }
  );
  const itemId = randomUUID();
  const snapshot = AgentRunSnapshotSchema.parse({
    service: SERVICE_NAME,
    enabled: true,
    status: 'settled',
    sequence: 1,
    runId: run.runId,
    pendingSteering: 0,
    timeline: [
      {
        id: itemId,
        kind: 'tool',
        title: 'check',
        state: 'complete',
        at: new Date().toISOString(),
        outputText: 'Independent checker passed.',
      },
    ],
  });
  tasks.database
    .prepare("UPDATE agent_runs SET status='completed',latest_snapshot_json=? WHERE id=?")
    .run(JSON.stringify(snapshot), run.runId);
  const entry = memory.write(
    {
      title: 'Verified procedure',
      content: 'Run the checker.',
      scope: 'project',
      projectId: a.id,
      kind: 'fact',
      status: 'confirmed',
      visibility: 'shared',
      sources: [{ kind: 'run', ref: run.runId + ':' + itemId + ':0' }],
    },
    { owner: true }
  );
  try {
    expect(
      memoryEvidence(memory, tasks, entry.id, { owner: false, projectId: a.id })[0]?.text
    ).toContain('Independent checker passed');
    const offsetNote = memory.write(
      {
        title: 'Offset source',
        content: entry.content,
        scope: entry.scope,
        projectId: entry.projectId,
        kind: entry.kind,
        status: entry.status,
        visibility: entry.visibility,
        sources: [{ kind: 'run', ref: run.runId + ':' + itemId + ':12' }],
      },
      { owner: true }
    );
    expect(memoryEvidence(memory, tasks, offsetNote.id, { owner: true })[0]?.text).toBe(
      'tool · check\nchecker passed.'
    );
    expect(() =>
      memoryEvidence(memory, tasks, entry.id, { owner: false, projectId: b.id })
    ).toThrow(/not found/);
    expect(
      memoryEvidence(memory, tasks, entry.id, {
        owner: false,
        projectId: a.id,
        sharedOnly: true,
      })[0]?.text
    ).toBeUndefined();
    await memoryControl(memory, tasks, { operation: 'ingest', runId: run.runId });
    const episode = memory.list({ owner: true }).find((item) => item.kind === 'episode')!;
    expect(() =>
      memory.write(
        { ...episode, title: 'Changed source' },
        { owner: true },
        { id: episode.id, version: episode.version }
      )
    ).toThrow();
  } finally {
    await memory.close();
    tasks.close();
  }
});
