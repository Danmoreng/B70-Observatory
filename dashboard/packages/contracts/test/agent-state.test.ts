import { describe, expect, it } from 'vitest';
import {
  DurableRunSchema,
  DurableTaskDetailSchema,
  canTransitionRun,
  canTransitionTurn,
  isTerminalRunStatus,
} from '../src/index.js';

describe('durable task contracts', () => {
  it('keeps completion, checks and human acceptance separate', () => {
    const run = DurableRunSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      taskId: '22222222-2222-4222-8222-222222222222',
      turnId: '33333333-3333-4333-8333-333333333333',
      status: 'completed',
      version: 3,
      profileId: 'coding-default-v1',
      baseRevision: 'a'.repeat(40),
      checkStatus: 'not_run',
      createdAt: '2026-09-13T12:00:00.000Z',
      finishedAt: '2026-09-13T12:01:00.000Z',
    });
    expect(run.status).toBe('completed');
    expect(run.checkStatus).toBe('not_run');
    expect(run).not.toHaveProperty('accepted');
  });

  it('rejects terminal rewrites and allows a controlled yield', () => {
    expect(canTransitionRun('queued', 'starting')).toBe(true);
    expect(canTransitionRun('running', 'yielded')).toBe(true);
    expect(canTransitionRun('completed', 'running')).toBe(false);
    expect(isTerminalRunStatus('failed')).toBe(true);
    expect(canTransitionTurn('active', 'waiting_for_input')).toBe(true);
  });

  it('does not admit reasoning or tool payloads into durable task detail', () => {
    const invalid = {
      task: {},
      runs: [],
      messages: [],
      reasoning: 'must stay live-only',
    };
    expect(DurableTaskDetailSchema.safeParse(invalid).success).toBe(false);
  });
});
