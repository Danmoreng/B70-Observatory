import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentRunSnapshotSchema,
  SERVICE_NAME,
  type AgentRunSnapshot,
} from '@observatory/contracts';
import AgentCockpit from '../src/components/AgentCockpit.vue';
import { clearAgentCockpitCache } from '../src/composables/useAgentCockpit.js';
import { runStatusLabel } from '../src/lib/labels.js';
import { setLocale } from '../src/lib/i18n.js';

interface Subscriber {
  onSnapshot: (snapshot: AgentRunSnapshot) => void;
  onError: (cause: { code: string; message: string }) => void;
  onOpen: () => void;
}

const mockState = vi.hoisted(() => ({
  snapshot: undefined as AgentRunSnapshot | undefined,
  subscriber: undefined as Subscriber | undefined,
}));

vi.mock('../src/lib/api.js', () => ({
  HealthFetchError: class HealthFetchError extends Error {},
  fetchAgent: vi.fn(async () => mockState.snapshot),
  fetchAgentTasks: vi.fn(async () => ({ items: [], activeTaskIds: [] })),
  fetchAgentTask: vi.fn(async () => undefined),
  fetchAgentProjects: vi.fn(async () => []),
  fetchAgentRunTrace: vi.fn(async () => ({ items: [], hasMore: false })),
  collectAgentRunTrace: vi.fn(async () => []),
  fetchAgentRunResult: vi.fn(async () => undefined),
  deleteAgentTask: vi.fn(async () => true),
  startAgentRun: vi.fn(async () => mockState.snapshot),
  startAgentReview: vi.fn(async () => mockState.snapshot),
  startAgentCorrection: vi.fn(async () => mockState.snapshot),
  steerAgentRun: vi.fn(async () => mockState.snapshot),
  cancelAgentRun: vi.fn(async () => mockState.snapshot),
  continueAgentTask: vi.fn(async () => mockState.snapshot),
  queueFollowup: vi.fn(async () => ({ queued: true })),
  answerQuestion: vi.fn(async () => mockState.snapshot),
  acceptAgentRunResult: vi.fn(async () => true),
  mergeAgentRunResult: vi.fn(async () => true),
  startReleaseBuild: vi.fn(async () => ({ id: 'release' })),
  activateRelease: vi.fn(async () => ({ id: 'release' })),
  rollbackRelease: vi.fn(async () => ({ accepted: true })),
  subscribeAgent: vi.fn((subscriber: Subscriber) => {
    mockState.subscriber = subscriber;
    const initial = mockState.snapshot;
    queueMicrotask(() => subscriber.onOpen());
    if (initial !== undefined) {
      queueMicrotask(() => subscriber.onSnapshot(initial));
    }
    return vi.fn();
  }),
}));

afterEach(() => {
  setLocale('en');
  clearAgentCockpitCache();
  mockState.snapshot = undefined;
  mockState.subscriber = undefined;
});

async function mountCockpit(snapshot: AgentRunSnapshot): Promise<ReturnType<typeof mount>> {
  clearAgentCockpitCache();
  mockState.snapshot = snapshot;
  const wrapper = mount(AgentCockpit);
  await flushPromises();
  return wrapper;
}

