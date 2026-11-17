import type { FinishedReason, VllmTelemetryPayload } from '@observatory/contracts';
import type { ParsedPrometheus } from './prometheus.js';

/**
 * Normalization of the vLLM Prometheus series into one dashboard snapshot.
 *
 * Rules:
 * - gauges (`num_requests_running`/`waiting`, `kv_cache_usage_perc`) are
 *   read directly; with several engines the values are summed;
 * - counters (`prompt_tokens_total`, `generation_tokens_total`,
 *   `…_hits_total`, `…_draft_tokens_total`, …) are cumulative since vLLM
 *   started. A counter value *below* the previous one is a process restart:
 *   the window is re-based and no rate is reported for this interval (the
 *   first interval after a reset is honestly "unknown");
 * - the prefill rate must not be derived from `prompt_tokens_total` against
 *   wall clock: vLLM credits a request's *entire* prompt length to that
 *   counter at the moment its prefill finishes, so a long 26k-token request
 *   adds ~26 000 in one step and Δ/Δwall would show ~26 000 tok/s for a
 *   scrape interval in which the GPU only processed a few thousand freshly
 *   computed tokens. Instead the rate is Δ(prefill tokens newly computed)
 *   ÷ Δ(prefill phase time), both read from the per-request histograms
 *   `request_prefill_kv_computed_tokens` and `request_prefill_time_seconds`.
 *   vLLM records both in the same per-request finish call, so the window is
 *   self-consistent: the result is the tokens-actually-computed per second of
 *   prefill work (the same quantity a cache-cold benchmark measures), and it
 *   stays finite when prefix caching shrinks the prefill. No prefill finished
 *   in the window ⇒ no prefill rate (a gap, not 0 tok/s);
 * - the decode rate stays real-time: `generation_tokens_total` advances per
 *   emitted token, so Δ/Δwall is a true output rate;
 * - the prefix-cache counters (`prefix_cache_queries_total`,
 *   `prefix_cache_hits_total`) are not throughput counters: vLLM credits a
 *   request's entire prompt length (queries) and its cached prefix (hits) in
 *   one batch step when the request is admitted to the scheduler. There is
 *   no matching per-request time axis to divide by (the lookup is
 *   instantaneous at admission and vLLM reports no prefix-cache duration),
 *   so no "tokens per second" rate is derived from them – a wall-clock
 *   delta would be the prompt length of the requests admitted in the window
 *   divided by the window length, i.e. exactly the aggregation artifact the
 *   prefill rate used to be. Only the cumulative counters and the
 *   cumulative hit rate (hits/queries) are reported;
 * - sections whose series are absent from the exposition are `undefined`
 *   (distinguishes "not reported" from "zero" in the UI);
 * - every value is checked to be finite before it enters the payload.
 */

interface CounterWindow {
  value: number;
  atMs: number;
}

/** Mutable per-metric memory used to derive rates across scrapes. */
export interface TelemetryState {
  counters: Map<string, CounterWindow>;
  /** Epoch ms of the last successful scrape; `undefined` before first success. */
  lastSuccessAtMs?: number;
}

export function createTelemetryState(): TelemetryState {
  return { counters: new Map() };
}

/** Metric names as exported by the vLLM Prometheus collector. */
export const VLLM_METRICS = {
  requestsRunning: 'vllm:num_requests_running',
  requestsWaiting: 'vllm:num_requests_waiting',
  kvCacheUsage: 'vllm:kv_cache_usage_perc',
  promptTokens: 'vllm:prompt_tokens_total',
  generationTokens: 'vllm:generation_tokens_total',
  prefixCacheQueries: 'vllm:prefix_cache_queries_total',
  prefixCacheHits: 'vllm:prefix_cache_hits_total',
  mtpDraftTokens: 'vllm:spec_decode_num_draft_tokens_total',
  mtpAcceptedTokens: 'vllm:spec_decode_num_accepted_tokens_total',
  requestSuccess: 'vllm:request_success_total',
  e2eSum: 'vllm:e2e_request_latency_seconds_sum',
  e2eCount: 'vllm:e2e_request_latency_seconds_count',
  ttftSum: 'vllm:time_to_first_token_seconds_sum',
  ttftCount: 'vllm:time_to_first_token_seconds_count',
  interTokenSum: 'vllm:inter_token_latency_seconds_sum',
  interTokenCount: 'vllm:inter_token_latency_seconds_count',
  /** Per-request histogram sum: newly computed KV tokens per finished request. */
  prefillKvComputedSum: 'vllm:request_prefill_kv_computed_tokens_sum',
  /** Per-request histogram sum: seconds spent in the prefill phase. */
  prefillTimeSum: 'vllm:request_prefill_time_seconds_sum',
} as const;

