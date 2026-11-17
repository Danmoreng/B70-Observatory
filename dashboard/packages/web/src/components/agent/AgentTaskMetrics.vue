<script setup lang="ts">
import { computed } from 'vue';
import type { AgentTaskTelemetry } from '@observatory/contracts';
import { fetchAgentTaskTelemetry } from '../../lib/api.js';
import { useVisiblePolling } from '../../composables/useVisiblePolling.js';
import { formatFixed, formatInteger, formatRuntimeClock } from '../../lib/format.js';
import { t } from '../../lib/i18n.js';
const props = defineProps<{
  taskId: string;
  runId: string;
  runtime: string;
  active: boolean;
  initial?: AgentTaskTelemetry;
  scope?: 'task' | 'run';
}>();
const { data, error } = useVisiblePolling({
  key: () => props.taskId,
  enabled: () => true,
  repeat: () => props.active,
  intervalMs: 4_000,
  load: async (signal) => {
    const result = await fetchAgentTaskTelemetry(props.taskId, signal);
    if (result.taskId !== props.taskId) throw new Error('Mismatched task telemetry');
    return result;
  },
});
const telemetry = computed(
  () => data.value ?? (props.initial?.taskId === props.taskId ? props.initial : undefined)
);
const totals = computed(() =>
  props.scope === 'task'
    ? telemetry.value?.totals
    : telemetry.value?.runs.find((run) => run.runId === props.runId)?.totals
);
const clock = (milliseconds: number | null | undefined) =>
  milliseconds == null ? '–' : formatRuntimeClock(milliseconds / 1000);
const runtimeClock = computed(() =>
  totals.value?.runtime
    ? clock(totals.value.runtime.wallMs)
    : props.scope === 'task'
      ? '–'
      : props.runtime
);
const notice = computed(() =>
  totals.value?.completedRequests && totals.value.uniqueInputTokens == null
    ? t('metrics.inputUnavailable')
    : totals.value?.usageSource === 'durable-history'
      ? t('metrics.recovered')
      : !totals.value?.completedRequests
        ? t(props.active ? 'metrics.pending' : 'metrics.notRecorded')
        : !totals.value.prefill && !totals.value.decode
          ? t('metrics.noTiming')
          : ''
);
</script>
<template>
  <section
    class="task-metrics"
    :aria-label="t('metrics.task')"
    :title="
      error
        ? t('metrics.stale')
        : notice ||
          t('metrics.coverage', {
            prefill: totals?.prefill?.samples ?? 0,
            decode: totals?.decode?.samples ?? 0,
            total: totals?.completedRequests ?? 0,
          })
    "
  >
    <div class="task-metrics-values">
      <div>
        <span>{{ t('metrics.runtime') }}</span
        ><strong>{{ runtimeClock }}</strong>
        <small v-if="totals?.runtime" class="runtime-parts" :title="t('metrics.runtimeMethod')">
          <span
            >{{
              t(totals.runtime.engineWaitMs === null ? 'metrics.modelAndWait' : 'metrics.modelTime')
            }}
            {{ clock(totals.runtime.modelMs) }}</span
          >
          <span>{{ t('metrics.toolWait') }} {{ clock(totals.runtime.toolMs) }}</span>
          <span v-if="totals.runtime.engineWaitMs !== null"
            >{{ t('metrics.engineWait') }} {{ clock(totals.runtime.engineWaitMs) }}</span
          >
          <span>{{ t('metrics.otherTime') }} {{ clock(totals.runtime.otherMs) }}</span>
        </small>
      </div>
      <div :title="t('metrics.method')" :aria-description="t('metrics.method')">
        <span>{{ t('metrics.prefill') }}</span
        ><strong
          >{{ formatFixed(totals?.prefill?.tokensPerSecond, 1) }} <small>tok/s</small></strong
        >
      </div>
      <div :title="t('metrics.method')" :aria-description="t('metrics.method')">
        <span>{{ t('metrics.decode') }}</span
        ><strong>{{ formatFixed(totals?.decode?.tokensPerSecond, 1) }} <small>tok/s</small></strong>
      </div>
      <div :title="t('metrics.uniqueInputMethod')">
        <span>{{ t('metrics.tokens') }}</span
        ><strong
          >{{ formatInteger(totals?.uniqueInputTokens ?? undefined) }} /
          {{ formatInteger(totals?.usage?.outputTokens ?? undefined) }}</strong
        >
      </div>
    </div>
  </section>
</template>
<style scoped>
.task-metrics {
  flex: none;
  padding: 6px 0;
  border: 0;
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  background: transparent;
}
.task-metrics-values {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 20px;
}
.task-metrics-values > div {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.task-metrics-values > div > span {
  color: var(--dim);
  font-size: 10px;
}
.task-metrics-values strong {
  font-weight: 500;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
.task-metrics-values strong small {
  font-size: 10px;
  font-weight: 400;
  color: var(--dim);
}
.runtime-parts {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 8px;
  max-width: 360px;
  color: var(--dim);
  font-size: 10px;
}
.task-metrics-values label {
  margin-left: auto;
}
.task-metrics select {
  border: 1px solid var(--border);
  background: var(--raised);
  color: var(--text);
  font-size: 11px;
  border-radius: 5px;
  padding: 6px;
}
.task-metrics-note {
  font-size: 10px;
  color: var(--dim);
  margin-top: 4px;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}
@media (max-width: 600px) {
  .task-metrics-values {
    gap: 10px 20px;
  }
  .task-metrics-values label {
    margin: 0;
  }
  .task-metrics-values strong {
    font-size: 12px;
  }
  .task-metrics-note {
    font-size: 10px;
  }
}
</style>
