import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentRunSnapshotSchema,
  DurableTaskDetailSchema,
  DurableTaskListSchema,
  SERVICE_NAME,
  type AgentRunSnapshot,
  type AgentProject,
  type DurableTaskDetail,
  type DurableTaskList,
  type DurableSteering,
} from '@observatory/contracts';
import { appRoute } from '../src/composables/useAppRoute.js';
import AgentCockpit from '../src/components/AgentCockpit.vue';
import WorkbenchBreadcrumb from '../src/components/WorkbenchBreadcrumb.vue';
import AgentTimeline from '../src/components/agent/AgentTimeline.vue';
import { clearAgentCockpitCache } from '../src/composables/useAgentCockpit.js';
import { agentDraftKey } from '../src/lib/drafts.js';
import {
  answerAgentQuestion,
  createAgentProject,
  startAgentRun,
  fetchAgentRunTrace,
  fetchAgentTask,
  fetchAgentProjects,
  queueAgentFollowup,
  steerAgentRun,
} from '../src/lib/api.js';

interface Subscriber {
  onSnapshot: (snapshot: AgentRunSnapshot) => void;
  onError: (cause: { code: string; message: string }) => void;
  onOpen: () => void;
}

const mockState = vi.hoisted(() => ({
  snapshot: undefined as AgentRunSnapshot | undefined,
  subscriber: undefined as Subscriber | undefined,
  tasks: { items: [], activeTaskIds: [] } as DurableTaskList,
  details: new Map<string, DurableTaskDetail>(),
}));

vi.mock('../src/lib/api.js', () => {
  interface MockTracePage {
    runId: string;
    items: never[];
    hasMore: boolean;
    nextAfterSequence?: number;
  }
  const fetchAgentRunTrace = vi.fn(
    async (runId: string, afterSequence: number, limit: number): Promise<MockTracePage> => {
      // Single page that never paginates; the cursor arguments exist so the
      // export test can assert the request contract.
      void afterSequence;
      void limit;
      return { runId, items: [], hasMore: false };
    }
  );
  return {
    fetchAppPreview: vi.fn(async () => undefined),
    fetchAgentDesktopFrame: vi.fn(async () => undefined),
    fetchSpeechStatus: vi.fn(async () => ({ available: false, device: 'cpu', maxSeconds: 120 })),
    transcribeSpeech: vi.fn(),
    HealthFetchError: class HealthFetchError extends Error {},
    fetchAgent: vi.fn(async () => mockState.snapshot),
    fetchAgentTasks: vi.fn(async () => mockState.tasks),
    fetchAgentTask: vi.fn(async (taskId: string) => mockState.details.get(taskId)),
    fetchAgentProjects: vi.fn(async (): Promise<AgentProject[]> => []),
    createAgentProject: vi.fn(async () => ({ id: '91919191-9191-4191-8191-919191919191' })),
    fetchAgentRunTrace,
    // Mirror of the real pagination walk so the component's export path runs
    // against the mocked page fetch (the helper itself is unit-tested in
    // apiExtra.test.ts).
    collectAgentRunTrace: vi.fn(
      async (
        runId: string,
        options: { afterSequence?: number; failOnStalledCursor?: boolean } = {}
      ) => {
        const events: unknown[] = [];
        let cursor = options.afterSequence ?? -1;
        for (;;) {
          const page = await fetchAgentRunTrace(runId, cursor, 250);
          events.push(...page.items);
          if (!page.hasMore) return events;
          const next = page.nextAfterSequence;
          if (next === undefined || next <= cursor) {
            if (options.failOnStalledCursor) throw new Error('Trace cursor did not advance.');
            return events;
          }
          cursor = next;
        }
      }
    ),
    deleteAgentTask: vi.fn(async () => true),
    startAgentRun: vi.fn(async () => mockState.snapshot),
    steerAgentRun: vi.fn(async () => mockState.snapshot),
    cancelAgentRun: vi.fn(async () => mockState.snapshot),
    continueAgentTask: vi.fn(async () => mockState.snapshot),
    queueAgentFollowup: vi.fn(async () => ({ queued: true })),
    answerAgentQuestion: vi.fn(async () => mockState.snapshot),
    fetchAgentRunResult: vi.fn(async () => undefined),
    acceptAgentRunResult: vi.fn(async () => undefined),
    mergeAgentRunResult: vi.fn(async () => undefined),
    subscribeAgent: vi.fn((subscriber: Subscriber) => {
      mockState.subscriber = subscriber;
      queueMicrotask(() => {
        if (mockState.snapshot !== undefined) subscriber.onSnapshot(mockState.snapshot);
      });
      return vi.fn();
    }),
  };
});

const idle = AgentRunSnapshotSchema.parse({
  service: SERVICE_NAME,
  enabled: true,
  status: 'idle',
  sequence: 0,
  pendingSteering: 0,
  timeline: [],
});

const active = AgentRunSnapshotSchema.parse({
  ...idle,
  status: 'running',
  sequence: 4,
  runId: '22222222-2222-4222-8222-222222222222',
  name: 'Gezielter UI-Test',
  task: 'Prüfe ausschließlich die Timeline.',
  model: 'Qwen3.8-27B',
  thinkingLevel: 'high',
  startedAt: '2026-09-13T10:00:00.000Z',
  pendingSteering: 1,
  timeline: [
    {
      id: '33333333-3333-4333-8333-333333333333',
      at: '2026-09-13T10:00:01.000Z',
      kind: 'thinking',
      title: 'Denken',
      text: 'Nur die benannten Dateien untersuchen.',
      state: 'complete',
    },
    {
      id: '44444444-4444-4444-8444-444444444444',
      at: '2026-09-13T10:00:02.000Z',
      kind: 'tool',
      title: 'bash · gezielter Test',
      argumentsText: JSON.stringify({ command: 'npm run test -- packages/web' }, null, 2),
      outputText: `Testausgabe ${'packages/web/'.repeat(400)}`,
      state: 'running',
      toolName: 'bash',
    },
  ],
});

