<script setup lang="ts">
import { engineMode } from '../composables/useEngineMode.js';
import { studioLabel } from '../studio/copy.js';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { EngineMetricsSchema, type EngineMetrics } from '@observatory/contracts';
import { useNotification } from '../composables/useNotifications.js';
import { formatBytes } from '../lib/format.js';
import { t } from '../lib/i18n.js';
const metrics = ref<EngineMetrics>();
const error = ref('');
useNotification(error, 'engine-metrics', 'warn');
const controller = new AbortController();
let timer: ReturnType<typeof setTimeout> | undefined;
async function poll() {
  try {
    if (!document.hidden) {
      const response = await fetch('/api/engine/metrics', {
        cache: 'no-store',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      });
      if (!response.ok) throw new Error(t('imageMetrics.unavailable'));
      metrics.value = EngineMetricsSchema.parse(await response.json());
      error.value = '';
    }
  } catch {
    if (!controller.signal.aborted) error.value = t('imageMetrics.unavailable');
  }
  if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
}
onMounted(poll);
onUnmounted(() => {
  controller.abort();
  clearTimeout(timer);
});
const activeJobs = computed(
  () =>
    metrics.value?.jobs.filter((job) =>
      ['queued', 'running', 'cancelling', 'generated'].includes(job.status)
    ) ?? []
);
const recentJobs = computed(
  () =>
    metrics.value?.jobs
      .filter((job) => !['queued', 'running', 'cancelling', 'generated'].includes(job.status))
      .slice(0, 5) ?? []
);
const seconds = (value: number | undefined) =>
  value === undefined ? '–' : `${value.toFixed(1)} s`;
</script>
<template>
  <div class="engine-overview">
    <div class="engine-status-strip" :aria-label="t('imageMetrics.title')" role="status">
      <template v-if="metrics">
        <span :class="{ ready: metrics.textReady }"
          ><i aria-hidden="true"></i
          >{{ engineMode.model === 'inkling2-mini-exl3-b70' ? 'Inkling 2 Mini' : 'Qwen 27B' }} ·
          {{
            metrics.textReady
              ? t('imageMetrics.ready')
              : t(metrics.phase === 'loading-text' ? 'imageMetrics.starting' : 'imageMetrics.off')
          }}</span
        >
        <span :class="{ ready: metrics.imageReady }"
          ><i aria-hidden="true"></i>H3 Image INT8 ·
          {{
            metrics.imageReady
              ? t('imageMetrics.ready')
              : t(metrics.phase === 'loading-image' ? 'imageMetrics.starting' : 'imageMetrics.off')
          }}</span
        >
        <small>{{ t(`engine.gpu.${metrics.phase}`) }}</small>
      </template>
      <span v-else>{{ t('engine.loading') }}</span>
    </div>
    <slot />
    <section v-if="metrics" class="engine-metrics panel" :aria-label="t('imageMetrics.activity')">
      <header class="engine-metrics-heading">
        <h2>{{ t('imageMetrics.activity') }}</h2>
      </header>
      <dl class="engine-metric-values">
        <div>
          <dt>{{ t('imageMetrics.textTurns') }}</dt>
          <dd>{{ metrics.activeText }} / {{ metrics.waitingText }}</dd>
        </div>
        <div>
          <dt>{{ t('imageMetrics.brokerQueue') }}</dt>
          <dd>{{ metrics.waitingImages }}</dd>
        </div>
        <div>
          <dt>{{ t('imageMetrics.comfyQueue') }}</dt>
          <dd>
            {{
              metrics.imageQueue
                ? metrics.imageQueue.running + ' / ' + metrics.imageQueue.pending
                : '–'
            }}
          </dd>
        </div>
        <template v-if="metrics.imageMemory"
          ><div v-for="(device, index) in metrics.imageMemory.devices" :key="index">
            <dt>{{ t('imageMetrics.vram') }}</dt>
            <dd>
              {{ formatBytes(Math.max(0, device.vramTotal - device.vramFree)) }} /
              {{ formatBytes(device.vramTotal) }}
            </dd>
          </div>
          <div>
            <dt>{{ t('imageMetrics.hostRam') }}</dt>
            <dd>{{ formatBytes(metrics.imageMemory.ramFree) }}</dd>
          </div></template
        >
      </dl>
      <div v-for="job in activeJobs" :key="job.id" class="engine-image-job">
        <div>
          <strong>{{ t(`imageMetrics.source.${job.source}`) }}</strong
          ><code>{{ job.id.slice(0, 8) }}</code
          ><span>{{ studioLabel(job.phase) }}</span>
        </div>
        <progress
          v-if="job.steps"
          :max="job.steps"
          :value="job.step ?? 0"
          :aria-label="t('imageMetrics.progress')"
        ></progress>
        <p class="dim">
          <span v-if="job.steps">{{ job.step ?? 0 }} / {{ job.steps }} · </span
          >{{ t('imageMetrics.elapsed') }}: {{ seconds(job.elapsedSeconds)
          }}<span v-if="job.width"> · {{ job.width }} × {{ job.height }}</span>
        </p>
      </div>
      <p v-if="!activeJobs.length" class="engine-idle dim">{{ t('imageMetrics.idle') }}</p>
      <table v-if="recentJobs.length" class="engine-recent-jobs">
        <caption>
          {{
            t('imageMetrics.recent')
          }}
        </caption>
        <thead>
          <tr>
            <th>{{ t('imageMetrics.job') }}</th>
            <th>{{ t('imageMetrics.status') }}</th>
            <th>{{ t('imageMetrics.elapsed') }}</th>
            <th>{{ t('imageMetrics.render') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="job in recentJobs" :key="job.id">
            <td>
              {{ t(`imageMetrics.source.${job.source}`) }} · <code>{{ job.id.slice(0, 8) }}</code>
            </td>
            <td>{{ studioLabel(job.status) }}</td>
            <td>{{ seconds(job.elapsedSeconds) }}</td>
            <td>{{ seconds(job.renderSeconds) }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>
<style scoped>
.engine-overview {
  display: grid;
  gap: 12px;
}
.engine-status-strip {
  display: flex;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
  padding: 4px 0;
  font-size: 12px;
  color: var(--dim);
}
.engine-status-strip > span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.engine-status-strip i {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--dim);
}
.engine-status-strip .ready i {
  background: var(--ok);
}
.engine-status-strip small {
  margin-left: auto;
  font-size: 11px;
}
.engine-metrics-heading h2 {
  font-size: 14px;
}
.engine-metric-values {
  margin: 8px 0;
}
.engine-idle {
  margin: 8px 0;
  font-size: 12px;
}
.engine-recent-jobs {
  margin-top: 12px;
}
</style>
