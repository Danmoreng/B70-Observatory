/**
 * Fixed server-side allowlist of metric series that the history API may
 * aggregate (M5A). The query parameter names exactly one of these keys;
 * anything else is a 400. Series identities map to the normalized
 * `metric_samples` columns `(source, name[, labels])`; `unit` is the
 * documented unit the collectors persist and is returned verbatim so the
 * UI never has to guess.
 *
 * The list is deliberately small and closed: it covers the vLLM, system
 * and GPU series the collectors (M4A/M4B) actually persist.
 */
export interface MetricSeriesDefinition {
  /** Public key used in the `series` query parameter. */
  key: string;
  /** `metric_samples.source` of the series. */
  source: 'vllm' | 'gpu' | 'system';
  /** `metric_samples.name` of the series. */
  name: string;
  /** Documented unit of the series values. */
  unit: string;
  /**
   * Canonical label key when the series is stored with labels. All
   * series persisted by the current collectors are label-less, so no
   * entry defines one; the field keeps the mapping closed for the future.
   */
  labelKey?: string;
}

function entry(
  key: string,
  source: MetricSeriesDefinition['source'],
  name: string,
  unit: string
): MetricSeriesDefinition {
  return { key, source, name, unit };
}

export const METRIC_SERIES: ReadonlyArray<MetricSeriesDefinition> = [
  entry('vllm.requests-running', 'vllm', 'vllm.requests_running', 'count'),
  entry('vllm.requests-waiting', 'vllm', 'vllm.requests_waiting', 'count'),
  entry('vllm.kv-cache-usage-percent', 'vllm', 'vllm.kv_cache_usage_percent', 'percent'),
  entry(
    'vllm.prefill-compute-tokens-per-second',
    'vllm',
    'vllm.prefill_compute_tokens_per_second',
    'tokens_per_second'
  ),
  entry(
    'vllm.generation-tokens-per-second',
    'vllm',
    'vllm.generation_tokens_per_second',
    'tokens_per_second'
  ),
  entry(
    'vllm.generation-tokens-per-second-per-request',
    'vllm',
    'vllm.generation_tokens_per_second_per_request',
    'tokens_per_second'
  ),
  entry('vllm.prefix-cache-hit-rate', 'vllm', 'vllm.prefix_cache_hit_rate', 'ratio'),
  entry('vllm.mtp-acceptance-rate', 'vllm', 'vllm.mtp_acceptance_rate', 'ratio'),
  entry('vllm.requests-finished-total', 'vllm', 'vllm.requests_finished_total', 'count'),
  entry('vllm.e2e-latency-avg-ms', 'vllm', 'vllm.e2e_latency_avg_ms', 'ms'),
  entry('vllm.ttft-avg-ms', 'vllm', 'vllm.ttft_avg_ms', 'ms'),
  entry('system.cpu-utilization-percent', 'system', 'system.cpu_utilization_percent', 'percent'),
  entry('system.memory-usage-percent', 'system', 'system.memory_usage_percent', 'percent'),
  entry('system.disk-usage-percent', 'system', 'system.disk_usage_percent', 'percent'),
  entry('gpu.utilization-percent', 'gpu', 'gpu.utilization_percent', 'percent'),
  entry('gpu.vram-used-bytes', 'gpu', 'gpu.vram_used_bytes', 'bytes'),
  entry('gpu.vram-total-bytes', 'gpu', 'gpu.vram_total_bytes', 'bytes'),
  entry('gpu.temperature-c', 'gpu', 'gpu.temperature_c', 'celsius'),
  entry('gpu.power-watts', 'gpu', 'gpu.power_watts', 'watts'),
  entry('gpu.clock-mhz', 'gpu', 'gpu.clock_mhz', 'megahertz'),
];

/** Unit-free lookup of an allowlisted series by its public key. */
export function findMetricSeries(key: string): MetricSeriesDefinition | undefined {
  return METRIC_SERIES.find((series) => series.key === key);
}
