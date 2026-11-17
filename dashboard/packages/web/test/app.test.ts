import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import TimeChart from '../src/components/TimeChart.vue';
import { SERIES } from '../src/lib/series.js';
import App from '../src/App.vue';
import { appRoute } from '../src/composables/useAppRoute.js';

const VALID_PAYLOAD = {
  service: 'local-ai-b70-observatory',
  status: 'ok',
  version: '0.1.0',
  startedAt: '2025-01-01T10:00:00.000Z',
  timestamp: '2025-01-01T10:00:30.000Z',
  uptimeSeconds: 30,
  checks: [
    { name: 'server', status: 'ok' },
    { name: 'gpu', status: 'degraded', message: 'Treiber meldet hohe Temperatur' },
  ],
};

/** M4A: a full, contract-valid telemetry snapshot. */
const TELEMETRY_OK = {
  service: 'local-ai-b70-observatory',
  sourceStatus: 'ok',
  timestamp: '2025-01-01T10:00:00.000Z',
  model: 'Qwen3.8-27B',
  requests: { running: 2, waiting: 1 },
  kvCacheUsagePercent: 25,
  tokens: {
    promptTokens: 1_000,
    generationTokens: 100,
    promptTokensPerSecond: 20,
    generationTokensPerSecond: 4,
  },
  prefixCache: { queriedTokens: 500, hitTokens: 300, hitRate: 0.625 },
  mtp: { draftTokens: 100, acceptedTokens: 80, acceptanceRate: 0.8 },
  requestsFinished: { total: 12, byReason: { stop: 10, error: 2 } },
  latency: { e2eAvgMs: 3500, ttftAvgMs: 210 },
  gpu: { available: false, reason: 'keine vollständige sysfs-Schnittstelle' },
};

const SYSTEM_OK = {
  service: 'local-ai-b70-observatory',
  sourceStatus: 'ok',
  timestamp: '2025-01-01T10:00:00.000Z',
  cpu: { coreCount: 24, utilizationPercent: 37.5, load1: 1.25 },
  memory: {
    totalBytes: 32 * 2 ** 30,
    usedBytes: 8 * 2 ** 30,
    availableBytes: 24 * 2 ** 30,
    usagePercent: 25,
  },
  disk: {
    path: '/',
    totalBytes: 2 * 2 ** 40,
    usedBytes: 1 * 2 ** 40,
    freeBytes: 1 * 2 ** 40,
    usagePercent: 50,
  },
  process: {
    count: 1138,
    running: 2,
    observatoryRssBytes: 128 * 2 ** 20,
    uptimeSeconds: 3600,
  },
  gpu: {
    available: true as const,
    card: 'card0',
    values: { temperatureC: 80, powerWatts: 6.5 },
    missing: ['utilization', 'vram', 'clock'],
  },
};

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readonly withCredentials: boolean;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, EventListener[]>();

  constructor(url: string | URL, init?: EventSourceInit) {
    this.url = String(url);
    this.withCredentials = init?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (listener === null) return;
    const callable: EventListener =
      typeof listener === 'function' ? listener : (event) => listener.handleEvent(event);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callable]);
  }

  emitHealth(value: unknown): void {
    const event = new MessageEvent('health', { data: JSON.stringify(value) });
    for (const listener of this.listeners.get('health') ?? []) listener(event);
  }

  emitTelemetry(value: unknown): void {
    const event = new MessageEvent('telemetry', { data: JSON.stringify(value) });
    for (const listener of this.listeners.get('telemetry') ?? []) listener(event);
  }

  emitSystem(value: unknown): void {
    const event = new MessageEvent('system', { data: JSON.stringify(value) });
    for (const listener of this.listeners.get('system') ?? []) listener(event);
  }

  emitStream(value: unknown): void {
    const event = new MessageEvent('stream', { data: JSON.stringify(value) });
    for (const listener of this.listeners.get('stream') ?? []) listener(event);
  }

  emitError(): void {
    this.onerror?.(new Event('error'));
  }

  close(): void {
    this.closed = true;
  }
}

