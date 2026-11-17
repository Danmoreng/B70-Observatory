import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import App from '../src/App.vue';
vi.mock('../src/components/EngineModeSwitcher.vue', () => ({ default: { template: '<div />' } }));
import { appRoute } from '../src/composables/useAppRoute.js';
import { useObservatory } from '../src/composables/useObservatory.js';
import type { SystemSnapshot, VllmTelemetryPayload } from '@observatory/contracts';

/**
 * M5C regression tests for the live/reconnect contract at the composable
 * level: the SSE stream is faked exactly the way the real server drives it
 * (open → stream notice → data frames; error → open → …), so the
 * freshness/synchronisation logic is tested against the M5C wire protocol.
 */

const HEALTH_OK = {
  service: 'local-ai-b70-observatory',
  status: 'ok',
  version: '0.1.0',
  startedAt: '2025-01-01T10:00:00.000Z',
  timestamp: '2025-01-01T10:00:05.000Z',
  uptimeSeconds: 5,
  checks: [{ name: 'server', status: 'ok' }],
};

const TELEMETRY_OK: VllmTelemetryPayload = {
  service: 'local-ai-b70-observatory',
  sourceStatus: 'ok',
  timestamp: '2025-01-01T10:00:05.000Z',
  model: 'Qwen3.8-27B',
  requests: { running: 2, waiting: 0 },
  kvCacheUsagePercent: 25,
  gpu: { available: false, reason: 'Test' },
};

const SYSTEM_OK: SystemSnapshot = {
  service: 'local-ai-b70-observatory',
  sourceStatus: 'ok',
  timestamp: '2025-01-01T10:00:05.000Z',
  gpu: { available: false, reason: 'Test' },
};

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, EventListener[]>();

  constructor(url: string | URL, init?: EventSourceInit) {
    this.url = String(url);
    void init;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (listener === null) return;
    const callable: EventListener =
      typeof listener === 'function' ? listener : (event) => listener.handleEvent(event);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callable]);
  }

  private emit(type: string, value: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(value) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  emitHealth(value: unknown): void {
    this.emit('health', value);
  }

  emitTelemetry(value: unknown): void {
    this.emit('telemetry', value);
  }

  emitSystem(value: unknown): void {
    this.emit('system', value);
  }

  emitStream(value: unknown): void {
    this.emit('stream', value);
  }

  emitHistory(value: unknown): void {
    this.emit('history', value);
  }

  emitError(): void {
    this.onerror?.(new Event('error'));
  }

  close(): void {
    this.closed = true;
  }
}

const mounted: Array<() => void> = [];

