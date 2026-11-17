import { describe, expect, it, vi } from 'vitest';
import { parseVllmTelemetryPayload, type VllmTelemetryPayload } from '@observatory/contracts';
import { MetricSampleSchema } from '../../src/db/contracts.js';
import { VllmCollector, type TelemetrySourceState } from '../../src/telemetry/collector.js';
import { prometheusFixture, type TelemetryFixtureValues } from './fixtures.js';

const T0 = Date.parse('2025-01-01T10:00:00.000Z');
const GPU = { available: false as const, reason: 'Testprobe: kein Intel-GPU gefunden' };

const idleFixture: TelemetryFixtureValues = {
  running: 1,
  waiting: 0,
  kv: 0.125,
  promptTokens: 1_000,
  generationTokens: 100,
  prefixQueries: 500,
  prefixHits: 250,
  mtpDraft: 100,
  mtpAccepted: 80,
  successStop: 3,
  e2eSumSeconds: 3.0,
  e2eCount: 3,
  ttftSumSeconds: 1.0,
  ttftCount: 3,
  prefillKvComputedSum: 500,
  prefillTimeSumSeconds: 1.0,
  prefillCount: 3,
};

type FetchLike = (url?: string, init?: RequestInit) => Promise<Response>;

function responseFor(fixture: TelemetryFixtureValues): Promise<Response> {
  return Promise.resolve(
    new Response(prometheusFixture(fixture), {
      status: 200,
      headers: { 'content-type': 'text/plain; version=0.0.4' },
    })
  );
}

const failingFetch: FetchLike = async () => {
  throw new TypeError('fetch failed');
};

interface Harness {
  collector: VllmCollector;
  snapshots: VllmTelemetryPayload[];
  stateChanges: TelemetrySourceState[];
  persist: ReturnType<typeof vi.fn>;
  setNow: (ms: number) => void;
  setFetch: (impl: FetchLike) => void;
  fetchCalls: { count: number };
}

function harness(initial: FetchLike, initialNowMs = T0, persistMinIntervalMs = 0): Harness {
  let nowMs = initialNowMs;
  const fetchRef: { impl: FetchLike } = { impl: initial };
  const snapshots: VllmTelemetryPayload[] = [];
  const stateChanges: TelemetrySourceState[] = [];
  const persist = vi.fn();
  const fetchCalls = { count: 0 };
  const collector = new VllmCollector({
    metricsUrl: 'http://127.0.0.1:9/metrics',
    gpu: GPU,
    fetchImpl: (async (url: string, init?: RequestInit) => {
      fetchCalls.count += 1;
      return fetchRef.impl(url, init);
    }) as typeof fetch,
    now: () => new Date(nowMs),
    intervalMs: 5_000,
    timeoutMs: 100,
    staleAfterMs: 15_000,
    persistMinIntervalMs,
    persist: (samples) => {
      for (const sample of samples) MetricSampleSchema.parse(sample);
      persist(samples);
    },
    onSnapshot: (payload) => snapshots.push(payload),
    onSourceStateChange: (state) => stateChanges.push(state),
    log: () => undefined,
  });
  return {
    collector,
    snapshots,
    stateChanges,
    persist,
    setNow: (ms) => {
      nowMs = ms;
    },
    setFetch: (impl: FetchLike) => {
      fetchRef.impl = impl;
    },
    fetchCalls,
  };
}