async function mountFixture(snapshot: AgentRunSnapshot) {
  window.location.hash = '#/agent';
  Object.assign(appRoute, {
    page: 'agent',
    taskId: undefined,
    projectId: undefined,
    view: undefined,
  });
  mockState.snapshot = snapshot;
  mockState.subscriber = undefined;
  const wrapper = mount({
    components: { AgentCockpit, WorkbenchBreadcrumb },
    template: '<WorkbenchBreadcrumb/><AgentCockpit/>',
  });
  await flushPromises();
  await nextTick();
  return wrapper;
}

async function mountSelected(
  snapshot: AgentRunSnapshot,
  status: 'running' | 'completed' | 'failed' | 'yielded' = 'running',
  withQuestion = false,
  withResult = false,
  steering: DurableSteering[] = []
) {
  const taskId = '66666666-6666-4666-8666-666666666666';
  const run = {
    id: snapshot.runId!,
    taskId,
    turnId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    status,
    version: 2,
    profileId: 'coding-default-v1',
    baseRevision: 'a'.repeat(40),
    checkStatus: 'not_run' as const,
    createdAt: snapshot.startedAt!,
    startedAt: snapshot.startedAt!,
    ...(snapshot.finishedAt === undefined ? {} : { finishedAt: snapshot.finishedAt }),
    ...(withResult ? { resultRevision: 'c'.repeat(40) } : {}),
  };
  mockState.tasks = DurableTaskListSchema.parse({
    items: [
      {
        id: taskId,
        title: snapshot.name!,
        status: 'open',
        version: 2,
        createdAt: snapshot.startedAt!,
        updatedAt: snapshot.finishedAt ?? snapshot.startedAt!,
        latestRun: run,
      },
    ],
    ...(status === 'running' ? { activeTaskId: taskId, activeTaskIds: [taskId] } : {}),
  });
  mockState.details.set(
    taskId,
    DurableTaskDetailSchema.parse({
      task: mockState.tasks.items[0],
      runs: [run],
      messages: [],
      steering,
      ...(withResult
        ? {
            latestResult: {
              runId: run.id,
              resultRevision: 'c'.repeat(40),
              files: ['dashboard/packages/web/src/App.vue'],
              diff: '',
              diffTruncated: false,
              checkStatus: 'passed',
              checks: [],
            },
          }
        : {}),
      latestSnapshot: snapshot,
      traceEventCount: snapshot.sequence,
      ...(withQuestion
        ? {
            openQuestion: {
              id: '12121212-1212-4212-8212-121212121212',
              taskId,
              runId: run.id,
              question: 'Hours or days?',
              status: 'open',
              createdAt: snapshot.finishedAt ?? snapshot.startedAt!,
            },
          }
        : {}),
    })
  );
  const wrapper = await mountFixture(snapshot);
  await wrapper.get('.task-table-row').trigger('click');
  await flushPromises();
  return wrapper;
}

/**
 * One task with a completed previous run and a still running latest run;
 * the global stream belongs to the latest run. Selects the task, so the
 * conversation view with the live timeline is open.
 */
async function mountTwoRunTask() {
  const taskId = '66666666-6666-4666-8666-666666666666';
  const previousRunId = '88888888-8888-4888-8888-888888888888';
  const currentRun = {
    id: active.runId!,
    taskId,
    turnId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    status: 'running' as const,
    version: 3,
    profileId: 'coding-default-v1',
    baseRevision: 'a'.repeat(40),
    checkStatus: 'not_run' as const,
    createdAt: active.startedAt!,
    startedAt: active.startedAt!,
  };
  const previousRun = {
    ...currentRun,
    id: previousRunId,
    turnId: '99999999-9999-4999-8999-999999999999',
    status: 'completed' as const,
    createdAt: '2026-09-13T09:00:00.000Z',
    startedAt: '2026-09-13T09:00:00.000Z',
    finishedAt: '2026-09-13T09:10:00.000Z',
  };
  mockState.tasks = DurableTaskListSchema.parse({
    activeTaskId: taskId,
    activeTaskIds: [taskId],
    items: [
      {
        id: taskId,
        title: 'Gezielter UI-Test',
        status: 'open',
        version: 3,
        createdAt: previousRun.createdAt,
        updatedAt: active.startedAt!,
        latestRun: currentRun,
      },
    ],
  });
  mockState.details.set(
    taskId,
    DurableTaskDetailSchema.parse({
      task: mockState.tasks.items[0],
      runs: [previousRun, currentRun],
      messages: [],
      latestSnapshot: active,
      traceEventCount: active.sequence,
    })
  );
  const wrapper = await mountFixture(active);
  await wrapper.get('.task-table-row').trigger('click');
  await flushPromises();
  return wrapper;
}

/** Details keeps its selection visible; open Conversation explicitly after picking a run. */
async function selectHistoricalRun(wrapper: Awaited<ReturnType<typeof mountTwoRunTask>>) {
  const detailsTab = wrapper
    .findAll('.task-view-tabs button')
    .find((button) => button.text().startsWith('Details'))!;
  await detailsTab.trigger('click');
  await wrapper.findAll('.run-list button')[1]!.trigger('click');
  await flushPromises();
  expect(wrapper.find('.details-view').exists()).toBe(true);
  await wrapper
    .findAll('.task-view-tabs button')
    .find((button) => button.text().startsWith('Conversation'))!
    .trigger('click');
  expect(wrapper.find('.conversation-view').exists()).toBe(true);
}

afterEach(() => {
  clearAgentCockpitCache();
  mockState.snapshot = undefined;
  mockState.subscriber = undefined;
  mockState.tasks = { items: [], activeTaskIds: [] };
  mockState.details.clear();
  vi.restoreAllMocks();
});

