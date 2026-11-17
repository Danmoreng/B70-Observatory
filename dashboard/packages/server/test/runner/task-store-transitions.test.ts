import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { canRecoverRun } from '../../../contracts/src/agent-state.js';
import { canTransitionRun } from '@observatory/contracts';
import { AgentTaskStore } from '../../src/runner/task-store.js';

const OWNER = '11111111-1111-4111-8111-111111111111';

function createStore(): AgentTaskStore {
  return new AgentTaskStore(new DatabaseSync(':memory:'));
}

describe('durable run/turn transition contract (F7)', () => {
  let store: AgentTaskStore | undefined;
  afterEach(() => {
    store?.close();
    store = undefined;
  });

  function acceptTask() {
    store = createStore();
    const at = new Date('2026-11-07T12:00:00.000Z');
    return {
      run: store.acceptRun({ task: 'Transition validation' }, {
        profileId: 'coding-default-v1',
        baseRevision: 'a'.repeat(40),
        now: at,
      }),
      at,
    };
  }

  it('rejects the forbidden backwards transition running -> starting', () => {
    const { run, at } = acceptTask();
    store!.markStarting(run, OWNER, at);
    store!.updateRunStatus(run.runId, 'running', undefined, at, OWNER);
    expect(store!.getTask(run.taskId).task.latestRun.status).toBe('running');
    expect(canTransitionRun('running', 'starting')).toBe(false);
    expect(() => store!.updateRunStatus(run.runId, 'starting', undefined, at, OWNER)).toThrow(
      'Forbidden run transition: running -> starting.'
    );
    expect(store!.getTask(run.taskId).task.latestRun.status).toBe('running');
  });

  it('allows the normal lifecycle queued -> starting -> running -> completed', () => {
    const { run, at } = acceptTask();
    store!.markStarting(run, OWNER, at);
    store!.updateRunStatus(run.runId, 'running', undefined, at, OWNER);
    store!.updateRunStatus(run.runId, 'completed', 'done', at, OWNER);
    const task = store!.getTask(run.taskId).task;
    expect(task.latestRun.status).toBe('completed');
  });

  it('allows early start failure queued -> failed (documented exception)', () => {
    const { run, at } = acceptTask();
    store!.updateRunStatus(run.runId, 'failed', 'Start refused.', at, OWNER);
    expect(store!.getTask(run.taskId).task.latestRun.status).toBe('failed');
  });

  it('allows legitimate failure and interruption while running', () => {
    const { run, at } = acceptTask();
    store!.markStarting(run, OWNER, at);
    store!.updateRunStatus(run.runId, 'running', undefined, at, OWNER);
    store!.updateRunStatus(run.runId, 'failed', 'Stopped.', at, OWNER);
    expect(store!.getTask(run.taskId).task.latestRun.status).toBe('failed');
  });

  it('treats same-state updates as idempotent and keeps version/owner checks', () => {
    const { run, at } = acceptTask();
    store!.markStarting(run, OWNER, at);
    const before = store!.getTask(run.taskId).task.latestRun.version;
    store!.updateRunStatus(run.runId, 'starting', undefined, at, OWNER);
    expect(store!.getTask(run.taskId).task.latestRun.version).toBe(before);
    expect(() => store!.updateRunStatus(run.runId, 'running', undefined, at, 'other')).toThrow();
  });

  it('protects terminal runs from further status updates', () => {
    const { run, at } = acceptTask();
    store!.updateRunStatus(run.runId, 'failed', 'Stopped.', at, OWNER);
    store!.updateRunStatus(run.runId, 'running', undefined, at, OWNER);
    expect(store!.getTask(run.taskId).task.latestRun.status).toBe('failed');
  });

  it('supports recovery: interrupted -> queued only via the explicit recovery command', () => {
    store = createStore();
    const at = new Date('2026-11-07T12:00:00.000Z');
    const run = store!.acceptRun({ task: 'Transition validation' }, {
      profileId: 'durable-v1',
      baseRevision: 'a'.repeat(40),
      now: at,
    });
    store!.markStarting(run, OWNER, at);
    store!.updateRunStatus(run.runId, 'running', undefined, at, OWNER);
    store!.updateRunStatus(run.runId, 'interrupted', 'Runner restarted.', at, OWNER);
    expect(store!.getTask(run.taskId).task.latestRun.status).toBe('interrupted');
    // Not a normal edge: updateRunStatus must not perform it even with recovery.
    expect(canTransitionRun('interrupted', 'queued')).toBe(false);
    expect(canRecoverRun('interrupted', 'queued')).toBe(true);
    expect(canRecoverRun('failed', 'queued')).toBe(false);
    // Not a normal edge: updateRunStatus cannot perform it (terminal runs are
    // protected and only the explicit recovery command requeues).
    store!.updateRunStatus(run.runId, 'queued', undefined, at, OWNER, true);
    expect(store!.getTask(run.taskId).task.latestRun.status).toBe('interrupted');
    expect(store!.requeueDurableRun(run.runId)).toBe(true);
    expect(store!.getTask(run.taskId).task.latestRun.status).toBe('queued');
  });

  it('still enforces the shared table for recovery-marked interruptions', () => {
    const { run, at } = acceptTask();
    store!.markStarting(run, OWNER, at);
    expect(() =>
      store!.updateRunStatus(run.runId, 'queued', undefined, at, undefined, true)
    ).toThrow('Forbidden run transition: starting -> queued.');
    store!.recoverInterrupted(at);
    expect(store!.getTask(run.taskId).task.latestRun.status).toBe('interrupted');
  });
});
