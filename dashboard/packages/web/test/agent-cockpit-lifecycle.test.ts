/**
 * Regression tests for the state-machine audit findings F1, F3, F4, F5 and
 * F6 in useAgentCockpit.ts (task/run selection identity, snapshot
 * reconciliation, list-request generations, mutation-origin guards and
 * unmount invalidation). Fixtures and scenarios are adapted from
 * audit-reference/web-reproductions.ts.
 */
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentRunSnapshotSchema,
  DurableTaskDetailSchema,
  DurableTaskListSchema,
  SERVICE_NAME,
  type AgentRunSnapshot,
  type DurableTaskDetail,
  type DurableTaskList,
} from '@observatory/contracts';
import {
  useAgentCockpit,
  clearAgentCockpitCache,
  type AgentCockpitState,
} from '../src/composables/useAgentCockpit.js';
import * as api from '../src/lib/api.js';

const taskA = '66666666-6666-4666-8666-666666666666';
const taskB = '77777777-7777-4777-8777-777777777777';
const runA = '22222222-2222-4222-8222-222222222222';
const runB = '33333333-3333-4333-8333-333333333333';
const revisionA = 'c'.repeat(40);

const mockState = vi.hoisted(() => ({
  snapshot: undefined as AgentRunSnapshot | undefined,
  tasks: { items: [], activeTaskIds: [] } as unknown as DurableTaskList,
  details: new Map<string, DurableTaskDetail>(),
}));

vi.mock('../src/lib/api.js', () => ({
  HealthFetchError: class HealthFetchError extends Error {
    constructor(
      message: string,
      readonly code: string,
      readonly status?: number,
      readonly source?: string,
      readonly apiCode?: string
    ) {
      super(message);
      this.name = 'HealthFetchError';
    }
  },
  fetchAgent: vi.fn(async () => mockState.snapshot),
  fetchAgentTasks: vi.fn(async () => mockState.tasks),
  fetchAgentTask: vi.fn(async (taskId: string) => mockState.details.get(taskId)),
  fetchAgentProjects: vi.fn(async () => []),
  fetchAgentRunResult: vi.fn(async () => undefined),
  fetchAgentRunTrace: vi.fn(async () => ({ runId: '', items: [], hasMore: false })),
  collectAgentRunTrace: vi.fn(async () => []),
  acceptAgentRunResult: vi.fn(async () => undefined),
  mergeAgentRunResult: vi.fn(async () => undefined),
  deleteAgentTask: vi.fn(async () => true),
  startAgentRun: vi.fn(async () => mockState.snapshot),
  startAgentReview: vi.fn(async () => mockState.snapshot),
  startAgentCorrection: vi.fn(async () => mockState.snapshot),
  startAgentConflictResolution: vi.fn(async () => mockState.snapshot),
  startReleaseBuild: vi.fn(async () => undefined),
  activateRelease: vi.fn(async () => undefined),
  rollbackRelease: vi.fn(async () => undefined),
  steerAgentRun: vi.fn(async () => mockState.snapshot),
  cancelAgentRun: vi.fn(async () => mockState.snapshot),
  continueAgentTask: vi.fn(async () => mockState.snapshot),
  queueAgentFollowup: vi.fn(async () => ({ queued: true })),
  answerAgentQuestion: vi.fn(async () => mockState.snapshot),
  subscribeAgent: vi.fn(() => vi.fn()),
}));

const idle = AgentRunSnapshotSchema.parse({
  service: SERVICE_NAME,
  enabled: true,
  status: 'idle',
  sequence: 0,
  pendingSteering: 0,
  timeline: [],
});

function taskSummary(id: string, runId: string, version: number) {
  return {
    id,
    title: id === taskA ? 'Aufgabe A' : 'Aufgabe B',
    status: 'open' as const,
    version,
    createdAt: '2026-09-13T09:00:00.000Z',
    updatedAt: '2026-09-13T10:00:00.000Z',
    latestRun: {
      id: runId,
      taskId: id,
      turnId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      status: 'completed' as const,
      version: 2,
      profileId: 'coding-default-v1',
      baseRevision: 'a'.repeat(40),
      checkStatus: 'not_run' as const,
      createdAt: '2026-09-13T09:00:00.000Z',
      startedAt: '2026-09-13T09:00:00.000Z',
      finishedAt: '2026-09-13T10:00:00.000Z',
      ...(id === taskA ? { resultRevision: revisionA } : {}),
    },
  };
}