describe('Tasks page availability wording', () => {
  it('distinguishes a configuration-disabled agent and shows no live/health claim (EN)', async () => {
    const disabled = AgentRunSnapshotSchema.parse({
      service: SERVICE_NAME,
      enabled: false,
      status: 'disabled',
      sequence: 0,
      pendingSteering: 0,
      reason: 'legacy or unexplained reason',
      timeline: [],
    });
    const wrapper = await mountCockpit(disabled);
    expect(wrapper.find('.cockpit-disabled h3').text()).toBe('Agent execution disabled');
    expect(wrapper.find('.cockpit-disabled p').text()).toContain(
      'disabled in the server configuration'
    );
    expect(wrapper.text()).not.toContain('safety');
    expect(wrapper.text()).not.toContain('No runner is running');
    expect(wrapper.text()).toContain('This dashboard is not connected to a runner.');
    expect(wrapper.get('.cockpit-heading .live-chip').text()).toBe('Agent disabled');
    expect(wrapper.text()).not.toContain('Agent live');
    wrapper.unmount();
  });

  it('distinguishes an unreachable configured runner and does not trust the open stream (EN)', async () => {
    const unreachable = AgentRunSnapshotSchema.parse({
      service: SERVICE_NAME,
      enabled: false,
      status: 'unreachable',
      sequence: 0,
      pendingSteering: 0,
      reason: 'The configured isolated runner is unreachable.',
      timeline: [],
    });
    const wrapper = await mountCockpit(unreachable);
    expect(wrapper.find('.cockpit-disabled h3').text()).toBe('Agent runner unreachable');
    expect(wrapper.find('.cockpit-disabled p').text()).toContain(
      'An open event stream does not mean the runner is healthy'
    );
    expect(wrapper.get('.cockpit-heading .live-chip').text()).toBe('Runner unreachable');
    expect(wrapper.text()).not.toContain('Agent live');
    wrapper.unmount();
  });

  it('renders the German wording for both conditions', async () => {
    setLocale('de');
    const disabled = AgentRunSnapshotSchema.parse({
      service: SERVICE_NAME,
      enabled: false,
      status: 'disabled',
      sequence: 0,
      pendingSteering: 0,
      timeline: [],
    });
    const wrapper = await mountCockpit(disabled);
    expect(wrapper.find('.cockpit-disabled h3').text()).toBe('Agentenausführung deaktiviert');
    expect(wrapper.find('.cockpit-disabled p').text()).toContain(
      'in der Server-Konfiguration deaktiviert'
    );
    expect(wrapper.get('.cockpit-heading .live-chip').text()).toBe('Agent deaktiviert');
    expect(wrapper.text()).not.toContain('Kein Runner läuft');
    expect(wrapper.text()).toContain('Dieses Dashboard ist nicht mit einem Runner verbunden.');

    mockState.subscriber?.onSnapshot(
      AgentRunSnapshotSchema.parse({
        service: SERVICE_NAME,
        enabled: false,
        status: 'unreachable',
        sequence: 1,
        pendingSteering: 0,
        timeline: [],
      })
    );
    await nextTick();
    expect(wrapper.find('.cockpit-disabled h3').text()).toBe('Agent-Runner nicht erreichbar');
    expect(wrapper.find('.cockpit-disabled p').text()).toContain(
      'Eine offene Ereignisverbindung bedeutet nicht'
    );
    expect(wrapper.get('.cockpit-heading .live-chip').text()).toBe('Runner nicht erreichbar');
    wrapper.unmount();
  });

  it('keeps "Agent live" for a healthy connected runner', async () => {
    const idle = AgentRunSnapshotSchema.parse({
      service: SERVICE_NAME,
      enabled: true,
      status: 'idle',
      sequence: 0,
      pendingSteering: 0,
      timeline: [],
    });
    const wrapper = await mountCockpit(idle);
    expect(wrapper.get('.cockpit-heading .live-chip').text()).toBe('Agent live');
    expect(wrapper.find('.cockpit-disabled').exists()).toBe(false);
    wrapper.unmount();
  });

  it('does not claim a live runner before receiving its first snapshot', async () => {
    clearAgentCockpitCache();
    mockState.snapshot = undefined;
    const wrapper = mount(AgentCockpit);
    await flushPromises();
    expect(wrapper.get('.cockpit-heading .live-chip').text()).toBe('Agent connecting …');
    expect(wrapper.text()).not.toContain('Agent live');
    wrapper.unmount();
  });

  it('maps the new snapshot status to a dedicated label', () => {
    expect(runStatusLabel(undefined, 'unreachable')).toBe('Runner unreachable');
    expect(runStatusLabel(undefined, 'disabled')).toBe('Execution disabled');
    setLocale('de');
    expect(runStatusLabel(undefined, 'unreachable')).toBe('Runner nicht erreichbar');
    expect(runStatusLabel(undefined, 'disabled')).toBe('Ausführung deaktiviert');
  });
});
