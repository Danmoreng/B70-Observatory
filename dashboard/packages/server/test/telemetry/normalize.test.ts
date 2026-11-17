import { describe, expect, it } from 'vitest';
import {
  createTelemetryState,
  deriveTelemetry,
  type TelemetryState,
} from '../../src/telemetry/normalize.js';
import { parsePrometheus } from '../../src/telemetry/prometheus.js';
import { prometheusFixture, type TelemetryFixtureValues } from './fixtures.js';

const T0 = Date.parse('2025-01-01T10:00:00.000Z');
const T1 = T0 + 10_000; // 10 s later

const baseFixture: TelemetryFixtureValues = {
  running: 2,
  waiting: 1,
  kv: 0.425,
  promptTokens: 100_000,
  generationTokens: 5_000,
  prefixQueries: 80_000,
  prefixHits: 48_000,
  mtpDraft: 900,
  mtpAccepted: 720,
  successStop: 12,
  successLength: 0,
  successAbort: 1,
  successError: 2,
  successRepetition: 0,
  e2eSumSeconds: 117.7,
  e2eCount: 16,
  ttftSumSeconds: 84.6525,
  ttftCount: 16,
  interTokenSumSeconds: 33.076,
  interTokenCount: 703,
  prefillKvComputedSum: 20_000,
  prefillTimeSumSeconds: 20,
  prefillCount: 15,
};

function deriveAt(fixture: TelemetryFixtureValues, nowMs: number, state?: TelemetryState) {
  const parsed = parsePrometheus(prometheusFixture(fixture));
  return deriveTelemetry(parsed, nowMs, state ?? createTelemetryState());
}