beforeEach(() => {
  appRoute.page = 'hardware';
  appRoute.taskId = undefined;
  appRoute.projectId = undefined;
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await flushPromises();
}

function latestSource(): FakeEventSource {
  const source = FakeEventSource.instances.at(-1);
  if (source === undefined) throw new Error('EventSource was not created');
  return source;
}

function mockSession(authenticated = true, loginRequired?: boolean) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (String(input) === '/api/auth/session') {
      const body: Record<string, unknown> = authenticated
        ? { authenticated: true, expiresAt: '2025-02-01T10:00:00.000Z' }
        : { authenticated: false };
      if (loginRequired !== undefined) body.loginRequired = loginRequired;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/metrics/history') {
      const definition = SERIES.find((series) => series.key === url.searchParams.get('series'));
      return new Response(
        JSON.stringify({
          series: definition?.key,
          unit: definition?.unit,
          bucketSeconds: Number(url.searchParams.get('bucketSeconds')),
          buckets: [],
        })
      );
    }
    if (url.pathname === '/api/requests')
      return new Response(JSON.stringify({ items: [], nextCursor: null }));
    if (url.pathname === '/api/auth/logout')
      return new Response(JSON.stringify({ authenticated: false }));
    throw new TypeError('unexpected fetch');
  });
}

async function mountSignedIn() {
  mockSession();
  const wrapper = mount(App, { global: { stubs: { TimeChart: true } } });
  await settle();
  return wrapper;
}

