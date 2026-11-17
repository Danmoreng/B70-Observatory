import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentRunSnapshotSchema,
  DurableTaskDetailSchema,
  DurableTaskListSchema,
  DurableTraceEventSchema,
  SERVICE_NAME,
  type AgentRunSnapshot,
  type DurableTaskDetail,
  type DurableTaskList,
  type DurableTraceEvent,
} from '@observatory/contracts';
import { clearAgentCockpitCache } from '../src/composables/useAgentCockpit.js';
import * as api from '../src/lib/api.js';
import AgentCockpit from '../src/components/AgentCockpit.vue';
import { appRoute } from '../src/composables/useAppRoute.js';

const taskA = '66666666-6666-4666-8666-666666666666';
const taskB = '77777777-7777-4777-8777-777777777777';
const runA = '22222222-2222-4222-8222-222222222222';
const runB = '33333333-3333-4333-8333-333333333333';
const currentRun = '44444444-4444-4444-8444-444444444444';

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
  regenerateAgentTaskTitle: vi.fn(async () => ({ regenerated: false })),
  registerAgentProject: vi.fn(async () => ({ id: 'p' })),
  createAgentProject: vi.fn(async () => ({ id: 'p' })),
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
    },
  };
}

function setup(): void {
  mockState.snapshot = idle;
  const summaryA = taskSummary(taskA, currentRun, 3);
  mockState.tasks = DurableTaskListSchema.parse({
    items: [summaryA, taskSummary(taskB, runA, 1)],
  });
  const baseRun = summaryA.latestRun;
  const historyA = { ...baseRun, id: runA };
  const historyB = { ...baseRun, id: runB };
  const detailA = DurableTaskDetailSchema.parse({
    task: summaryA,
    runs: [historyA, historyB, baseRun],
    messages: [],
    latestSnapshot: idle,
    traceEventCount: 0,
  });
  mockState.details.set(taskA, detailA);
  mockState.details.set(
    taskB,
    DurableTaskDetailSchema.parse({
      task: taskSummary(taskB, runA, 1),
      runs: [taskSummary(taskB, runA, 1).latestRun],
      messages: [],
      latestSnapshot: idle,
      traceEventCount: 0,
    })
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function trace(runId: string): DurableTraceEvent[] {
  return [
    DurableTraceEventSchema.parse({
      id: 1,
      runId,
      sequence: 1,
      recordedAt: '2026-11-07T12:00:00.000Z',
      event: { operation: 'reset', sequence: 1, snapshot: { ...idle, sequence: 1, runId } },
    }),
  ];
}

type CockpitVm = {
  selectRun(id: string): Promise<void>;
  selectedRunId: string | undefined;
  historicalSnapshot: AgentRunSnapshot | undefined;
};

const mounted: Array<{ unmount(): void }> = [];

async function openCockpit() {
  const wrapper = mount(AgentCockpit, {
    global: {
      stubs: Object.fromEntries(
        [
          'AgentImagePicker',
          'AgentDictation',
          'AppDialog',
          'AgentRunSummary',
          'AgentTaskInput',
          'AgentPendingMessages',
          'AgentTaskList',
          'AgentTimeline',
          'AgentDesktopPanel',
          'AgentResultPanel',
          'AgentLiveChanges',
          'AgentTaskMetrics',
          'AgentReviewPanel',
          'AgentReleasePanel',
          'AgentAppPanel',
        ].map((name) => [name, true])
      ),
    },
  });
  mounted.push(wrapper);
  await flushPromises();
  await nextTick();
  return wrapper.vm as unknown as CockpitVm;
}

beforeEach(() => {
  clearAgentCockpitCache();
  vi.clearAllMocks();
  localStorage.clear();
  setup();
  appRoute.page = 'agent';
  appRoute.taskId = taskA;
});

afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount());
  clearAgentCockpitCache();
  vi.useRealTimers();
});

