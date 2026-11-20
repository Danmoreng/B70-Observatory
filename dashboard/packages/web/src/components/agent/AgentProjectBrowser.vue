<script setup lang="ts">
import { computed, ref, watch, watchEffect } from 'vue';
import { requestNewTask, workbenchContext } from '../../composables/useWorkbenchContext.js';
import { engineMode } from '../../composables/useEngineMode.js';
import ProjectCard from '../ProjectCard.vue';
import AgentArchitectureMap from './AgentArchitectureMap.vue';
import type { AgentProject, DurableTaskSummary } from '@observatory/contracts';
import { useAgentCockpit } from '../../composables/useAgentCockpit.js';
import { useProjectPins } from '../../composables/useProjectPins.js';
import { useAppRoute } from '../../composables/useAppRoute.js';
import { formatShortDateTime } from '../../lib/format.js';
import { taskStatusLabel } from '../../lib/labels.js';
import { t } from '../../lib/i18n.js';

const cockpit = useAgentCockpit();
const { projects, projectsLoading, tasks } = cockpit;
const { appRoute, navigateTo } = useAppRoute();
const { isPinned, togglePin, persistenceFailed } = useProjectPins();
const query = ref('');
const pinnedOnly = ref(false);
const showArchived = ref(false);
const sortBy = ref('activity');
const taskFilter = ref('all');
const projectView = ref<'tasks' | 'map'>(appRoute.nodeId ? 'map' : 'tasks');
watch(
  () => [appRoute.projectId, appRoute.nodeId],
  () => {
    projectView.value = appRoute.nodeId ? 'map' : 'tasks';
  }
);

interface ProjectGroup {
  id: string;
  name: string;
  project: AgentProject | undefined;
  items: DurableTaskSummary[];
  activeCount: number;
  latestActivity: string;
}

const ACTIVE_STATUSES = ['queued', 'starting', 'running'];

// The registry order is canonical; tasks of projects that are no longer
// registered (or predate the registry) are grouped under their stored name
// and appended afterwards, so nothing silently disappears.
const projectGroups = computed<ProjectGroup[]>(() => {
  const byId = new Map<string, DurableTaskSummary[]>();
  for (const item of tasks.value.items) {
    const list = byId.get(item.projectId) ?? [];
    list.push(item);
    byId.set(item.projectId, list);
  }
  const seen = new Set<string>();
  const groups: ProjectGroup[] = [];
  const collect = (id: string, name: string, project: AgentProject | undefined) => {
    if (seen.has(id)) return;
    seen.add(id);
    const items = (byId.get(id) ?? [])
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    groups.push({
      id,
      name,
      project,
      items,
      activeCount: items.filter((item) => ACTIVE_STATUSES.includes(item.latestRun.status)).length,
      latestActivity: items[0]?.updatedAt ?? project?.updatedAt ?? '1970-01-01T00:00:00.000Z',
    });
  };
  for (const project of projects.value) collect(project.id, project.name, project);
  const orphans = [...byId.keys()]
    .filter((id) => !seen.has(id))
    .sort((a, b) => {
      const nameA = byId.get(a)?.[0]?.projectName ?? a;
      const nameB = byId.get(b)?.[0]?.projectName ?? b;
      return nameA.localeCompare(nameB);
    });
  for (const id of orphans) {
    const items = byId.get(id) ?? [];
    collect(id, items[0]?.projectName ?? t('projects.unknownProject'), undefined);
  }
  return groups;
});

const filteredGroups = computed(() =>
  projectGroups.value
    .filter(
      (group) =>
        (showArchived.value || !group.project?.archived) &&
        (!pinnedOnly.value || isPinned(group.id)) &&
        `${group.name} ${group.project?.targetBranch ?? ''}`
          .toLocaleLowerCase()
          .includes(query.value.toLocaleLowerCase())
    )
    .sort((a, b) =>
      sortBy.value === 'name'
        ? a.name.localeCompare(b.name)
        : sortBy.value === 'tasks'
          ? b.items.length - a.items.length
          : b.latestActivity.localeCompare(a.latestActivity)
    )
);

const selectedGroup = computed(() =>
  appRoute.page === 'projects'
    ? (projectGroups.value.find((group) => group.id === appRoute.projectId) ?? undefined)
    : undefined
);

