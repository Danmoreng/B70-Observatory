import {
  SERVICE_NAME,
  VllmTelemetryPayloadSchema,
  type GpuAvailability,
  type HealthCheck,
  type VllmTelemetryPayload,
} from '@observatory/contracts';
import type { MetricSample } from '../db/contracts.js';
import { createTelemetryState, deriveTelemetry, type TelemetryState } from './normalize.js';
import { parsePrometheus } from './prometheus.js';

/**
 * The vLLM telemetry collector.
 *
 * Server-side, interval-driven polling of the local vLLM `/metrics` endpoint
 * (documented design decision: the *browser* must never poll; the server may
 * poll the local source). Every scrape produces at most one snapshot, and a
 * snapshot is published over SSE only when its semantic content changed.
 * Successful observations are persisted on a separate bounded cadence,
 * including quiet periods; stale copies never create fresh history samples.
 *
 * Failure modes are classified (`unreachable`, `timeout`, `http_<status>`,
 * `empty`) and mapped to a sanitized, secret-free message. A failure never
 * destroys the last good snapshot: the collector moves to `stale` once the
 * last success is older than the staleness horizon.
 */

export type TelemetrySourceState =
  { status: 'ok' } | { status: 'stale'; message?: string } | { status: 'error'; message?: string };

export class SourceError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SourceError';
  }
}

export interface VllmCollectorOptions {
  /** Absolute URL of the vLLM Prometheus endpoint (validated in config). */
  metricsUrl: string;
  /** Read-only result of the Intel-GPU interface probe. */
  gpu: GpuAvailability;
  /** Injectable fetch (tests); defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (tests). Defaults to the system clock. */
  now?: () => Date;
  /** Scrape interval in ms. Default 5000. */
  intervalMs?: number;
  /** Per-request budget (connect + full body) in ms. Default 3000. */
  timeoutMs?: number;
  /** Last success older than this ⇒ source is `stale`. Default 3 × interval. */
  staleAfterMs?: number;
  /** Minimum distance between two *persisted* sample batches (ms). */
  persistMinIntervalMs?: number;
  /** Persist normalized samples (called with a bounded, validated set). */
  persist?: (samples: MetricSample[]) => void;
  /**
   * Initial snapshot sink. The application re-points the public
   * `onSnapshot` property to the SSE hub after construction.
   */
  onSnapshot?: (payload: VllmTelemetryPayload) => void;
  /** Fired when the source state machine changes (ok/stale/error). */
  onSourceStateChange?: (state: TelemetrySourceState) => void;
  /** Structured logger; defaults to `console`. */
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void;
}

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 3_000;

/**
 * Semantic change key: everything the dashboard can display, quantized so
 * that float jitter in derived rates does not create events, while any real
 * change (counter movement, status flip, GPU state) does.
 */
export function telemetrySemanticKey(payload: VllmTelemetryPayload): string {
  const r = (value: number | undefined, digits: number): number | undefined =>
    value === undefined ? undefined : Math.round(value * 10 ** digits) / 10 ** digits;
  return JSON.stringify({
    s: payload.sourceStatus,
    m: payload.sourceMessage ?? '',
    model: payload.model,
    rq:
      payload.requests === undefined
        ? undefined
        : [payload.requests.running, payload.requests.waiting],
    kv: r(payload.kvCacheUsagePercent, 2),
    tok:
      payload.tokens === undefined
        ? undefined
        : [
            r(payload.tokens.promptTokensPerSecond, 3),
            r(payload.tokens.generationTokensPerSecond, 3),
            r(payload.tokens.generationTokensPerSecondPerRequest, 3),
          ],
    pc:
      payload.prefixCache === undefined
        ? undefined
        : [
            r(payload.prefixCache.hitRate, 4),
            payload.prefixCache.queriedTokens,
            payload.prefixCache.hitTokens,
          ],
    mtp:
      payload.mtp === undefined
        ? undefined
        : [r(payload.mtp.acceptanceRate, 4), payload.mtp.draftTokens, payload.mtp.acceptedTokens],
    fin: payload.requestsFinished?.total,
    lat:
      payload.latency === undefined
        ? undefined
        : [r(payload.latency.e2eAvgMs, 1), r(payload.latency.ttftAvgMs, 1)],
    gpu: payload.gpu.available,
  });
}

