import { createHash } from 'node:crypto';
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';
import { obj, str } from '@earendil-works/pi-schema';
import type { AgentRunSnapshot, StartAgentRunRequest } from '@observatory/contracts';

/** No control token, repository selection or host execution capability enters the model. */
export function taskCreationTools(binding: {
  projectId: string;
  taskId: string;
  create: (request: StartAgentRunRequest) => Promise<AgentRunSnapshot>;
  taskIdForRun: (runId: string) => string;
}): ToolRegistration[] {
  return [
    defineTool({
      name: 'create_task',
      description:
        'Lege eine neue unabhängige Coding-Aufgabe im aktuellen Projekt in die dauerhafte Warteschlange. Nur verwenden, wenn der Nutzer ausdrücklich das Anlegen/Starten neuer Tasks beauftragt hat. Maximal acht Tasks pro Ursprungsaufgabe. Die Tasks starten automatisch bei freiem Agentenplatz, übernehmen keine ungespeicherten Änderungen dieses Laufs und dürfen selbst keine weiteren Tasks erzeugen. Keine automatische Übernahme oder Veröffentlichung. Identischer Titel und Auftrag ergeben bei Wiederholung denselben Task.',
      parameters: obj({
        name: str({ minLength: 1, maxLength: 160 }),
        task: str({ minLength: 1, maxLength: 65536 }),
      }),
      executionMode: 'sequential',
      replay: 'safe',
      async execute(args) {
        const name = args.name.trim();
        const task = args.task.trim();
        if (!name || !task) throw new Error('Name and task must not be empty.');
        const hex = createHash('sha256')
          .update(JSON.stringify([binding.taskId, name, task]))
          .digest('hex');
        const idempotencyKey = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
        const snapshot = await binding.create({
          projectId: binding.projectId,
          name,
          task,
          idempotencyKey,
        });
        if (!snapshot.runId) throw new Error('The queued task has no run ID.');
        const taskId = binding.taskIdForRun(snapshot.runId);
        return {
          output: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                taskId,
                runId: snapshot.runId,
                status: snapshot.status,
                url: `/#/agent/${taskId}`,
              }),
            },
          ],
        };
      },
    }),
  ];
}
