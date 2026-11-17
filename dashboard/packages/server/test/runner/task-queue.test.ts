import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentTaskStore } from '../../src/runner/task-store.js';

const stores: AgentTaskStore[] = [];
const roots: string[] = [];
function fixture(path = ':memory:') {
  const store = new AgentTaskStore(path);
  stores.push(store);
  return store;
}
const options = { profileId: 'durable-v1', baseRevision: 'a'.repeat(40), enqueue: true };
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('durable task backlog', () => {
  it('accepts many requests without reserving slots, claims FIFO, and never exceeds two', () => {
    const store = fixture();
    const accepted = Array.from({ length: 25 }, (_, i) =>
      store.acceptRun({ task: `Task ${i}`, idempotencyKey: randomUUID() }, options)
    );
    expect(store.occupiedRunCount()).toBe(0);
    expect(store.listTasks().activeTaskIds).toEqual([]);
    expect(store.getTask(accepted[0]!.taskId).latestSnapshot).toMatchObject({ status: 'queued' });
    expect(store.getTask(accepted[0]!.taskId).latestSnapshot?.startedAt).toBeUndefined();
    expect(store.claimNextQueuedRun(2, 'owner')?.accepted.runId).toBe(accepted[0]!.runId);
    expect(store.claimNextQueuedRun(2, 'owner')?.accepted.runId).toBe(accepted[1]!.runId);
    expect(store.claimNextQueuedRun(2, 'owner')).toBeUndefined();
    expect(store.listTasks().activeTaskIds).toHaveLength(2);
    store.updateRunStatus(accepted[0]!.runId, 'running', undefined, new Date(), 'owner');
    store.updateRunStatus(accepted[0]!.runId, 'completed', undefined, new Date(), 'owner');
    expect(store.claimNextQueuedRun(2, 'owner')?.accepted.runId).toBe(accepted[2]!.runId);
    expect(store.occupiedRunCount()).toBe(2);
  });

  it('keeps acknowledged requests, references and ordering across a database reopen', () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-queue-'));
    roots.push(root);
    const path = join(root, 'tasks.sqlite');
    const first = new AgentTaskStore(path);
    const request = {
      task: 'Saved task',
      images: [
        {
          mimeType: 'image/png' as const,
          data: readFileSync(
            new URL('../../../runner/test/fixtures/desktop/blank.png', import.meta.url)
          ).toString('base64'),
          label: 'reference',
        },
      ],
      idempotencyKey: randomUUID(),
    };
    const accepted = first.acceptRun(request, options);
    const second = first.acceptRun({ task: 'Next task' }, options);
    expect(first.recoverInterrupted()).toEqual([]);
    first.close();
    const store = fixture(path);
    expect(store.acceptRun(request, options)).toMatchObject({
      created: false,
      runId: accepted.runId,
    });
    expect(() => store.acceptRun({ ...request, task: 'Changed' }, options)).toThrow(
      /different task content/
    );
    expect(store.queuedRun(accepted.runId)?.input).toEqual(request);
    const pendingImage = store.snapshotForRun(accepted.runId).timeline[0]!.images![0]!;
    expect(store.getRunImage(pendingImage.runId, pendingImage.id).data.toString('base64')).toBe(
      request.images[0]!.data
    );
    expect(
      store.storeInputImage(accepted.runId, 0, {
        mimeType: request.images[0]!.mimeType,
        data: Buffer.from(request.images[0]!.data, 'base64'),
        label: 'reference',
      }).id
    ).toBe(pendingImage.id);
    expect(store.claimNextQueuedRun(2, 'owner')?.accepted.runId).toBe(accepted.runId);
    expect(store.claimNextQueuedRun(2, 'owner')?.accepted.runId).toBe(second.runId);
    expect(store.recoverInterrupted()).toHaveLength(2);
    expect(store.claimNextQueuedRun(2, 'next-owner')).toBeUndefined();
  });

  it('cancels a waiting task durably without ever claiming it', () => {
    const store = fixture();
    const accepted = store.acceptRun({ task: 'Cancel me' }, options);
    const detail = store.getTask(accepted.taskId);
    const request = {
      runId: accepted.runId,
      expectedRunVersion: detail.task.latestRun.version,
      expectedTaskVersion: detail.task.version,
      idempotencyKey: randomUUID(),
    };
    const cancellation = store.acceptCancellation(request);
    store.updateRunStatus(accepted.runId, 'cancelled', 'User cancelled');
    store.markCancellation(cancellation.id, 'completed');
    expect(store.acceptCancellation(request).created).toBe(false);
    expect(store.claimNextQueuedRun(2, 'owner')).toBeUndefined();
    expect(store.getTask(accepted.taskId).latestSnapshot?.status).toBe('cancelled');
  });

  it('queues continuations while other tasks occupy the slots and retains the single-writer guard', () => {
    const store = fixture();
    const accepted = store.acceptRun({ task: 'First turn' }, options);
    store.claimNextQueuedRun(2, 'owner');
    store.updateRunStatus(accepted.runId, 'running', undefined, new Date(), 'owner');
    store.updateRunStatus(accepted.runId, 'completed', undefined, new Date(), 'owner');
    for (let i = 0; i < 2; i++) {
      store.acceptRun({ task: `Other ${i}` }, options);
      store.claimNextQueuedRun(2, 'owner');
    }
    const input = { taskId: accepted.taskId, message: 'Continue', idempotencyKey: randomUUID() };
    const continuation = store.acceptContinuation(input, {
      profileId: 'durable-v1',
      enqueue: true,
      recentContext: 'Saved context',
    });
    expect(store.acceptContinuation(input, { profileId: 'durable-v1', enqueue: true }).runId).toBe(
      continuation.runId
    );
    expect(store.queuedRun(continuation.runId)).toMatchObject({
      input: { task: 'Continue' },
      recentContext: 'Saved context',
    });
    expect(store.claimNextQueuedRun(2, 'owner')).toBeUndefined();
    expect(() =>
      store.acceptContinuation(
        { ...input, idempotencyKey: randomUUID() },
        { profileId: 'durable-v1', enqueue: true }
      )
    ).toThrow(/active writer/);
  });

  it('keeps active and recoverable runs visible to the scheduler beyond the 100-row task history window', () => {
    const store = fixture();
    const first = store.acceptRun({ task: 'Old active' }, options);
    store.claimNextQueuedRun(2, 'owner');
    for (let i = 0; i < 110; i++)
      store.acceptRun(
        { task: `Waiting ${i}` },
        { ...options, now: new Date(Date.now() + 1000 + i) }
      );
    expect(store.listTasks().items).toHaveLength(100);
    expect(store.listTasks().items.some((task) => task.id === first.taskId)).toBe(false);
    expect(store.listTasks().activeTaskIds).toEqual([first.taskId]);
    store.recoverInterrupted();
    expect(store.interruptedDurableTasks()).toEqual([{ taskId: first.taskId, runId: first.runId }]);
  });

  it('returns the original run on an idempotent retry after a newer turn was queued', () => {
    const store = fixture();
    const input = { task: 'First', idempotencyKey: randomUUID() };
    const first = store.acceptRun(input, options);
    store.claimNextQueuedRun(2, 'owner');
    store.updateRunStatus(first.runId, 'running', undefined, new Date(), 'owner');
    store.updateRunStatus(first.runId, 'completed', undefined, new Date(), 'owner');
    const next = store.acceptContinuation(
      { taskId: first.taskId, message: 'Next turn', idempotencyKey: randomUUID() },
      { profileId: 'durable-v1', enqueue: true }
    );
    expect(store.snapshotForRun(store.acceptRun(input, options).runId)).toMatchObject({
      runId: first.runId,
      task: 'First',
      status: 'settled',
    });
    expect(store.snapshotForRun(next.runId)).toMatchObject({
      runId: next.runId,
      task: 'Next turn',
      status: 'queued',
    });
    expect(store.getTask(first.taskId).runs).toHaveLength(2);
  });

  it('rolls the whole enqueue back when any reference cannot be stored', () => {
    const store = fixture();
    expect(() =>
      store.acceptRun(
        {
          task: 'Invalid reference',
          images: [{ mimeType: 'image/png', data: 'aGVsbG8=', label: 'invalid' }],
        },
        options
      )
    ).toThrow(/Image rejected/);
    expect(store.listTasks().items).toEqual([]);
    expect(store.database.prepare('SELECT COUNT(*) AS count FROM agent_queue').get()).toMatchObject(
      { count: 0 }
    );
    expect(
      store.database.prepare('SELECT COUNT(*) AS count FROM agent_images').get()
    ).toMatchObject({ count: 0 });
  });

  it('bounds agent-created work, blocks recursive task creation and rolls rejected work back', () => {
    const store = fixture();
    const parent = store.acceptRun({ task: 'Parent' }, options);
    const child = store.acceptRun({ task: 'Child' }, { ...options, originTaskId: parent.taskId });
    expect(store.isAgentCreatedTask(child.taskId)).toBe(true);
    expect(() =>
      store.acceptRun({ task: 'Grandchild' }, { ...options, originTaskId: child.taskId })
    ).toThrow(/cannot create more/);
    for (let i = 1; i < 8; i++)
      store.acceptRun({ task: `Child ${i}` }, { ...options, originTaskId: parent.taskId });
    expect(() =>
      store.acceptRun({ task: 'Overflow' }, { ...options, originTaskId: parent.taskId })
    ).toThrow(/at most eight/);
    expect(store.listTasks().items).toHaveLength(9);
  });

  it('retains a follow-up until its continuation has been stored, including an interrupted promotion', () => {
    const store = fixture();
    const parent = store.acceptRun({ task: 'Parent' }, options);
    store.claimNextQueuedRun(2, 'owner');
    const followup = {
      taskId: parent.taskId,
      message: 'Do the next thing',
      idempotencyKey: randomUUID(),
    };
    store.queueFollowup(followup);
    store.updateRunStatus(parent.runId, 'running', undefined, new Date(), 'owner');
    store.updateRunStatus(parent.runId, 'completed', undefined, new Date(), 'owner');
    expect(store.pendingFollowups()).toEqual([followup]);
    expect(store.pendingFollowups()).toEqual([followup]);
    const next = store.acceptContinuation(followup, { profileId: 'durable-v1', enqueue: true });
    expect(store.pendingFollowups()).toEqual([]);
    expect(store.queuedRun(next.runId)?.input.task).toBe(followup.message);
  });
});
