<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { AgentTimelineItem } from '@observatory/contracts';
import { agentImageUrl, collectAgentRunTrace } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { useNotification } from '../../composables/useNotifications.js';
import { formatClock } from '../../lib/format.js';
const props = defineProps<{ runId?: string; items: AgentTimelineItem[] }>();
const selectedId = ref<string>();
const storedItems = ref<AgentTimelineItem[]>([]);
const historyError = ref('');
useNotification(historyError, 'screenshot-history-' + props.runId);
let generation = 0;
const mergeScreens = (target: Map<string, AgentTimelineItem>, items: AgentTimelineItem[]) => {
  for (const item of items)
    if (
      (item.toolName?.startsWith('browser_') || item.toolName?.startsWith('desktop_')) &&
      item.images?.some((image) => image.runId === props.runId)
    )
      target.set(item.id, item);
};
watch(
  () => props.runId,
  async (runId) => {
    const request = ++generation;
    storedItems.value = [];
    historyError.value = '';
    selectedId.value = undefined;
    if (!runId) return;
    try {
      const events = await collectAgentRunTrace(runId, { failOnStalledCursor: true });
      if (request !== generation) return;
      const byId = new Map<string, AgentTimelineItem>();
      for (const entry of events) {
        const event = entry.event;
        if (event.operation === 'reset') mergeScreens(byId, event.snapshot.timeline);
        else if (event.operation === 'append' || event.operation === 'replace')
          mergeScreens(byId, [event.item]);
      }
      mergeScreens(byId, storedItems.value);
      mergeScreens(byId, props.items);
      storedItems.value = [...byId.values()];
    } catch {
      if (request === generation) historyError.value = t('agent.historyLoadFailed');
    }
  },
  { immediate: true }
);
watch(
  () => props.items,
  (items) => {
    const byId = new Map(storedItems.value.map((item) => [item.id, item]));
    mergeScreens(byId, items);
    storedItems.value = [...byId.values()];
  },
  { immediate: true, deep: true }
);
onBeforeUnmount(() => {
  generation++;
});
// Only persisted tool screenshots: no independent capture, refresh timer or generated images.
const screenshots = computed(() => {
  const seen = new Set<string>();
  return [...storedItems.value]
    .sort((a, b) => a.at.localeCompare(b.at))
    .flatMap((item) => {
      if (!item.toolName?.startsWith('desktop_') && !item.toolName?.startsWith('browser_'))
        return [];
      return (item.images ?? [])
        .filter((image) => image.runId === props.runId && !seen.has(image.id) && seen.add(image.id))
        .map((image) => ({ image, at: item.at }));
    });
});
const selected = computed(
  () =>
    screenshots.value.find((entry) => entry.image.id === selectedId.value) ??
    screenshots.value.at(-1)
);
const imageUrl = computed(() =>
  selected.value ? agentImageUrl(selected.value.image.runId, selected.value.image.id) : ''
);
watch(
  () => props.runId,
  () => {
    selectedId.value = undefined;
  }
);
</script>
<template>
  <section class="desktop-panel" :aria-label="t('desktop.title')">
    <div class="desktop-screen">
      <a
        v-if="imageUrl"
        :href="imageUrl"
        target="_blank"
        rel="noopener"
        :aria-label="t('desktop.open')"
        ><img :src="imageUrl" :alt="t('desktop.image')"
      /></a>
      <p v-else>{{ t('desktop.empty') }}</p>
      <time v-if="selected" class="desktop-image-time" :datetime="selected.at">{{
        formatClock(selected.at)
      }}</time>
    </div>
    <nav
      v-if="screenshots.length > 1"
      class="screenshot-history"
      :aria-label="t('desktop.history')"
    >
      <button
        class="screenshot-follow"
        :aria-pressed="selectedId === undefined"
        :title="t('desktop.latest')"
        :aria-label="t('desktop.latest')"
        @click="selectedId = undefined"
      >
        ↪
      </button>
      <div class="screenshot-filmstrip">
        <button
          v-for="(entry, index) in screenshots"
          :key="entry.image.id"
          :aria-pressed="selected?.image.id === entry.image.id"
          :aria-label="t('desktop.select', { number: index + 1, time: formatClock(entry.at) })"
          @click="selectedId = entry.image.id"
        >
          <img loading="lazy" :src="agentImageUrl(entry.image.runId, entry.image.id)" alt="" /><time
            :datetime="entry.at"
            >{{ formatClock(entry.at) }}</time
          >
        </button>
      </div>
    </nav>
  </section>
</template>
<style scoped>
.desktop-panel {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.desktop-screen {
  position: relative;
  inset: auto;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.desktop-screen a {
  position: absolute;
  inset: 0;
}
.screenshot-history {
  display: flex;
  flex: none;
  height: 76px;
  gap: 4px;
  min-width: 0;
}
.screenshot-filmstrip {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  overflow-y: hidden;
  min-width: 0;
  flex: 1;
}
.screenshot-history button {
  flex: none;
  min-width: 44px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--panel);
  color: var(--dim);
}
.screenshot-history button[aria-pressed='true'] {
  border-color: var(--accent);
  background: var(--raised);
}
.screenshot-filmstrip button {
  width: 92px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: center;
}
.screenshot-filmstrip img {
  position: static;
  width: 84px;
  height: 45px;
  object-fit: scale-down;
}
.screenshot-filmstrip time {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.screenshot-follow {
  align-self: stretch;
  font-size: 20px;
}
</style>
