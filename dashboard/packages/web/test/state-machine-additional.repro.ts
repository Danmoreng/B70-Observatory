import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, nextTick } from 'vue';
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
import { useAgentCockpit, clearAgentCockpitCache, type AgentCockpitState } from '../src/composables/useAgentCockpit.js';
import * as api from '../src/lib/api.js';
import AgentCockpit from '../src/components/AgentCockpit.vue';
import { appRoute } from '../src/composables/useAppRoute.js';

const taskA = '66666666-6666-4666-8666-666666666666';
const taskB = '77777777-7777-4777-8777-777777777777';
const runA = '22222222-2222-4222-8222-222222222222';
const runB = '33333333-3333-4333-8333-333333333333';
const revisionA = 'c'.repeat(40);

const mockState = vi.hoisted(() => ({
  snapshot: undefined as AgentRunSnapshot | undefined,
  tasks: { items: [], activeTaskIds: [] } as unknown as DurableTaskList,
  details: new Map<string, DurableTaskDetail>(),
  acceptImpl: undefined as ((input: unknown) => Promise<unknown>) | undefined,
  mergeImpl: undefined as ((input: unknown) => Promise<unknown>) | undefined,
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
  acceptAgentRunResult: vi.fn((input: unknown) => mockState.acceptImpl?.(input) ?? Promise.resolve()),
  mergeAgentRunResult: vi.fn((input: unknown) => mockState.mergeImpl?.(input) ?? Promise.resolve()),
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

async function mountHarness() {
  const wrapper = mount(Harness);
  await flushPromises();
  return wrapper;
}

afterEach(() => {
  mockState.acceptImpl = undefined;
  mockState.mergeImpl = undefined;
  mockState.details.clear();
});

// Audit-only reproductions. Each test states the desired invariant. Failures
// against ce1756b are evidence; these tests are not a production change.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const mounted: Array<{ unmount(): void }> = [];
beforeEach(() => {
  clearAgentCockpitCache();
  vi.clearAllMocks();
  setupTwoTasks();
  appRoute.page = 'agent';
  appRoute.taskId = undefined;
});
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount());
  clearAgentCockpitCache();
  vi.useRealTimers();
});
async function openHarness() {
  const wrapper = await mountHarness();
  mounted.push(wrapper);
  return cockpit!;
}