describe('VllmCollector', () => {
  it('persists quiet periods on cadence without duplicate live events (R3)', async () => {
    const h = harness(() => responseFor(idleFixture), T0, 60_000);
    for (const elapsed of [0, 5_000, 60_000, 120_000]) {
      h.setNow(T0 + elapsed);
      await h.collector.scrapeOnce();
    }
    expect(h.persist).toHaveBeenCalledTimes(3);
    expect(h.snapshots).toHaveLength(2);
    expect(h.collector.latestSnapshot?.timestamp).toBe(new Date(T0 + 120_000).toISOString());
    h.setNow(T0 + 180_000);
    h.setFetch(failingFetch);
    await h.collector.scrapeOnce();
    expect(h.collector.latestSnapshot?.sourceStatus).toBe('stale');
    expect(h.persist).toHaveBeenCalledTimes(3);
  });

  it('publishes one contract-valid snapshot on the first successful scrape', async () => {
    const h = harness(() => responseFor(idleFixture));
    await h.collector.scrapeOnce();

    expect(h.snapshots).toHaveLength(1);
    const payload = parseVllmTelemetryPayload(h.snapshots[0]);
    expect(payload.sourceStatus).toBe('ok');
    expect(payload.model).toBe('Qwen3.8-27B');
    expect(payload.gpu).toEqual(GPU);
    expect(h.stateChanges).toEqual([{ status: 'ok' }]);
    expect(h.collector.sourceState()).toEqual({ status: 'ok' });
  });

  it('stays silent while the semantic content does not change', async () => {
    const h = harness(() => responseFor(idleFixture));
    await h.collector.scrapeOnce(); // first sighting: rates undefined
    h.setNow(T0 + 5_000);
    await h.collector.scrapeOnce(); // counters unchanged: no prefill rate (idle), decode 0
    h.setNow(T0 + 10_000);
    await h.collector.scrapeOnce(); // still unchanged → identical key, no event

    expect(h.snapshots).toHaveLength(2);
    expect(h.snapshots[0]?.tokens?.promptTokensPerSecond).toBeUndefined();
    // Idle means "no prefill work", reported as a gap – not as 0 tok/s.
    expect(h.snapshots[1]?.tokens?.promptTokensPerSecond).toBeUndefined();
    expect(h.snapshots[1]?.tokens?.generationTokensPerSecond).toBe(0);
  });

  it('publishes when a prefill finishes', async () => {
    let prefillKv = 500;
    let prefillTime = 1.0;
    const h = harness(() =>
      responseFor({
        ...idleFixture,
        promptTokens: 1_100,
        prefillKvComputedSum: prefillKv,
        prefillTimeSumSeconds: prefillTime,
      })
    );
    await h.collector.scrapeOnce();
    prefillKv = 600;
    prefillTime = 2.0;
    h.setNow(T0 + 5_000);
    await h.collector.scrapeOnce();
    expect(h.snapshots).toHaveLength(2);
    expect(h.snapshots[1]?.tokens?.promptTokens).toBe(1_100);
    expect(h.snapshots[1]?.tokens?.promptTokensPerSecond).toBe(100); // 100 / 1 s
  });

  it('reports an unreachable source before any success (error, sanitized message)', async () => {
    const h = harness(failingFetch);
    await h.collector.scrapeOnce();

    expect(h.snapshots).toHaveLength(1);
    expect(h.snapshots[0]?.sourceStatus).toBe('error');
    expect(h.snapshots[0]?.sourceMessage).toContain('Metrikquelle nicht erreichbar');
    expect(h.snapshots[0]?.requests).toBeUndefined(); // no data was ever seen
    expect(h.collector.healthCheck().status).toBe('error');
  });

  it('keeps a fresh last-known-good snapshot on one transient scrape failure', async () => {
    const h = harness(() => responseFor(idleFixture));
    await h.collector.scrapeOnce();
    h.setNow(T0 + 5_000); // still inside staleAfterMs (15 s)
    h.setFetch(failingFetch);
    await h.collector.scrapeOnce();

    expect(h.snapshots).toHaveLength(1);
    expect(h.snapshots[0]?.sourceStatus).toBe('ok');
    expect(h.collector.sourceState().status).toBe('ok');
    expect(h.collector.healthCheck().status).toBe('ok');
    expect(h.stateChanges.map((state) => state.status)).toEqual(['ok']);
  });

  it('rejects derived values that violate the shared runtime contract', async () => {
    const invalid = [
      'vllm:num_requests_running{model_name="Qwen3.8-27B"} -1',
      'vllm:num_requests_waiting{model_name="Qwen3.8-27B"} 0',
      'vllm:prefix_cache_queries_total{model_name="Qwen3.8-27B"} 1',
      'vllm:prefix_cache_hits_total{model_name="Qwen3.8-27B"} 2',
      '',
    ].join('\n');
    const h = harness(async () => new Response(invalid));
    await h.collector.scrapeOnce();

    expect(h.snapshots).toHaveLength(1);
    expect(h.snapshots[0]).toMatchObject({
      sourceStatus: 'error',
      sourceMessage: 'Metrikquelle liefert Werte außerhalb des Datenvertrags',
    });
    expect(h.snapshots[0]?.requests).toBeUndefined();
    expect(h.collector.healthCheck().status).toBe('error');
  });

  it('classifies an aborted request as a timeout with the configured budget', async () => {
    const hangForever: FetchLike = async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        // the request never resolves on its own
      });
    const h = harness(hangForever);
    await h.collector.scrapeOnce(); // timeoutMs is 100 ms in the harness

    expect(h.snapshots[0]?.sourceStatus).toBe('error');
    expect(h.snapshots[0]?.sourceMessage).toContain('timeout nach 100 ms');
    expect(h.collector.healthCheck().status).toBe('error');
  });

  it('classifies a non-2xx response with the HTTP status', async () => {
    const h = harness(async () => new Response('boom', { status: 502 }));
    await h.collector.scrapeOnce();
    expect(h.snapshots[0]?.sourceStatus).toBe('error');
    expect(h.snapshots[0]?.sourceMessage).toContain('HTTP 502');
  });

  it('treats a response without usable series as a failure', async () => {
    const h = harness(
      async () => new Response('# HELP only a comment\n# TYPE only_meta gauge\n', { status: 200 })
    );
    await h.collector.scrapeOnce();
    expect(h.snapshots[0]?.sourceStatus).toBe('error');
    expect(h.snapshots[0]?.sourceMessage).toContain('keine auswertbaren Seren');
  });

  it('marks the source as stale once the last success ages out, keeping last values', async () => {
    const h = harness(() => responseFor(idleFixture));
    await h.collector.scrapeOnce();
    h.setNow(T0 + 20_000); // 20 s > staleAfterMs (15 s)
    h.setFetch(failingFetch);
    await h.collector.scrapeOnce();

    expect(h.snapshots).toHaveLength(2);
    const stale = h.snapshots[1];
    expect(stale?.sourceStatus).toBe('stale');
    expect(stale?.sourceMessage).toContain('Metrikquelle nicht erreichbar');
    // Last known values survive the failure; the timestamp keeps the last success.
    expect(stale?.requests).toEqual({ running: 1, waiting: 0 });
    expect(stale?.timestamp).toBe(new Date(T0).toISOString());
    expect(h.collector.healthCheck().status).toBe('degraded');
    expect(h.stateChanges.map((s) => s.status)).toEqual(['ok', 'stale']);
  });

  it('recovers from stale back to ok on the next successful scrape', async () => {
    let healthy = true;
    const h = harness(() => {
      if (healthy) return responseFor(idleFixture);
      return failingFetch();
    });
    await h.collector.scrapeOnce();
    healthy = false;
    h.setNow(T0 + 20_000);
    await h.collector.scrapeOnce();
    expect(h.collector.sourceState().status).toBe('stale');
    healthy = true;
    h.setNow(T0 + 25_000);
    await h.collector.scrapeOnce();
    expect(h.collector.sourceState().status).toBe('ok');
    expect(h.collector.healthCheck()).toEqual({ name: 'vllm', status: 'ok' });
    expect(h.stateChanges.map((s) => s.status)).toEqual(['ok', 'stale', 'ok']);
  });

  it('skips overlapping scrapes instead of piling them up', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness(async () => {
      await gate;
      return responseFor(idleFixture);
    });
    void h.collector.scrapeOnce();
    void h.collector.scrapeOnce(); // in flight → skipped
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.fetchCalls.count).toBe(1);
    expect(h.snapshots).toHaveLength(1);
  });

  it('persists validated samples and throttles repeated batches', async () => {
    let value = 1_000;
    const h = harness(() => responseFor({ ...idleFixture, promptTokens: value }), T0, 60_000);
    await h.collector.scrapeOnce();
    expect(h.persist).toHaveBeenCalledTimes(1);
    const samples = h.persist.mock.calls[0]?.[0] as Array<{ name: string; unit: string }>;
    expect(samples.map((s) => s.name)).toContain('vllm.requests_running');
    expect(samples.map((s) => s.unit)).toContain('percent');

    value = 1_100; // semantic change inside the throttle window
    h.setNow(T0 + 5_000);
    await h.collector.scrapeOnce();
    expect(h.snapshots).toHaveLength(2); // SSE still sees the change …
    expect(h.persist).toHaveBeenCalledTimes(1); // … but the DB does not

    value = 1_200;
    h.setNow(T0 + 70_000);
    await h.collector.scrapeOnce();
    expect(h.persist).toHaveBeenCalledTimes(2);
  });

  it('keeps publishing snapshots when persistence throws', async () => {
    let value = 1_000;
    const h = harness(() => responseFor({ ...idleFixture, promptTokens: value }));
    await h.collector.scrapeOnce();
    h.persist.mockImplementation(() => {
      throw new Error('database locked');
    });
    value = 1_050;
    h.setNow(T0 + 5_000);
    await h.collector.scrapeOnce();
    expect(h.snapshots).toHaveLength(2);
  });

  it('runs the interval loop on start() and stops it on stop()', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const fetchSpy = vi.fn(async () => responseFor(idleFixture));
    const collector = new VllmCollector({
      metricsUrl: 'http://127.0.0.1:9/metrics',
      gpu: GPU,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      now: () => new Date(),
      intervalMs: 5_000,
      timeoutMs: 100,
      log: () => undefined,
    });
    collector.start();
    expect(fetchSpy).toHaveBeenCalledTimes(1); // immediate first scrape
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchSpy).toHaveBeenCalledTimes(3); // every 5 s
    collector.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchSpy).toHaveBeenCalledTimes(3); // timer cleaned up
    vi.useRealTimers();
  });

  it('aborts and suppresses an in-flight scrape when stopped', async () => {
    let aborted = false;
    const fetchImpl: FetchLike = async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('aborted'));
          },
          { once: true }
        );
      });
    const h = harness(fetchImpl);

    const scrape = h.collector.scrapeOnce();
    h.collector.stop();
    await scrape;

    expect(aborted).toBe(true);
    expect(h.snapshots).toHaveLength(0);
    expect(h.stateChanges).toHaveLength(0);
  });
});
