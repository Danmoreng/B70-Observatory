import {
  defineExtension,
  defineTool,
  configure,
  type ConversationId,
} from '@earendil-works/pi-durable';
import { arr, obj, str } from '@earendil-works/pi-schema';
import { assertMayStartWork } from './working-hours.js';

export interface DurableSubagentObserver {
  attach(id: ConversationId, name: string): Promise<void>;
  finish(id: ConversationId, status: 'completed' | 'failed'): Promise<string>;
}

/** Foreground ownership makes cancellation, idle waits and recovery include every child. */
export function createSubagentTools(observer: DurableSubagentObserver) {
  return defineExtension({
    name: 'b70-subagents',
    tools: [
      defineTool({
        name: 'delegate_tasks',
        description:
          'Delegate one or two independent, bounded tasks to sub-agents in parallel. Assign separate files; all agents share the sandbox/workspace. Returns their reports after both finish. You must integrate and test their work. Children cannot delegate or ask the user. Use for substantial independent work, not trivial steps.',
        parameters: obj({
          tasks: arr(
            obj({
              name: str({ minLength: 1, maxLength: 80, pattern: '^[^\\r\\n]+$' }),
              task: str({ minLength: 1, maxLength: 32768 }),
            }),
            { minItems: 1, maxItems: 2 }
          ),
        }),
        // Reattaches to the same children and deduplicates their submissions.
        replay: 'safe',
        executionMode: 'sequential',
        async execute(args, api, context) {
          const parent = await api.agent(context);
          const childIds = await api.commit(async (tx) => {
            const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 2)).items;
            if (existing.length === args.tasks.length) return existing.map((child) => child.id);
            if (existing.length) throw new Error('Incomplete durable delegation record.');
            assertMayStartWork();
            const children: ConversationId[] = [];
            for (const assignment of args.tasks) {
              const child = await tx.createConversation({
                ownership: { kind: 'task', taskId: api.taskId },
              });
              await configure(tx, child.id, {
                tools: parent.tools.filter(
                  (tool) => !['delegate_tasks', 'ask_user'].includes(tool.name)
                ),
                instructions: `B70_SUBAGENT_NAME: ${assignment.name}\n${parent.instructions ?? ''}\nYou are a sub-agent. Work only on your assigned task in the shared sandbox. Coordinate file ownership through your report. Do not commit, reset, clean, alter AGENTS.md, or change package manifests unless explicitly assigned. Never ask the user; report questions to the main agent. No further delegation. Finish and save before 22:55 Europe/Berlin; no work may run after 23:00. Return a concise report with changes, checks and remaining issues.`,
              });
              children.push(child.id);
            }
            return children;
          }, context);
          await api.details({ conversationIds: childIds }, context);
          const results = await Promise.all(
            childIds.map(async (id, index) => {
              const assignment = args.tasks[index]!;
              await observer.attach(id, assignment.name);
              const child = await api.conversation(id, context);
              if (!child) throw new Error('Saved sub-agent is unavailable.');
              const settled = await (
                await child.submit(
                  {
                    type: 'input',
                    content: assignment.task,
                    requestId: `b70-delegation:${api.taskId}:${index}`,
                  },
                  context
                )
              ).wait(context);
              await child.waitForIdle(context);
              const status = settled.status === 'done' ? 'completed' : 'failed';
              const report = await observer.finish(id, status);
              return { name: assignment.name, status, report };
            })
          );
          return {
            output: [{ type: 'text', text: JSON.stringify(results) }],
            isError: results.some((result) => result.status === 'failed'),
          };
        },
      }),
    ],
    sections: [
      {
        key: 'b70-delegation',
        render: ({ agent }) =>
          agent.tools.some((tool) => tool.name === 'delegate_tasks')
            ? 'For substantial independent subtasks, use delegate_tasks with up to two named assignments and separate files. The sub-agents share your sandbox, model and working directory. Their reports return before you continue; inspect and test their changes. Do not delegate tiny steps.'
            : undefined,
      },
    ],
  });
}
