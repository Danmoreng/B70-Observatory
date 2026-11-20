import { reactive, ref } from 'vue';
import type { AgentProject } from '@observatory/contracts';
import { navigateTo } from './useAppRoute.js';
export const workbenchContext = reactive({
  projectId: '',
  projectName: '',
  taskId: '',
  taskTitle: '',
  taskStatus: '',
  taskAction: '',
  taskRunStatus: '',
  taskMapNodeId: '',
  taskMapLabel: '',
});

export type NewTaskProject = Pick<AgentProject, 'id' | 'name'>;
export const pendingNewTask = ref<{ project?: NewTaskProject }>();

export function requestNewTask(project?: NewTaskProject): void {
  pendingNewTask.value = project ? { project: { id: project.id, name: project.name } } : {};
  navigateTo('agent');
}
