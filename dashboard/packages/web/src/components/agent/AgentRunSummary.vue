<script setup lang="ts">
import type { AgentRunSnapshot } from '@observatory/contracts';
import { t } from '../../lib/i18n.js';

/**
 * Quiet compact header of the selected task. The status is derived from the
 * selected durable task (see taskStatusView) — never from an unrelated global
 * run — and is paired with the relevant next action.
 */
defineProps<{
  snapshot: AgentRunSnapshot | undefined;
  /** Task-derived status, e.g. "Working", "Needs your answer", "For review". */
  status: string;
  /** Relevant next action for the current task state, if any. */
  action?: string;
  /** Durable run status for the bar's accent color. */
  runStatus?: string;
  runtime: string;
  /** Canonical task title (durable). Falls back to the snapshot's run name. */
  title?: string;
  backHref?: string;
  backLabel?: string;
}>();
defineEmits<{ back: [] }>();
</script>

<template>
  <div class="task-context" :class="runStatus">
    <a
      v-if="backHref"
      class="task-back-button task-map-return"
      :href="backHref"
      :title="t('map.taskOnMap')"
      >← {{ backLabel ?? t('map.backMap') }}</a
    >
    <button v-else class="task-back-button" type="button" @click="$emit('back')">
      ← {{ t('agent.backToTasks') }}
    </button>
    <span class="task-context-title" :title="title ?? snapshot?.name">{{
      title ?? snapshot?.name ?? t('agent.noTask')
    }}</span>
    <span class="run-status-chip" role="status" :title="action">{{ status }}</span>
  </div>
</template>

<style scoped>
.task-map-return {
  display: inline-flex;
  align-items: center;
  min-height: 40px;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--ok);
  text-decoration: none;
  overflow-wrap: anywhere;
  max-width: 100%;
}
</style>
