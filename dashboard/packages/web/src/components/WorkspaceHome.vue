<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  EngineRuntimesSchema,
  type EngineRuntimes,
  type SystemSnapshot,
} from '@observatory/contracts';
import { formatBytes, formatClock, formatFixed, formatUptime } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ system: SystemSnapshot | null; current: boolean; model?: string }>();
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

function capacity(used?: number, total?: number): string {
  return used !== undefined && total ? `${formatBytes(used)} / ${formatBytes(total)}` : '';
}

const resources = computed(() => {
  const gpu = props.system?.gpu.available ? props.system.gpu.values : undefined;
  const cpu = props.system?.cpu;
  const ram = props.system?.memory;
  return [
    {
      label: 'GPU',
      value: gpu?.utilizationPercent,
      hint: [
        gpu?.temperatureC !== undefined ? `${formatFixed(gpu.temperatureC, 0)} °C` : '',
        gpu?.powerWatts !== undefined ? `${formatFixed(gpu.powerWatts, 0)} W` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    },
    {
      label: 'VRAM',
      value:
        gpu?.vramUsedBytes !== undefined && gpu.vramTotalBytes
          ? (gpu.vramUsedBytes / gpu.vramTotalBytes) * 100
          : undefined,
      hint: capacity(gpu?.vramUsedBytes, gpu?.vramTotalBytes),
    },
    {
      label: 'CPU',
      value: cpu?.utilizationPercent,
      hint: cpu?.coreCount ? t('home.threads', { count: cpu.coreCount }) : '',
    },
    { label: 'RAM', value: ram?.usagePercent, hint: capacity(ram?.usedBytes, ram?.totalBytes) },
  ];
});
</script>

<template>
  <section class="system-home" aria-labelledby="system-home-title">
    <header class="home-heading">
      <h1 id="system-home-title">{{ t('home.title') }}</h1>
      <div class="host-uptime">
        <AppIcon name="clock" />
        <div>
          <span>{{ t('home.uptime') }}</span
          ><strong>{{ duration(runtimes?.hostUptimeSeconds) }}</strong>
        </div>
      </div>
    </header>

    <section aria-labelledby="engines-heading">
      <h2 id="engines-heading">{{ t('home.engines') }}</h2>
      <div class="engine-pair">
        <article
          v-for="engine in engines"
          :key="engine.key"
          class="home-engine"
          :data-state="runtimes?.[engine.key].state ?? 'unknown'"
        >
          <div class="engine-symbol"><AppIcon :name="engine.icon" /></div>
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
      <dl class="resource-grid" :class="{ stale: !current }">
        <div v-for="item in resources" :key="item.label" class="resource">
          <dt>{{ item.label }}</dt>
          <dd>
            <strong
              >{{ formatFixed(item.value, 0)
              }}<small v-if="item.value !== undefined"> %</small></strong
            >
            <div class="meter-track" aria-hidden="true">
              <i
                v-if="item.value !== undefined"
                :style="{ width: Math.max(0, Math.min(100, item.value)) + '%' }"
              ></i>
            </div>
            <span v-if="item.hint">{{ item.hint }}</span>
          </dd>
        </div>
      </dl>
    </section>
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
.home-heading,
.resource-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.home-heading h1 {
  margin: 0;
  font-size: clamp(22px, 3vw, 32px);
  line-height: 1.15;
  letter-spacing: -0.035em;
}
.system-home h2 {
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 600;
}
.host-uptime {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--dim);
}
.host-uptime span,
.engine-identity span {
  display: block;
  font-size: 12px;
  color: var(--dim);
}
.host-uptime strong {
  display: block;
  font-variant-numeric: tabular-nums;
  color: var(--text);
}
.engine-pair {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.home-engine {
  --state: var(--dim);
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 12px;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  background: var(--panel);
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
.engine-symbol {
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
.engine-reading small,
.resource dd > span {
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
.resource-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  border: 1px solid var(--border);
  background: var(--border);
  border-radius: 8px;
  overflow: hidden;
  margin: 0;
}
.resource {
  background: var(--panel);
  padding: 14px 16px;
  min-width: 0;
}
.resource dt {
  font-size: 13px;
  font-weight: 600;
  color: var(--dim);
}
.resource dd {
  margin: 4px 0 0;
}
.resource dd strong {
  font-size: 26px;
  line-height: 1.25;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.resource dd strong small {
  font-size: 14px;
  font-weight: 400;
  color: var(--dim);
}
.meter-track {
  height: 4px;
  margin: 8px 0;
  border-radius: 3px;
  overflow: hidden;
  background: var(--border);
}
.meter-track i {
  display: block;
  height: 100%;
  background: var(--accent);
}
.stale .meter-track i {
  background: var(--dim);
}
.sample-status {
  color: var(--dim);
  font-size: 12px;
  margin: 0 0 8px;
}
@container (max-width: 640px) {
  .engine-pair {
    grid-template-columns: 1fr;
  }
  .resource-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 600px) {
  .system-home {
    gap: 18px;
    padding-top: 4px;
  }
  .host-uptime .app-icon {
    display: none;
  }
  .home-engine,
  .resource {
    padding: 12px;
  }
}
</style>