/** Metric samples persisted for a snapshot (bounded, unit-explicit set). */
export function samplesFromPayload(payload: VllmTelemetryPayload): MetricSample[] {
  const samples: MetricSample[] = [];
  const add = (name: string, value: number | undefined, unit: string): void => {
    if (value !== undefined && Number.isFinite(value)) {
      samples.push({ source: 'vllm', name, value, unit, atUtc: payload.timestamp });
    }
  };
  add('vllm.requests_running', payload.requests?.running, 'count');
  add('vllm.requests_waiting', payload.requests?.waiting, 'count');
  add('vllm.kv_cache_usage_percent', payload.kvCacheUsagePercent, 'percent');
  // Renamed (was vllm.prompt_tokens_per_second): the value is newly computed
  // prompt tokens per second of prefill phase, not per wall-clock second.
  // Samples persisted under the old name are quarantined: the old key is no
  // longer in the history allowlist and ages out via retention.
  add(
    'vllm.prefill_compute_tokens_per_second',
    payload.tokens?.promptTokensPerSecond,
    'tokens_per_second'
  );
  add(
    'vllm.generation_tokens_per_second',
    payload.tokens?.generationTokensPerSecond,
    'tokens_per_second'
  );
  add(
    'vllm.generation_tokens_per_second_per_request',
    payload.tokens?.generationTokensPerSecondPerRequest,
    'tokens_per_second'
  );
  add('vllm.prefix_cache_hit_rate', payload.prefixCache?.hitRate, 'ratio');
  add('vllm.mtp_acceptance_rate', payload.mtp?.acceptanceRate, 'ratio');
  add('vllm.requests_finished_total', payload.requestsFinished?.total, 'count');
  add('vllm.e2e_latency_avg_ms', payload.latency?.e2eAvgMs, 'ms');
  add('vllm.ttft_avg_ms', payload.latency?.ttftAvgMs, 'ms');
  return samples;
}

