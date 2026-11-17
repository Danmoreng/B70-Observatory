import { memoryEvidence } from './evidence.js';
import {
  MemoryRequestSchema,
  MemoryResponseSchema,
  type MemoryRequest,
  type MemoryResponse,
} from '@observatory/contracts';
import type { AgentTaskStore } from '../runner/task-store.js';
import { MemoryStore } from './store.js';
/** Owner UI control. Agent tool calls use a separate, project-bound policy. */
export async function memoryControl(
  memory: MemoryStore,
  tasks: AgentTaskStore,
  raw: MemoryRequest
): Promise<MemoryResponse> {
  const input = MemoryRequestSchema.parse(raw);
  const result: MemoryResponse = { enabled: true };
  switch (input.operation) {
    case 'runImages': {
      const row = tasks.database
        .prepare('SELECT task_id FROM agent_runs WHERE id=?')
        .get(input.runId) as { task_id: string } | undefined;
      if (!row) throw new Error('Source run not found.');
      result.runImages = (
        tasks.database
          .prepare('SELECT id FROM agent_images WHERE run_id=? ORDER BY created_at DESC LIMIT 200')
          .all(input.runId) as Array<{ id: string }>
      ).map((r) => {
        const { data, ...metadata } = tasks.getRunImage(input.runId, r.id);
        void data;
        return metadata;
      });
      break;
    }
    case 'image':
      result.image = memory.image(input.id, { owner: true });
      break;
    case 'capture': {
      const source = tasks.getRunImage(input.runId, input.imageId);
      const run = tasks.database
        .prepare(
          'SELECT r.task_id,r.base_revision,r.result_revision,i.created_at FROM agent_runs r JOIN agent_images i ON i.run_id=r.id WHERE r.id=? AND i.id=?'
        )
        .get(input.runId, input.imageId) as
        | {
            task_id: string;
            base_revision: string;
            result_revision: string | null;
            created_at: string;
          }
        | undefined;
      if (!run) throw new Error('Source run image not found.');
      const item = memory.write(
        {
          title: input.title,
          content: input.description,
          scope: 'project',
          projectId: tasks.getTask(run.task_id).task.projectId,
          kind: 'fact',
          status: 'proposed',
          visibility: 'local',
          sources: [
            { kind: 'run', ref: input.runId },
            { kind: 'code', ref: run.base_revision },
          ],
        },
        { owner: true }
      );
      try {
        memory.attachImage(item.id, {
          data: source.data,
          mimeType: source.mimeType,
          width: source.width,
          height: source.height,
          purpose: input.purpose,
          runId: input.runId,
          sourceImageId: input.imageId,
          capturedAt: run.created_at,
          revision: run.base_revision,
        });
      } catch (error) {
        memory.remove(item.id, item.version);
        throw error;
      }
      result.item = memory.get(item.id, { owner: true });
      break;
    }
    case 'status':
      result.status = memory.status();
      break;
    case 'list':
      result.items = memory.list({ owner: true }, input);
      break;
    case 'search':
      Object.assign(result, await memory.search(input.query, { owner: true }, input));
      break;
    case 'create':
      if (input.entry.projectId) tasks.getProject(input.entry.projectId);
      result.item = memory.write(input.entry, { owner: true });
      break;
    case 'update':
      if (input.entry.projectId) tasks.getProject(input.entry.projectId);
      result.item = memory.write(
        input.entry,
        { owner: true },
        { id: input.id, version: input.version }
      );
      break;
    case 'remove':
      memory.remove(input.id, input.version);
      result.removed = true;
      break;
    case 'evidence':
      result.evidence = memoryEvidence(memory, tasks, input.id, { owner: true });
      break;
    case 'history':
      result.items = memory.history(input.id);
      break;
    case 'maintenance':
      result.maintenance = memory.maintenance();
      result.status = memory.status();
      break;
    case 'ingest': {
      const row = tasks.database
        .prepare('SELECT task_id,status FROM agent_runs WHERE id=?')
        .get(input.runId) as { task_id: string; status: string } | undefined;
      if (!row || !['completed', 'failed', 'cancelled', 'interrupted'].includes(row.status))
        throw new Error('Only finished runs can be imported.');
      const detail = tasks.getTask(row.task_id);
      const snapshot = JSON.parse(
        (
          tasks.database
            .prepare('SELECT latest_snapshot_json FROM agent_runs WHERE id=?')
            .get(input.runId) as { latest_snapshot_json: string }
        ).latest_snapshot_json ?? 'null'
      ) as {
        timeline?: Array<{
          id: string;
          kind: string;
          title: string;
          text?: string;
          argumentsText?: string;
          outputText?: string;
          toolName?: string;
        }>;
      } | null;
      let count = 0;
      for (const item of snapshot?.timeline ?? []) {
        if (item.title.startsWith('Memory ·') || item.toolName?.startsWith('memory_')) continue;
        if (!['task', 'steering', 'assistant', 'tool', 'notice'].includes(item.kind)) continue;
        const content = [item.text, item.argumentsText, item.outputText].filter(Boolean).join('\n');
        if (!content) continue;
        // Full original remains in Durable. Index bounded passages with a precise pointer.
        for (let offset = 0; offset < Math.min(content.length, 64000); offset += 12000) {
          if (count >= 400) break;
          const created = memory.ingest('run:' + input.runId + ':' + item.id + ':' + offset, {
            title: (item.kind + ' · ' + item.title).slice(0, 160),
            content: content.slice(offset, offset + 12000),
            scope: 'project',
            projectId: detail.task.projectId,
            kind: 'episode',
            status: 'confirmed',
            visibility: 'local',
            sources: [{ kind: 'run', ref: input.runId + ':' + item.id + ':' + offset }],
          });
          if (created) count++;
        }
      }
      const verification = tasks.database
        .prepare(
          'SELECT result_revision,checks_json,accepted_at,merged_revision FROM agent_run_results WHERE run_id=?'
        )
        .get(input.runId) as
        | {
            result_revision: string;
            checks_json: string;
            accepted_at: string | null;
            merged_revision: string | null;
          }
        | undefined;
      if (verification) {
        const checks = (
          JSON.parse(verification.checks_json) as Array<{
            label: string;
            status: string;
            exitCode?: number;
          }>
        ).map((check) => ({ label: check.label, status: check.status, exitCode: check.exitCode }));
        if (
          memory.ingest('run:' + input.runId + ':verification', {
            title: 'Runner verification · ' + verification.result_revision.slice(0, 8),
            content: JSON.stringify(
              {
                resultRevision: verification.result_revision,
                checks,
                acceptedAt: verification.accepted_at,
                mergedRevision: verification.merged_revision,
              },
              null,
              2
            ).slice(0, 16000),
            scope: 'project',
            projectId: detail.task.projectId,
            kind: 'episode',
            status: 'confirmed',
            visibility: 'local',
            sources: [
              { kind: 'check', ref: input.runId },
              { kind: 'code', ref: verification.result_revision },
            ],
          })
        )
          count++;
      }
      memory.clearImportError();
      result.imported = count;
      break;
    }
  }
  return MemoryResponseSchema.parse(result);
}
