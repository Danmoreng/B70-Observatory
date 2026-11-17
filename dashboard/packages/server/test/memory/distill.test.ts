import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AgentTaskStore } from '../../src/runner/task-store.js';
import { MemoryStore } from '../../src/memory/store.js';
import { distillRun } from '../../src/memory/distill.js';
import type { RunnerConfig } from '../../src/runner/config.js';
import { AgentRunSnapshotSchema, SERVICE_NAME } from '@observatory/contracts';
const stores: MemoryStore[] = [];
const tasks: AgentTaskStore[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const s of stores.splice(0)) await s.close();
  for (const t of tasks.splice(0)) t.close();
});
function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-07T12:00:00Z'));
  const db = new AgentTaskStore(':memory:');
  tasks.push(db);
  const project = db.registerProject({
    name: 'Memory fixture',
    repositoryPath: '/tmp/memory-fixture',
    targetBranch: 'main',
    workdir: '.',
    editPaths: ['.'],
    checks: [],
  });
  const run = db.acceptRun(
    { projectId: project.id, task: 'Keep table names plural and snake_case.' },
    { projectId: project.id, profileId: 'fixture', baseRevision: 'a'.repeat(40) }
  );
  const snapshot = AgentRunSnapshotSchema.parse({
    service: SERVICE_NAME,
    enabled: true,
    status: 'settled',
    sequence: 1,
    runId: run.runId,
    pendingSteering: 0,
    timeline: [
      {
        id: randomUUID(),
        kind: 'task',
        title: 'User decision',
        at: new Date().toISOString(),
        text: 'Use plural SQL table names in snake_case.',
        state: 'complete',
      },
    ],
  });
  db.database
    .prepare("UPDATE agent_runs SET status='completed',latest_snapshot_json=? WHERE id=?")
    .run(JSON.stringify(snapshot), run.runId);
  const memory = new MemoryStore(':memory:');
  stores.push(memory);
  const config = {
    model: 'fixture',
    gatewayUrl: 'http://127.0.0.1:19090',
    gatewayToken: 'private-gateway-token',
  } as RunnerConfig;
  return { db, memory, config, run };
}
it('distills only proposals through the gateway, binding source IDs and preserving confirmed memory', async () => {
  const f = fixture();
  let called = '';
  const mocked = vi.fn(async (url: URL | string, init?: RequestInit) => {
    called = String(url);
    const payload = JSON.parse(String(init?.body));
    const input = JSON.parse(payload.messages[1].content);
    expect(payload.tools).toBeUndefined();
    expect(payload.max_tokens).toBe(1600);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                notes: [
                  {
                    title: 'SQL naming',
                    content: 'Use plural snake_case table names; explicit user decision.',
                    sourceIds: [input.source[0].id],
                  },
                ],
              }),
            },
          },
        ],
      }),
      { status: 200 }
    );
  }) as unknown as typeof fetch;
  const result = await distillRun(f.memory, f.db, f.config, f.run.runId, mocked);
  expect(called).toBe('http://127.0.0.1:19090/v1/chat/completions');
  expect(result.created).toBe(1);
  const note = f.memory.list({ owner: true }).find((i) => i.kind === 'fact');
  expect(note?.status).toBe('proposed');
  expect(note?.sources[0]?.kind).toBe('run');
  expect(f.memory.database.prepare('SELECT status FROM memory_jobs').get()).toMatchObject({
    status: 'completed',
  });
});
it('rejects invented evidence and leaves no accepted knowledge behind', async () => {
  const f = fixture();
  const mocked = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  notes: [
                    {
                      title: 'Invented',
                      content: 'This is unsupported.',
                      sourceIds: [randomUUID()],
                    },
                  ],
                }),
              },
            },
          ],
        })
      )
  ) as unknown as typeof fetch;
  await expect(distillRun(f.memory, f.db, f.config, f.run.runId, mocked)).rejects.toThrow(
    /unknown source/
  );
  expect(f.memory.list({ owner: true }).filter((i) => i.kind === 'fact')).toHaveLength(0);
  expect(f.memory.database.prepare('SELECT status FROM memory_jobs').get()).toMatchObject({
    status: 'failed',
  });
});

it('discards assistant-only claims and audits an aborted request', async () => {
  const f = fixture();
  const row = f.db.database
    .prepare('SELECT latest_snapshot_json FROM agent_runs WHERE id=?')
    .get(f.run.runId) as { latest_snapshot_json: string };
  const snapshot = JSON.parse(row.latest_snapshot_json);
  snapshot.timeline.push({
    id: randomUUID(),
    kind: 'assistant',
    title: 'Agent',
    at: new Date().toISOString(),
    text: 'I claim all tests passed.',
    state: 'complete',
  });
  f.db.database
    .prepare('UPDATE agent_runs SET latest_snapshot_json=? WHERE id=?')
    .run(JSON.stringify(snapshot), f.run.runId);
  const mocked = vi.fn(async (_url: URL | string, init?: RequestInit) => {
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                notes: [
                  {
                    title: 'Unverified claim',
                    content: 'All tests pass.',
                    sourceIds: [
                      input.source.find((s: { title: string }) => s.title.startsWith('assistant ·'))
                        .id,
                    ],
                  },
                ],
              }),
            },
          },
        ],
      })
    );
  }) as unknown as typeof fetch;
  expect((await distillRun(f.memory, f.db, f.config, f.run.runId, mocked)).created).toBe(0);
  const abort = new AbortController();
  abort.abort();
  const aborted = vi.fn(async (_url: URL | string, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    throw new Error('Expected aborted signal');
  }) as unknown as typeof fetch;
  await expect(
    distillRun(f.memory, f.db, f.config, f.run.runId, aborted, abort.signal)
  ).rejects.toThrow();
  expect(f.memory.list({ owner: true }).filter((i) => i.kind === 'fact')).toHaveLength(0);
  expect(
    f.memory.database.prepare("SELECT count(*) n FROM memory_jobs WHERE status='failed'").get()
  ).toMatchObject({ n: 1 });
});