describe('Agent Cockpit UI fixtures', () => {
  it('opens the compact screenshot pane for browser tools in a desktop-enabled run', async () => {
    vi.spyOn(globalThis, 'matchMedia').mockReturnValue({
      matches: true,
      media: '(min-width: 1100px)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: () => true,
    });
    for (const desktopAvailable of [false, true]) {
      clearAgentCockpitCache();
      const snapshot = AgentRunSnapshotSchema.parse({
        ...active,
        desktopAvailable,
        timeline: [{ ...active.timeline[1], toolName: 'browser_open', title: 'browser_open' }],
      });
      const wrapper = await mountSelected(snapshot);
      expect(wrapper.find('.desktop-panel').exists()).toBe(desktopAvailable);
      expect(wrapper.find('.screenshot-workspace').exists()).toBe(desktopAvailable);
      expect(wrapper.find('.desktop-toolbar, .desktop-panel footer').exists()).toBe(false);
      expect(wrapper.find('.conversation-view').exists()).toBe(true);
      expect(wrapper.find('.tool-payload-card').exists()).toBe(true);
      wrapper.unmount();
    }
  });

  it('opens app controls only through the App Preview tab', async () => {
    vi.mocked(fetchAgentProjects).mockResolvedValueOnce([
      {
        id: '00000000-0000-4000-8000-000000000000',
        name: 'Preview project',
        repositoryPath: '/tmp/preview',
        targetBranch: 'main',
        workdir: '.',
        editPaths: ['.'],
        checks: [],
        appCapable: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const wrapper = await mountSelected(active);
    expect(wrapper.find('.agent-app-panel').exists()).toBe(false);
    const preview = wrapper
      .findAll('.task-view-tabs button')
      .find((b) => b.text() === 'App preview')!;
    expect(preview).toBeDefined();
    await preview.trigger('click');
    await flushPromises();
    expect(wrapper.find('.app-preview-view.agent-app-panel').exists()).toBe(true);
    await wrapper
      .findAll('.task-view-tabs button')
      .find((b) => b.text() === 'Conversation')!
      .trigger('click');
    expect(wrapper.find('.agent-app-panel').exists()).toBe(false);
    wrapper.unmount();
  });
  it('refreshes delivery confirmation even when cached task/run versions do not change', async () => {
    const message: DurableSteering = {
      id: '71717171-7171-4171-8171-717171717171',
      runId: active.runId!,
      text: 'Use the existing 3D UI',
      status: 'acknowledged',
      createdAt: active.startedAt!,
      updatedAt: active.startedAt!,
      acknowledgedAt: active.startedAt!,
    };
    const wrapper = await mountSelected(active, 'running', false, false, [message]);
    expect(wrapper.get('.pending-messages').text()).toContain(message.text);
    const taskId = '66666666-6666-4666-8666-666666666666';
    const original = mockState.details.get(taskId)!;
    const delivered = AgentRunSnapshotSchema.parse({
      ...active,
      pendingSteering: 0,
      timeline: [
        ...active.timeline,
        {
          id: '72727272-7272-4272-8272-727272727272',
          at: active.startedAt!,
          kind: 'steering',
          title: 'Delivered',
          text: message.text,
          state: 'complete',
        },
      ],
    });
    // The real backend changes confirmedAt without incrementing either version.
    mockState.details.set(taskId, {
      ...original,
      latestSnapshot: delivered,
      steering: [{ ...message, confirmedAt: active.startedAt! }],
    });
    mockState.subscriber?.onSnapshot(delivered);
    await flushPromises();
    expect(wrapper.find('.pending-messages').exists()).toBe(false);
    expect(wrapper.get('.agent-timeline').text()).toContain(message.text);
    expect(mockState.details.get(taskId)?.task.version).toBe(original.task.version);
    wrapper.unmount();
  });

  it('polls a pending delivery to confirmation without requiring another stream event', async () => {
    const message: DurableSteering = {
      id: '73737373-7373-4373-8373-737373737373',
      runId: active.runId!,
      text: 'Pending delivery',
      status: 'acknowledged',
      createdAt: active.startedAt!,
      updatedAt: active.startedAt!,
    };
    const noInboxCount = AgentRunSnapshotSchema.parse({ ...active, pendingSteering: 0 });
    const wrapper = await mountSelected(noInboxCount, 'running', false, false, [message]);
    const taskId = '66666666-6666-4666-8666-666666666666';
    const original = mockState.details.get(taskId)!;
    mockState.details.set(taskId, {
      ...original,
      steering: [{ ...message, confirmedAt: active.startedAt! }],
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await flushPromises();
    expect(wrapper.find('.pending-messages').exists()).toBe(false);
    wrapper.unmount();
  });

  it('focuses the conversation and puts model information and title actions in Details', async () => {
    const wrapper = await mountSelected(active, 'running');
    expect(wrapper.find('.cockpit-heading').exists()).toBe(false);
    expect(wrapper.find('.cockpit-runbar').exists()).toBe(false);
    expect(wrapper.find('.task-context').exists()).toBe(false);
    expect(wrapper.find('.split-workspace').exists()).toBe(false);
    expect(wrapper.find('.task-metric-scope').exists()).toBe(false);
    expect(wrapper.find('.agent-app-panel').exists()).toBe(false);
    expect(wrapper.find('.task-toolbar .task-metrics').exists()).toBe(true);
    expect(wrapper.get('.workbench-breadcrumb .workbench-task-title').text()).toBe(
      'Gezielter UI-Test'
    );
    expect(wrapper.find('.regenerate-title').exists()).toBe(false);
    expect(wrapper.find('.runbar-meta').exists()).toBe(false);
    const details = wrapper
      .findAll('.task-view-tabs button')
      .find((button) => button.text() === 'Details')!;
    await details.trigger('click');
    expect(wrapper.get('.task-metadata').text()).toContain('Qwen3.8-27B');
    expect(wrapper.get('.details-view .task-metric-scope').text()).toContain('All task runs');
    expect(wrapper.find('.task-metadata .regenerate-title').exists()).toBe(true);
    await wrapper.get('.task-back-button').trigger('click');
    await flushPromises();
    expect(wrapper.find('.cockpit-heading').exists()).toBe(true);
    wrapper.unmount();
  });

  it.each(['app', 'github'])(
    'creates a %s repository in the GUI and binds the task to it',
    async (mode) => {
      const wrapper = await mountFixture(idle);
      try {
        await wrapper.get('.task-overview-actions button').trigger('click');
        await wrapper.get('#agent-project-mode').setValue(mode);
        await wrapper.get('#new-project-name').setValue('My new project');
        if (mode === 'github')
          await wrapper.get('#github-url').setValue('https://github.com/octocat/Hello-World');
        await wrapper.get('#agent-name').setValue('App task');
        await wrapper.get('#agent-task').setValue('Build my requested app');
        await wrapper.get('form.agent-form').trigger('submit');
        await flushPromises();
        expect(createAgentProject).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'My new project',
            idempotencyKey: expect.any(String),
            source:
              mode === 'app'
                ? { kind: 'app' }
                : { kind: 'github', url: 'https://github.com/octocat/Hello-World' },
          })
        );
        expect(startAgentRun).toHaveBeenCalledWith(
          expect.objectContaining({
            projectId: '91919191-9191-4191-8191-919191919191',
            task: 'Build my requested app',
          })
        );
      } finally {
        wrapper.unmount();
      }
    }
  );

  it('offers only active projects when creating a new task', async () => {
    const base = {
      targetBranch: 'main',
      workdir: '.',
      editPaths: ['.'],
      checks: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    vi.mocked(fetchAgentProjects).mockResolvedValueOnce([
      {
        ...base,
        id: '10000000-0000-4000-8000-000000000001',
        name: 'Old dashboard',
        repositoryPath: '/tmp/old',
        archived: true,
      },
      {
        ...base,
        id: '10000000-0000-4000-8000-000000000002',
        name: 'Current dashboard',
        repositoryPath: '/tmp/current',
      },
    ]);
    const wrapper = await mountFixture(idle);
    try {
      await wrapper.get('.task-overview-actions button').trigger('click');
      const select = wrapper.get('#agent-project');
      expect(select.findAll('option').map((option) => option.text())).toEqual([
        'Current dashboard',
      ]);
      expect((select.element as HTMLSelectElement).value).toBe(
        '10000000-0000-4000-8000-000000000002'
      );
    } finally {
      wrapper.unmount();
    }
  });

  it('renders the empty state without duplicate explanatory cards', async () => {
    const wrapper = await mountFixture(idle);
    expect(wrapper.get('.task-list-empty').text()).toContain('No stored tasks yet.');
    expect(wrapper.find('.agent-form').exists()).toBe(false);
    await wrapper.get('.task-overview-actions button').trigger('click');
    expect(wrapper.get('dialog').attributes('aria-label')).toBe('New task');
    await wrapper.get('#agent-task').setValue('Keep this draft');
    await wrapper.get('dialog header button').trigger('click');
    expect(wrapper.find('dialog').exists()).toBe(false);
    await wrapper.get('.task-overview-actions button').trigger('click');
    expect((wrapper.get('#agent-task').element as HTMLTextAreaElement).value).toBe(
      'Keep this draft'
    );
    await wrapper.get('dialog').trigger('cancel');
    expect(wrapper.find('dialog').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Was sichtbar ist');
    expect(wrapper.text()).not.toContain('Live in die Arbeit schauen');
    wrapper.unmount();
  });

  it('reopens a completed task from the in-memory store without loading it again', async () => {
    const scrollTo = vi.spyOn(HTMLElement.prototype, 'scrollTo');
    const completed = AgentRunSnapshotSchema.parse({
      ...active,
      status: 'settled',
      finishedAt: '2026-09-13T10:01:00.000Z',
    });
    const wrapper = await mountSelected(completed, 'completed');
    expect(vi.mocked(fetchAgentTask)).toHaveBeenCalledTimes(1);

    await wrapper.get('.task-back-button').trigger('click');
    scrollTo.mockClear();
    await wrapper.get('.task-table-row').trigger('click');
    await flushPromises();

    expect(vi.mocked(fetchAgentTask)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchAgentRunTrace)).not.toHaveBeenCalled();
    // A historical task must not jump to the end; the follow control stays
    // available for the newest events.
    expect(scrollTo).not.toHaveBeenCalled();
    expect(wrapper.get('.follow-button').text()).toBe('Scroll down');
    wrapper.unmount();
  });

  it('shows thinking and full technical content immediately without disclosures', async () => {
    const wrapper = await mountSelected(active);
    const items = wrapper.findAll('.timeline-item');
    expect(items.map((item) => item.get('strong').text())).toEqual([
      'Thinking',
      'bash · gezielter Test',
    ]);
    expect(wrapper.find('.agent-timeline details, .agent-timeline summary').exists()).toBe(false);
    expect(items[0]?.get('.timeline-reasoning-text').text()).toContain('benannten Dateien');
    const toolCards = items[1]?.findAll('.tool-payload-card') ?? [];
    expect(toolCards.map((card) => card.get('.timeline-block-label').text())).toEqual([
      'Tool arguments',
      'Tool output',
    ]);
    expect(toolCards[0]?.get('.timeline-text').text()).toContain('command');
    expect(toolCards[1]?.get('.timeline-text').text().length).toBeGreaterThan(4_000);
    expect(wrapper.get('.task-input-hint').text()).toBe(
      'Send adds your comment to the running task.'
    );
    expect(wrapper.get('.stop-button').text()).toBe('Stop run');
    expect(wrapper.get('.pending-messages .queue-note').text()).toContain('1 comment');
    const children = Array.from(wrapper.get('.conversation-view').element.children);
    const timelineIndex = children.indexOf(wrapper.get('.timeline-panel').element);
    const pendingIndex = children.indexOf(wrapper.get('.pending-messages').element);
    const inputIndex = children.indexOf(wrapper.get('.task-input').element);
    expect(pendingIndex).toBe(timelineIndex + 1);
    expect(inputIndex).toBe(pendingIndex + 1);
    expect(wrapper.find('.task-input .steering-deliveries').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows arguments and output immediately for completed and failed tools', async () => {
    const completed = AgentRunSnapshotSchema.parse({
      ...active,
      status: 'settled',
      finishedAt: '2026-09-13T10:01:00.000Z',
      timeline: [{ ...active.timeline[1], state: 'complete' }],
    });
    const completedWrapper = await mountSelected(completed, 'completed');
    const toolCards = completedWrapper.findAll('.tool-payload-card');
    expect(toolCards).toHaveLength(2);
    expect(completedWrapper.find('.agent-timeline details').exists()).toBe(false);
    expect(toolCards[1]?.get('.timeline-text').text()).toContain('Testausgabe');
    expect(completedWrapper.get('.run-status-chip').text()).toBe('Finished · unverified');
    completedWrapper.unmount();
    clearAgentCockpitCache();

    const failed = AgentRunSnapshotSchema.parse({
      ...active,
      status: 'failed',
      finishedAt: '2026-09-13T10:01:00.000Z',
      timeline: [{ ...active.timeline[1], state: 'error' }],
    });
    const failedWrapper = await mountSelected(failed, 'failed');
    expect(failedWrapper.findAll('.tool-payload-card')).toHaveLength(2);
    expect(failedWrapper.get('.run-status-chip').text()).toBe('Run failed');
    failedWrapper.unmount();
  });

  it('keeps runs, review and release reachable through the Details tab', async () => {
    const completed = AgentRunSnapshotSchema.parse({
      ...active,
      status: 'settled',
      finishedAt: '2026-09-13T10:01:00.000Z',
    });
    const wrapper = await mountSelected(completed, 'completed');

    expect(wrapper.findAll('.task-view-tabs button').map((tab) => tab.text().trim())).toEqual([
      'Conversation',
      'Changes',
      'Test environment',
      'Details',
    ]);
    // The delivery queue stays between the timeline and the single input.
    const conversation = wrapper.get('.conversation-view').element.children;
    expect(conversation[0]?.classList.contains('timeline-panel')).toBe(true);
    expect(conversation[1]?.classList.contains('pending-messages')).toBe(true);
    expect(conversation[2]?.classList.contains('task-input')).toBe(true);
    expect(wrapper.get('.task-input-hint').text()).toBe('Send starts a new run on this task.');

    const detailsTab = wrapper
      .findAll('.task-view-tabs button')
      .find((button) => button.text().startsWith('Details'))!;
    await detailsTab.trigger('click');
    expect(
      wrapper
        .get('.details-subnav')
        .findAll('button')
        .map((tab) => tab.text().trim())
    ).toEqual(['Work runs', 'Review', 'Release']);
    expect(wrapper.get('.run-sidebar').attributes('aria-label')).toBe('Work runs');
    expect(wrapper.get('.run-entry-heading strong').text()).toBe('1. Gezielter UI-Test');
    expect(wrapper.get('.run-entry-meta').text()).toContain('Finished · unverified');
    expect(wrapper.get('.run-list button').attributes('aria-current')).toBe('true');
    wrapper.unmount();
  });

  it('uses durable parallel-run capacity for Continue and Review after completion', async () => {
    const completed = AgentRunSnapshotSchema.parse({
      ...active,
      status: 'settled',
      finishedAt: '2026-09-13T10:01:00.000Z',
      // This run-bound terminal snapshot was emitted while both slots were
      // occupied. The refreshed durable task list below has no active run.
      activeRuns: 2,
      maxActiveRuns: 2,
    });
    const wrapper = await mountSelected(completed, 'completed', false, true);

    expect(wrapper.get('.task-input-hint').text()).toBe('Send starts a new run on this task.');
    const detailsTab = wrapper
      .findAll('.task-view-tabs button')
      .find((button) => button.text().startsWith('Details'))!;
    await detailsTab.trigger('click');
    const reviewTab = wrapper
      .findAll('.details-subnav button')
      .find((button) => button.text().startsWith('Review'))!;
    expect(reviewTab.attributes('disabled')).toBeUndefined();
    await reviewTab.trigger('click');
    expect(wrapper.get('.review-launch button').attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it('offers Continue for an accepted task and reopens it with a new instruction', async () => {
    const completed = AgentRunSnapshotSchema.parse({
      ...active,
      status: 'settled',
      finishedAt: '2026-09-13T10:01:00.000Z',
      activeRuns: 0,
      maxActiveRuns: 2,
    });
    const wrapper = await mountSelected(completed, 'completed');
    const taskId = mockState.tasks.items[0]!.id;
    const accepted = DurableTaskDetailSchema.parse({
      ...mockState.details.get(taskId)!,
      task: { ...mockState.details.get(taskId)!.task, status: 'accepted' },
    });
    mockState.details.set(taskId, accepted);
    mockState.tasks = DurableTaskListSchema.parse({
      items: [{ ...mockState.tasks.items[0]!, status: 'accepted' }],
    });
    await wrapper.get('.task-back-button').trigger('click');
    await wrapper.get('.task-table-row').trigger('click');
    await flushPromises();

    expect(wrapper.get('.task-input-hint').text()).toBe('Send starts a new run on this task.');
    expect(wrapper.get('.task-input button[type="submit"]').text()).toBe('Continue');
    wrapper.unmount();
  });

  it('refreshes the task version before answering without a page reload', async () => {
    const yielded = AgentRunSnapshotSchema.parse({
      ...active,
      status: 'settled',
      finishedAt: '2026-09-13T10:01:00.000Z',
    });
    const wrapper = await mountSelected(yielded, 'yielded', true);
    const taskId = mockState.tasks.items[0]!.id;
    const fresh = DurableTaskDetailSchema.parse({
      ...mockState.details.get(taskId)!,
      task: { ...mockState.details.get(taskId)!.task, version: 7 },
    });
    mockState.details.set(taskId, fresh);
    mockState.tasks = DurableTaskListSchema.parse({
      items: [{ ...mockState.tasks.items[0]!, version: 7 }],
    });

    expect(wrapper.get('.task-question').text()).toBe('Hours or days?');
    await wrapper.get('.task-input textarea').setValue('Use days.');
    await wrapper.get('.task-input').trigger('submit');
    await flushPromises();

    expect(vi.mocked(answerAgentQuestion)).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId,
        questionId: fresh.openQuestion!.id,
        answer: 'Use days.',
        expectedTaskVersion: 7,
      })
    );
    wrapper.unmount();
  });

  it('shows an interrupted persisted tool as terminal instead of waiting forever', async () => {
    const taskId = '66666666-6666-4666-8666-666666666666';
    const interruptedRun = {
      id: active.runId!,
      taskId,
      turnId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      status: 'interrupted' as const,
      version: 3,
      profileId: 'coding-default-v1',
      baseRevision: 'a'.repeat(40),
      checkStatus: 'not_run' as const,
      createdAt: '2026-09-13T10:00:00.000Z',
      startedAt: '2026-09-13T10:00:00.000Z',
      finishedAt: '2026-09-13T10:00:18.000Z',
      reason: 'Runner restarted before completion.',
    };
    const interrupted = AgentRunSnapshotSchema.parse({
      ...active,
      status: 'failed',
      finishedAt: interruptedRun.finishedAt,
      timeline: [{ ...active.timeline[1], state: 'error', outputText: undefined }],
    });
    mockState.tasks = DurableTaskListSchema.parse({
      items: [
        {
          id: taskId,
          title: 'Recovery-Abnahme',
          status: 'open',
          version: 3,
          createdAt: interruptedRun.createdAt,
          updatedAt: interruptedRun.finishedAt,
          latestRun: interruptedRun,
        },
      ],
    });
    mockState.details.set(
      taskId,
      DurableTaskDetailSchema.parse({
        task: mockState.tasks.items[0],
        runs: [interruptedRun],
        messages: [],
        latestSnapshot: interrupted,
        traceEventCount: 2,
      })
    );

    const wrapper = await mountFixture(idle);
    await wrapper.get('.task-table-row').trigger('click');
    await flushPromises();
    expect(wrapper.get('.run-status-chip').text()).toBe('Interrupted');
    expect(wrapper.get('.timeline-state').text()).toBe('Interrupted');
    const outputSection = wrapper.findAll('.tool-payload-card')[1]!;
    expect(outputSection.get('.timeline-block-label').text()).toContain('Tool output');
    expect(outputSection.get('.tool-payload-empty').text()).toBe('Tool execution not completed.');
    expect(wrapper.text()).not.toContain('Output pending');
    wrapper.unmount();
  });

  it('lists current and past tasks and opens a persisted full trace', async () => {
    const currentTaskId = '66666666-6666-4666-8666-666666666666';
    const previousTaskId = '77777777-7777-4777-8777-777777777777';
    const previousRunId = '88888888-8888-4888-8888-888888888888';
    const previousTurnId = '99999999-9999-4999-8999-999999999999';
    const previous = AgentRunSnapshotSchema.parse({
      ...active,
      runId: previousRunId,
      name: 'Vorherige Aufgabe',
      task: 'Prüfe den alten Trace.',
      status: 'settled',
      finishedAt: '2026-09-13T09:10:00.000Z',
      timeline: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          at: '2026-09-13T09:09:00.000Z',
          kind: 'thinking',
          title: 'Reasoning',
          text: 'Gespeichertes Reasoning',
          state: 'complete',
        },
      ],
    });
    const currentRun = {
      id: active.runId!,
      taskId: currentTaskId,
      turnId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      status: 'running' as const,
      version: 2,
      profileId: 'coding-default-v1',
      baseRevision: 'a'.repeat(40),
      checkStatus: 'not_run' as const,
      createdAt: '2026-09-13T10:00:00.000Z',
      startedAt: '2026-09-13T10:00:00.000Z',
    };
    const previousRun = {
      ...currentRun,
      id: previousRunId,
      taskId: previousTaskId,
      turnId: previousTurnId,
      status: 'completed' as const,
      createdAt: '2026-09-13T09:00:00.000Z',
      startedAt: '2026-09-13T09:00:00.000Z',
      finishedAt: '2026-09-13T09:10:00.000Z',
    };
    mockState.tasks = DurableTaskListSchema.parse({
      activeTaskId: currentTaskId,
      items: [
        {
          id: currentTaskId,
          title: 'Gezielter UI-Test',
          status: 'open',
          version: 2,
          createdAt: '2026-09-13T10:00:00.000Z',
          updatedAt: '2026-09-13T10:00:00.000Z',
          latestRun: currentRun,
        },
        {
          id: previousTaskId,
          title: 'Vorherige Aufgabe',
          status: 'open',
          version: 3,
          createdAt: '2026-09-13T09:00:00.000Z',
          updatedAt: '2026-09-13T09:10:00.000Z',
          latestRun: previousRun,
        },
      ],
    });
    mockState.details.set(
      currentTaskId,
      DurableTaskDetailSchema.parse({
        task: mockState.tasks.items[0],
        runs: [currentRun],
        messages: [],
        latestSnapshot: active,
        traceEventCount: 4,
      })
    );
    mockState.details.set(
      previousTaskId,
      DurableTaskDetailSchema.parse({
        task: mockState.tasks.items[1],
        runs: [previousRun],
        messages: [],
        latestSnapshot: previous,
        traceEventCount: 12,
      })
    );

    const wrapper = await mountFixture(active);
    expect(wrapper.findAll('.task-table-row')).toHaveLength(2);
    expect(wrapper.get('.task-table-row').text()).toContain('Gezielter UI-Test');
    expect(wrapper.find('.cockpit-runbar').exists()).toBe(false);
    await wrapper.findAll('.task-table-row')[1]!.trigger('click');
    await flushPromises();
    expect(wrapper.get('.workbench-task-title').text()).toBe('Vorherige Aufgabe');
    expect(wrapper.get('.timeline-item strong').text()).toBe('Thinking');
    expect(wrapper.get('.timeline-reasoning-text').text()).toContain('Gespeichertes Reasoning');
    expect(wrapper.find('.agent-timeline details').exists()).toBe(false);
    expect(wrapper.find('.timeline-heading').exists()).toBe(false);
    expect(wrapper.find('.trace-export').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows a transport interruption once and keeps schema errors separate', async () => {
    const wrapper = await mountFixture(active);
    mockState.subscriber?.onError({ code: 'network_error', message: 'socket lost' });
    await nextTick();
    expect(wrapper.get('.cockpit-heading .live-chip').text()).toContain('Agent disconnected');
    expect(wrapper.find('.cockpit-error').exists()).toBe(false);
    expect(wrapper.get('.cockpit-heading .text-button').text()).toBe('Reconnect');

    mockState.subscriber?.onOpen();
    mockState.subscriber?.onError({ code: 'invalid_payload', message: 'Ungültiges Event' });
    await nextTick();
    expect(wrapper.get('.cockpit-heading .live-chip').text()).toContain('Agent live');
    const { notifications } = await import('../src/composables/useNotifications.js');
    expect(notifications.value.find((item) => item.id === 'agent-cockpit')?.text).toBe(
      'Ungültiges Event'
    );
    expect(wrapper.find('.cockpit-error').exists()).toBe(false);
    wrapper.unmount();
  });

  it('keeps only the 30 most recently used task details in the shared cache', async () => {
    const uuid = (part: number): string =>
      `00000000-0000-4000-8000-${String(part).padStart(12, '0')}`;
    const makeRun = (index: number) => ({
      id: uuid(1000 + index),
      taskId: uuid(index),
      turnId: uuid(5000 + index),
      status: 'completed' as const,
      version: 1,
      profileId: 'coding-default-v1',
      baseRevision: 'a'.repeat(40),
      checkStatus: 'not_run' as const,
      createdAt: '2026-09-13T08:00:00.000Z',
      startedAt: '2026-09-13T08:00:00.000Z',
      finishedAt: '2026-09-13T08:05:00.000Z',
    });
    const items = [] as {
      id: string;
      title: string;
      status: 'open';
      version: number;
      createdAt: string;
      updatedAt: string;
      latestRun: ReturnType<typeof makeRun>;
    }[];
    for (let i = 0; i < 31; i += 1) {
      const run = makeRun(i);
      items.push({
        id: uuid(i),
        title: `Aufgabe ${i + 1}`,
        status: 'open',
        version: 1,
        createdAt: run.createdAt,
        updatedAt: run.finishedAt!,
        latestRun: run,
      });
      const snapshot = AgentRunSnapshotSchema.parse({
        ...idle,
        runId: run.id,
        name: `Aufgabe ${i + 1}`,
        status: 'settled',
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      });
      mockState.details.set(
        uuid(i),
        DurableTaskDetailSchema.parse({
          task: items[i],
          runs: [run],
          messages: [],
          latestSnapshot: snapshot,
          traceEventCount: 0,
        })
      );
    }
    mockState.tasks = DurableTaskListSchema.parse({ items });
    const wrapper = await mountFixture(idle);

    for (let i = 0; i < 31; i += 1) {
      await wrapper.findAll('.task-table-row')[i]!.trigger('click');
      await flushPromises();
      await wrapper.get('.task-back-button').trigger('click');
      await flushPromises();
    }
    vi.mocked(fetchAgentTask).mockClear();

    // Task 1 was evicted by the 30 newer selections: it must be re-fetched.
    await wrapper.findAll('.task-table-row')[0]!.trigger('click');
    await flushPromises();
    expect(vi.mocked(fetchAgentTask)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchAgentTask)).toHaveBeenCalledWith(uuid(0));

    vi.mocked(fetchAgentTask).mockClear();
    await wrapper.get('.task-back-button').trigger('click');
    await flushPromises();
    // The most recently used task is still cached: no second read.
    await wrapper.findAll('.task-table-row')[30]!.trigger('click');
    await flushPromises();
    expect(vi.mocked(fetchAgentTask)).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('routes the shared input to steer and queueFollowup of the selected task', async () => {
    const wrapper = await mountSelected(active);
    const taskId = mockState.tasks.items[0]!.id;

    await wrapper.get('.task-input textarea').setValue('focus on the web package');
    await wrapper.get('.task-input').trigger('submit');
    await flushPromises();
    expect(vi.mocked(steerAgentRun)).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: active.runId!,
        message: 'focus on the web package',
      })
    );
    expect((wrapper.get('.task-input textarea').element as HTMLTextAreaElement).value).toBe('');
    expect(localStorage.getItem(agentDraftKey(taskId, 'steer'))).toBeNull();

    const toggle = wrapper.get('.task-input-actions .composer-followup');
    expect(toggle.text()).toBe('Work afterwards');
    await toggle.trigger('click');
    await wrapper.get('.task-input textarea').setValue('then rebuild the docs');
    await wrapper.get('.task-input').trigger('submit');
    await flushPromises();
    expect(vi.mocked(queueAgentFollowup)).toHaveBeenCalledWith(
      expect.objectContaining({ taskId, message: 'then rebuild the docs' })
    );
    wrapper.unmount();
  });

  it('derives the compact status from the selected task, not another global run', async () => {
    // The global stream belongs to a different, still active run.
    const otherRun = AgentRunSnapshotSchema.parse({
      ...active,
      runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      name: 'Another running task',
    });
    const completed = AgentRunSnapshotSchema.parse({
      ...active,
      status: 'settled',
      finishedAt: '2026-09-13T10:01:00.000Z',
    });
    const wrapper = await mountSelected(completed, 'completed', false, true);
    mockState.snapshot = otherRun;
    mockState.subscriber?.onSnapshot(otherRun);
    await flushPromises();

    // The selected task is finished with a stored result, even though a
    // different run is live globally: status and input stay task-bound.
    expect(wrapper.get('.run-status-chip').text()).toBe('For review');
    expect(wrapper.get('.run-status-chip').attributes('title')).toBe(
      'Review the changes in the Changes tab.'
    );
    expect(wrapper.get('.task-input-hint').text()).toBe('Send starts a new run on this task.');
    expect(wrapper.find('.stop-button').exists()).toBe(false);
    wrapper.unmount();
  });

  it('re-initializes the main timeline when the selected run changes within the activity view', async () => {
    const scrollTo = vi.spyOn(HTMLElement.prototype, 'scrollTo');
    const wrapper = await mountTwoRunTask();
    scrollTo.mockClear();
    await selectHistoricalRun(wrapper);

    // Historical view: the freshly mounted timeline stays where the reader is
    // and offers the follow control instead of an end jump.
    const historyTimeline = wrapper.findComponent(AgentTimeline);
    expect(historyTimeline.props('isLiveRun')).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(wrapper.get('.follow-button').text()).toBe('Scroll down');

    // "Back to current run" happens entirely inside the activity view: the
    // stable key on the selected durable run must replace the component so
    // the live follow state re-initializes from scratch.
    scrollTo.mockClear();
    await wrapper.get('.task-note .text-button').trigger('click');
    await flushPromises();

    const liveTimeline = wrapper.findComponent(AgentTimeline);
    expect(liveTimeline.vm).not.toBe(historyTimeline.vm);
    expect(liveTimeline.element).not.toBe(historyTimeline.element);
    expect(liveTimeline.props('isLiveRun')).toBe(true);
    expect(wrapper.find('.follow-button').exists()).toBe(false);
    expect(scrollTo).toHaveBeenCalled();
    wrapper.unmount();
  });

  it('prefers Steer over an open question while the selected run is active', async () => {
    const wrapper = await mountSelected(active, 'running', true);
    expect(wrapper.get('.task-input-hint').text()).toBe(
      'Send adds your comment to the running task.'
    );
    expect(wrapper.get('.stop-button').text()).toBe('Stop run');
    expect(wrapper.find('.task-question').exists()).toBe(false);
    wrapper.unmount();
  });

  it("keeps the main status and runbar accent on the task's latest run in the history view", async () => {
    const wrapper = await mountTwoRunTask();

    expect(wrapper.get('.workbench-breadcrumb .run-status-chip').classes()).toContain('running');
    expect(wrapper.get('.run-status-chip').text()).toBe('Working');

    await selectHistoricalRun(wrapper);

    // While the completed historical run is displayed, the compact status and
    // the accent color still describe the task\'s latest (running) run. The
    // history note and locked historical actions stay.
    expect(wrapper.get('.workbench-breadcrumb .run-status-chip').classes()).toContain('running');
    expect(wrapper.get('.workbench-breadcrumb .run-status-chip').classes()).not.toContain(
      'completed'
    );
    expect(wrapper.get('.run-status-chip').text()).toBe('Working');
    expect(wrapper.get('.task-note').text()).toContain('You are viewing a historical run.');
    expect(wrapper.find('.pending-messages').exists()).toBe(false);
    wrapper.unmount();
  });

  it('keeps per-task drafts separate, restores them on reload and clears them on sign out', async () => {
    const taskIdA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const taskIdB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const finishedAt = '2026-09-13T10:01:00.000Z';
    const completed = AgentRunSnapshotSchema.parse({
      ...active,
      status: 'settled',
      finishedAt,
    });
    const makeRun = (runId: string, taskId: string) => ({
      id: runId,
      taskId,
      turnId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      status: 'completed' as const,
      version: 2,
      profileId: 'coding-default-v1',
      baseRevision: 'a'.repeat(40),
      checkStatus: 'not_run' as const,
      createdAt: '2026-09-13T10:00:00.000Z',
      startedAt: '2026-09-13T10:00:00.000Z',
      finishedAt,
    });
    const runA = makeRun(active.runId!, taskIdA);
    const runB = makeRun('99999999-9999-4999-8999-999999999999', taskIdB);
    const makeSummary = (taskId: string, run: typeof runA, title: string) => ({
      id: taskId,
      title,
      status: 'open' as const,
      version: 2,
      createdAt: run.createdAt,
      updatedAt: finishedAt,
      latestRun: run,
    });
    mockState.tasks = DurableTaskListSchema.parse({
      items: [
        makeSummary(taskIdA, runA, 'Draft task A'),
        makeSummary(taskIdB, runB, 'Draft task B'),
      ],
    });
    for (const taskId of [taskIdA, taskIdB]) {
      const run = mockState.tasks.items.find((item) => item.id === taskId)!.latestRun;
      mockState.details.set(
        taskId,
        DurableTaskDetailSchema.parse({
          task: mockState.tasks.items.find((item) => item.id === taskId)!,
          runs: [run],
          messages: [],
          latestSnapshot: completed,
          traceEventCount: 0,
        })
      );
    }
    const wrapper = await mountFixture(completed);

    await wrapper.findAll('.task-table-row')[0]!.trigger('click');
    await flushPromises();
    await wrapper.get('.task-input textarea').setValue('draft for A');
    expect(localStorage.getItem(agentDraftKey(taskIdA, 'continue'))).toBe('draft for A');

    // Switching to the other task must not carry over the draft.
    await wrapper.get('.task-back-button').trigger('click');
    await wrapper.findAll('.task-table-row')[1]!.trigger('click');
    await flushPromises();
    expect((wrapper.get('.task-input textarea').element as HTMLTextAreaElement).value).toBe('');
    expect(localStorage.getItem(agentDraftKey(taskIdB, 'continue'))).toBeNull();

    // Switching back restores the stored draft.
    await wrapper.get('.task-back-button').trigger('click');
    await wrapper.findAll('.task-table-row')[0]!.trigger('click');
    await flushPromises();
    expect((wrapper.get('.task-input textarea').element as HTMLTextAreaElement).value).toBe(
      'draft for A'
    );

    // A reload (fresh mount) still shows the draft.
    wrapper.unmount();
    const reloaded = await mountFixture(completed);
    await reloaded.findAll('.task-table-row')[0]!.trigger('click');
    await flushPromises();
    expect((reloaded.get('.task-input textarea').element as HTMLTextAreaElement).value).toBe(
      'draft for A'
    );

    // Sign-out (cache clear) removes the drafts from this browser.
    clearAgentCockpitCache();
    expect(localStorage.getItem(agentDraftKey(taskIdA, 'continue'))).toBeNull();
    reloaded.unmount();
  });
});