beforeEach(() => {
  appRoute.page = 'hardware';
  appRoute.taskId = undefined;
  appRoute.projectId = undefined;
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/auth/session') {
      return new Response(
        JSON.stringify({ authenticated: true, expiresAt: '2025-02-01T10:00:00.000Z' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.startsWith('/api/requests') || url.startsWith('/api/metrics/history')) {
      return new Response(JSON.stringify({ items: [], nextCursor: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
  });
});

afterEach(() => {
  mounted.splice(0).forEach((stop) => stop());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await flushPromises();
}

async function mountComposable() {
  const wrapper = mount(
    defineComponent({
      setup() {
        return { obs: useObservatory() };
      },
      template: '<div></div>',
    })
  );
  mounted.push(() => wrapper.unmount());
  await settle();
  const source = FakeEventSource.instances.at(-1);
  if (source === undefined) throw new Error('EventSource was not created');
  return {
    wrapper,
    obs: (wrapper.vm as { obs: ReturnType<typeof useObservatory> }).obs,
    source,
  };
}

async function reachConnected(obs: ReturnType<typeof useObservatory>): Promise<void> {
  const source = FakeEventSource.instances.at(-1)!;
  source.onopen?.(new Event('open'));
  source.emitStream({ kind: 'resync' });
  source.emitHealth(HEALTH_OK);
  source.emitTelemetry(TELEMETRY_OK);
  source.emitSystem(SYSTEM_OK);
  await settle();
  expect(obs.connection.value).toBe('connected');
}

describe('M5C reconnect contract (stream notice → freshness)', () => {
  it('resync: everything becomes last-known, then current again after validated snapshots', async () => {
    const { obs, source } = await mountComposable();
    await reachConnected(obs);

    // Transport loss: nothing may be called current any more.
    source.emitError();
    await settle();
    expect(obs.connection.value).toBe('reconnecting');
    expect(obs.fresh.value).toEqual({ health: false, telemetry: false, system: false });

    // Server cannot continue from Last-Event-ID → explicit re-synchronisation.
    source.onopen?.(new Event('open'));
    source.emitStream({ kind: 'resync' });
    await settle();
    expect(obs.sync.value).toBe('resync');
    expect(obs.fresh.value).toEqual({ health: false, telemetry: false, system: false });
    // Old values remain readable (not wiped) while the notice is pending.
    expect(obs.telemetry.value?.requests?.running).toBe(2);
    // … and history is re-fetched, not replayed.
    expect(obs.metricRevision.value).toBeGreaterThan(0);
    expect(obs.requestRevision.value).toBeGreaterThan(0);

    // Fresh snapshots arrive → only now may the values be called current.
    source.emitHealth({ ...HEALTH_OK, uptimeSeconds: 900 });
    await settle();
    expect(obs.connection.value).toBe('connecting');
    const newer = { ...TELEMETRY_OK, requests: { running: 9, waiting: 0 } };
    source.emitTelemetry(newer);
    await settle();
    expect(obs.connection.value).toBe('connecting');
    source.emitSystem({ ...SYSTEM_OK, timestamp: '2025-01-01T10:15:00.000Z' });
    await settle();
    expect(obs.connection.value).toBe('connected');
    expect(obs.sync.value).toBe('none');
    expect(obs.fresh.value).toEqual({ health: true, telemetry: true, system: true });
    expect(obs.telemetry.value?.requests?.running).toBe(9);
  });

  it('replay without missed events keeps un-missed sources current immediately', async () => {
    const { obs, source } = await mountComposable();
    await reachConnected(obs);
    source.emitError();
    await settle();
    expect(obs.connection.value).toBe('reconnecting');

    source.onopen?.(new Event('open'));
    source.emitStream({ kind: 'replay', types: ['telemetry'] });
    await settle();
    // No health/system event was missed: those values are provably the
    // server's current state and are current again; telemetry must wait
    // for its replayed frame.
    expect(obs.fresh.value.health).toBe(true);
    expect(obs.fresh.value.system).toBe(true);
    expect(obs.fresh.value.telemetry).toBe(false);
    expect(obs.connection.value).toBe('connecting');
    expect(obs.sync.value).toBe('replay');

    source.emitTelemetry({ ...TELEMETRY_OK, requests: { running: 7, waiting: 0 } });
    await settle();
    expect(obs.connection.value).toBe('connected');
    expect(obs.sync.value).toBe('none');
    expect(obs.fresh.value.telemetry).toBe(true);
  });

  it('replay lists only what was missed and re-fetches history when needed', async () => {
    const { obs, source } = await mountComposable();
    await reachConnected(obs);
    const metricsBefore = obs.metricRevision.value;
    const requestsBefore = obs.requestRevision.value;
    source.emitError();
    await settle();
    source.onopen?.(new Event('open'));
    source.emitStream({ kind: 'replay', types: ['history'] });
    await settle();
    expect(obs.metricRevision.value).toBe(metricsBefore + 1);
    expect(obs.requestRevision.value).toBe(requestsBefore + 1);
    // No data source was missed: connection may settle immediately.
    expect(obs.connection.value).toBe('connected');
    expect(obs.fresh.value).toEqual({ health: true, telemetry: true, system: true });
  });

  it('reports an invalid stream frame as a stream error and recovers on a valid one', async () => {
    const { obs, source } = await mountComposable();
    await reachConnected(obs);
    source.emitError();
    await settle();
    source.onopen?.(new Event('open'));
    source.emitStream({ kind: 'bogus' });
    await settle();
    expect(obs.errors.value.stream).not.toBe('');
    expect(obs.connection.value).toBe('connecting');
    source.emitStream({ kind: 'replay', types: [] });
    await settle();
    expect(obs.errors.value.stream).toBe('');
    expect(obs.connection.value).toBe('connected');
  });

  it('keeps invalid-payload errors attributed to their source without dropping the connection', async () => {
    const { obs, source } = await mountComposable();
    await reachConnected(obs);
    source.emitTelemetry({ sourceStatus: 'bogus' });
    await settle();
    expect(obs.errors.value.telemetry).not.toBe('');
    expect(obs.errors.value.health).toBe('');
    expect(obs.connection.value).toBe('connected');
  });
});

describe('M5C accessibility acceptance (real DOM)', () => {
  async function mountApp() {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const wrapper: VueWrapper = mount(App, {
      attachTo: host,
      global: { stubs: { TimeChart: true } },
    });
    mounted.push(() => {
      wrapper.unmount();
      host.remove();
    });
    await settle();
    const source = FakeEventSource.instances.at(-1);
    if (source === undefined) throw new Error('EventSource was not created');
    source.onopen?.(new Event('open'));
    source.emitStream({ kind: 'resync' });
    source.emitHealth(HEALTH_OK);
    source.emitTelemetry(TELEMETRY_OK);
    source.emitSystem(SYSTEM_OK);
    await settle();
    return { wrapper, source };
  }

  it('keeps healthy status compact and exposes the live state in the sidebar', async () => {
    const { wrapper } = await mountApp();
    expect(wrapper.find('.status-bar').exists()).toBe(false);
    const chip = wrapper.find('.sidebar-connection');
    expect(chip.attributes('role')).toBe('status');
    expect(chip.text()).toBe('Connected');
    wrapper.unmount();
  });

  it('associates the login form label with its input and names the form', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ authenticated: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const wrapper = mount(App, { attachTo: host, global: { stubs: { TimeChart: true } } });
    mounted.push(() => {
      wrapper.unmount();
      host.remove();
    });
    await settle();
    const label = wrapper.find('label[for="password"]');
    expect(label.exists()).toBe(true);
    expect(label.text()).toBe('Password');
    const input = wrapper.find('#password');
    expect(input.attributes('type')).toBe('password');
    expect(wrapper.find('form[aria-labelledby="login-title"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('links a failed login to the password field for assistive technology', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/session')
        return new Response(JSON.stringify({ authenticated: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (url === '/api/auth/login') return new Response(null, { status: 401 });
      return new Response('{}', { status: 404 });
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const wrapper = mount(App, { attachTo: host, global: { stubs: { TimeChart: true } } });
    mounted.push(() => {
      wrapper.unmount();
      host.remove();
    });
    await settle();
    await wrapper.find('input[type=password]').setValue('falsches Passwort');
    await wrapper.get('form.login-panel').trigger('submit');
    await settle();
    const input = wrapper.find('#password');
    expect(input.attributes('aria-describedby')).toBe('login-error');
    const notice = wrapper.find('#login-error');
    expect(notice.exists()).toBe(true);
    expect(notice.attributes('role')).toBe('alert');
    expect(notice.text()).toContain('password');
    wrapper.unmount();
  });

  it('labels table headers with scope and stamps lifecycle times with machine-readable datetimes', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/auth/session')
          return new Response(
            JSON.stringify({ authenticated: true, expiresAt: '2025-02-01T10:00:00.000Z' }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        if (url.startsWith('/api/requests?'))
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: 'b0000000-0000-4000-8000-000000000001',
                  origin: 'web',
                  model: 'Qwen3.8-27B',
                  endpoint: '/v1/chat/completions',
                  method: 'POST',
                  status: 'completed',
                  httpStatus: 200,
                  startedAtUtc: '2025-01-01T09:00:00.000Z',
                  completedAtUtc: '2025-01-01T09:00:04.000Z',
                  durationMs: 4000,
                  ttftMs: 210,
                  promptTokens: 100,
                  completionTokens: 40,
                  totalTokens: 140,
                  promptBytes: 900,
                  responseBytes: 1400,
                },
              ],
              nextCursor: null,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        if (url.startsWith('/api/requests/b0000000'))
          return new Response(
            JSON.stringify({
              id: 'b0000000-0000-4000-8000-000000000001',
              origin: 'web',
              model: 'Qwen3.8-27B',
              endpoint: '/v1/chat/completions',
              method: 'POST',
              status: 'completed',
              httpStatus: 200,
              startedAtUtc: '2025-01-01T09:00:00.000Z',
              completedAtUtc: '2025-01-01T09:00:04.000Z',
              durationMs: 4000,
              ttftMs: 210,
              promptTokens: 100,
              completionTokens: 40,
              totalTokens: 140,
              promptBytes: 900,
              responseBytes: 1400,
              events: [
                { sequence: 1, eventType: 'start', atUtc: '2025-01-01T09:00:00.000Z' },
                { sequence: 2, eventType: 'first_token', atUtc: '2025-01-01T09:00:00.210Z' },
                { sequence: 3, eventType: 'complete', atUtc: '2025-01-01T09:00:04.000Z' },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        if (url.startsWith('/api/metrics/history'))
          return new Response(
            JSON.stringify({ series: 'x', unit: 'count', bucketSeconds: 60, buckets: [] }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
      });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const wrapper = mount(App, {
      attachTo: host,
      global: { stubs: { TimeChart: true } },
    });
    mounted.push(() => {
      wrapper.unmount();
      host.remove();
      fetchMock.mockRestore();
    });
    await settle();
    // Request list rows appear; open the detail view through its button.
    const link = wrapper.find('button.request-link');
    expect(link.exists()).toBe(true);
    await link.trigger('click');
    await settle();
    const headers = wrapper.findAll('.requests-panel th');
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) expect(header.attributes('scope')).toBe('col');
    const times = wrapper.findAll('.lifecycle time');
    expect(times.length).toBe(3);
    expect(times[0]?.attributes('datetime')).toBe('2025-01-01T09:00:00.000Z');
  });

  it('moves focus into the request detail on open and restores it to the opener on Escape', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/auth/session')
          return new Response(
            JSON.stringify({ authenticated: true, expiresAt: '2025-02-01T10:00:00.000Z' }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        if (url.startsWith('/api/requests?'))
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: 'c0000000-0000-4000-8000-000000000002',
                  origin: 'web',
                  model: 'Qwen3.8-27B',
                  endpoint: '/v1/chat/completions',
                  method: 'POST',
                  status: 'completed',
                  startedAtUtc: '2025-01-01T09:00:00.000Z',
                  promptBytes: 0,
                  responseBytes: 0,
                },
              ],
              nextCursor: null,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        if (url.startsWith('/api/requests/c0000000'))
          return new Response(
            JSON.stringify({
              id: 'c0000000-0000-4000-8000-000000000002',
              origin: 'web',
              model: 'Qwen3.8-27B',
              endpoint: '/v1/chat/completions',
              method: 'POST',
              status: 'completed',
              startedAtUtc: '2025-01-01T09:00:00.000Z',
              promptBytes: 0,
              responseBytes: 0,
              events: [],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
      });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const wrapper = mount(App, {
      attachTo: host,
      global: { stubs: { TimeChart: true } },
    });
    mounted.push(() => {
      wrapper.unmount();
      host.remove();
      fetchMock.mockRestore();
    });
    await settle();
    const link = wrapper.find('button.request-link');
    await link.trigger('click');
    await settle();
    // Focus moves into the detail view (to the close control)…
    const closeButton = wrapper.find('.request-detail button.quiet-button');
    expect(closeButton.exists()).toBe(true);
    expect((document.activeElement as HTMLElement | null)?.tagName).toBe('BUTTON');
    // …and Escape returns focus to the row that opened it.
    await wrapper.find('.request-detail').trigger('keydown', { key: 'Escape' });
    await settle();
    expect(wrapper.find('.request-detail').exists()).toBe(false);
    const active = document.activeElement as HTMLElement | null;
    expect(active?.classList.contains('request-link')).toBe(true);
  });
});
