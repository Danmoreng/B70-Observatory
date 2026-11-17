<script setup lang="ts">
import './composables/useAppearance.js';
import { defineAsyncComponent } from 'vue';
const ComfyDesk = defineAsyncComponent(() => import('./studio/ComfyDesk.vue'));
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useObservatory } from './composables/useObservatory.js';
import { useAppRoute } from './composables/useAppRoute.js';
import { useMetricHistory } from './composables/useMetricHistory.js';
import {
  formatBytes,
  formatFixed,
  formatInteger,
  formatMsAsSeconds,
  formatPercent,
  formatUptime,
} from './lib/format.js';
import TelemetryCard from './components/TelemetryCard.vue';
import TimeChart from './components/TimeChart.vue';
import CheckRow from './components/CheckRow.vue';
import RequestList from './components/RequestList.vue';
import MemoryPanel from './components/MemoryPanel.vue';
import AgentCockpit from './components/AgentCockpit.vue';
import WorkbenchBreadcrumb from './components/WorkbenchBreadcrumb.vue';
import WorkspaceHome from './components/WorkspaceHome.vue';
import AgentProjectBrowser from './components/agent/AgentProjectBrowser.vue';
import AppSidebar from './components/AppSidebar.vue';
import AppFooter from './components/AppFooter.vue';
import CollapsibleSection from './components/CollapsibleSection.vue';
import LoginScreen from './components/LoginScreen.vue';
import RangePicker from './components/RangePicker.vue';
import SettingsPage from './components/SettingsPage.vue';
import EngineMetricsPanel from './components/EngineMetricsPanel.vue';
import { engineMode, useEngineModePolling } from './composables/useEngineMode.js';
import { clearAgentCockpitCache } from './composables/useAgentCockpit.js';
import { t } from './lib/i18n.js';
import NotificationHost from './components/NotificationHost.vue';
import { useNotification } from './composables/useNotifications.js';

const obs = useObservatory();
const {
  auth,
  authError,
  signingOut,
  loginRequired,
  signIn,
  signOut,
  connection,
  sync,
  health,
  telemetry,
  system,
  telemetryCurrent,
  systemCurrent,
  metricRevision,
  requestRevision,
  uptime,
  status,
  startLive,
} = obs;
useNotification(authError, 'auth');
const enabled = computed(() => auth.value === 'signed-in');
useEngineModePolling(enabled);
const metrics = useMetricHistory({
  enabled,
  revision: metricRevision,
  telemetry,
  system,
  connection,
  onError: obs.handleDataError,
});
const { rangeIndex, range, from, end, charts, loading } = metrics;
const minutes = computed(() => range.value.minutes);
const engineOpen = ref(false);
const cacheOpen = ref(false);
const systemOpen = ref(false);
const { appRoute } = useAppRoute();
const taskFocused = computed(() => appRoute.page === 'agent' && appRoute.taskId !== undefined);
const visibleHeight = ref<number>();
function updateVisibleHeight(): void {
  visibleHeight.value = window.visualViewport?.height ?? window.innerHeight;
}
onMounted(() => {
  updateVisibleHeight();
  window.addEventListener('resize', updateVisibleHeight);
  window.visualViewport?.addEventListener('resize', updateVisibleHeight);
});
onUnmounted(() => {
  window.removeEventListener('resize', updateVisibleHeight);
  window.visualViewport?.removeEventListener('resize', updateVisibleHeight);
});