const FINISHED_REASONS = ['stop', 'length', 'abort', 'error', 'repetition'] as const;

function finiteNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Sum of all series carrying the given metric name (`undefined` if absent). */
function sumOf(parsed: ParsedPrometheus, name: string): number | undefined {
  const series = parsed.get(name);
  if (series === undefined || series.length === 0) return undefined;
  let sum = 0;
  let found = false;
  for (const entry of series) {
    if (Number.isFinite(entry.value)) {
      sum += entry.value;
      found = true;
    }
  }
  return found ? sum : undefined;
}

/** The `model_name` label from the first series that carries one. */
function modelNameOf(parsed: ParsedPrometheus): string | undefined {
  for (const series of parsed.values()) {
    for (const entry of series) {
      const model = entry.labels['model_name'];
      if (model !== undefined && model.length > 0) return model;
    }
  }
  return undefined;
}

/**
 * Advance a counter window and return the delta-based rate.
 *
 * @returns `perSecond` (may be `undefined` on first sighting or a reset),
 *          `undefined` value if the input is not usable, `reset` whether the
 *          counter went backwards (vLLM process restart).
 */
function counterRate(
  name: string,
  value: number | undefined,
  nowMs: number,
  state: TelemetryState
): { perSecond: number | undefined; reset: boolean } {
  if (value === undefined) {
    // Series missing this round (should not happen for stable vLLM
    // metrics): drop the window so the next sighting starts fresh.
    state.counters.delete(name);
    return { perSecond: undefined, reset: false };
  }
  const window = state.counters.get(name);
  if (window === undefined) {
    state.counters.set(name, { value, atMs: nowMs });
    return { perSecond: undefined, reset: false };
  }
  if (value < window.value) {
    // Counter reset (process restart): re-base, report no rate for the gap.
    state.counters.set(name, { value, atMs: nowMs });
    return { perSecond: undefined, reset: true };
  }
  const dtSeconds = (nowMs - window.atMs) / 1000;
  const perSecond = dtSeconds > 0 ? (value - window.value) / dtSeconds : undefined;
  state.counters.set(name, { value, atMs: nowMs });
  return { perSecond, reset: false };
}

/** Histogram average in whole ms (`undefined` while no observations exist). */
function avgMs(sum: number | undefined, count: number | undefined): number | undefined {
  const s = finiteNumber(sum);
  const c = finiteNumber(count);
  if (s === undefined || c === undefined || c <= 0) return undefined;
  return round((s / c) * 1000, 3);
}

export interface DerivedTelemetry extends Omit<VllmTelemetryPayload, 'service' | 'gpu'> {
  /** Epoch ms this derivation ran on; set by the caller on success. */
  atMs: number;
}

/**
 * Derive the (source-ok) telemetry snapshot fields from one parsed scrape.
 * Mutates `state` (counter windows, `lastSuccessAtMs`).
 */