describe('M5B dashboard and review regressions', () => {
  it('keeps the conversation within the visible viewport when the on-screen keyboard opens', async () => {
    mockSession();
    const viewport = new EventTarget() as EventTarget & { height: number };
    viewport.height = 790;
    vi.stubGlobal('visualViewport', viewport);
    appRoute.page = 'agent';
    appRoute.taskId = '11111111-1111-4111-8111-111111111111';
    const wrapper = mount(App, { global: { stubs: { TimeChart: true, AgentCockpit: true } } });
    try {
      await settle();
      expect(wrapper.get('main').classes()).toContain('conversation-stage');
      expect(wrapper.get('main').attributes('style')).toContain('--conversation-height: 790px');
      expect(wrapper.find('footer.meta').exists()).toBe(false);
      viewport.height = 380;
      viewport.dispatchEvent(new Event('resize'));
      await flushPromises();
      expect(wrapper.get('main').attributes('style')).toContain('--conversation-height: 380px');
      appRoute.taskId = undefined;
      await flushPromises();
      expect(wrapper.get('main').classes()).not.toContain('conversation-stage');
      expect(wrapper.find('footer.meta').exists()).toBe(true);
    } finally {
      wrapper.unmount();
      appRoute.page = 'overview';
      appRoute.taskId = undefined;
    }
  });

  it('identifies missing production metrics without claiming stale hardware is current', async () => {
    const wrapper = await mountSignedIn();
    const failed = {
      ...VALID_PAYLOAD,
      status: 'error',
      checks: [
        { name: 'server', status: 'ok' },
        { name: 'vllm', status: 'error', message: 'Metrikquelle nicht erreichbar' },
      ],
    };
    latestSource().emitHealth(failed);
    latestSource().emitSystem(SYSTEM_OK);
    await settle();
    expect(wrapper.find('.beacon-status').text()).toBe('Production vLLM metrics unavailable');
    expect(wrapper.find('.status-bar').text()).toContain('Computer data is current.');
    expect(wrapper.find('.status-bar').text()).toContain('KV cache');
    latestSource().emitSystem({ ...SYSTEM_OK, sourceStatus: 'stale' });
    await settle();
    expect(wrapper.find('.status-bar').text()).not.toContain('Computer data is current.');
    latestSource().emitHealth({
      ...failed,
      checks: [
        ...failed.checks,
        { name: 'database', status: 'error', message: 'Datenbank nicht erreichbar' },
      ],
    });
    await settle();
    expect(wrapper.find('.beacon-status').text()).toBe('Degraded operation');
    expect(wrapper.find('.status-bar').text()).toContain('Datenbank nicht erreichbar');
    wrapper.unmount();
  });

  it('loads historical GPU power and appends real watts from the system source', async () => {
    const wrapper = await mountSignedIn();
    expect(
      vi
        .mocked(globalThis.fetch)
        .mock.calls.some((call) => String(call[0]).includes('series=gpu.power-watts'))
    ).toBe(true);
    latestSource().emitSystem({
      ...SYSTEM_OK,
      timestamp: new Date().toISOString(),
      gpu: { available: true, values: { powerWatts: 185.5 } },
    });
    await settle();
    const chart = wrapper
      .findAllComponents(TimeChart)
      .find((chart) => chart.props('title').includes('GPU'))!;
    const power = () => chart.props('series').find((item) => item.key === 'gpu.power-watts')!;
    expect(power().points.some((point) => point[1] === 185.5)).toBe(true);
    latestSource().emitSystem({
      ...SYSTEM_OK,
      timestamp: new Date().toISOString(),
      gpu: { available: true, values: {} },
    });
    await settle();
    expect(power().points.at(-1)?.[1]).toBeNull();
    wrapper.unmount();
  });

  it('waits for a validated initial health snapshot', async () => {
    const wrapper = await mountSignedIn();
    expect(wrapper.text()).toContain('Connecting');
    latestSource().emitHealth({ ...VALID_PAYLOAD, checks: [{ name: 'server', status: 'ok' }] });
    await settle();
    expect(wrapper.text()).not.toContain('Server ready');
    expect(wrapper.find('.status-bar').exists()).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
    wrapper.unmount();
    expect(latestSource().closed).toBe(true);
  });

  it('shows an unknown overall status after transport loss, keeping labelled last values (R1)', async () => {
    const wrapper = await mountSignedIn();
    const source = latestSource();
    source.onopen?.(new Event('open'));
    source.emitHealth({ ...VALID_PAYLOAD, checks: [{ name: 'server', status: 'ok' }] });
    source.emitTelemetry(TELEMETRY_OK);
    source.emitSystem(SYSTEM_OK);
    await settle();
    source.emitError();
    await settle();
    expect(wrapper.find('.beacon-status').text()).toBe('Connection lost');
    expect(wrapper.text()).toContain('Current server state unknown');
    expect(wrapper.findAll('.computer-kpis .kpi')[3]!.classes()).toContain('stale');
    expect(wrapper.text()).toContain('4.0');
    source.onopen?.(new Event('open'));
    // The server announces the reconnection outcome before any data frame:
    // only `telemetry` was missed while disconnected (M5C replay notice).
    source.emitStream({ kind: 'replay', types: ['telemetry'] });
    await settle();
    expect(wrapper.find('.beacon-status').text()).toContain('Replaying missed events');
    source.emitHealth({ ...VALID_PAYLOAD, checks: [{ name: 'server', status: 'ok' }] });
    await settle();
    expect(wrapper.findAll('.computer-kpis .kpi')[3]!.classes()).toContain('stale');
    source.emitTelemetry(TELEMETRY_OK);
    await settle();
    expect(wrapper.findAll('.computer-kpis .kpi')[3]!.classes()).not.toContain('stale');
    wrapper.unmount();
  });

  it('does not append vLLM measurements on system updates (R2)', async () => {
    const wrapper = await mountSignedIn();
    latestSource().emitHealth(VALID_PAYLOAD);
    latestSource().emitTelemetry({ ...TELEMETRY_OK, timestamp: new Date().toISOString() });
    await settle();
    const before = structuredClone(wrapper.findComponent(TimeChart).props('series'));
    latestSource().emitSystem({ ...SYSTEM_OK, timestamp: new Date().toISOString() });
    await settle();
    expect(wrapper.findComponent(TimeChart).props('series')).toEqual(before);
    wrapper.unmount();
  });

  it('keeps GPU fresh when vLLM is stale, and stale when its system source is stale (R4)', async () => {
    const wrapper = await mountSignedIn();
    latestSource().emitHealth(VALID_PAYLOAD);
    latestSource().emitTelemetry({ ...TELEMETRY_OK, sourceStatus: 'stale' });
    latestSource().emitSystem(SYSTEM_OK);
    await settle();
    const cards = wrapper.findAll('.computer-kpis .kpi');
    expect(cards[3]?.classes()).toContain('stale');
    expect(cards[0]?.classes()).not.toContain('stale');
    expect(wrapper.find('.dimmed').exists()).toBe(false);
    latestSource().emitTelemetry(TELEMETRY_OK);
    latestSource().emitSystem({ ...SYSTEM_OK, sourceStatus: 'stale' });
    await settle();
    expect(cards[3]?.classes()).not.toContain('stale');
    expect(cards[0]?.classes()).toContain('stale');
    wrapper.unmount();
  });

  it('distinguishes schema failures from transport loss and recovers per source (R5)', async () => {
    const wrapper = await mountSignedIn();
    const source = latestSource();
    source.onopen?.(new Event('open'));
    source.emitHealth(VALID_PAYLOAD);
    source.emitTelemetry(TELEMETRY_OK);
    await settle();
    source.emitTelemetry({ sourceStatus: 'bogus' });
    await settle();
    expect(wrapper.find('.live-chip').classes()).toContain('connected');
    expect(wrapper.findAll('.computer-kpis .kpi')[3]!.classes()).toContain('stale');
    expect(wrapper.find('.beacon-status').text()).toBe('Incomplete telemetry');
    source.emitTelemetry(TELEMETRY_OK);
    await settle();
    expect(wrapper.findAll('.computer-kpis .kpi')[3]!.classes()).not.toContain('stale');
    expect(wrapper.find('.beacon-status').text()).not.toBe('Incomplete telemetry');
    wrapper.unmount();
  });

  it('keeps missing values honest and explains unavailable GPU metrics', async () => {
    const wrapper = await mountSignedIn();
    latestSource().emitHealth(VALID_PAYLOAD);
    latestSource().emitTelemetry({
      service: TELEMETRY_OK.service,
      sourceStatus: 'ok',
      timestamp: TELEMETRY_OK.timestamp,
      gpu: TELEMETRY_OK.gpu,
    });
    latestSource().emitSystem({
      ...SYSTEM_OK,
      gpu: { available: false, reason: 'GPU-Helfer nicht erreichbar' },
    });
    await settle();
    expect(wrapper.text()).toContain('GPU-Helfer nicht erreichbar');
    expect(wrapper.text()).toContain('MTP disabled or not reported');
    expect(
      wrapper.findAll('.primary-kpis .kpi-value').every((node) => node.text().includes('–'))
    ).toBe(true);
    wrapper.unmount();
  });

  it('keeps the overview free of repeated timestamps and chart explanations', async () => {
    const wrapper = await mountSignedIn();
    latestSource().emitHealth(VALID_PAYLOAD);
    latestSource().emitTelemetry(TELEMETRY_OK);
    latestSource().emitSystem(SYSTEM_OK);
    await settle();

    expect(wrapper.find('.kpi-stamp').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('neu berechnet');
    expect(wrapper.text()).not.toContain('Historie:');
    expect(wrapper.text()).not.toContain('Messstand');
    expect(wrapper.findAllComponents(TimeChart).every((chart) => !chart.props('subtitle'))).toBe(
      true
    );
    wrapper.unmount();
  });

  it('exposes initial connection failure and retry', async () => {
    const wrapper = await mountSignedIn();
    latestSource().emitError();
    await settle();
    expect(wrapper.find('button.retry').exists()).toBe(true);
    await wrapper.find('button.retry').trigger('click');
    expect(FakeEventSource.instances).toHaveLength(2);
    latestSource().emitHealth(VALID_PAYLOAD);
    await settle();
    expect(wrapper.find('.live-chip').classes()).toContain('connected');
    wrapper.unmount();
  });

  it('returns to login when a reconnect finds an expired session', async () => {
    const wrapper = await mountSignedIn();
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ authenticated: false }))
    );
    latestSource().emitError();
    await settle();
    expect(wrapper.find('input[type=password]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Your session has expired');
    expect(latestSource().closed).toBe(true);
    wrapper.unmount();
  });

  it('does not claim logout succeeded when the request failed', async () => {
    const wrapper = await mountSignedIn();
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError('offline'));
    await wrapper.find('.sidebar-signout').trigger('click');
    await settle();
    expect(document.querySelector('.notification-stack')?.textContent).toContain('Sign-out failed');
    expect(wrapper.find('.stage-content .inline-error').exists()).toBe(false);
    expect(wrapper.find('input[type=password]').exists()).toBe(false);
    expect(latestSource().closed).toBe(false);
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ authenticated: false }))
    );
    await wrapper.find('.sidebar-signout').trigger('click');
    await settle();
    expect(latestSource().closed).toBe(true);
    expect(wrapper.find('input[type=password]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('uses the selected time range for historical charts and request list', async () => {
    const wrapper = await mountSignedIn();
    await wrapper.findAll('.range-picker button')[2]?.trigger('click');
    await settle();
    const calls = vi
      .mocked(globalThis.fetch)
      .mock.calls.map((call) => new URL(String(call[0]), 'http://localhost'));
    const history = calls.filter((url) => url.pathname === '/api/metrics/history').at(-1);
    expect(history?.searchParams.get('bucketSeconds')).toBe('300');
    expect(
      Date.parse(history?.searchParams.get('to') ?? '') -
        Date.parse(history?.searchParams.get('from') ?? '')
    ).toBe(86_400_000);
    const list = calls.filter((url) => url.pathname === '/api/requests').at(-1);
    expect(
      Date.parse(list?.searchParams.get('to') ?? '') -
        Date.parse(list?.searchParams.get('from') ?? '')
    ).toBe(86_400_000);
    wrapper.unmount();
  });

  it('signs in with password only and creates one stream after authentication', async () => {
    mockSession(false);
    const wrapper = mount(App, { global: { stubs: { TimeChart: true } } });
    await settle();
    expect(FakeEventSource.instances).toHaveLength(0);
    mockSession(true);
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ authenticated: true, expiresAt: '2027-01-01T00:00:00.000Z' }))
    );
    await wrapper.find('input[type=password]').setValue('test password');
    await wrapper.find('form').trigger('submit');
    await settle();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(wrapper.find('input[type=password]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows no login screen and no sign-out action when login is not required', async () => {
    mockSession(true, false);
    const wrapper = mount(App, { global: { stubs: { TimeChart: true } } });
    await settle();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(wrapper.find('input[type=password]').exists()).toBe(false);
    expect(wrapper.find('.sidebar-signout').exists()).toBe(false);
    expect(wrapper.find('.app-sidebar').exists()).toBe(true);
    wrapper.unmount();
  });

  it('keeps the sign-out action when an older server omits the loginRequired flag', async () => {
    mockSession(true); // no loginRequired field at all
    const wrapper = mount(App, { global: { stubs: { TimeChart: true } } });
    await settle();
    expect(wrapper.find('input[type=password]').exists()).toBe(false);
    expect(wrapper.find('.sidebar-signout').exists()).toBe(true);
    wrapper.unmount();
  });
});
