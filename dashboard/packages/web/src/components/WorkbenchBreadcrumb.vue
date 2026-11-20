<script setup lang="ts">
import { engineMode } from '../composables/useEngineMode.js';
import { computed } from 'vue';
import { appRoute, navigateTo } from '../composables/useAppRoute.js';
import { requestNewTask, workbenchContext as context } from '../composables/useWorkbenchContext.js';
import { t } from '../lib/i18n.js';
const label = computed(() =>
  t(
    appRoute.page === 'settings'
      ? 'settings.title'
      : appRoute.page === 'studio'
        ? 'studio.title'
        : appRoute.page === 'gallery'
          ? 'studio.gallery'
          : appRoute.page === 'overview'
            ? 'sidebar.overview'
            : appRoute.page === 'memory'
              ? 'memory.title'
              : appRoute.page === 'hardware'
                ? 'sidebar.hardware'
                : appRoute.page === 'projects'
                  ? 'projects.title'
                  : 'sidebar.tasks'
  )
);
const project = computed(
  () =>
    (appRoute.page === 'projects' && appRoute.projectId === context.projectId) ||
    (appRoute.page === 'agent' && appRoute.taskId === context.taskId)
);
const task = computed(() => appRoute.page === 'agent' && appRoute.taskId !== undefined);
const currentTask = computed(() => task.value && appRoute.taskId === context.taskId);
</script>
<template>
  <header class="workbench-topbar">
    <nav class="workbench-breadcrumb" :aria-label="t('workbench.name')">
      <a href="#/overview">{{ t('workbench.name') }}</a
      ><span aria-hidden="true">›</span>
      <template v-if="task">
        <a
          v-if="currentTask && context.projectName"
          :href="`#/projects/${encodeURIComponent(context.projectId)}`"
          >{{ context.projectName }}</a
        >
        <template v-if="currentTask && context.taskMapNodeId"
          ><span aria-hidden="true">›</span
          ><a
            :href="`#/projects/${encodeURIComponent(context.projectId)}/map/${encodeURIComponent(context.taskMapNodeId)}`"
            >{{ context.taskMapLabel || t('map.title') }}</a
          ></template
        >
        <span v-if="currentTask && context.projectName" aria-hidden="true">›</span>
        <a class="task-back-button" href="#/agent" @click.prevent="navigateTo('agent')">{{
          t('agent.backToTasks')
        }}</a
        ><span aria-hidden="true">›</span>
        <strong class="workbench-task-title" aria-current="page">{{
          currentTask ? context.taskTitle : t('label.loading')
        }}</strong>
        <span
          v-if="currentTask && context.taskStatus"
          class="run-status-chip"
          :class="context.taskRunStatus"
          role="status"
          :title="context.taskAction"
          >{{ context.taskStatus }}</span
        >
      </template>
      <a v-else-if="project && context.projectName" href="#/projects">{{ t('projects.title') }}</a>
      <span v-else aria-current="page">{{ label }}</span>
      <template v-if="!task && project && context.projectName"
        ><span aria-hidden="true">›</span
        ><a
          v-if="appRoute.page === 'agent'"
          :href="`#/projects/${encodeURIComponent(context.projectId)}`"
          >{{ context.projectName }}</a
        ><span v-else aria-current="page">{{ context.projectName }}</span></template
      >
    </nav>
    <button
      v-if="
        engineMode.agentsAllowed &&
        !appRoute.taskId &&
        !['agent', 'settings'].includes(appRoute.page) &&
        !(appRoute.page === 'projects' && appRoute.projectId)
      "
      class="quiet-button"
      type="button"
      @click="requestNewTask()"
    >
      ＋ {{ t('agent.newTask') }}
    </button>
  </header>
</template>