const sidebarMedia = globalThis.matchMedia?.('(max-width: 900px)');
const sidebarCollapsed = ref(sidebarMedia?.matches ?? false);
function collapseSidebarOnNarrowViewport(event: MediaQueryListEvent): void {
  if (event.matches) sidebarCollapsed.value = true;
}
onMounted(() => sidebarMedia?.addEventListener('change', collapseSidebarOnNarrowViewport));
onUnmounted(() => sidebarMedia?.removeEventListener('change', collapseSidebarOnNarrowViewport));
async function submitSignOut(): Promise<void> {
  clearAgentCockpitCache();
  await signOut();
}
const gpu = computed(() => (system.value?.gpu.available ? system.value.gpu.values : undefined));
const gpuHint = computed(() => {
  const section = system.value?.gpu;
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
const chartGroups = computed(() => {
  return [
    { key: 'tokens', title: t('chart.tokens'), percent: false },
    { key: 'gpu', title: t('chart.gpu'), percent: true },
    { key: 'host', title: t('chart.host'), percent: true },
    { key: 'cache', title: t('chart.cache'), percent: true },
  ].map((group) => ({
    ...group,
    series: charts.value.filter((s) => s.group === group.key),
    error: charts.value.find((s) => s.group === group.key && s.error)?.error,
  }));
});
const prefixHint = computed(() => {
  const prefix = telemetry.value?.prefixCache;
  return !prefix
    ? t('prefix.notReported')
    : prefix.queriedTokens === 0
      ? t('prefix.none')
      : t('prefix.hint', {
          hits: formatInteger(prefix.hitTokens),
          queries: formatInteger(prefix.queriedTokens),
        });
});
const mtpHint = computed(() => {
  const mtp = telemetry.value?.mtp;
  return !mtp
    ? t('mtp.notReported')
    : mtp.draftTokens === 0
      ? t('mtp.none')
      : t('mtp.hint', {
          accepted: formatInteger(mtp.acceptedTokens),
          draft: formatInteger(mtp.draftTokens),
        });
});
</script>

<template>
  <main
    class="stage"
    :style="
      taskFocused && visibleHeight ? { '--conversation-height': `${visibleHeight}px` } : undefined
    "
    :class="{
      'login-stage': !enabled,
      'app-stage': enabled,
      'sidebar-collapsed': enabled && sidebarCollapsed,
      'conversation-stage': enabled && taskFocused,
      'studio-stage': enabled && ['studio', 'gallery'].includes(appRoute.page),
    }"
  >
    <AppSidebar
      v-if="enabled"
      :page="appRoute.page"
      :collapsed="sidebarCollapsed"
      :connection="connection"
      :sync="sync"
      :login-required="loginRequired"
      :signing-out="signingOut"
      @toggle="sidebarCollapsed = !sidebarCollapsed"
      @sign-out="submitSignOut"
    />
    <div class="stage-content">
      <header v-if="auth === 'checking'" class="masthead">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">B70</div>
          <div>
            <h1>B70 Observatory</h1>
          </div>
        </div>
      </header>

      <section v-if="auth === 'checking'" class="panel state" aria-busy="true">
        <h2>{{ t('app.checking') }}</h2>
      </section>
      <LoginScreen v-else-if="!enabled" :auth="auth" :error="authError" @submit="signIn" />

      <template v-else>
        <WorkbenchBreadcrumb v-if="appRoute.page !== 'gallery'" />
        <ComfyDesk v-if="appRoute.page === 'studio' || appRoute.page === 'gallery'" />
        <WorkspaceHome v-else-if="appRoute.page === 'overview'" />
        <MemoryPanel v-else-if="appRoute.page === 'memory'" />
        <SettingsPage v-else-if="appRoute.page === 'settings'" />
        <template v-else-if="appRoute.page === 'hardware'">
          <EngineMetricsPanel>
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
          </EngineMetricsPanel>
          <section
            v-if="status.tone !== 'ok' && engineMode.mode === 'text'"
            class="status-bar"
            :class="status.tone"
            :aria-label="t('app.statusAria')"
            role="status"
          >
            <span class="status-dot" aria-hidden="true"></span>
            <div>
              <h2 class="beacon-status">{{ status.title }}</h2>
              <p>{{ status.detail }}</p>
            </div>
            <button
              v-if="connection !== 'connected' && sync === 'none'"
              class="quiet-button retry"
              type="button"
              @click="startLive"
            >
              {{ t('app.retryNow') }}
            </button>
          </section>

          <div class="overview-heading computer-history-range">
            <RangePicker v-model="rangeIndex" />
          </div>
          <div class="chart-grid computer-charts">
            <TimeChart
              v-for="chart in chartGroups.slice(0, 3)"
              :key="chart.key"
              :title="chart.title"
              :series="chart.series"
              :from="from"
              :to="end"
              :percent="chart.percent"
              :loading="loading"
              :error="chart.error"
              group="observatory-overview"
              @retry="metrics.refresh"
            />
          </div>
          <CollapsibleSection v-model:open="engineOpen" :title="t('workbench.engine')">
            <section class="kpi-grid secondary-kpis">
              <TelemetryCard
                :title="t('kpi.activeRequests')"
                :value="formatInteger(telemetry?.requests?.running)"
                :hint="t('kpi.inQueue', { count: formatInteger(telemetry?.requests?.waiting) })"
                :stale="!telemetryCurrent"
              />
              <TelemetryCard
                :title="t('kpi.firstToken')"
                :value="formatFixed(telemetry?.latency?.ttftAvgMs, 0)"
                unit="ms"
                :hint="t('kpi.ttftHint')"
                :stale="!telemetryCurrent"
              />
              <TelemetryCard
                title="KV-Cache"
                :value="formatFixed(telemetry?.kvCacheUsagePercent)"
                unit="%"
                :meter="telemetry?.kvCacheUsagePercent"
                :stale="!telemetryCurrent"
              />
            </section>
            <RequestList
              :enabled="enabled"
              :minutes="minutes"
              :revision="requestRevision"
              @error="obs.handleDataError"
            />
          </CollapsibleSection>
          <CollapsibleSection
            v-model:open="cacheOpen"
            class="detail-section"
            :title="t('app.cacheSection')"
            :note="t('app.cacheNote')"
          >
            <template #default>
              <div class="kpi-grid secondary-kpis">
                <TelemetryCard
                  :title="t('kpi.prefixHits')"
                  :value="formatPercent(telemetry?.prefixCache?.hitRate)"
                  :hint="prefixHint"
                  :stale="!telemetryCurrent"
                />
                <TelemetryCard
                  :title="t('kpi.mtpAcceptance')"
                  :value="formatPercent(telemetry?.mtp?.acceptanceRate)"
                  :hint="mtpHint"
                  :stale="!telemetryCurrent"
                />
                <TelemetryCard
                  :title="t('kpi.finishedRequests')"
                  :value="formatInteger(telemetry?.requestsFinished?.total)"
                  :hint="
                    t('kpi.avgDuration', {
                      duration: formatMsAsSeconds(telemetry?.latency?.e2eAvgMs),
                    })
                  "
                  :stale="!telemetryCurrent"
                />
              </div>
              <TimeChart
                v-if="cacheOpen && chartGroups[3]"
                :title="chartGroups[3].title"
                :series="chartGroups[3].series"
                :from="from"
                :to="end"
                percent
                :loading="loading"
                :error="chartGroups[3].error"
                @retry="metrics.refresh"
              />
            </template>
          </CollapsibleSection>
          <CollapsibleSection
            v-model:open="systemOpen"
            class="detail-section"
            :title="t('app.systemSection')"
          >
            <template #default>
              <div class="diagnostics-grid">
                <section>
                  <h3>{{ t('app.services') }}</h3>
                  <p v-if="connection !== 'connected'" class="section-caption">
                    {{ t('app.lastKnown') }}
                  </p>
                  <ul class="check-list">
                    <CheckRow
                      v-for="check in health?.checks ?? []"
                      :key="check.name"
                      :check="check"
                    />
                  </ul>
                </section>
                <section>
                  <h3>{{ t('app.host') }}</h3>
                  <dl class="host-facts">
                    <div>
                      <dt>{{ t('app.disk') }}</dt>
                      <dd>
                        {{ formatBytes(system?.disk?.usedBytes) }} /
                        {{ formatBytes(system?.disk?.totalBytes) }}
                      </dd>
                    </div>
                    <div>
                      <dt>{{ t('app.mountPoint') }}</dt>
                      <dd>{{ system?.disk?.path ?? '–' }}</dd>
                    </div>
                    <div>
                      <dt>{{ t('app.processes') }}</dt>
                      <dd>
                        {{
                          t('app.processesDetail', {
                            total: formatInteger(system?.process?.count),
                            active: formatInteger(system?.process?.running),
                          })
                        }}
                      </dd>
                    </div>
                    <div>
                      <dt>Observatory-RAM</dt>
                      <dd>{{ formatBytes(system?.process?.observatoryRssBytes) }}</dd>
                    </div>
                  </dl>
                </section>
              </div>
            </template>
          </CollapsibleSection>
          <AppFooter :version="health?.version ?? '–'" :uptime="formatUptime(uptime)" />
        </template>
        <template v-else-if="appRoute.page === 'agent'">
          <AgentCockpit />
          <AppFooter
            v-if="!taskFocused"
            scope="Agent Cockpit"
            :version="health?.version ?? '–'"
            :uptime="formatUptime(uptime)"
          />
        </template>
        <template v-else>
          <AgentProjectBrowser />
          <AppFooter
            scope="Agent Cockpit"
            :version="health?.version ?? '–'"
            :uptime="formatUptime(uptime)"
          />
        </template>
      </template>
    </div>
  </main>
  <NotificationHost />
</template>