function taskDetail(id: string, runId: string, version: number) {
  const summary = taskSummary(id, runId, version);
  const run = { ...summary.latestRun };
  return DurableTaskDetailSchema.parse({
    task: summary,
    runs: [run],
    messages: [],
    latestSnapshot: idle,
    traceEventCount: 0,
  });
}

function setupTwoTasks(versionA = 2, versionB = 1): void {
  mockState.snapshot = idle;
  mockState.tasks = DurableTaskListSchema.parse({
    items: [taskSummary(taskA, runA, versionA), taskSummary(taskB, runB, versionB)],
    activeTaskIds: [],
  });
  mockState.details.set(taskA, taskDetail(taskA, runA, versionA));
  mockState.details.set(taskB, taskDetail(taskB, runB, versionB));
}

let cockpit: AgentCockpitState | undefined;
const Harness = defineComponent({
  setup() {
    cockpit = useAgentCockpit();
    return () => null;
  },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const mounted: Array<{ unmount(): void }> = [];

beforeEach(() => {
  clearAgentCockpitCache();
  vi.clearAllMocks();
  setupTwoTasks();
});

afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount());
  clearAgentCockpitCache();
  vi.useRealTimers();
});

async function openHarness() {
  const wrapper = mount(Harness);
  mounted.push(wrapper);
  await flushPromises();
  return cockpit!;
}