describe('deriveTelemetry', () => {
  it('normalizes a complete scrape into all payload sections', () => {
    // Two consecutive scrapes on one state so delta-based rates are defined.
    const state = createTelemetryState();
    deriveTelemetry(parsePrometheus(prometheusFixture(baseFixture)), T0, state);
    const derived = deriveTelemetry(
      parsePrometheus(
        prometheusFixture({
          ...baseFixture,
          promptTokens: 110_000,
          generationTokens: 5_300,
          prefixQueries: 81_000,
          prefixHits: 48_100,
          mtpDraft: 1_000,
          mtpAccepted: 800,
          prefillKvComputedSum: 25_000,
          prefillTimeSumSeconds: 25,
        })
      ),
      T1,
      state
    );

    expect(derived.sourceStatus).toBe('ok');
    expect(derived.model).toBe('Qwen3.8-27B');
    expect(derived.requests).toEqual({ running: 2, waiting: 1 });
    expect(derived.kvCacheUsagePercent).toBe(42.5);
    expect(derived.tokens).toMatchObject({
      promptTokens: 110_000,
      generationTokens: 5_300,
      promptTokensPerSecond: 1_000, // 5 000 computed tokens ÷ 5 s prefill time
      generationTokensPerSecond: 30, // (5300 − 5000) / 10 s wall clock
      generationTokensPerSecondPerRequest: 15, // 30 tok/s ÷ 2 running requests
    });
    expect(derived.prefixCache).toMatchObject({
      queriedTokens: 81_000,
      hitTokens: 48_100,
    });
    // vLLM credits these counters in one batch step per admitted request,
    // so no per-second rate exists (a wall-clock delta would be an
    // artifact); the strict contract rejects such fields outright.
    expect(derived.prefixCache).not.toHaveProperty('queriedTokensPerSecond');
    expect(derived.prefixCache).not.toHaveProperty('hitTokensPerSecond');
    // Cumulative hit rate comes from the current totals (48100/81000), rounded to 4 digits.
    expect(derived.prefixCache?.hitRate).toBeCloseTo(48_100 / 81_000, 4);
    expect(derived.mtp).toMatchObject({
      draftTokens: 1_000,
      acceptedTokens: 800,
      acceptanceRate: 0.8,
    });
    expect(derived.requestsFinished).toEqual({
      total: 15,
      byReason: { stop: 12, length: 0, abort: 1, error: 2, repetition: 0 },
    });
    expect(derived.latency).toMatchObject({
      e2eAvgMs: 7356.25, // 117.7 s / 16 requests
      ttftAvgMs: 5290.781, // 84.6525 s / 16
    });
  });

  it('leaves derived rates undefined on the first sighting of a counter', () => {
    const derived = deriveAt(baseFixture, T0);
    expect(derived.tokens?.promptTokensPerSecond).toBeUndefined();
    expect(derived.tokens?.generationTokensPerSecond).toBeUndefined();
    expect(derived.tokens?.generationTokensPerSecondPerRequest).toBeUndefined();
    // Cumulative ratios are still well defined from the very first sample.
    expect(derived.prefixCache?.hitRate).toBe(0.6);
    expect(derived.mtp?.acceptanceRate).toBe(0.8);
  });

  it('treats a prefill-histogram drop as a vLLM restart and re-bases', () => {
    const state = createTelemetryState();
    deriveTelemetry(parsePrometheus(prometheusFixture(baseFixture)), T0, state);
    // vLLM restarts: all cumulative sums drop below their previous values.
    const afterReset = deriveTelemetry(
      parsePrometheus(
        prometheusFixture({
          ...baseFixture,
          promptTokens: 5_000,
          generationTokens: 200,
          prefillKvComputedSum: 1_000,
          prefillTimeSumSeconds: 1.5,
        })
      ),
      T1,
      state
    );
    expect(afterReset.tokens?.promptTokensPerSecond).toBeUndefined();
    // The next delta is measured against the re-based window.
    const afterRecovery = deriveTelemetry(
      parsePrometheus(
        prometheusFixture({
          ...baseFixture,
          promptTokens: 6_000,
          generationTokens: 300,
          prefillKvComputedSum: 3_000,
          prefillTimeSumSeconds: 3.5,
        })
      ),
      T1 + 10_000,
      state
    );
    expect(afterRecovery.tokens?.promptTokensPerSecond).toBe(1_000); // 2 000 / 2 s
  });

  it('omits the prefill rate while no prefill finished in the window (idle, not 0)', () => {
    const state = createTelemetryState();
    deriveTelemetry(parsePrometheus(prometheusFixture(baseFixture)), T0, state);
    // Quiet window: none of the counters moved.
    const idle = deriveTelemetry(
      parsePrometheus(prometheusFixture(baseFixture)),
      T0 + 10_000,
      state
    );
    expect(idle.tokens?.promptTokensPerSecond).toBeUndefined(); // Δprefill time = 0 s
    expect(idle.tokens?.generationTokensPerSecond).toBe(0); // real-time rate: truly 0
    expect(idle.tokens?.generationTokensPerSecondPerRequest).toBe(0); // 0 ÷ 2 running
  });

  it('reports the per-request decode rate as aggregate ÷ running requests', () => {
    const state = createTelemetryState();
    deriveTelemetry(parsePrometheus(prometheusFixture({ ...baseFixture, running: 1 })), T0, state);
    const single = deriveTelemetry(
      parsePrometheus(prometheusFixture({ ...baseFixture, running: 1, generationTokens: 5_300 })),
      T1,
      state
    );
    // One running request: per-request rate equals the aggregate rate.
    expect(single.tokens?.generationTokensPerSecond).toBe(30);
    expect(single.tokens?.generationTokensPerSecondPerRequest).toBe(30); // 30 / 1
    // Two running requests: the per-request rate is halved.
    const doubled = deriveTelemetry(
      parsePrometheus(prometheusFixture({ ...baseFixture, running: 2, generationTokens: 5_600 })),
      T1 + 10_000,
      state
    );
    expect(doubled.tokens?.generationTokensPerSecond).toBe(30);
    expect(doubled.tokens?.generationTokensPerSecondPerRequest).toBe(15); // 30 / 2
  });

  it('omits the per-request decode rate while no request is running (no fake division)', () => {
    const state = createTelemetryState();
    deriveTelemetry(parsePrometheus(prometheusFixture(baseFixture)), T0, state);
    const drained = deriveTelemetry(
      parsePrometheus(prometheusFixture({ ...baseFixture, running: 0, generationTokens: 5_200 })),
      T1,
      state
    );
    expect(drained.tokens?.generationTokensPerSecond).toBe(20);
    expect(drained.tokens?.generationTokensPerSecondPerRequest).toBeUndefined();
  });

  it('survives a long request whose prompt is credited late without a wall-clock spike', () => {
    // Production-shaped scenario: a 26 000-token request. vLLM credits the
    // request's *entire* prompt length to prompt_tokens_total the moment its
    // prefill finishes, but records the per-request prefill histograms only
    // when the request *finishes* – for a long response, minutes later.
    const small: TelemetryFixtureValues = {
      ...baseFixture,
      promptTokens: 100,
      generationTokens: 10,
      prefillKvComputedSum: 100,
      prefillTimeSumSeconds: 0.1,
      prefillCount: 1,
    };
    const state = createTelemetryState();
    deriveTelemetry(parsePrometheus(prometheusFixture(small)), T0, state);

    // Prefill finished inside this window (prompt counter jumped by 26 000),
    // but the request is still decoding: the prefill histograms have not
    // moved. The old wall-clock derivation would have reported
    // 26 000 / 10 s = 2 600 tok/s here; the corrected derivation has no rate.
    const duringDecode = deriveTelemetry(
      parsePrometheus(
        prometheusFixture({
          ...small,
          promptTokens: 26_100,
          generationTokens: 310,
        })
      ),
      T0 + 10_000,
      state
    );
    expect(duringDecode.tokens?.promptTokens).toBe(26_100);
    expect(duringDecode.tokens?.promptTokensPerSecond).toBeUndefined();

    // The request finishes: 26 000 prompt tokens, 90 % served from the
    // prefix cache, 2 600 newly computed over 2.6 s of prefill time.
    const afterFinish = deriveTelemetry(
      parsePrometheus(
        prometheusFixture({
          ...small,
          promptTokens: 26_100,
          generationTokens: 990,
          prefillKvComputedSum: 2_700,
          prefillTimeSumSeconds: 2.7,
          prefillCount: 2,
        })
      ),
      T0 + 90_000,
      state
    );
    // 2 600 computed tokens ÷ 2.6 s of prefill time = 1 000 tok/s – the
    // rate a cache-cold benchmark measures, not 26 000 / 80 s of wall clock.
    expect(afterFinish.tokens?.promptTokensPerSecond).toBeCloseTo(1_000, 0);
  });

  it('measures prefill and decode rates on their own time axes', () => {
    const state = createTelemetryState();
    deriveTelemetry(parsePrometheus(prometheusFixture(baseFixture)), T0, state);
    // Prefill: 10 000 newly computed tokens over 20 s of prefill time
    // (500 tok/s). Decode: the same window of 100 s wall clock emitted 400
    // tokens (4 tok/s). Different phase durations must not mix together.
    const derived = deriveTelemetry(
      parsePrometheus(
        prometheusFixture({
          ...baseFixture,
          promptTokens: 110_000,
          generationTokens: 5_400,
          prefillKvComputedSum: 30_000,
          prefillTimeSumSeconds: 40,
        })
      ),
      T0 + 100_000,
      state
    );
    expect(derived.tokens?.promptTokensPerSecond).toBe(500); // 10 000 / 20 s
    expect(derived.tokens?.generationTokensPerSecond).toBeCloseTo(4, 1); // 400 / 100 s
  });

  it('omits the prefill rate while the per-request histograms are absent and resumes after they return', () => {
    const state = createTelemetryState();
    const absent: TelemetryFixtureValues = {
      ...baseFixture,
      withPrefillHistograms: false,
      prefillKvComputedSum: undefined,
      prefillTimeSumSeconds: undefined,
    };
    deriveTelemetry(parsePrometheus(prometheusFixture(absent)), T0, state);
    const stillAbsent = deriveTelemetry(
      parsePrometheus(
        prometheusFixture({
          ...absent,
          promptTokens: 105_000,
          generationTokens: 5_100,
        })
      ),
      T0 + 10_000,
      state
    );
    // The tokens section still exists (the real-time generation rate is well
    // defined) …
    expect(stillAbsent.tokens).toMatchObject({
      promptTokens: 105_000,
      generationTokensPerSecond: 10,
    });
    // … but the prefill rate is absent, not zero.
    expect(stillAbsent.tokens?.promptTokensPerSecond).toBeUndefined();

    // The series reappear (e.g. after an operator restart with a newer vLLM):
    // the first sighting only establishes the window …
    deriveTelemetry(
      parsePrometheus(prometheusFixture({ ...baseFixture, promptTokens: 105_000 })),
      T0 + 20_000,
      state
    );
    // … the next delta yields a rate.
    const resumed = deriveTelemetry(
      parsePrometheus(
        prometheusFixture({
          ...baseFixture,
          promptTokens: 106_000,
          prefillKvComputedSum: 22_000,
          prefillTimeSumSeconds: 22,
        })
      ),
      T0 + 30_000,
      state
    );
    expect(resumed.tokens?.promptTokensPerSecond).toBe(1_000); // 2 000 / 2 s
  });

  it('keeps prefix-cache counters cumulative without inventing a rate when a long prompt is admitted', () => {
    // Admission semantics (verified in the production vLLM build): the
    // scheduler credits a request's *entire* prompt length to
    // prefix_cache_queries_total and its cached prefix to
    // prefix_cache_hits_total in one step when the request is admitted, so
    // a 26 000-token request moves the counters by 26 000 in a single
    // scrape. There is no matching per-request time axis to divide by, so
    // the derived payload must not carry a per-second rate at all – a
    // wall-clock delta would have reported ~2 600 tok/s here.
    const small: TelemetryFixtureValues = {
      ...baseFixture,
      prefixQueries: 1_000,
      prefixHits: 900,
    };
    const state = createTelemetryState();
    deriveTelemetry(parsePrometheus(prometheusFixture(small)), T0, state);

    const admitted = deriveTelemetry(
      parsePrometheus(prometheusFixture({ ...small, prefixQueries: 27_000, prefixHits: 23_500 })),
      T0 + 10_000,
      state
    );
    // Cumulative counters and the cumulative hit rate stay correct…
    expect(admitted.prefixCache).toMatchObject({
      queriedTokens: 27_000,
      hitTokens: 23_500,
    });
    expect(admitted.prefixCache?.hitRate).toBeCloseTo(23_500 / 27_000, 4);
    // …and no per-second rate is invented from the batch credit.
    expect(admitted.prefixCache).not.toHaveProperty('queriedTokensPerSecond');
    expect(admitted.prefixCache).not.toHaveProperty('hitTokensPerSecond');
  });

  it('omits sections whose metric series are absent (not reported ≠ zero)', () => {
    const derived = deriveAt({ ...baseFixture, withMtp: false, withLatency: false }, T0);
    expect(derived.mtp).toBeUndefined();
    expect(derived.latency).toBeUndefined();
    // Sections that exist stay intact.
    expect(derived.tokens).toMatchObject({ promptTokens: 100_000 });
  });

  it('omits hit rate while no queries were observed (0/0 is not 0 %)', () => {
    const derived = deriveAt(
      { ...baseFixture, prefixQueries: 0, prefixHits: 0, mtpDraft: 0, mtpAccepted: 0 },
      T0
    );
    expect(derived.prefixCache?.queriedTokens).toBe(0);
    expect(derived.prefixCache?.hitRate).toBeUndefined();
    expect(derived.mtp?.acceptanceRate).toBeUndefined();
  });

  it('drops the KV gauge when vLLM reports an out-of-range value', () => {
    const derived = deriveAt({ ...baseFixture, kv: 1.7 }, T0);
    expect(derived.kvCacheUsagePercent).toBeUndefined();
  });

  it('sums series across multiple engines and takes the model name from a label', () => {
    const makeScrape = (
      prompt0: number,
      prompt1: number,
      gen0: number,
      gen1: number,
      running1: number,
      prefillKv0: number,
      prefillKv1: number,
      prefillTime0: number,
      prefillTime1: number
    ): string =>
      [
        'vllm:num_requests_running{engine="0",model_name="Qwen3.8-27B"} 3.0',
        `vllm:num_requests_running{engine="1",model_name="Qwen3.8-27B"} ${running1}`,
        'vllm:num_requests_waiting{engine="0",model_name="Qwen3.8-27B"} 1.0',
        'vllm:num_requests_waiting{engine="1",model_name="Qwen3.8-27B"} 2.0',
        'vllm:kv_cache_usage_perc{engine="0",model_name="Qwen3.8-27B"} 0.1',
        'vllm:kv_cache_usage_perc{engine="1",model_name="Qwen3.8-27B"} 0.25',
        `vllm:prompt_tokens_total{engine="0",model_name="Qwen3.8-27B"} ${prompt0}`,
        `vllm:prompt_tokens_total{engine="1",model_name="Qwen3.8-27B"} ${prompt1}`,
        `vllm:generation_tokens_total{engine="0",model_name="Qwen3.8-27B"} ${gen0}`,
        `vllm:generation_tokens_total{engine="1",model_name="Qwen3.8-27B"} ${gen1}`,
        `vllm:request_prefill_kv_computed_tokens_sum{engine="0",model_name="Qwen3.8-27B"} ${prefillKv0}`,
        `vllm:request_prefill_kv_computed_tokens_sum{engine="1",model_name="Qwen3.8-27B"} ${prefillKv1}`,
        `vllm:request_prefill_time_seconds_sum{engine="0",model_name="Qwen3.8-27B"} ${prefillTime0}`,
        `vllm:request_prefill_time_seconds_sum{engine="1",model_name="Qwen3.8-27B"} ${prefillTime1}`,
      ].join('\n');

    const state = createTelemetryState();
    deriveTelemetry(parsePrometheus(makeScrape(10, 15, 4, 6, 4, 10, 15, 4, 6)), T0, state);
    const derived = deriveTelemetry(
      parsePrometheus(makeScrape(20, 30, 14, 16, 6, 20, 30, 7, 13)),
      T1,
      state
    );

    expect(derived.model).toBe('Qwen3.8-27B');
    expect(derived.requests).toEqual({ running: 9, waiting: 3 }); // 3+6 / 1+2
    expect(derived.kvCacheUsagePercent).toBe(35); // (0.1 + 0.25) * 100
    // Cumulative prompt counter: (20−10) + (30−15) = 25 → 50 total.
    expect(derived.tokens?.promptTokens).toBe(50);
    // Prefill rate: computed (20−10) + (30−15) = 25 over (7−4) + (13−6) = 10 s.
    expect(derived.tokens?.promptTokensPerSecond).toBe(2.5);
    // Generation delta (14−4) + (16−6) = 20 over 10 s → 2/s.
    expect(derived.tokens?.generationTokens).toBe(30);
    expect(derived.tokens?.generationTokensPerSecond).toBe(2); // 20 / 10 s, two engines
    expect(derived.tokens?.generationTokensPerSecondPerRequest).toBeCloseTo(2 / 9, 3); // ÷ 9
  });
});
