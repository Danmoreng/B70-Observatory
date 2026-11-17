<script setup lang="ts">
import { t } from '../lib/i18n.js';

/**
 * One compact KPI tile of the telemetry grid. `value` is pre-formatted
 * server-side normalized data – the component renders exactly what it is
 * given (`–` when a metric is absent) and never invents numbers.
 */
defineProps<{
  title: string;
  value: string;
  hint?: string;
  tone?: 'ok' | 'warn' | 'error' | 'muted';
  unit?: string;
  stale?: boolean;
  meter?: number;
  secondaryLabel?: string;
  secondaryValue?: string;
  secondaryHint?: string;
  secondaryMeter?: number;
}>();
</script>

<template>
  <article
    class="kpi"
    :class="[tone ?? 'ok', { stale }]"
    :aria-label="stale ? t('kpi.lastKnownAria', { title }) : undefined"
  >
    <p class="kpi-title">{{ title }}</p>
    <p class="kpi-value">
      {{ value }} <span v-if="unit" class="kpi-unit">{{ unit }}</span>
    </p>
    <div
      v-if="meter !== undefined"
      class="meter"
      role="meter"
      :aria-label="title"
      :aria-valuenow="meter"
      :aria-valuemin="0"
      :aria-valuemax="100"
    >
      <span :style="{ width: `${Math.max(0, Math.min(100, meter))}%` }"></span>
    </div>
    <p v-if="hint !== undefined" class="kpi-hint">{{ hint }}</p>
    <div v-if="secondaryLabel" class="kpi-secondary">
      <div>
        <strong>{{ secondaryLabel }}</strong
        ><span>{{ secondaryValue }}</span>
      </div>
      <div
        v-if="secondaryMeter !== undefined"
        class="meter"
        role="meter"
        :aria-label="secondaryLabel"
        :aria-valuenow="secondaryMeter"
        :aria-valuemin="0"
        :aria-valuemax="100"
      >
        <span :style="{ width: Math.max(0, Math.min(100, secondaryMeter)) + '%' }"></span>
      </div>
      <p v-if="secondaryHint" class="kpi-hint">{{ secondaryHint }}</p>
    </div>
  </article>
</template>

<style scoped>
.kpi-secondary {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.kpi-secondary > div:first-child {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
}
.kpi-secondary strong {
  font-size: 11px;
  font-weight: 500;
  color: var(--dim);
}
.kpi-secondary .meter {
  margin-top: 7px;
}
.kpi-secondary .kpi-hint {
  margin-bottom: 0;
}
</style>
