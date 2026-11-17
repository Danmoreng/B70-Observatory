import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { canTransitionRun } from '@observatory/contracts';
import { AgentTaskStore } from '../../src/runner/task-store.js';

// Desired invariant; intentionally fails against audited commit ce1756b.
describe('state machine audit: durable transition contract', () => {
  it('must reject running -> starting just as the shared transition table does', () => {
    const store = new AgentTaskStore(new DatabaseSync(':memory:'));
    try {
      const at = new Date('2026-11-07T12:00:00.000Z');
      const run = store.acceptRun({ task: 'Audit transition validation' }, {
        profileId: 'coding-default-v1', baseRevision: 'a'.repeat(40), now: at,
      });
      const owner = '11111111-1111-4111-8111-111111111111';
      store.markStarting(run, owner, at);
      store.updateRunStatus(run.runId, 'running', undefined, at, owner);
      expect(store.getTask(run.taskId).task.latestRun.status).toBe('running');
      expect(canTransitionRun('running', 'starting')).toBe(false);
      expect(() => store.updateRunStatus(run.runId, 'starting', undefined, at, owner)).toThrow();
    } finally {
      store.close();
    }
  });
});
