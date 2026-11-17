import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentRunSnapshotSchema,
  DurableTaskDetailSchema,
  DurableTaskListSchema,
  SERVICE_NAME,
  type AgentRunSnapshot,
  type AgentRunResult,
  type DurableTaskDetail,
  type DurableTaskList,
} from '@observatory/contracts';
import { useAgentCockpit, type AgentCockpitState } from '../src/composables/useAgentCockpit.js';

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

describe('accept/merge result while the user switches tasks', () => {
  it('keeps task B selected when a pending approval of task A completes', async () => {
    setupTwoTasks();
    const wrapper = await mountHarness();
    const state = cockpit!;
    await state.selectTask(taskA);

    let resolveAccept!: (value?: unknown) => void;
    mockState.acceptImpl = () => new Promise((resolve) => (resolveAccept = resolve));
    const pending = state.acceptResult({
      runId: runA,
      resultRevision: revisionA,
    } as AgentRunResult);
    await flushPromises();
    expect(state.accepting.value).toBe(true);

    // The user switches to task B while the approval is still in flight.
    await state.selectTask(taskB);
    expect(state.selectedTaskId.value).toBe(taskB);
    const beforeB = state.selectedTask.value;

    // The approval completes and the durable state of A has advanced.
    mockState.tasks = DurableTaskListSchema.parse({
      items: [taskSummary(taskA, runA, 3), taskSummary(taskB, runB, 1)],
    });
    mockState.details.set(
      taskA,
      DurableTaskDetailSchema.parse({
        ...taskDetail(taskA, runA, 3),
        latestResult: {
          runId: runA,
          resultRevision: revisionA,
          files: [],
          diff: '',
          diffTruncated: false,
          checkStatus: 'passed',
          checks: [],
          acceptedAt: '2026-09-13T10:05:00.000Z',
          acceptedRevision: revisionA,
        },
      })
    );
    resolveAccept();
    await expect(pending).resolves.toBe(true);
    await flushPromises();

    // Task B stays selected with its own data; the flag ends without error.
    expect(state.accepting.value).toBe(false);
    expect(state.selectedTaskId.value).toBe(taskB);
    expect(state.selectedTask.value?.task.id).toBe(taskB);
    expect(state.selectedTask.value).toEqual(beforeB);
    expect(state.error.value).toBe('');
    // Task A's cache is fresh even though B is on screen.
    await state.selectTask(taskA);
    expect(state.selectedTask.value?.task.version).toBe(3);
    expect(state.selectedTask.value?.latestResult?.acceptedRevision).toBe(revisionA);
    wrapper.unmount();
  });

  it('shows the approval error only while task A is still selected', async () => {
    setupTwoTasks();
    const wrapper = await mountHarness();
    const state = cockpit!;
    await state.selectTask(taskA);

    let rejectAccept!: (cause?: unknown) => void;
    mockState.acceptImpl = () => new Promise((_resolve, reject) => (rejectAccept = reject));
    const pending = state.acceptResult({
      runId: runA,
      resultRevision: revisionA,
    } as AgentRunResult);
    await flushPromises();

    await state.selectTask(taskB);
    mockState.details.set(taskA, taskDetail(taskA, runA, 3));
    rejectAccept(new Error('conflict'));
    await expect(pending).resolves.toBe(false);
    await flushPromises();

    expect(state.accepting.value).toBe(false);
    expect(state.selectedTaskId.value).toBe(taskB);
    expect(state.error.value).toBe('');
    wrapper.unmount();
  });

  it('keeps task B selected and fresh when a pending merge of task A completes', async () => {
    setupTwoTasks();
    const approvedA = DurableTaskDetailSchema.parse({
      ...taskDetail(taskA, runA, 2),
      latestResult: {
        runId: runA,
        resultRevision: revisionA,
        files: [],
        diff: '',
        diffTruncated: false,
        checkStatus: 'passed',
        checks: [],
        acceptedAt: '2026-09-13T10:05:00.000Z',
        acceptedRevision: revisionA,
      },
    });
    mockState.details.set(taskA, approvedA);
    const wrapper = await mountHarness();
    const state = cockpit!;
    await state.selectTask(taskA);

    let resolveMerge!: (value?: unknown) => void;
    mockState.mergeImpl = () => new Promise((resolve) => (resolveMerge = resolve));
    const pending = state.mergeResult({
      runId: runA,
      resultRevision: revisionA,
      acceptedAt: '2026-09-13T10:05:00.000Z',
      acceptedRevision: revisionA,
    } as AgentRunResult);
    await flushPromises();
    expect(state.merging.value).toBe(true);

    await state.selectTask(taskB);
    expect(state.selectedTaskId.value).toBe(taskB);
    const beforeB = state.selectedTask.value;

    const mergedA = DurableTaskDetailSchema.parse({
      ...approvedA,
      latestResult: {
        ...approvedA.latestResult,
        mergedAt: '2026-09-13T10:06:00.000Z',
        mergedRevision: 'd'.repeat(40),
      },
    });
    mockState.details.set(taskA, mergedA);
    resolveMerge();
    await expect(pending).resolves.toBe(true);
    await flushPromises();

    expect(state.merging.value).toBe(false);
    expect(state.selectedTaskId.value).toBe(taskB);
    expect(state.selectedTask.value?.task.id).toBe(taskB);
    expect(state.selectedTask.value).toEqual(beforeB);
    expect(state.error.value).toBe('');
    await state.selectTask(taskA);
    expect(state.selectedTask.value?.latestResult?.mergedRevision).toBe('d'.repeat(40));
    wrapper.unmount();
  });

  it('does not carry a merge conflict marker across tasks', async () => {
    setupTwoTasks();
    const approvedA = DurableTaskDetailSchema.parse({
      ...taskDetail(taskA, runA, 2),
      latestResult: {
        runId: runA,
        resultRevision: revisionA,
        files: [],
        diff: '',
        diffTruncated: false,
        checkStatus: 'passed',
        checks: [],
        acceptedAt: '2026-09-13T10:05:00.000Z',
        acceptedRevision: revisionA,
      },
    });
    mockState.details.set(taskA, approvedA);
    const wrapper = await mountHarness();
    const state = cockpit!;
    await state.selectTask(taskA);

    // A stale marker from an older attempt must be cleared by a new attempt.
    state.conflictedRunId.value = '00000000-0000-4000-8000-000000000000';
    let rejectMerge!: (cause?: unknown) => void;
    mockState.mergeImpl = () => new Promise((_resolve, reject) => (rejectMerge = reject));
    const pending = state.mergeResult({
      runId: runA,
      resultRevision: revisionA,
      acceptedAt: '2026-09-13T10:05:00.000Z',
      acceptedRevision: revisionA,
    } as AgentRunResult);
    await flushPromises();
    expect(state.conflictedRunId.value).toBeUndefined();

    await state.selectTask(taskB);
    const HealthFetchError = (
      await import('../src/lib/api.js')
    ).HealthFetchError;
    rejectMerge(new HealthFetchError('merge conflict', 'http', 409, 'agent', 'merge_conflict'));
    await expect(pending).resolves.toBe(false);
    await flushPromises();

    expect(state.merging.value).toBe(false);
    expect(state.selectedTaskId.value).toBe(taskB);
    expect(state.conflictedRunId.value).toBeUndefined();
    expect(state.error.value).toBe('');
    wrapper.unmount();
  });
});