describe('agent cockpit lifecycle invariants', () => {
  it('F1: must not retain task A as the actionable detail while task B is loading', async () => {
    const detail = mockState.details.get(taskA)!;
    const running = { ...detail.task.latestRun, status: 'running' as const };
    mockState.details.set(
      taskA,
      DurableTaskDetailSchema.parse({
        ...detail,
        task: { ...detail.task, latestRun: running },
        runs: [running],
      })
    );
    mockState.tasks = DurableTaskListSchema.parse({
      items: [{ ...detail.task, latestRun: running }, mockState.tasks.items[1]],
      activeTaskIds: [taskA],
    });
    const state = await openHarness();
    await state.selectTask(taskA);
    const response = deferred<DurableTaskDetail>();
    vi.mocked(api.fetchAgentTask).mockImplementationOnce(() => response.promise);
    const pending = state.selectTask(taskB);
    const selectedDuringLoad = state.selectedTask.value?.task.id;
    // The UI derives its input/cancel controls from the detail; a stale
    // detail of task A must not be actionable while B is loading.
    await state.steer('Message intended for the newly selected task');
    response.resolve(mockState.details.get(taskB)!);
    await pending;
    expect(selectedDuringLoad).not.toBe(taskA);
    expect(api.steerAgentRun).not.toHaveBeenCalled();
    expect(state.selectedTaskId.value).toBe(taskB);
    expect(state.selectedTask.value?.task.id).toBe(taskB);
  });

  it('F4: must ignore an older task-list response after a newer one has arrived', async () => {
    const oldResponse = deferred<DurableTaskList>();
    vi.mocked(api.fetchAgentTasks).mockImplementationOnce(() => oldResponse.promise);
    // The mount request captured an empty list. Tasks were created before a
    // second (for example SSE-triggered) refresh returns the current list.
    const state = await openHarness();
    await state.refreshTasks();
    await state.selectTask(taskB);
    oldResponse.resolve(DurableTaskListSchema.parse({ items: [] }));
    await flushPromises();
    expect(state.selectedTaskId.value).toBe(taskB);
    expect(state.tasks.value.items).toHaveLength(2);
  });

  it('F5: must preserve navigation when a review request for another task completes', async () => {
    const state = await openHarness();
    await state.selectTask(taskA);
    const response = deferred<AgentRunSnapshot>();
    vi.mocked(api.startAgentReview).mockImplementationOnce(() => response.promise);
    const pending = state.startReview({ sourceRunId: runA, resultRevision: revisionA });
    await state.selectTask(taskB);
    response.resolve(idle);
    await pending;
    expect(state.selectedTaskId.value).toBe(taskB);
    expect(state.reviewing.value).toBe(false);
    expect(state.error.value).toBe('');
  });

  it('F5: must not attach the error of a mutation to another selected task', async () => {
    const state = await openHarness();
    await state.selectTask(taskA);
    const response = deferred<never>();
    vi.mocked(api.startAgentCorrection).mockImplementationOnce(() => response.promise);
    const pending = state.startCorrection({ reviewId: runA, findingIds: [taskB] });
    await state.selectTask(taskB);
    response.reject(new Error('Correction failed after navigation'));
    await pending;
    await flushPromises();
    expect(state.selectedTaskId.value).toBe(taskB);
    expect(state.error.value).toBe('');
  });

  it('F3: must apply the same sequence guard to the selected task as to the global snapshot', async () => {
    const response = deferred<AgentRunSnapshot>();
    vi.mocked(api.fetchAgent).mockImplementationOnce(() => response.promise);
    let callbacks!: Parameters<typeof api.subscribeAgent>[0];
    vi.mocked(api.subscribeAgent).mockImplementationOnce((value) => {
      callbacks = value;
      return () => undefined;
    });
    const state = await openHarness();
    await state.selectTask(taskA);
    const newer = AgentRunSnapshotSchema.parse({ ...idle, runId: runA, sequence: 20 });
    callbacks.onSnapshot(newer);
    await flushPromises();
    // The older initial HTTP answer arrives after SSE advanced the stream.
    response.resolve(AgentRunSnapshotSchema.parse({ ...newer, sequence: 5 }));
    await flushPromises();
    expect(state.snapshot.value?.sequence).toBe(20);
    expect(state.selectedTask.value?.latestSnapshot?.sequence).toBe(20);
  });

  it('F6: must not restart delivery polling when a detail response arrives after unmount', async () => {
    vi.useFakeTimers();
    const state = await openHarness();
    const response = deferred<DurableTaskDetail>();
    vi.mocked(api.fetchAgentTask).mockImplementationOnce(() => response.promise);
    const pending = state.selectTask(taskA);
    mounted[0]!.unmount();
    mounted.splice(0);
    const detail = mockState.details.get(taskA)!;
    response.resolve(
      DurableTaskDetailSchema.parse({
        ...detail,
        task: { ...detail.task, latestRun: { ...detail.task.latestRun, status: 'running' } },
        steering: [
          {
            id: taskB,
            runId: runA,
            text: 'Pending delivery',
            status: 'stored',
            createdAt: '2026-09-13T10:00:00.000Z',
            updatedAt: '2026-09-13T10:00:00.000Z',
          },
        ],
      })
    );
    await pending;
    const callsAfterUnmount = vi.mocked(api.fetchAgentTasks).mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    const additionalCalls = vi.mocked(api.fetchAgentTasks).mock.calls.length - callsAfterUnmount;
    vi.clearAllTimers();
    expect(additionalCalls).toBe(0);
  });

  it('F6: must not repopulate the shared cache from a late detail of an unmounted session', async () => {
    vi.useFakeTimers();
    await openHarness();
    const stale = deferred<DurableTaskDetail>();
    vi.mocked(api.fetchAgentTask).mockImplementationOnce(() => stale.promise);
    const state2 = cockpit!;
    const pending = state2.selectTask(taskA);
    mounted[0]!.unmount();
    mounted.splice(0);
    clearAgentCockpitCache();
    stale.resolve(taskDetail(taskA, runA, 99));
    await pending;
    // A fresh session must not inherit the stale reply of the old session.
    const fresh = await openHarness();
    expect(fresh.selectedTaskId.value).toBeUndefined();
    const before = vi.mocked(api.fetchAgentTask).mock.calls.length;
    await fresh.selectTask(taskA);
    // The cached detail comes from the live detail map (version 2), not from
    // the stale late reply (version 99).
    expect(fresh.selectedTask.value?.task.version).toBe(2);
    expect(vi.mocked(api.fetchAgentTask).mock.calls.length).toBe(before + 1);
  });
});
