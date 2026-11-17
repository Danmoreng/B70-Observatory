<script setup lang="ts">
import { computed } from 'vue';
import ProjectCard from './ProjectCard.vue';
import { useAgentCockpit } from '../composables/useAgentCockpit.js';
import { navigateTo } from '../composables/useAppRoute.js';
import { taskStatusLabel } from '../lib/labels.js';
import { t } from '../lib/i18n.js';
const cockpit = useAgentCockpit();
const running = computed(() =>
  cockpit.tasks.value.items.filter((task) =>
    ['queued', 'starting', 'running'].includes(task.latestRun.status)
  )
);
const sections = computed(() =>
  [
    { key: 'workspace.running' as const, items: running.value },
    {
      key: 'workspace.questions' as const,
      items: cockpit.tasks.value.items.filter(
        (task) =>
          task.status === 'open' &&
          (['question', 'waiting'].includes(task.attention ?? '') ||
            (task.attention === undefined && task.latestRun.status === 'yielded'))
      ),
    },
    {
      key: 'workspace.errors' as const,
      items: cockpit.tasks.value.items.filter(
        (task) =>
          task.status === 'open' &&
          (task.attention === 'error' ||
            (task.attention === undefined &&
              ['failed', 'interrupted'].includes(task.latestRun.status)))
      ),
    },
    {
      key: 'workspace.reviews' as const,
      items: cockpit.tasks.value.items.filter(
        (task) =>
          task.status === 'open' &&
          (task.attention === 'review' ||
            (task.attention === undefined && task.latestRun.status === 'completed'))
      ),
    },
  ].filter((section) => section.items.length)
);
function projectStats(id: string) {
  const items = cockpit.tasks.value.items.filter((task) => task.projectId === id);
  return {
    count: items.length,
    active: items.filter((task) =>
      ['queued', 'starting', 'running'].includes(task.latestRun.status)
    ).length,
    updatedAt: items.reduce(
      (at, task) => (task.updatedAt > at ? task.updatedAt : at),
      cockpit.projects.value.find((project) => project.id === id)?.updatedAt ?? ''
    ),
  };
}
const recentProjects = computed(() =>
  cockpit.projects.value
    .filter((project) => !project.archived)
    .sort((a, b) => {
      const activity = (id: string, fallback: string) =>
        cockpit.tasks.value.items
          .filter((task) => task.projectId === id)
          .reduce((latest, task) => (task.updatedAt > latest ? task.updatedAt : latest), fallback);
      return activity(b.id, b.updatedAt).localeCompare(activity(a.id, a.updatedAt));
    })
    .slice(0, 6)
);
</script>
<template>
  <section class="workspace-home">
    <p v-if="cockpit.error.value" class="inline-error" role="status">{{ cockpit.error.value }}</p>
    <p v-if="!sections.length" class="section-caption">{{ t('workbench.noInbox') }}</p>
    <section v-for="section in sections" :key="section.key" class="workspace-inbox">
      <h2 class="workbench-section-title">
        {{ t(section.key) }}
        <span>{{ section.items.length }}</span>
      </h2>
      <button
        v-for="task in section.items"
        :key="task.id"
        class="workspace-task-row"
        :aria-label="`${task.title} (${task.projectName}) – ${t('projects.open')}`"
        @click="navigateTo('agent', task.id)"
      >
        <span class="workbench-monogram" aria-hidden="true">{{
          task.projectName.slice(0, 2)
        }}</span>
        <span class="workbench-row-title"
          ><strong>{{ task.title }}</strong
          ><small>{{ task.projectName }}</small></span
        >
        <span class="workbench-status" :class="task.latestRun.status">{{
          taskStatusLabel(task.latestRun.status)
        }}</span
        ><span aria-hidden="true">›</span>
      </button>
    </section>
    <div class="workbench-section-title">
      <h2>{{ t('projects.title') }}</h2>
      <a href="#/projects" :aria-label="t('projects.open')">→</a>
    </div>
    <div class="shared-project-grid">
      <ProjectCard
        v-for="project in recentProjects"
        :key="project.id"
        :id="project.id"
        :name="project.name"
        :project="project"
        v-bind="projectStats(project.id)"
      />
    </div>
    <footer class="workspace-home-links">
      <button class="text-button" @click="navigateTo('hardware')">
        {{ t('sidebar.hardware') }} →
      </button>
    </footer>
  </section>
</template>
