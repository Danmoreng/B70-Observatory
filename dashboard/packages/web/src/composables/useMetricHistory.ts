import { computed, onUnmounted, ref, shallowRef, watch, type Ref } from 'vue';
import type {
  MetricsHistoryResponse,
  SystemSnapshot,
  VllmTelemetryPayload,
} from '@observatory/contracts';
import { fetchMetricHistory } from '../lib/api.js';
import { t } from '../lib/i18n.js';
import {
  appendPoint,
  mergePoints,
  RANGES,
  SERIES,
  systemValues,
  vllmValues,
  type SeriesKey,
  type TimePoint,
} from '../lib/series.js';

export function useMetricHistory(options: {
  enabled: Ref<boolean>;
  revision: Ref<number>;
  telemetry: Ref<VllmTelemetryPayload | null>;
  system: Ref<SystemSnapshot | null>;
  connection: Ref<string>;
  onError: (error: unknown) => void;
}) {
  const rangeIndex = ref(0);
  const range = computed(() => RANGES[rangeIndex.value] ?? RANGES[0]);
  const end = ref(Date.now());
  const from = computed(() => end.value - range.value.minutes * 60_000);
  const history = shallowRef<Partial<Record<SeriesKey, MetricsHistoryResponse>>>({});
  const live = shallowRef<Partial<Record<SeriesKey, TimePoint[]>>>({});
  const errors = ref<Partial<Record<SeriesKey, string>>>({});
  const loading = ref(false);
  let controller: AbortController | undefined;
  let epoch = 0;
  let disposed = false;
  let queued = false;

  async function refresh(): Promise<void> {
    if (!options.enabled.value || disposed) return;
    if (loading.value) {
      queued = true;
      return;
    }
    const token = ++epoch;
    controller = new AbortController();
    const signal = controller.signal;
    end.value = Date.now();
    const query = {
      from: new Date(from.value).toISOString(),
      to: new Date(end.value).toISOString(),
      bucketSeconds: range.value.bucket,
    };
    loading.value = true;
    await Promise.all(
      SERIES.map(async (series) => {
        try {
          const payload = await fetchMetricHistory({ ...query, series: series.key }, signal);
          if (token !== epoch || disposed) return;
          if (payload.unit !== series.unit) throw new Error('Unerwartete Maßeinheit.');
          history.value = { ...history.value, [series.key]: payload };
          delete errors.value[series.key];
        } catch (error) {
          if (token !== epoch || signal.aborted || disposed) return;
          errors.value[series.key] = error instanceof Error ? error.message : t('history.failed');
          options.onError(error);
        }
      })
    );
    if (token !== epoch || disposed) return;
    loading.value = false;
    if (queued) {
      queued = false;
      void refresh();
    }
  }

  function cancel(): void {
    epoch++;
    controller?.abort();
    queued = false;
    loading.value = false;
  }
  function record(
    values: Partial<Record<SeriesKey, number | undefined>>,
    timestamp: string,
    valid: boolean
  ): void {
    const time = valid ? Date.parse(timestamp) : Date.now();
    const next = { ...live.value };
    for (const [key, value] of Object.entries(values)) {
      const series = key as SeriesKey;
      next[series] = appendPoint(next[series] ?? [], [time, valid ? (value ?? null) : null]);
    }
    live.value = next;
    end.value = Date.now();
  }
  watch(options.telemetry, (payload) => {
    if (payload) record(vllmValues(payload), payload.timestamp, payload.sourceStatus === 'ok');
  });
  watch(options.system, (payload) => {
    if (payload) record(systemValues(payload), payload.timestamp, payload.sourceStatus === 'ok');
  });
  watch(options.connection, (state, previous) => {
    if (state === 'reconnecting' && previous !== state) {
      const time = Date.now();
      live.value = Object.fromEntries(
        SERIES.map((s) => [s.key, appendPoint(live.value[s.key] ?? [], [time, null])])
      );
    }
  });
  watch(rangeIndex, () => {
    cancel();
    history.value = {};
    errors.value = {};
    void refresh();
  });
  watch(options.revision, () => {
    void refresh();
  });
  watch(
    options.enabled,
    (enabled) => {
      cancel();
      if (enabled) void refresh();
      else {
        history.value = {};
        live.value = {};
        errors.value = {};
      }
    },
    { immediate: true }
  );
  onUnmounted(() => {
    disposed = true;
    cancel();
  });

  const charts = computed(() =>
    SERIES.map((s) => ({
      ...s,
      // Resolve translated series names in the active locale (legend, table).
      label: 'labelKey' in s && s.labelKey !== undefined ? t(s.labelKey) : s.label,
      points: mergePoints(
        history.value[s.key],
        live.value[s.key] ?? [],
        from.value,
        end.value,
        range.value.bucket
      ).map(([time, value]): TimePoint => [
        time,
        value === null ? null : s.unit === 'ratio' ? value * 100 : value,
      ]),
      error: errors.value[s.key],
    }))
  );
  return { rangeIndex, range, from, end, charts, loading, refresh };
}