const visibleTasks = computed(
  () =>
    selectedGroup.value?.items.filter(
      (task) =>
        taskFilter.value === 'all' ||
        (taskFilter.value === 'active'
          ? ACTIVE_STATUSES.includes(task.latestRun.status)
          : !ACTIVE_STATUSES.includes(task.latestRun.status))
    ) ?? []
);
watch(
  () => appRoute.projectId,
  () => {
    taskFilter.value = 'all';
  }
);
watchEffect(() => {
  if (selectedGroup.value)
    Object.assign(workbenchContext, {
      projectId: selectedGroup.value.id,
      projectName: selectedGroup.value.name,
      taskId: '',
      taskTitle: '',
    });
});
</script>
<template>
  <section class="project-browser" :aria-label="t('projects.title')">
    <p v-if="cockpit.error.value" class="inline-error" role="status">{{ cockpit.error.value }}</p>
    <div v-if="appRoute.projectId && !selectedGroup" class="task-note" role="status">
      <p>{{ projectsLoading ? t('projects.loading') : t('projects.notFound') }}</p>
      <button class="task-back-button" @click="navigateTo('projects')">
        ← {{ t('projects.back') }}
      </button>
    </div>
    <template v-else-if="!selectedGroup">
      <div class="project-list-controls">
        <label
          ><span class="sr-only">{{ t('projects.search') }}</span
          ><input v-model="query" type="search" :placeholder="t('projects.searchPlaceholder')"
        /></label>
        <label class="project-pinned-filter"
          ><input v-model="pinnedOnly" type="checkbox" />{{ t('projects.pinnedOnly') }}</label
        >
        <label class="project-archived-filter"
          ><input v-model="showArchived" type="checkbox" />{{ t('projects.showArchived') }}</label
        >
        <select v-model="sortBy" :aria-label="t('workbench.sort')">
          <option value="activity">{{ t('workbench.activitySort') }}</option>
          <option value="name">{{ t('workbench.nameSort') }}</option>
          <option value="tasks">{{ t('workbench.taskSort') }}</option>
        </select>
      </div>
      <p v-if="persistenceFailed" role="status">{{ t('pins.unsaved') }}</p>
      <div class="workbench-main">
        <div class="shared-project-grid">
          <ProjectCard
            v-for="group in filteredGroups"
            :key="group.id"
            :id="group.id"
            :name="group.name"
            :project="group.project"
            :count="group.items.length"
            :active="group.activeCount"
            :updated-at="group.latestActivity"
          />
        </div>
        <p v-if="projectGroups.length && !filteredGroups.length" class="task-list-empty">
          {{ t('projects.noMatches') }}
        </p>
        <p v-if="projectsLoading" class="task-list-empty" role="status">
          {{ t('projects.loading') }}
        </p>
        <p v-else-if="!projectGroups.length" class="task-list-empty">{{ t('projects.empty') }}</p>
      </div>
    </template>
    <template v-else>
      <div class="project-detail-heading">
        <button
          v-if="selectedGroup.project && !selectedGroup.project.archived"
          class="primary-button"
          type="button"
          :disabled="!engineMode.agentsAllowed"
          @click="requestNewTask(selectedGroup.project)"
        >
          ＋ {{ t('agent.newTask') }}
        </button>
        <button
          class="quiet-button"
          :aria-pressed="isPinned(selectedGroup.id)"
          @click="togglePin({ id: selectedGroup.id, name: selectedGroup.name })"
        >
          {{ t(isPinned(selectedGroup.id) ? 'pins.unpin' : 'pins.pin') }}
        </button>
        <span class="project-detail-meta"
          >{{ selectedGroup.project?.archived ? t('projects.archived') + ' · ' : ''
          }}{{ selectedGroup.project?.targetBranch }} ·
          {{ selectedGroup.project?.repositoryPath }}</span
        >
      </div>
      <nav class="task-view-tabs project-view-tabs" role="tablist" :aria-label="selectedGroup.name">
        <button
          role="tab"
          :aria-selected="projectView === 'tasks'"
          :class="{ active: projectView === 'tasks' }"
          @click="projectView = 'tasks'"
        >
          {{ t('map.allTasks') }} · {{ selectedGroup.items.length }}</button
        ><button
          v-if="selectedGroup.project"
          role="tab"
          :aria-selected="projectView === 'map'"
          :class="{ active: projectView === 'map' }"
          @click="projectView = 'map'"
        >
          {{ t('map.title') }}
        </button>
      </nav>
      <AgentArchitectureMap
        v-if="selectedGroup.project && projectView === 'map'"
        :key="selectedGroup.id"
        :project="selectedGroup.project"
        :tasks="selectedGroup.items"
        :cockpit="cockpit"
      />
      <div v-else class="workbench-project-detail">
        <div v-if="selectedGroup.items.length" class="workbench-filter">
          <button
            v-for="filter in ['all', 'active', 'other'] as const"
            :key="filter"
            class="quiet-button"
            :aria-pressed="taskFilter === filter"
            @click="taskFilter = filter"
          >
            {{
              t(
                filter === 'all'
                  ? 'workbench.all'
                  : filter === 'active'
                    ? 'workspace.running'
                    : 'projects.inactiveTasks'
              )
            }}
          </button>
        </div>
        <div v-if="visibleTasks.length" class="task-table">
          <button
            v-for="item in visibleTasks"
            :key="item.id"
            class="task-table-row"
            :aria-label="`${item.title} – ${t('projects.open')}`"
            @click="navigateTo('agent', item.id)"
          >
            <span class="task-table-title">{{ item.title }}</span
            ><span class="task-table-status" :class="item.latestRun.status">{{
              taskStatusLabel(item.latestRun.status)
            }}</span
            ><time :datetime="item.updatedAt">{{ formatShortDateTime(item.updatedAt) }}</time
            ><span aria-hidden="true">›</span>
          </button>
        </div>
        <p v-else class="task-list-empty" role="status">
          {{ t(selectedGroup.items.length ? 'projects.noMatchingTasks' : 'projects.noTasks') }}
        </p>
      </div>
    </template>
  </section>
</template>
