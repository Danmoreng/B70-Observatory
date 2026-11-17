import type { MemoryResponse } from '@observatory/contracts';
import type { AgentTaskStore } from '../runner/task-store.js';
import type { MemoryPolicy, MemoryStore } from './store.js';
/** Resolves only stored run references; never opens arbitrary paths or URLs from a memory. */
export function memoryEvidence(
  memory: MemoryStore,
  tasks: AgentTaskStore,
  id: string,
  policy: MemoryPolicy
): NonNullable<MemoryResponse['evidence']> {
  const item = memory.get(id, policy);
  return item.sources.map((source) => {
    const match =
      source.kind === 'run' || source.kind === 'check'
        ? /^([a-f0-9-]{36})(?::([a-f0-9-]{36}):([0-9]+))?$/.exec(source.ref)
        : null;
    if (!match || policy.sharedOnly) return { ...source };
    const row = tasks.database
      .prepare(
        'SELECT r.task_id,r.latest_snapshot_json,t.project_id FROM agent_runs r JOIN agent_tasks t ON t.id=r.task_id WHERE r.id=?'
      )
      .get(match[1]!) as
      { task_id: string; project_id: string; latest_snapshot_json: string | null } | undefined;
    if (!row || (!policy.owner && row.project_id !== policy.projectId)) return { ...source };
    if (source.kind === 'check') {
      const result = tasks.database
        .prepare('SELECT checks_json FROM agent_run_results WHERE run_id=?')
        .get(match[1]!) as { checks_json: string } | undefined;
      return {
        ...source,
        taskId: row.task_id,
        runId: match[1],
        text: result?.checks_json.slice(0, 12000),
      };
    }
    const snapshot = JSON.parse(row.latest_snapshot_json ?? 'null') as {
      timeline?: Array<{
        id: string;
        kind: string;
        title: string;
        text?: string;
        argumentsText?: string;
        outputText?: string;
      }>;
    } | null;
    const event = match[2] ? snapshot?.timeline?.find((event) => event.id === match[2]) : undefined;
    const text = event
      ? [event.text, event.argumentsText, event.outputText].filter(Boolean).join('\n')
      : undefined;
    const offset = Number(match[3] ?? 0);
    return {
      ...source,
      taskId: row.task_id,
      runId: match[1],
      text:
        text === undefined
          ? undefined
          : event!.kind +
            ' · ' +
            event!.title +
            '\n' +
            text.slice(Math.min(offset, text.length), Math.min(offset, text.length) + 12000),
    };
  });
}
