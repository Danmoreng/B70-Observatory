<script setup lang="ts">
import { computed, ref } from 'vue';
import type { DurableTaskSummary } from '@observatory/contracts';
import { formatShortDateTime } from '../../lib/format.js';
import { taskStatusLabel } from '../../lib/labels.js';
import { t } from '../../lib/i18n.js';

const props = defineProps<{
  items: DurableTaskSummary[];
  loading: boolean;
}>();
const query = ref('');
const project = ref('');
const status = ref('');
const projects = computed(() =>
  [...new Map(props.items.map((item) => [item.projectId, item.projectName])).entries()].sort(
    (a, b) => a[1].localeCompare(b[1])
  )
);
const statuses = computed(() => [...new Set(props.items.map((item) => item.latestRun.status))]);
const filtered = computed(() =>
  props.items.filter(
    (item) =>
      (!project.value || item.projectId === project.value) &&
      (!status.value || item.latestRun.status === status.value) &&
      (item.title + ' ' + item.projectName)
        .toLocaleLowerCase()
        .includes(query.value.toLocaleLowerCase())
  )
);
const emit = defineEmits<{ select: [taskId: string] }>();
</script>

<template>
  <section class="panel task-browser" :aria-label="t('agent.tasks')">
    <div class="task-filter-bar">
      <input
        v-model="query"
        type="search"
        :aria-label="t('tasks.search')"
        :placeholder="t('tasks.search')"
      />
      <select v-model="project" :aria-label="t('tasks.project')">
        <option value="">{{ t('tasks.allProjects') }}</option>
        <option v-for="[id, name] in projects" :key="id" :value="id">{{ name }}</option>
      </select>
      <select v-model="status" :aria-label="t('tasks.status')">
        <option value="">{{ t('tasks.allStatuses') }}</option>
        <option v-for="value in statuses" :key="value" :value="value">
          {{ taskStatusLabel(value) }}
        </option>
      </select>
      <span class="task-filter-count">{{ filtered.length }} / {{ items.length }}</span>
    </div>
    <div v-if="filtered.length" class="task-table" role="list">
      <button
        v-for="item in filtered"
        :key="item.id"
        type="button"
        class="task-table-row"
        role="listitem"
        @click="emit('select', item.id)"
      >
        <span class="task-table-title"
          ><small>{{ item.projectName }}</small
          >{{ item.title }}</span
        >
        <span class="task-table-status" :class="item.latestRun.status">
          {{ taskStatusLabel(item.latestRun.status) }}
        </span>
        <time :datetime="item.updatedAt">{{ formatShortDateTime(item.updatedAt) }}</time>
        <span aria-hidden="true">→</span>
      </button>
    </div>
    <p v-else-if="loading" class="task-list-empty">{{ t('agent.tasksLoading') }}</p>
    <p v-else class="task-list-empty">
      {{ t(items.length ? 'projects.noMatches' : 'agent.noTasks') }}
    </p>
  </section>
</template>

<style scoped>
.task-filter-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding-bottom: 12px;
}
.task-filter-bar input {
  flex: 1;
  min-width: 180px;
}
.task-filter-bar select {
  min-width: 140px;
  max-width: 260px;
}
.task-filter-count {
  font-size: 11px;
  color: var(--dim);
}
.task-table-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 140px 150px 20px;
  align-items: center;
}
.task-table-status {
  text-align: left;
}
.task-table-row time {
  font-variant-numeric: tabular-nums;
  text-align: right;
}
@media (max-width: 650px) {
  .task-table-row {
    grid-template-columns: minmax(0, 1fr) 110px 20px;
  }
  .task-table-row time {
    grid-column: 1;
    grid-row: 2;
    text-align: left;
    font-size: 11px;
  }
  .task-filter-bar select {
    flex: 1;
    min-width: 100px;
    max-width: 100%;
  }
}
</style>
