<script setup lang="ts">
import { computed } from 'vue';
import { LIVE_CHANGES_POLL_MS } from '@observatory/contracts';
import { fetchAgentLiveChanges } from '../../lib/api.js';
import { useVisiblePolling } from '../../composables/useVisiblePolling.js';
import { t } from '../../lib/i18n.js';
import { formatShortDateTime } from '../../lib/format.js';
import AgentDiffView from './AgentDiffView.vue';
const props = defineProps<{ taskId: string; runId: string; active: boolean; visible: boolean }>();
let manualRefresh = false;
const { data, error, loading, refresh } = useVisiblePolling({
  key: () => `${props.taskId}/${props.runId}`,
  enabled: () => props.visible,
  repeat: () => props.active,
  intervalMs: LIVE_CHANGES_POLL_MS,
  load: async (signal) => {
    const force = manualRefresh;
    manualRefresh = false;
    const result = await fetchAgentLiveChanges(props.taskId, props.runId, signal, force);
    if (result.taskId !== props.taskId || result.runId !== props.runId)
      throw new Error('Mismatched workspace response');
    return result;
  },
});
function refreshNow() {
  if (loading.value) return;
  manualRefresh = true;
  void refresh();
}
const stale = computed(() => Boolean(error.value || data.value?.stale));
</script>
<template>
  <section class="live-changes-panel" :aria-label="t('liveChanges.title')">
    <header>
      <div>
        <h3>
          {{ t('liveChanges.title') }} <span v-if="data">{{ data.files.length }}</span>
        </h3>
      </div>
      <button class="quiet-button" :disabled="loading" @click="refreshNow">
        {{ t('liveChanges.retry') }}
      </button>
    </header>
    <p class="live-changes-caption">
      {{ t(active ? 'liveChanges.interim' : 'liveChanges.complete') }}
      <span v-if="data">
        · {{ t('liveChanges.updated', { time: formatShortDateTime(data.capturedAt) }) }}
      </span>
    </p>
    <p v-if="stale" class="inline-error" role="status">{{ t('liveChanges.stale') }}</p>
    <p v-if="loading && !data" class="task-note" role="status">{{ t('liveChanges.loading') }}</p>
    <p v-else-if="!data || data.status === 'unavailable'" class="task-note" role="status">
      {{ data?.message || t('liveChanges.unavailable') }}
    </p>
    <template v-if="data && data.status !== 'unavailable'">
      <AgentDiffView
        v-if="data.files.length || data.diff"
        :image-version="data.capturedAt"
        :task-id="taskId"
        :run-id="runId"
        :diff="data.diff"
        :files="data.files.map((file) => file.path)"
        :file-statuses="data.files"
        :truncated="data.truncated"
      />
      <p v-else class="task-note">{{ t('liveChanges.empty') }}</p>
    </template>
  </section>
</template>
<style scoped>
.live-changes-panel {
  min-width: 0;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: 0;
}
.live-changes-panel > header {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
}
.live-changes-panel h3 {
  font-size: 14px;
}
.live-changes-panel h3 span {
  font-size: 11px;
  color: var(--dim);
  margin-left: 8px;
}
.live-changes-caption {
  font-size: 11px;
  color: var(--dim);
  margin: 6px 0;
}
.live-changes-panel .task-note {
  margin-top: 8px;
}
.live-changes-panel :deep(.file-review) {
  margin-top: 8px;
}
.live-changes-panel :deep(.diff-file-list) {
  max-height: 65vh;
}
@media (max-width: 600px) {
  .live-changes-panel {
    padding: 0;
  }
  .live-changes-panel > header {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
