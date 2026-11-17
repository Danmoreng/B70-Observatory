<script setup lang="ts">
import type { AgentProject } from '@observatory/contracts';
import { navigateTo } from '../composables/useAppRoute.js';
import { pendingNewTask } from '../composables/useWorkbenchContext.js';
import { useProjectPins } from '../composables/useProjectPins.js';
import { formatShortDateTime } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import AppIcon from './AppIcon.vue';
const props = defineProps<{
  id: string;
  name: string;
  project?: AgentProject;
  count: number;
  active: number;
  updatedAt: string;
}>();
const { isPinned, togglePin } = useProjectPins();
function open(event: MouseEvent) {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0)
    return;
  event.preventDefault();
  navigateTo('projects', undefined, props.id);
}
function newTask() {
  pendingNewTask.value = { projectId: props.id };
  navigateTo('agent');
}
</script>
<template>
  <article class="shared-project-card">
    <a
      :href="'#/projects/' + id"
      class="project-card-link"
      @click="open"
      :aria-label="name + ' – ' + t('projects.open')"
    >
      <AppIcon name="folder" /><span
        ><strong>{{ name }}</strong
        ><small v-if="project?.targetBranch">{{ project.targetBranch }}</small></span
      >
    </a>
    <button
      class="project-card-pin"
      :aria-label="t(isPinned(id) ? 'pins.unpin' : 'pins.pin') + ': ' + name"
      :aria-pressed="isPinned(id)"
      @click="togglePin({ id, name })"
    >
      {{ isPinned(id) ? '★' : '☆' }}
    </button>
    <div class="project-card-summary">
      <span
        >{{ t('projects.tasksCount', { count })
        }}<small v-if="active"> · {{ t('projects.activeCount', { count: active }) }}</small></span
      ><time :datetime="updatedAt">{{ formatShortDateTime(updatedAt) }}</time>
    </div>
    <button
      v-if="project && !project.archived"
      class="text-button project-card-create"
      @click="newTask"
    >
      ＋ {{ t('agent.newTask') }}
    </button>
  </article>
</template>
<style scoped>
.shared-project-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 16px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
}
.project-card-link {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--text);
  text-decoration: none;
  padding-right: 30px;
  min-width: 0;
}
.project-card-link > span {
  min-width: 0;
}
.project-card-link strong {
  display: block;
  font-size: 15px;
  overflow-wrap: anywhere;
}
.project-card-link small {
  display: block;
  color: var(--dim);
  font-size: 11px;
  margin-top: 4px;
  overflow-wrap: anywhere;
}
.project-card-link svg {
  flex: none;
  color: var(--accent);
}
.project-card-pin {
  position: absolute;
  right: 8px;
  top: 7px;
  background: transparent;
  border: 0;
  color: var(--dim);
  min-width: 36px;
  min-height: 36px;
}
.project-card-pin[aria-pressed='true'] {
  color: var(--accent);
}
.project-card-summary {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: space-between;
  color: var(--dim);
  font-size: 11px;
}
.project-card-create {
  align-self: flex-start;
  margin-top: auto;
  font-size: 12px;
  min-height: 36px;
}
</style>
