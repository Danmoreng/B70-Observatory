import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AgentLiveChanges from '../src/components/agent/AgentLiveChanges.vue';
import AgentTaskMetrics from '../src/components/agent/AgentTaskMetrics.vue';
import { useProjectPins } from '../src/composables/useProjectPins.js';
import AppSidebar from '../src/components/AppSidebar.vue';
import { parseAppRoute } from '../src/composables/useAppRoute.js';

const mocks = vi.hoisted(() => ({ changes: vi.fn(), metrics: vi.fn() }));
vi.mock('../src/lib/api.js', () => ({
  fetchAgentLiveChanges: mocks.changes,
  fetchAgentTaskTelemetry: mocks.metrics,
}));
enableAutoUnmount(afterEach);
const taskId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const secondRun = '33333333-3333-4333-8333-333333333333';
function changes(id = runId, path = 'new.ts') {
  return {
    taskId,
    runId: id,
    capturedAt: '2026-10-29T18:00:00.000Z',
    status: 'live',
    stale: false,
    truncated: false,
    files: [{ path, status: 'untracked' }],
    diff: `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+export const answer = 42;\n`,
  };
}
const totals = {
  requests: 2,
  completedRequests: 2,
  failedRequests: 0,
  usage: { inputTokens: 200, outputTokens: 30, cachedInputTokens: 20 },
  uniqueInputTokens: 120,
  prefill: { tokens: 180, durationMs: 200, tokensPerSecond: 900, samples: 2 },
  decode: null,
};
beforeEach(() => {
  vi.useFakeTimers();
  mocks.changes.mockReset();
  mocks.metrics.mockReset();
  mocks.changes.mockResolvedValue(changes());
  mocks.metrics.mockResolvedValue({ taskId, totals, runs: [{ runId, totals }] });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('live workspace changes', () => {
  it('refreshes visible live code every five minutes and immediately on explicit request', async () => {
    const wrapper = mount(AgentLiveChanges, {
      props: { taskId, runId, active: true, visible: false },
    });
    await flushPromises();
    expect(mocks.changes).not.toHaveBeenCalled();
    await wrapper.setProps({ visible: true });
    await flushPromises();
    expect(wrapper.text()).toContain('new.ts');
    expect(wrapper.text()).toContain('New');
    expect(wrapper.text()).toContain('export const answer = 42');
    await vi.advanceTimersByTimeAsync(299_999);
    expect(mocks.changes).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.changes).toHaveBeenCalledTimes(2);
    await wrapper.get('.quiet-button').trigger('click');
    await flushPromises();
    expect(mocks.changes).toHaveBeenCalledTimes(3);
    expect(mocks.changes.mock.calls[2]![3]).toBe(true);
    await wrapper.setProps({ visible: false });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(mocks.changes).toHaveBeenCalledTimes(3);
  });
  it('retains the last diff on a failed refresh and labels it stale', async () => {
    const wrapper = mount(AgentLiveChanges, {
      props: { taskId, runId, active: true, visible: true },
    });
    await flushPromises();
    mocks.changes.mockRejectedValueOnce(new Error('temporarily unavailable'));
    await vi.advanceTimersByTimeAsync(300_000);
    await flushPromises();
    expect(wrapper.text()).toContain('new.ts');
    expect(wrapper.text()).toContain('last captured state');
  });
  it('cancels hidden-tab work and never installs a response for a previously selected run', async () => {
    let resolveOld: (value: ReturnType<typeof changes>) => void = () => {};
    mocks.changes.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        })
    );
    const wrapper = mount(AgentLiveChanges, {
      props: { taskId, runId, active: true, visible: true },
    });
    const firstSignal = mocks.changes.mock.calls[0]![2] as AbortSignal;
    mocks.changes.mockResolvedValue(changes(secondRun, 'current.ts'));
    await wrapper.setProps({ runId: secondRun });
    await flushPromises();
    expect(firstSignal.aborted).toBe(true);
    resolveOld(changes(runId, 'old.ts'));
    await flushPromises();
    expect(wrapper.text()).toContain('current.ts');
    expect(wrapper.text()).not.toContain('old.ts');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    const before = mocks.changes.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.changes).toHaveBeenCalledTimes(before);
  });
});

describe('task performance and navigation', () => {
  it('refreshes final counts when a run stops before the next polling interval', async () => {
    mocks.metrics.mockResolvedValueOnce({
      taskId,
      totals: {
        ...totals,
        requests: 0,
        completedRequests: 0,
        uniqueInputTokens: null,
        usage: null,
        prefill: null,
      },
      runs: [],
    });
    const wrapper = mount(AgentTaskMetrics, {
      props: { taskId, runId, runtime: '00:01', active: true },
    });
    await flushPromises();
    expect(wrapper.attributes('title')).toContain('No completed model request');
    await wrapper.setProps({ active: false });
    await flushPromises();
    expect(wrapper.text()).toContain('120 / 30');
    expect(wrapper.text()).toContain('900.0');
  });

  it('distinguishes recovered old token counts from measured phase clocks', async () => {
    mocks.metrics.mockResolvedValue({
      taskId,
      totals: { ...totals, prefill: null, decode: null, usageSource: 'durable-history' },
      runs: [],
    });
    const wrapper = mount(AgentTaskMetrics, {
      props: { taskId, runId, runtime: '00:28', active: false, scope: 'task' },
    });
    await flushPromises();
    expect(wrapper.text()).toContain('120 / 30');
    expect(wrapper.attributes('title')).toContain('recovered from saved responses');
    expect(wrapper.text()).not.toContain('No completed model request');
  });
  it('uses task-specific phase measurements, shows missing timings and scopes to a run', async () => {
    const wrapper = mount(AgentTaskMetrics, {
      props: { taskId, runId, runtime: '08:42', active: true },
    });
    await flushPromises();
    expect(wrapper.text()).toContain('08:42');
    expect(wrapper.text()).toContain('900.0');
    expect(wrapper.attributes('title')).toContain('Decode 0/2');
    await wrapper.setProps({ scope: 'run' });
    expect(wrapper.text()).toContain('120 / 30');
    mocks.metrics.mockResolvedValue({ taskId, totals: { ...totals, prefill: null }, runs: [] });
    await wrapper.setProps({ scope: 'task' });
    await vi.advanceTimersByTimeAsync(4_000);
    await flushPromises();
    expect(wrapper.attributes('title')).toContain('not provided phase timings');
  });
  it('has no default project shortcuts and adds only an explicitly pinned project', async () => {
    const { pins, togglePin } = useProjectPins();
    pins.value = [];
    const wrapper = mount(AppSidebar, {
      props: {
        page: 'hardware',
        collapsed: false,
        connection: 'connected',
        sync: 'none',
        loginRequired: false,
        signingOut: false,
      },
    });
    expect(wrapper.find('.sidebar-pins').exists()).toBe(false);
    togglePin({ id: taskId, name: 'Chosen project' });
    await flushPromises();
    expect(wrapper.get('.sidebar-pins').text()).toContain('Chosen project');
    expect(JSON.parse(localStorage.getItem('observatory.project-pins.v1') ?? '[]')).toHaveLength(1);
    togglePin({ id: taskId, name: 'Chosen project' });
    await flushPromises();
    expect(wrapper.find('.sidebar-pins').exists()).toBe(false);
    expect(parseAppRoute('#/hardware').page).toBe('hardware');
  });
});