export function deriveTelemetry(
  parsed: ParsedPrometheus,
  nowMs: number,
  state: TelemetryState
): DerivedTelemetry {
  state.lastSuccessAtMs = nowMs;

  const running = finiteNumber(sumOf(parsed, VLLM_METRICS.requestsRunning));
  const waiting = finiteNumber(sumOf(parsed, VLLM_METRICS.requestsWaiting));

  const kvRaw = finiteNumber(sumOf(parsed, VLLM_METRICS.kvCacheUsage));
  // vLLM reports 0..1; normalize to percent. Values outside [0,1] are
  // malformed and are dropped rather than scaled.
  const kv = kvRaw !== undefined && kvRaw >= 0 && kvRaw <= 1 ? round(kvRaw * 100, 2) : undefined;

  const promptTokens = finiteNumber(sumOf(parsed, VLLM_METRICS.promptTokens));
  const generationTokens = finiteNumber(sumOf(parsed, VLLM_METRICS.generationTokens));
  // vLLM credits a request's full prompt length to prompt_tokens_total at the
  // moment its prefill finishes (a one-shot batch credit), so dividing that
  // counter by wall clock is not a throughput: a long request would produce
  // promptLength/scrapeInterval. Measure the prefill against its own time
  // axis instead: both histogram sums below are recorded by vLLM in the same
  // per-request finish call and grow monotonically, so their delta ratio over
  // the window of finished requests is the tokens-actually-computed per
  // second of prefill phase (cached tokens excluded).
  const prefillKvComputedSum = finiteNumber(sumOf(parsed, VLLM_METRICS.prefillKvComputedSum));
  const prefillTimeSum = finiteNumber(sumOf(parsed, VLLM_METRICS.prefillTimeSum));
  const prefillComputedWindow = counterRate(
    VLLM_METRICS.prefillKvComputedSum,
    prefillKvComputedSum,
    nowMs,
    state
  );
  const prefillTimeWindow = counterRate(VLLM_METRICS.prefillTimeSum, prefillTimeSum, nowMs, state);
  // Δcomputed/Δwall ÷ ΔprefillSeconds/Δwall = Δcomputed ÷ ΔprefillSeconds.
  // Requires ΔprefillSeconds > 0: an idle window (no finished prefill) has
  // no rate at all rather than a fake 0 or a division blow-up.
  const prefillRate =
    prefillComputedWindow.perSecond !== undefined &&
    prefillTimeWindow.perSecond !== undefined &&
    prefillTimeWindow.perSecond > 0
      ? prefillComputedWindow.perSecond / prefillTimeWindow.perSecond
      : undefined;
  const generationRate = finiteNumber(
    counterRate(VLLM_METRICS.generationTokens, generationTokens, nowMs, state).perSecond
  );
  // Average decode throughput per concurrent request: the aggregate real-
  // time rate divided by the number of running requests. Undefined while no
  // request is running (division by zero would be a fake, not a rate). With
  // a single running request it equals the aggregate rate.
  const generationRatePerRequest =
    generationRate !== undefined && running !== undefined && running > 0
      ? generationRate / running
      : undefined;

  // Cumulative counters only: vLLM credits both in one batch step per
  // request at admission (full prompt length / cached prefix), so a
  // wall-clock delta is not a rate. No counter windows are tracked for them
  // and no per-second fields are derived (see module documentation).
  const prefixQueries = finiteNumber(sumOf(parsed, VLLM_METRICS.prefixCacheQueries));
  const prefixHits = finiteNumber(sumOf(parsed, VLLM_METRICS.prefixCacheHits));

  const mtpDraft = finiteNumber(sumOf(parsed, VLLM_METRICS.mtpDraftTokens));
  const mtpAccepted = finiteNumber(sumOf(parsed, VLLM_METRICS.mtpAcceptedTokens));

  const successSeries = parsed.get(VLLM_METRICS.requestSuccess);
  let finishedTotal: number | undefined;
  const byReason: Partial<Record<FinishedReason, number>> = {};
  if (successSeries !== undefined && successSeries.length > 0) {
    finishedTotal = 0;
    for (const entry of successSeries) {
      if (!Number.isFinite(entry.value)) continue;
      finishedTotal += entry.value;
      const reason = entry.labels['finished_reason'];
      if (reason !== undefined && (FINISHED_REASONS as readonly string[]).includes(reason)) {
        const key = reason as FinishedReason;
        byReason[key] = (byReason[key] ?? 0) + entry.value;
      }
    }
  }

  const e2eAvgMs = avgMs(sumOf(parsed, VLLM_METRICS.e2eSum), sumOf(parsed, VLLM_METRICS.e2eCount));
  const ttftAvgMs = avgMs(
    sumOf(parsed, VLLM_METRICS.ttftSum),
    sumOf(parsed, VLLM_METRICS.ttftCount)
  );
  const interTokenAvgMs = avgMs(
    sumOf(parsed, VLLM_METRICS.interTokenSum),
    sumOf(parsed, VLLM_METRICS.interTokenCount)
  );

  const hitRate =
    prefixQueries !== undefined && prefixHits !== undefined && prefixQueries > 0
      ? round(prefixHits / prefixQueries, 4)
      : undefined;
  const mtpAcceptance =
    mtpDraft !== undefined && mtpAccepted !== undefined && mtpDraft > 0
      ? round(mtpAccepted / mtpDraft, 4)
      : undefined;

  const model = modelNameOf(parsed);

  return {
    sourceStatus: 'ok',
    timestamp: new Date(nowMs).toISOString(),
    ...(model !== undefined && model.length > 0 && model.length <= 128 ? { model } : {}),
    ...(running !== undefined && waiting !== undefined
      ? { requests: { running: Math.trunc(running), waiting: Math.trunc(waiting) } }
      : {}),
    ...(kv !== undefined && kv >= 0 && kv <= 100 ? { kvCacheUsagePercent: kv } : {}),
    ...(promptTokens !== undefined && generationTokens !== undefined
      ? {
          tokens: {
            promptTokens: Math.trunc(promptTokens),
            generationTokens: Math.trunc(generationTokens),
            ...(roundRate(prefillRate) !== undefined
              ? { promptTokensPerSecond: roundRate(prefillRate) }
              : {}),
            ...(roundRate(generationRate) !== undefined
              ? { generationTokensPerSecond: roundRate(generationRate) }
              : {}),
            ...(roundRate(generationRatePerRequest) !== undefined
              ? { generationTokensPerSecondPerRequest: roundRate(generationRatePerRequest) }
              : {}),
          },
        }
      : {}),
    ...(prefixQueries !== undefined && prefixHits !== undefined
      ? {
          prefixCache: {
            queriedTokens: Math.trunc(prefixQueries),
            hitTokens: Math.trunc(prefixHits),
            // Cumulative ratio (hits/queries over the whole process life);
            // deliberately the only derived prefix-cache figure – there is
            // no stable time axis for the admission-credited counters.
            ...(hitRate !== undefined ? { hitRate } : {}),
          },
        }
      : {}),
    ...(mtpDraft !== undefined && mtpAccepted !== undefined
      ? {
          mtp: {
            draftTokens: Math.trunc(mtpDraft),
            acceptedTokens: Math.trunc(mtpAccepted),
            ...(mtpAcceptance !== undefined ? { acceptanceRate: mtpAcceptance } : {}),
          },
        }
      : {}),
    ...(finishedTotal !== undefined
      ? {
          requestsFinished: {
            total: Math.trunc(finishedTotal),
            ...(Object.keys(byReason).length > 0
              ? {
                  byReason: Object.fromEntries(
                    FINISHED_REASONS.filter((reason) => byReason[reason] !== undefined).map(
                      (reason) => [reason, Math.trunc(byReason[reason] as number)]
                    )
                  ),
                }
              : {}),
          },
        }
      : {}),
    ...(e2eAvgMs !== undefined || ttftAvgMs !== undefined || interTokenAvgMs !== undefined
      ? {
          latency: {
            ...(e2eAvgMs !== undefined ? { e2eAvgMs } : {}),
            ...(ttftAvgMs !== undefined ? { ttftAvgMs } : {}),
            ...(interTokenAvgMs !== undefined ? { interTokenAvgMs } : {}),
          },
        }
      : {}),
    atMs: nowMs,
  };
}

function roundRate(value: number | undefined): number | undefined {
  return value === undefined ? undefined : round(value, 3);
}
