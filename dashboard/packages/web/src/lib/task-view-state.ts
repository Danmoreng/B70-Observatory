export interface TaskViewState {
  runId?: string;
  metricsScope: 'task' | 'run';
}
const prefix = 'observatory.task-view.';
export function readTaskView(taskId: string): TaskViewState {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(prefix + taskId) ?? '{}');
    if (value && typeof value === 'object') {
      const v = value as Record<string, unknown>;
      return {
        ...(typeof v.runId === 'string' && /^[a-f0-9-]{36}$/i.test(v.runId)
          ? { runId: v.runId }
          : {}),
        metricsScope: v.metricsScope === 'task' ? 'task' : 'run',
      };
    }
  } catch {
    /* session only */
  }
  return { metricsScope: 'run' };
}
export function writeTaskView(taskId: string, value: TaskViewState) {
  try {
    localStorage.setItem(prefix + taskId, JSON.stringify(value));
  } catch {
    /* session only */
  }
}
