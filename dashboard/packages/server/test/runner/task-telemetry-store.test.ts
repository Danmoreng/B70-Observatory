import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InferenceRequestTelemetry } from '@observatory/contracts';
import { AgentTaskStore } from '../../src/runner/task-store.js';

const stores: AgentTaskStore[] = [];
const roots: string[] = [];
const options = {
  profileId: 'coding-default-v1',
  baseRevision: 'a'.repeat(40),
  maxActiveRuns: 8,
  now: new Date('2026-10-29T12:00:00.000Z'),
};
function store() {
  const result = new AgentTaskStore(new DatabaseSync(':memory:'));
  stores.push(result);
  return result;
}
function sample(overrides: Partial<InferenceRequestTelemetry> = {}): InferenceRequestTelemetry {
  return {
    requestId: randomUUID(),
    startedAt: '2026-10-29T12:00:00.000Z',
    finishedAt: '2026-10-29T12:00:02.000Z',
    durationMs: 2_000,
    outcome: 'completed',
    usage: null,
    prefill: { tokens: 100, durationMs: 100 },
    decode: { tokens: 10, durationMs: 1_000 },
    ...overrides,
  };
}
afterEach(() => {
  for (const value of stores.splice(0)) value.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('durable per-run inference telemetry', () => {
  it('preserves measured GPU queue intervals and leaves old unrecorded waits unknown', () => {
    const db = store();
    const run = db.acceptRun({ task: 'Queue clocks' }, options);
    expect(db.getRunEngineWaits(run.runId)).toBeUndefined();
    db.recordInferenceTelemetry(run.runId, sample({ engineWaitMs: 125.5 }));
    const start = Date.parse('2026-10-29T12:00:00.000Z');
    expect(db.getRunEngineWaits(run.runId)).toEqual([[start, start + 125.5]]);
    db.recordInferenceTelemetry(run.runId, sample());
    expect(db.getRunEngineWaits(run.runId)).toBeUndefined();
  });
  it('weights rates by actual phase time and reports missing measurement coverage', () => {
    const db = store();
    const run = db.acceptRun({ task: 'Simplify projects' }, options);
    const first = sample({
      usage: { inputTokens: 1_000, outputTokens: 10, cachedInputTokens: 900 },
    });
    expect(db.recordInferenceTelemetry(run.runId, first)).toBe(true);
    expect(db.recordInferenceTelemetry(run.runId, first)).toBe(false);
    db.recordInferenceTelemetry(
      run.runId,
      sample({
        usage: { inputTokens: 2_000, outputTokens: 90, cachedInputTokens: 1_100 },
        prefill: { tokens: 900, durationMs: 9_000 },
        decode: { tokens: 90, durationMs: 1_000 },
      })
    );
    db.recordInferenceTelemetry(run.runId, sample({ prefill: null, decode: null }));
    db.recordInferenceTelemetry(
      run.runId,
      sample({ outcome: 'failed', prefill: null, decode: null })
    );
    const totals = db.getRunTelemetry(run.runId).totals;
    expect(totals).toMatchObject({
      requests: 4,
      completedRequests: 3,
      failedRequests: 1,
      usage: { inputTokens: 3_000, outputTokens: 100, cachedInputTokens: 2_000 },
      prefill: { tokens: 1_000, durationMs: 9_100, samples: 2 },
      decode: { tokens: 100, durationMs: 2_000, tokensPerSecond: 50, samples: 2 },
    });
    expect(totals.prefill?.tokensPerSecond).toBeCloseTo(1_000 / 9.1);
    expect(db.getTask(run.taskId).telemetry?.totals).toEqual(totals);
  });

  it('keeps run selection and task totals separate from other tasks and review runs', () => {
    const db = store();
    const first = db.acceptRun({ task: 'Task A' }, options);
    db.recordInferenceTelemetry(first.runId, sample());
    db.updateRunStatus(first.runId, 'failed', 'fixture');
    const second = db.acceptContinuation(
      { taskId: first.taskId, message: 'Continue', idempotencyKey: randomUUID() },
      options
    );
    db.recordInferenceTelemetry(second.runId, sample({ decode: { tokens: 30, durationMs: 500 } }));
    const other = db.acceptRun({ task: 'Task B' }, options);
    db.recordInferenceTelemetry(other.runId, sample({ decode: { tokens: 999, durationMs: 1 } }));
    const task = db.getTaskTelemetry(first.taskId);
    expect(task.runs).toHaveLength(2);
    expect(task.totals.decode).toMatchObject({ tokens: 40, durationMs: 1_500, samples: 2 });
    expect(db.getRunTelemetry(second.runId).totals.decode?.tokensPerSecond).toBe(60);
    expect(() =>
      db.recordInferenceTelemetry(other.runId, {
        ...sample(),
        requestId: db.database
          .prepare('SELECT request_id FROM agent_inference_telemetry WHERE run_id=?')
          .get(first.runId)!.request_id as string,
      })
    ).toThrow('different run');
    // Review runs share a task but must never enter implementation totals.
    db.database.prepare("UPDATE agent_runs SET run_kind='review' WHERE id=?").run(second.runId);
    expect(db.getTaskTelemetry(first.taskId).totals.decode?.tokens).toBe(10);
    expect(db.getRunTelemetry(second.runId).totals.decode?.tokens).toBe(30);
  });

  it('returns honest unavailable values for legacy runs and rejects failed phase measurements', () => {
    const db = store();
    const run = db.acceptRun({ task: 'No clocks' }, options);
    expect(db.getRunTelemetry(run.runId).totals).toEqual({
      requests: 0,
      completedRequests: 0,
      failedRequests: 0,
      usage: null,
      prefill: null,
      decode: null,
    });
    db.recordInferenceTelemetry(run.runId, sample({ prefill: null, decode: null }));
    expect(db.getRunTelemetry(run.runId).totals).toMatchObject({
      completedRequests: 1,
      prefill: null,
      decode: null,
    });
    expect(() => db.recordInferenceTelemetry(run.runId, sample({ outcome: 'failed' }))).toThrow(
      'Failed requests'
    );
    expect(() => db.getRunTelemetry(randomUUID())).toThrow('Run not found');
    expect(() => db.getTaskTelemetry(randomUUID())).toThrow('Task not found');
  });

  it('persists timings across database reopen without storing request or response content', () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-telemetry-'));
    roots.push(root);
    const path = join(root, 'tasks.sqlite');
    const first = new AgentTaskStore(path);
    const run = first.acceptRun({ task: 'Persist metrics' }, options);
    first.recordInferenceTelemetry(run.runId, sample());
    first.close();
    const reopened = new AgentTaskStore(path);
    stores.push(reopened);
    expect(reopened.getRunTelemetry(run.runId).totals.prefill?.tokensPerSecond).toBe(1_000);
    expect(reopened.getTask(run.taskId).telemetry?.runs[0]?.runId).toBe(run.runId);
    const columns = reopened.database
      .prepare('PRAGMA table_info(agent_inference_telemetry)')
      .all()
      .map((row) => row.name);
    expect(columns).not.toContain('token');
    expect(columns).not.toContain('payload_json');
  });
});
