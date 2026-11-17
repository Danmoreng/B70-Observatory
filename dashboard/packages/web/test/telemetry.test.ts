import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VllmTelemetryPayload } from '@observatory/contracts';
import { HealthFetchError, subscribeHealth } from '../src/lib/api.js';

const TELEMETRY: VllmTelemetryPayload = {
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
  prefixCache: { queriedTokens: 500, hitTokens: 300, hitRate: 0.6 },
  mtp: { draftTokens: 100, acceptedTokens: 80, acceptanceRate: 0.8 },
  requestsFinished: { total: 12, byReason: { stop: 10, error: 2 } },
  latency: { e2eAvgMs: 3500, ttftAvgMs: 210 },
  gpu: { available: false, reason: 'Test' },
};

const HEALTH = {
  service: 'local-ai-b70-observatory',
  status: 'ok',
  version: '0.1.0',
  startedAt: '2025-01-01T10:00:00.000Z',
  timestamp: '2025-01-01T10:00:05.000Z',
  uptimeSeconds: 5,
  checks: [{ name: 'server', status: 'ok' }],
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

  emitTelemetry(value: unknown): void {
    const event = new MessageEvent('telemetry', { data: JSON.stringify(value) });
    for (const listener of this.listeners.get('telemetry') ?? []) listener(event);
  }

  emitHealth(value: unknown): void {
    const event = new MessageEvent('health', { data: JSON.stringify(value) });
    for (const listener of this.listeners.get('health') ?? []) listener(event);
  }

  emitRawTelemetry(data: string): void {
    const event = new MessageEvent('telemetry', { data });
    for (const listener of this.listeners.get('telemetry') ?? []) listener(event);
  }

  close(): void {
    this.closed = true;
  }
}

let source: FakeEventSource;

beforeEach(() => {
  FakeEventSource.instances = [];
  source = new FakeEventSource('/api/events', { withCredentials: true });
});

afterEach(() => {
  // nothing to restore (no vi usage)
});

describe('subscribeHealth (M4A telemetry frames)', () => {
  it('dispatches a contract-valid telemetry frame to onTelemetry', () => {
    const onTelemetry = vi.fn();
    const stop = subscribeHealth(
      { onHealth: () => undefined, onTelemetry },
      () => source as unknown as EventSource
    );
    source.emitTelemetry(TELEMETRY);
    expect(onTelemetry).toHaveBeenCalledTimes(1);
    expect(onTelemetry).toHaveBeenCalledWith(TELEMETRY);
    stop();
    expect(source.closed).toBe(true);
  });

  it('round-trips the payload through the shared contract schema', () => {
    const seen: VllmTelemetryPayload[] = [];
    const stop = subscribeHealth(
      { onHealth: () => undefined, onTelemetry: (payload) => seen.push(payload) },
      () => source as unknown as EventSource
    );
    source.emitTelemetry(TELEMETRY);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.sourceStatus).toBe('ok');
    expect(seen[0]?.requests).toEqual({ running: 2, waiting: 1 });
    stop();
  });

  it('reports an invalid telemetry frame as an error without calling onTelemetry', () => {
    const onTelemetry = vi.fn();
    const onError = vi.fn();
    const stop = subscribeHealth(
      { onHealth: () => undefined, onTelemetry, onError },
      () => source as unknown as EventSource
    );
    source.emitRawTelemetry('{"sourceStatus":"bogus"}');
    expect(onTelemetry).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as HealthFetchError).code).toBe('invalid_payload');
    stop();
  });

  it('reports a non-JSON telemetry frame as an error', () => {
    const onTelemetry = vi.fn();
    const onError = vi.fn();
    const stop = subscribeHealth(
      { onHealth: () => undefined, onTelemetry, onError },
      () => source as unknown as EventSource
    );
    source.emitRawTelemetry('<html>gateway timeout</html>');
    expect(onTelemetry).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    stop();
  });

  it('keeps delivering health frames after a rejected telemetry frame', () => {
    const onHealth = vi.fn();
    const stop = subscribeHealth(
      { onHealth, onError: () => undefined },
      () => source as unknown as EventSource
    );
    source.emitRawTelemetry('not json');
    source.emitHealth(HEALTH);
    expect(onHealth).toHaveBeenCalledTimes(1);
    expect((onHealth.mock.calls[0]?.[0] as { status: string }).status).toBe('ok');
    stop();
  });

  it('does not require onTelemetry to be provided', () => {
    const stop = subscribeHealth(
      { onHealth: () => undefined },
      () => source as unknown as EventSource
    );
    source.emitTelemetry(TELEMETRY); // no handler → silently ignored
    expect(source.closed).toBe(false);
    stop();
  });
});
