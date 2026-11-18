<script setup lang="ts">
import { computed } from 'vue';
import type { SystemSnapshot, VllmTelemetryPayload } from '@observatory/contracts';
import { formatBytes, formatFixed } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import TelemetryCard from './TelemetryCard.vue';
const props = defineProps<{
  system: SystemSnapshot | null;
  telemetry: VllmTelemetryPayload | null;
  systemCurrent: boolean;
  telemetryCurrent: boolean;
}>();
const gpu = computed(() => (props.system?.gpu.available ? props.system.gpu.values : undefined));
const gpuHint = computed(() => {
  const section = props.system?.gpu;
  if (!section) return t('gpu.loading');
  if (!section.available) return section.reason;
  const values = section.values;
  const parts = [];
  if (values.temperatureC !== undefined) parts.push(`${formatFixed(values.temperatureC)} °C`);
  if (values.powerWatts !== undefined) parts.push(`${formatFixed(values.powerWatts)} W`);
  if (values.clockMhz !== undefined) parts.push(`${formatFixed(values.clockMhz, 0)} MHz`);
  if (values.utilizationPercent === undefined) parts.push(t('gpu.noUtilization'));
  return parts.join(' · ') || t('gpu.noValues');
});
const vramPercent = computed(() =>
  gpu.value?.vramUsedBytes !== undefined && gpu.value.vramTotalBytes
    ? (gpu.value.vramUsedBytes / gpu.value.vramTotalBytes) * 100
    : undefined
);
</script>
<template>
  <section class="kpi-grid computer-kpis" :aria-label="t('app.liveKpis')">
    <TelemetryCard
      :title="t('kpi.gpuUtilization')"
      :value="formatFixed(gpu?.utilizationPercent)"
      unit="%"
      :hint="gpuHint"
      :meter="gpu?.utilizationPercent"
      secondary-label="VRAM"
      :secondary-value="formatBytes(gpu?.vramUsedBytes)"
      :secondary-hint="t('kpi.of', { value: formatBytes(gpu?.vramTotalBytes) })"
      :secondary-meter="vramPercent"
      :stale="!systemCurrent"
    />
    <TelemetryCard
      title="CPU"
      :value="formatFixed(system?.cpu?.utilizationPercent)"
      unit="%"
      :hint="
        t('kpi.cpuThreads', {
          threads: (system?.cpu?.coreCount ?? '–').toString(),
          load: formatFixed(system?.cpu?.load1, 2),
        })
      "
      :meter="system?.cpu?.utilizationPercent"
      secondary-label="RAM"
      :secondary-value="formatBytes(system?.memory?.usedBytes)"
      :secondary-hint="t('kpi.of', { value: formatBytes(system?.memory?.totalBytes) })"
      :secondary-meter="system?.memory?.usagePercent"
      :stale="!systemCurrent"
    />
    <TelemetryCard
      :title="t('workbench.prefill')"
      :value="formatFixed(telemetry?.tokens?.promptTokensPerSecond)"
      unit="tok/s"
      :stale="!telemetryCurrent"
    />
    <TelemetryCard
      :title="t('workbench.decode')"
      :value="formatFixed(telemetry?.tokens?.generationTokensPerSecond)"
      unit="tok/s"
      :stale="!telemetryCurrent"
    />
  </section>
</template>