describe('independent additional async lifecycle checks', () => {
  it('must not repopulate the shared task-list cache after unmount and sign-out clearing', async () => {
    const old = deferred<DurableTaskList>();
    vi.mocked(api.fetchAgentTasks).mockImplementationOnce(() => old.promise);
    await openHarness();
    mounted.pop()!.unmount();
    clearAgentCockpitCache();
    old.resolve(mockState.tasks);
    await flushPromises();
    const current = deferred<DurableTaskList>();
    vi.mocked(api.fetchAgentTasks).mockImplementationOnce(() => current.promise);
    const next = await openHarness();
    const initialCount = next.tasks.value.items.length;
    current.resolve(mockState.tasks);
    await flushPromises();
    expect(initialCount).toBe(0);
  });

  it('must not repopulate shared task details after unmount and cache clearing', async () => {
    const state = await openHarness();
    const old = deferred<DurableTaskDetail>();
    vi.mocked(api.fetchAgentTask).mockImplementationOnce(() => old.promise);
    const pending = state.selectTask(taskA);
    mounted.pop()!.unmount();
    clearAgentCockpitCache();
    old.resolve(mockState.details.get(taskA)!);
    await pending;
    const next = await openHarness();
    const callsBefore = vi.mocked(api.fetchAgentTask).mock.calls.length;
    await next.selectTask(taskA);
    expect(vi.mocked(api.fetchAgentTask).mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('must not let an older detail request regress the cache after a newer detail request', async () => {
    const state = await openHarness();
    const old = deferred<DurableTaskDetail>();
    const newer = deferred<DurableTaskDetail>();
    vi.mocked(api.fetchAgentTask)
      .mockImplementationOnce(() => old.promise)
      .mockImplementationOnce(() => newer.promise);
    const pendingOld = state.selectTask(taskA);
    const pendingNew = state.selectTask(taskA);
    const detail = mockState.details.get(taskA)!;
    const withSequence = (sequence: number) => DurableTaskDetailSchema.parse({
      ...detail, latestSnapshot: { ...idle, runId: runA, sequence },
    });
    newer.resolve(withSequence(20));
    await pendingNew;
    old.resolve(withSequence(5));
    await pendingOld;
    await state.selectTask(taskA);
    expect(state.selectedTask.value?.latestSnapshot?.sequence).toBe(20);
  });
});

async function openHistory() {
  const detail = mockState.details.get(taskA)!;
  const currentRun = { ...detail.task.latestRun, id: '44444444-4444-4444-8444-444444444444' };
  mockState.details.set(taskA, DurableTaskDetailSchema.parse({
    ...detail, task: { ...detail.task, latestRun: currentRun },
    runs: [detail.task.latestRun, { ...detail.task.latestRun, id: runB }, currentRun],
    latestSnapshot: { ...idle, runId: currentRun.id, sequence: 20 },
  }));
  appRoute.taskId = taskA;
  const wrapper = mount(AgentCockpit, {
    global: { stubs: Object.fromEntries([
      'AgentImagePicker', 'AgentDictation', 'AppDialog', 'AgentRunSummary',
      'AgentTaskInput', 'AgentPendingMessages', 'AgentTaskList', 'AgentTimeline',
      'AgentDesktopPanel', 'AgentResultPanel', 'AgentLiveChanges', 'AgentTaskMetrics',
      'AgentReviewPanel', 'AgentReleasePanel', 'AgentAppPanel',
    ].map((name) => [name, true])) },
  });
  mounted.push(wrapper);
  await flushPromises();
  await nextTick();
  return { currentRunId: currentRun.id, vm: wrapper.vm as unknown as {
    selectRun(id: string): Promise<void>;
    selectedRunId: string | undefined;
    historicalSnapshot: AgentRunSnapshot | undefined;
    displayedSnapshot: AgentRunSnapshot | undefined;
  } };
}
function trace(runId: string): DurableTraceEvent[] {
  return [DurableTraceEventSchema.parse({
    id: 1, runId, sequence: 1, recordedAt: '2026-11-07T12:00:00.000Z',
    event: { operation: 'reset', sequence: 1, snapshot: { ...idle, sequence: 1, runId } },
  })];
}
describe('independent additional history checks', () => {
  it('must not show the latest run under a historical selection while its trace loads', async () => {
    const {vm} = await openHistory();
    const old = deferred<DurableTraceEvent[]>();
    vi.mocked(api.collectAgentRunTrace).mockImplementationOnce(() => old.promise);
    const pending = vm.selectRun(runA);
    const shownDuringLoad = vm.displayedSnapshot?.runId;
    old.resolve(trace(runA));
    await pending;
    expect(shownDuringLoad === undefined || shownDuringLoad === runA).toBe(true);
  });

  it('must retain a newer history selection after an older request rejects', async () => {
    const {vm} = await openHistory();
    let reject!: (error: Error) => void;
    const old = new Promise<DurableTraceEvent[]>((_resolve, fail) => { reject = fail; });
    vi.mocked(api.collectAgentRunTrace)
      .mockImplementationOnce(() => old)
      .mockResolvedValueOnce(trace(runB));
    const oldSelection = vm.selectRun(runA);
    await vm.selectRun(runB);
    reject(new Error('Old history request failed'));
    await oldSelection;
    expect(vm.selectedRunId).toBe(runB);
    expect(vm.historicalSnapshot?.runId).toBe(runB);
  });

  it('must invalidate pending history when the latest run is selected', async () => {
    const {vm,currentRunId} = await openHistory();
    const old = deferred<DurableTraceEvent[]>();
    vi.mocked(api.collectAgentRunTrace).mockImplementationOnce(() => old.promise);
    const oldSelection = vm.selectRun(runA);
    await vm.selectRun(currentRunId);
    old.resolve(trace(runA));
    await oldSelection;
    expect(vm.historicalSnapshot).toBeUndefined();
  });

  it('must invalidate pending history when the selected task changes', async () => {
    const {vm} = await openHistory();
    const old = deferred<DurableTraceEvent[]>();
    vi.mocked(api.collectAgentRunTrace).mockImplementationOnce(() => old.promise);
    const oldSelection = vm.selectRun(runA);
    appRoute.taskId = taskB;
    await flushPromises();
    old.resolve(trace(runA));
    await oldSelection;
    expect(vm.selectedRunId).toBeUndefined();
    expect(vm.historicalSnapshot).toBeUndefined();
  });
});
