/**
 * Series definitions for the metric charts. `label` holds a translation key
 * (resolved via `t()` at render time) so the legend follows the UI locale.
 */
import type {
  MetricsHistoryResponse,
  SystemSnapshot,
  VllmTelemetryPayload,
} from '@observatory/contracts';
import type { TranslationKey } from './translations.js';

export type TimePoint = [number, number | null];
export const SERIES = [
  {
    key: 'vllm.generation-tokens-per-second',
    label: 'Decode',
    unit: 'tokens_per_second',
    color: '#6de2ae',
    group: 'tokens',
    axis: 'right',
  },
  {
    key: 'vllm.generation-tokens-per-second-per-request',
    label: 'Decode/Req.',
    unit: 'tokens_per_second',
    color: '#f5bd69',
    group: 'tokens',
    axis: 'right',
  },
  {
    key: 'vllm.prefill-compute-tokens-per-second',
    label: 'Prefill',
    unit: 'tokens_per_second',
    color: '#76b9f6',
    group: 'tokens',
    axis: 'left',
  },
  { key: 'gpu.utilization-percent', label: 'GPU', unit: 'percent', color: '#6de2ae', group: 'gpu' },
  {
    key: 'gpu.power-watts',
    label: 'Power draw',
    labelKey: 'series.power' satisfies TranslationKey,
    unit: 'watts',
    color: '#f5bd69',
    group: 'gpu',
  },
  {
    key: 'system.cpu-utilization-percent',
    label: 'CPU',
    unit: 'percent',
    color: '#76b9f6',
    group: 'host',
  },
  {
    key: 'system.memory-usage-percent',
    label: 'RAM',
    unit: 'percent',
    color: '#c2a7ff',
    group: 'host',
  },
  {
    key: 'vllm.prefix-cache-hit-rate',
    label: 'Prefix-Cache',
    unit: 'ratio',
    color: '#76b9f6',
    group: 'cache',
  },
  {
    key: 'vllm.mtp-acceptance-rate',
    label: 'MTP',
    unit: 'ratio',
    color: '#c2a7ff',
    group: 'cache',
  },
] as const;
export type SeriesKey = (typeof SERIES)[number]['key'];
/** Time range presets; labels are translation keys resolved via `t()`. */
export const RANGES = [
  { label: 'range.15m' satisfies TranslationKey, minutes: 15, bucket: 60 },
  { label: 'range.1h' satisfies TranslationKey, minutes: 60, bucket: 60 },
  { label: 'range.24h' satisfies TranslationKey, minutes: 1440, bucket: 300 },
] as const;

export function vllmValues(
  payload: VllmTelemetryPayload
): Partial<Record<SeriesKey, number | undefined>> {
  return {
    'vllm.generation-tokens-per-second': payload.tokens?.generationTokensPerSecond,
    'vllm.generation-tokens-per-second-per-request':
      payload.tokens?.generationTokensPerSecondPerRequest,
    'vllm.prefill-compute-tokens-per-second': payload.tokens?.promptTokensPerSecond,
    'vllm.prefix-cache-hit-rate': payload.prefixCache?.hitRate,
    'vllm.mtp-acceptance-rate': payload.mtp?.acceptanceRate,
  };
}
export function systemValues(
  payload: SystemSnapshot
): Partial<Record<SeriesKey, number | undefined>> {
  return {
    'gpu.utilization-percent': payload.gpu.available
      ? payload.gpu.values.utilizationPercent
      : undefined,
    'gpu.power-watts': payload.gpu.available ? payload.gpu.values.powerWatts : undefined,
    'system.cpu-utilization-percent': payload.cpu?.utilizationPercent,
    'system.memory-usage-percent': payload.memory?.usagePercent,
  };
}

/** One bounded, sorted buffer per source series. Null is a real discontinuity. */
export function appendPoint(points: TimePoint[], point: TimePoint): TimePoint[] {
  const byTime = new Map(points);
  byTime.set(point[0], point[1]);
  return [...byTime].sort((a, b) => a[0] - b[0]).slice(-1800);
}

/** Never interpolate missing buckets; live measurements keep their actual timestamps. */
export function mergePoints(
  history: MetricsHistoryResponse | undefined,
  live: TimePoint[],
  from: number,
  to: number,
  bucketSeconds: number
): TimePoint[] {
  const width = bucketSeconds * 1000;
  const buckets = new Map(history?.buckets.map((b) => [Date.parse(b.atUtc), b.avg]) ?? []);
  const liveBuckets = new Map<number, TimePoint[]>();
  for (const point of live) {
    if (point[0] < from || point[0] > to) continue;
    const bucket = Math.floor(point[0] / width) * width;
    liveBuckets.set(bucket, [...(liveBuckets.get(bucket) ?? []), point]);
  }
  const result: TimePoint[] = [];
  for (let time = Math.floor(from / width) * width; time <= to; time += width) {
    const exact = liveBuckets.get(time);
    if (exact?.length) result.push(...exact);
    else result.push([time, buckets.get(time) ?? null]);
  }
  return result;
}