export class VllmCollector {
  readonly state: TelemetryState = createTelemetryState();
  /**
   * Snapshot sink; wired by the application to the SSE hub. Called with
   * every semantically changed snapshot (the initial one included).
   */
  onSnapshot: ((payload: VllmTelemetryPayload) => void) | undefined;
  /**
   * Optional test seam for direct snapshot observation without the app
   * wiring (called in addition to `onSnapshot` when both are set).
   */
  onSnapshotObserved?: (payload: VllmTelemetryPayload) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly nowImpl: () => Date;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly staleAfterMs: number;
  private readonly persistMinIntervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private activeController: AbortController | undefined;
  private inFlight = false;
  private latest: VllmTelemetryPayload | undefined;
  private lastKey: string | undefined;
  private lastStateKey: string | undefined;
  private lastFailureMessage: string | undefined;
  private lastPersistAtMs = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: VllmCollectorOptions) {
    this.onSnapshot = options.onSnapshot;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.nowImpl = options.now ?? (() => new Date());
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.staleAfterMs = options.staleAfterMs ?? this.intervalMs * 3;
    this.persistMinIntervalMs = options.persistMinIntervalMs ?? 60_000;
  }

  /** The GPU probe result this collector serves to every snapshot. */
  get gpuProbe(): GpuAvailability {
    return this.options.gpu;
  }

  /** Start the scrape loop (immediate first scrape, then every interval). */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.scrapeOnce();
    }, this.intervalMs);
    this.timer.unref();
    void this.scrapeOnce();
  }

  /** Stop the scrape loop and drop all timers. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const controller = this.activeController;
    this.activeController = undefined;
    controller?.abort();
  }

  get latestSnapshot(): VllmTelemetryPayload | undefined {
    return this.latest;
  }

  /** Current source state derived from the last success/failure. */
  sourceState(): TelemetrySourceState {
    const nowMs = this.nowImpl().getTime();
    if (this.state.lastSuccessAtMs === undefined) {
      return {
        status: 'error',
        message: this.lastFailureMessage ?? 'Noch kein erfolgreicher Abgriff der Metrikquelle',
      };
    }
    if (nowMs - this.state.lastSuccessAtMs > this.staleAfterMs) {
      return {
        status: 'stale',
        message: this.lastFailureMessage,
      };
    }
    return { status: 'ok' };
  }

  /** Health-check entry for `GET /api/health` (worst-case, honest). */
  healthCheck(): HealthCheck {
    const state = this.sourceState();
    if (state.status === 'ok') return { name: 'vllm', status: 'ok' };
    if (state.status === 'stale') {
      return {
        name: 'vllm',
        status: 'degraded',
        message: truncate(
          state.message !== undefined
            ? `Metriken veraltet: ${state.message}`
            : 'Metriken veraltet (letzte Aktualisierung verpasst)'
        ),
      };
    }
    return {
      name: 'vllm',
      status: 'error',
      message: truncate(`Metriken nicht verfügbar: ${state.message ?? 'unbekannter Fehler'}`),
    };
  }

  /**
   * Perform one scrape. Never throws: transport errors, timeouts, non-2xx
   * responses and empty payloads are classified and recorded as failures.
   */
  async scrapeOnce(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    const controller = new AbortController();
    this.activeController = controller;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref();
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(this.options.metricsUrl, {
          signal: controller.signal,
          headers: { accept: 'text/plain; version=0.0.4' },
        });
      } catch {
        throw this.classifyTransport(controller.signal.aborted);
      }
      // stop() invalidates and aborts the active scrape. A fetch
      // implementation is allowed to ignore AbortSignal, so also guard the
      // continuation explicitly before publishing or persisting anything.
      if (this.activeController !== controller) return;
      if (!response.ok) {
        throw new SourceError(
          `http_${response.status}`,
          `Metrikquelle antwortet mit HTTP ${response.status}`
        );
      }
      const text = await response.text();
      if (this.activeController !== controller) return;
      const parsed = parsePrometheus(text);
      if (parsed.size === 0) {
        throw new SourceError('empty', 'Metrikquelle liefert keine auswertbaren Seren');
      }
      const nowMs = this.nowImpl().getTime();
      // Derivation advances rate windows. Work on a copy first so an invalid
      // external payload cannot poison the last-known-good collector state.
      const nextState: TelemetryState = {
        counters: new Map(this.state.counters),
        ...(this.state.lastSuccessAtMs === undefined
          ? {}
          : { lastSuccessAtMs: this.state.lastSuccessAtMs }),
      };
      const derived = deriveTelemetry(parsed, nowMs, nextState);
      const candidate: VllmTelemetryPayload = {
        service: SERVICE_NAME,
        sourceStatus: 'ok',
        timestamp: derived.timestamp,
        model: derived.model,
        requests: derived.requests,
        kvCacheUsagePercent: derived.kvCacheUsagePercent,
        tokens: derived.tokens,
        prefixCache: derived.prefixCache,
        mtp: derived.mtp,
        requestsFinished: derived.requestsFinished,
        latency: derived.latency,
        gpu: this.options.gpu,
      };
      const validated = VllmTelemetryPayloadSchema.safeParse(candidate);
      if (!validated.success) {
        throw new SourceError('invalid', 'Metrikquelle liefert Werte außerhalb des Datenvertrags');
      }
      this.state.counters = nextState.counters;
      this.state.lastSuccessAtMs = nextState.lastSuccessAtMs;
      this.lastFailureMessage = undefined;
      this.applySnapshot(validated.data, true);
    } catch (error) {
      // An explicit stop is lifecycle control, not a source outage. Do not
      // emit a misleading terminal error while the app is shutting down.
      if (this.activeController !== controller) return;
      const failure =
        error instanceof SourceError
          ? error
          : new SourceError('unreachable', 'Metrikquelle nicht erreichbar');
      this.lastFailureMessage =
        failure.code === 'unreachable'
          ? 'Metrikquelle nicht erreichbar (Netzwerkfehler)'
          : `Metrikquelle nicht erreichbar (${failure.message})`;
      this.options.log?.('warn', 'vLLM telemetry source unavailable', {
        code: failure.code,
        url: '(redacted)',
      });
      // A failed scrape still publishes: the payload keeps the last values
      // but the status flips (error before any success, stale afterwards).
      const nowMs = this.nowImpl().getTime();
      const base = this.latest;
      const sourceState = this.sourceState();
      // A single missed scrape does not invalidate a still-fresh last-known-
      // good snapshot. Stay silent until the configured stale horizon is
      // crossed, keeping the SSE and health views consistent.
      if (base !== undefined && sourceState.status === 'ok') return;
      const payload: VllmTelemetryPayload =
        base === undefined
          ? {
              service: SERVICE_NAME,
              sourceStatus: 'error',
              sourceMessage: truncate(failure.message),
              timestamp: new Date(nowMs).toISOString(),
              gpu: this.options.gpu,
            }
          : {
              ...base,
              sourceStatus: sourceState.status,
              sourceMessage: truncate(failure.message),
            };
      this.applySnapshot(payload);
    } finally {
      clearTimeout(timer);
      if (this.activeController === controller) this.activeController = undefined;
      this.inFlight = false;
    }
  }

  /** Map an undistinguishable transport failure to a sanitized source error. */
  private classifyTransport(aborted: boolean): SourceError {
    if (aborted) {
      return new SourceError('timeout', `timeout nach ${this.timeoutMs} ms`);
    }
    return new SourceError('unreachable', 'Metrikquelle nicht erreichbar');
  }

  /** Deduplicate live events; persist fresh observations on their own cadence. */
  private applySnapshot(payload: VllmTelemetryPayload, fresh = false): void {
    const previousState = this.lastStateKey;
    const nextState = JSON.stringify(this.sourceState());
    this.lastStateKey = nextState;
    if (previousState !== nextState) {
      this.options.onSourceStateChange?.(this.sourceState());
    }

    const key = telemetrySemanticKey(payload);
    const changed = this.latest === undefined || key !== this.lastKey;
    this.latest = payload;
    this.lastKey = key;

    if (changed) {
      this.onSnapshot?.(payload);
      this.onSnapshotObserved?.(payload);
    }

    if (fresh && this.options.persist !== undefined) {
      const nowMs = this.nowImpl().getTime();
      if (nowMs - this.lastPersistAtMs >= this.persistMinIntervalMs) {
        const samples = samplesFromPayload(payload);
        if (samples.length > 0) {
          this.lastPersistAtMs = nowMs;
          try {
            this.options.persist(samples);
          } catch (error) {
            // Persistence is best effort: a healthy telemetry path must not
            // be broken by a database problem (project brief §4).
            this.options.log?.('warn', 'persisting telemetry samples failed', {
              detail: (error as Error).message,
              count: samples.length,
            });
          }
        }
      }
    }
  }
}

function truncate(value: string): string {
  return value.length <= 256 ? value : `${value.slice(0, 253)}…`;
}
