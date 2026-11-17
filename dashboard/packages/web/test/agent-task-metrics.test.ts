import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentTaskTelemetry } from '@observatory/contracts';
import AgentTaskMetrics from '../src/components/agent/AgentTaskMetrics.vue';
import { fetchAgentTaskTelemetry } from '../src/lib/api.js';
import { setLocale } from '../src/lib/i18n.js';
vi.mock('../src/lib/api.js', () => ({ fetchAgentTaskTelemetry: vi.fn() }));
afterEach(() => {
  setLocale('en');
  vi.clearAllMocks();
});
const taskId = '11111111-1111-4111-8111-111111111111',
  runId = '22222222-2222-4222-8222-222222222222';
function telemetry(unique?: number | null): AgentTaskTelemetry {
  const totals = {
    requests: 30,
    completedRequests: 30,
    failedRequests: 0,
    usage: { inputTokens: 708489, outputTokens: 9970, cachedInputTokens: 663040 },
    uniqueInputTokens: unique,
    prefill: null,
    decode: null,
  };
  return {
    taskId,
    totals,
    runs: [
      { runId, totals: { ...totals, uniqueInputTokens: unique === undefined ? undefined : 1000 } },
    ],
  };
}
it('shows input content once, preserves output, and switches task/run scopes', async () => {
  vi.mocked(fetchAgentTaskTelemetry).mockResolvedValue(telemetry(34000));
  const w = mount(AgentTaskMetrics, {
    props: { taskId, runId, runtime: '4:29', active: false, scope: 'task' },
  });
  await flushPromises();
  expect(w.text()).toContain('34,000');
  expect(w.text()).toContain('9,970');
  expect(w.text()).not.toContain('708,489');
  expect(w.find('select').exists()).toBe(false);
  await w.setProps({ scope: 'run' });
  expect(w.text()).toContain('1,000');
  w.unmount();
});
it('never falls back to the repeated prompt sum when historical input accounting is unavailable', async () => {
  vi.mocked(fetchAgentTaskTelemetry).mockResolvedValue(telemetry());
  setLocale('de');
  const w = mount(AgentTaskMetrics, { props: { taskId, runId, runtime: '4:29', active: false } });
  await flushPromises();
  expect(w.text()).not.toContain('708');
  expect(w.attributes('title')).toContain('nicht verfügbar');
  w.unmount();
});

it('shows measured tool and GPU waits alongside runtime without a scope dropdown', async () => {
  const value = telemetry(1000);
  value.runs[0]!.totals.runtime = {
    wallMs: 100000,
    toolMs: 40000,
    modelMs: 30000,
    engineWaitMs: 20000,
    otherMs: 10000,
  };
  vi.mocked(fetchAgentTaskTelemetry).mockResolvedValue(value);
  const w = mount(AgentTaskMetrics, {
    props: { taskId, runId, runtime: '1:40', active: false, scope: 'run' },
  });
  await flushPromises();
  expect(w.find('.runtime-parts').text()).toContain('Tools 0:40');
  expect(w.find('.runtime-parts').text()).toContain('GPU wait 0:20');
  expect(w.find('select').exists()).toBe(false);
  expect(w.text()).not.toContain('Input once');
  w.unmount();
});
