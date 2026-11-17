<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import type { AppPreview } from '@observatory/contracts';
import { fetchAppPreview, startAppPreview, stopAppPreview } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { useNotification } from '../../composables/useNotifications.js';

const props = withDefaults(
  defineProps<{
    compact?: boolean;
    projectId: string;
    name: string;
    runId?: string;
    revision?: string;
    /** When false, the selected result cannot be started (e.g. the run is still active). */
    canStart?: boolean;
  }>(),
  { compact: false, canStart: true }
);
const app = ref<AppPreview>();
const pendingAction = ref<'start' | 'stop'>();
const busy = computed(() => pendingAction.value !== undefined);
const error = ref('');
useNotification(error, `app-preview-${props.projectId}`);
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const link = computed(() => {
  if (
    app.value?.status !== 'running' ||
    app.value.port === undefined ||
    app.value.accessPath === undefined
  )
    return undefined;
  const url = new URL(window.location.href);
  url.protocol = 'http:';
  url.port = String(app.value.port);
  url.pathname = app.value.accessPath;
  url.search = '';
  url.hash = '';
  return url.href;
});
const selectedIsRunning = computed(
  () =>
    props.revision !== undefined &&
    props.revision === app.value?.revision &&
    app.value?.status === 'running'
);
async function refresh(): Promise<void> {
  const current = generation;
  try {
    const value = await fetchAppPreview(props.projectId);
    if (current === generation) {
      app.value = value;
      error.value = '';
    }
  } catch (cause) {
    if (current === generation)
      error.value = cause instanceof Error ? cause.message : t('agent.appFailed');
  } finally {
    if (current === generation && ['running', 'starting'].includes(app.value?.status ?? ''))
      timer = setTimeout(() => void refresh(), 3000);
  }
}
function refreshNow(): void {
  generation++;
  clearTimeout(timer);
  void refresh();
}
async function act(action: 'start' | 'stop'): Promise<void> {
  if (busy.value) return;
  const current = ++generation;
  clearTimeout(timer);
  pendingAction.value = action;
  error.value = '';
  try {
    const value =
      action === 'stop'
        ? await stopAppPreview(props.projectId)
        : await startAppPreview({
            projectId: props.projectId,
            ...(props.runId === undefined || props.revision === undefined
              ? {}
              : { runId: props.runId, revision: props.revision }),
          });
    if (current === generation) app.value = value;
  } catch (cause) {
    if (current === generation)
      error.value = cause instanceof Error ? cause.message : t('agent.appFailed');
    // A failed startup still has a useful runtime log on the server.
    try {
      const value = await fetchAppPreview(props.projectId);
      if (current === generation) app.value = value;
    } catch {
      /* keep the action error */
    }
  } finally {
    if (current === generation) {
      pendingAction.value = undefined;
      if (app.value?.status === 'running') timer = setTimeout(() => void refresh(), 3000);
    }
  }
}
watch(
  () => props.projectId,
  () => {
    generation++;
    clearTimeout(timer);
    app.value = undefined;
    error.value = '';
    pendingAction.value = undefined;
    void refresh();
  },
  { immediate: true }
);
onUnmounted(() => {
  generation++;
  clearTimeout(timer);
});
</script>

<template>
  <section class="panel agent-app-panel" :class="{ compact }">
    <div class="app-status-row">
      <strong v-if="!compact" class="app-name">{{ name }}</strong>
      <p v-if="app" role="status">
        {{ t(`agent.appStatus.${app.status}`)
        }}<span v-if="app.revision"> · {{ app.revision.slice(0, 8) }}</span>
      </p>

      <div class="app-actions">
        <button
          v-if="canStart !== false"
          :class="link ? 'quiet-button' : 'primary-button'"
          type="button"
          :disabled="busy || selectedIsRunning"
          @click="act('start')"
        >
          {{ pendingAction === 'start' ? t('agent.appWorking') : t('agent.appStart') }}
        </button>
        <a
          v-if="link"
          class="primary-button"
          :href="link"
          target="_blank"
          rel="noopener noreferrer"
          >{{ t('agent.appOpen') }}</a
        >
        <button
          v-if="['running', 'starting'].includes(app?.status ?? '')"
          class="text-button"
          type="button"
          :disabled="busy"
          @click="act('stop')"
        >
          {{ pendingAction === 'stop' ? t('agent.appStopping') : t('agent.appStop') }}
        </button>
        <button v-if="!compact" type="button" :disabled="busy" @click="refreshNow">
          {{ t('agent.appRefresh') }}
        </button>
      </div>
    </div>
    <p v-if="revision && app?.status === 'running' && !selectedIsRunning">
      {{ t('agent.appOtherVersion') }}
    </p>
    <template v-if="app?.logs && !compact">
      <h4>{{ t('agent.appLogs') }}</h4>
      <pre>{{ app.logs }}</pre>
    </template>
  </section>
</template>

<style scoped>
.agent-app-panel {
  margin-block: 0;
  min-width: 0;
}
.agent-app-panel.compact {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 0;
  padding: 0 8px;
  background: transparent;
  border: 0;
}
.compact p {
  margin: 0;
  font-size: 11px;
  color: var(--dim);
}
.app-status-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.app-status-row > p {
  font-size: 12px;
  color: var(--dim);
  margin: 0;
}
.app-name {
  font-size: 13px;
}
.app-status-row > .app-actions {
  margin-left: auto;
}
.compact .app-actions {
  gap: 8px;
}
.compact .primary-button {
  background: transparent;
  border-color: transparent;
  font-size: 12px;
  padding: 4px 8px;
}
.app-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: center;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 0.8rem;
}
a {
  text-decoration: none;
}
</style>
