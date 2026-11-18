<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import {
  EngineRuntimesSchema,
  type EngineRuntimes,
  type SystemSnapshot,
} from '@observatory/contracts';
import { formatClock, formatUptime } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import RecentWork from './RecentWork.vue';
import AppIcon from './AppIcon.vue';

defineProps<{ system: SystemSnapshot | null; current: boolean; model?: string }>();
const runtimes = ref<EngineRuntimes>();
const loading = ref(true);
const session = new AbortController();
let timer: ReturnType<typeof setTimeout>;

async function refreshRuntimes() {
  if (!document.hidden) {
    try {
      const response = await fetch('/api/engine/runtimes', {
        cache: 'no-store',
        signal: AbortSignal.any([session.signal, AbortSignal.timeout(5000)]),
      });
      if (!response.ok) throw new Error();
      runtimes.value = EngineRuntimesSchema.parse(await response.json());
    } catch {
      runtimes.value = undefined;
    } finally {
      loading.value = false;
    }
  }
  if (!session.signal.aborted) timer = setTimeout(refreshRuntimes, 5000);
}
onMounted(refreshRuntimes);
onUnmounted(() => {
  session.abort();
  clearTimeout(timer);
});

const engines = [
  { key: 'text', name: 'vLLM', icon: 'tasks' },
  { key: 'image', name: 'ComfyUI', icon: 'studio' },
] as const;

function duration(seconds: number | undefined): string {
  if (seconds === undefined) return '–';
  return formatUptime(seconds < 60 ? seconds : Math.floor(seconds / 60) * 60);
}
</script>

<template>
  <section class="system-home" :aria-label="t('sidebar.overview')">
    <section aria-labelledby="engines-heading">
      <h2 id="engines-heading">{{ t('home.engines') }}</h2>
      <div class="status-cards">
        <article
          v-for="engine in engines"
          :key="engine.key"
          class="status-card home-engine"
          :data-state="runtimes?.[engine.key].state ?? 'unknown'"
        >
          <div class="status-symbol"><AppIcon :name="engine.icon" /></div>
          <div class="engine-identity">
            <span>{{ t(`home.${engine.key}`) }}</span>
            <h3>{{ engine.name }}</h3>
            <small
              v-if="engine.key === 'text' && runtimes?.text.state === 'active' && model"
              class="engine-model"
              >{{ model }}</small
            >
          </div>
          <div class="engine-reading">
            <strong class="service-state"
              ><i aria-hidden="true"></i
              >{{
                loading
                  ? t('label.loading')
                  : t(`engine.state.${runtimes?.[engine.key].state ?? 'unknown'}`)
              }}</strong
            >
            <small
              v-if="
                runtimes?.[engine.key].state === 'active' &&
                runtimes[engine.key].uptimeSeconds !== undefined
              "
              >{{
                t('home.runningFor', { time: duration(runtimes[engine.key].uptimeSeconds) })
              }}</small
            >
          </div>
        </article>
        <article class="status-card host-uptime">
          <div class="status-symbol"><AppIcon name="clock" /></div>
          <div class="uptime-reading">
            <span>{{ t('home.uptime') }}</span>
            <strong>{{ duration(runtimes?.hostUptimeSeconds) }}</strong>
          </div>
        </article>
      </div>
    </section>

    <section aria-labelledby="resources-heading">
      <header class="resource-heading">
        <h2 id="resources-heading">{{ t('home.resources') }}</h2>
        <a href="#/hardware">{{ t('home.details') }} <AppIcon name="right" /></a>
      </header>
      <p v-if="!current" class="sample-status" role="status">
        {{
          system
            ? t('home.lastSample', { time: formatClock(system.timestamp) })
            : t('home.awaiting')
        }}
      </p>
      <div class="overview-telemetry"><slot name="kpis" /><slot name="chart" /></div>
    </section>
    <RecentWork />
  </section>
</template>

<style scoped>
.system-home {
  width: 100%;
  max-width: 1120px;
  container-type: inline-size;
  display: grid;
  gap: 24px;
  align-self: start;
  padding: 12px 0;
}
.resource-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.system-home h2 {
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 600;
}
.uptime-reading span,
.engine-identity span {
  display: block;
  font-size: 12px;
  color: var(--dim);
}
.uptime-reading strong {
  font-size: 19px;
  line-height: 1.25;
  display: block;
  font-variant-numeric: tabular-nums;
  color: var(--text);
}
.status-cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr)) minmax(160px, 0.55fr);
  gap: 10px;
}
.status-card {
  --state: var(--dim);
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 12px;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  background: var(--panel);
}
.home-engine {
  grid-template-columns: auto minmax(0, 1fr) auto;
}
.home-engine[data-state='active'] {
  --state: var(--ok);
  border-color: color-mix(in srgb, var(--ok) 45%, var(--border));
  background: color-mix(in srgb, var(--ok) 6%, var(--panel));
}
.home-engine:is([data-state='activating'], [data-state='deactivating']) {
  --state: var(--warn);
}
.home-engine[data-state='failed'] {
  --state: var(--error);
}
.status-symbol {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--state);
}
.engine-identity {
  min-width: 0;
}
.engine-model {
  color: var(--dim);
  overflow-wrap: anywhere;
  font-size: 12px;
}
.engine-identity h3 {
  margin: 0;
  font-size: 19px;
  line-height: 1.25;
}
.engine-reading {
  display: grid;
  justify-items: end;
  gap: 2px;
}
.engine-reading small {
  color: var(--dim);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.service-state {
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--state);
}
.service-state i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}
.resource-heading {
  margin-bottom: 8px;
}
.resource-heading h2 {
  margin: 0;
}
.resource-heading a {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 13px;
  text-decoration: none;
  color: var(--accent);
}
.resource-heading a:hover {
  text-decoration: underline;
}
.resource-heading .app-icon {
  width: 14px;
  height: 14px;
}
.overview-telemetry {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.12fr);
  gap: 12px;
}
.overview-telemetry :deep(.computer-kpis) {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  align-content: start;
}
.overview-telemetry :deep(.kpi) {
  padding: 12px;
}
.overview-telemetry :deep(.kpi-secondary) {
  margin-top: 8px;
  padding-top: 6px;
}
.overview-telemetry :deep(.chart-panel) {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.overview-telemetry :deep(.chart-canvas) {
  flex: 1;
  min-height: 160px;
}
.overview-telemetry :deep(.section-heading) {
  flex-wrap: wrap;
  gap: 4px;
}
@container (max-width: 800px) {
  .overview-telemetry {
    grid-template-columns: minmax(0, 1fr);
  }
  .overview-telemetry :deep(.chart-canvas) {
    flex: none;
    height: 170px;
  }
}
.sample-status {
  color: var(--dim);
  font-size: 12px;
  margin: 0 0 8px;
}
@container (max-width: 740px) {
  .status-cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .home-engine {
    grid-template-columns: minmax(0, 1fr);
    align-content: start;
    gap: 6px;
    padding: 12px;
  }
  .home-engine .status-symbol {
    display: none;
  }
  .engine-reading {
    justify-items: start;
  }
  .host-uptime {
    grid-column: 1 / -1;
    display: flex;
    gap: 8px;
    padding: 8px 12px;
  }
  .host-uptime .status-symbol {
    width: auto;
    height: auto;
    border: 0;
  }
  .host-uptime .app-icon {
    width: 16px;
    height: 16px;
  }
  .uptime-reading {
    flex: 1;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .uptime-reading strong {
    font-size: 14px;
  }
}
@media (max-width: 600px) {
  .system-home {
    gap: 18px;
    padding-top: 4px;
  }
}
</style>