describe('historical run selection (F2)', () => {
  it('restores a valid selected run and metrics scope after remounting, rejecting foreign runs', async () => {
    localStorage.setItem(
      'observatory.task-view.' + taskA,
      JSON.stringify({ runId: runA, metricsScope: 'task' })
    );
    vi.mocked(api.collectAgentRunTrace).mockResolvedValue(trace(runA));
    const vm = await openCockpit();
    expect(vm.selectedRunId).toBe(runA);
    expect(vm.historicalSnapshot?.runId).toBe(runA);
    expect((vm as unknown as { metricsScope: string }).metricsScope).toBe('task');
    appRoute.taskId = taskB;
    await flushPromises();
    expect(vm.selectedRunId).toBeUndefined();
  });
  it('keeps the newest run when trace responses arrive out of order', async () => {
    const vm = await openCockpit();
    const older = deferred<DurableTraceEvent[]>();
    const newer = deferred<DurableTraceEvent[]>();
    vi.mocked(api.collectAgentRunTrace)
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    const oldSelection = vm.selectRun(runA);
    const newSelection = vm.selectRun(runB);
    newer.resolve(trace(runB));
    await newSelection;
    older.resolve(trace(runA));
    await oldSelection;
    expect(vm.selectedRunId).toBe(runB);
    expect(vm.historicalSnapshot?.runId).toBe(runB);
  });

  it('does not show a previous run history while the selected run is loading', async () => {
    const vm = await openCockpit();
    const first = deferred<DurableTraceEvent[]>();
    const second = deferred<DurableTraceEvent[]>();
    vi.mocked(api.collectAgentRunTrace)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const firstSelection = vm.selectRun(runA);
    first.resolve(trace(runA));
    await firstSelection;
    const pending = vm.selectRun(runB);
    expect(vm.selectedRunId).toBe(runB);
    expect(vm.historicalSnapshot).toBeUndefined();
    second.resolve(trace(runB));
    await pending;
    expect(vm.historicalSnapshot?.runId).toBe(runB);
  });

  it('keeps the newer selection when an older request fails late', async () => {
    const vm = await openCockpit();
    const older = deferred<DurableTraceEvent[]>();
    const newer = deferred<DurableTraceEvent[]>();
    vi.mocked(api.collectAgentRunTrace)
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    const oldSelection = vm.selectRun(runA);
    const newSelection = vm.selectRun(runB);
    newer.resolve(trace(runB));
    await newSelection;
    older.reject(new Error('late failure'));
    await expect(oldSelection).resolves.toBeUndefined();
    expect(vm.selectedRunId).toBe(runB);
    expect(vm.historicalSnapshot?.runId).toBe(runB);
  });

  it('selecting the current/latest run invalidates a pending history request', async () => {
    const vm = await openCockpit();
    const pending = deferred<DurableTraceEvent[]>();
    vi.mocked(api.collectAgentRunTrace).mockImplementationOnce(() => pending.promise);
    const oldSelection = vm.selectRun(runA);
    void vm.selectRun(currentRun);
    expect(vm.selectedRunId).toBe(currentRun);
    expect(vm.historicalSnapshot).toBeUndefined();
    pending.resolve(trace(runA));
    await oldSelection;
    expect(vm.selectedRunId).toBe(currentRun);
    expect(vm.historicalSnapshot).toBeUndefined();
  });

  it('ignores a late trace response after the task selection changed', async () => {
    const vm = await openCockpit();
    const pending = deferred<DurableTraceEvent[]>();
    vi.mocked(api.collectAgentRunTrace).mockImplementationOnce(() => pending.promise);
    const oldSelection = vm.selectRun(runA);
    appRoute.taskId = taskB;
    await flushPromises();
    expect(vm.selectedRunId).toBeUndefined();
    pending.resolve(trace(runA));
    await oldSelection;
    expect(vm.selectedRunId).toBeUndefined();
    expect(vm.historicalSnapshot).toBeUndefined();
  });
});
