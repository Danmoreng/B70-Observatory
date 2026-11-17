import { reactive, ref } from 'vue';
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

export const pendingNewTask = ref<{ projectId?: string }>();
