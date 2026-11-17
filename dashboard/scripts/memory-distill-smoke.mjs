/** One tool-free Qwen request through the production gateway; all source data is synthetic. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { AgentTaskStore } from '../packages/server/dist/runner/task-store.js';
import { MemoryStore } from '../packages/server/dist/memory/store.js';
import { CpuMemoryEmbedder } from '../packages/server/dist/memory/embedding.js';
import { distillRun } from '../packages/server/dist/memory/distill.js';
import { loadRunnerConfig } from '../packages/server/dist/runner/config.js';
import { AgentRunSnapshotSchema, SERVICE_NAME } from '../packages/contracts/dist/index.js';
const root = resolve(process.argv[2] ?? 'build/memory-distill-smoke');
mkdirSync(root, { recursive: true });
const production = new DatabaseSync('/var/lib/local-ai-b70-runner/tasks.sqlite', {
  readOnly: true,
});
assert.equal(
  production
    .prepare(
      "SELECT count(*) n FROM agent_runs WHERE status IN ('queued','starting','running','cancelling')"
    )
    .get().n,
  0,
  'Production agent active.'
);
production.close();
const config = loadRunnerConfig(
  parseEnv(readFileSync('data/runner.env', 'utf8'))
);
assert.equal(config.model, 'Qwen3.8-27B');
const tasks = new AgentTaskStore(join(root, 'tasks.sqlite'));
const project = tasks.registerProject({
  name: 'Synthetic memory distillation',
  repositoryPath: root,
  targetBranch: 'main',
  workdir: '.',
  editPaths: ['.'],
  checks: [],
});
const accepted = tasks.acceptRun(
  { projectId: project.id, task: 'SQL conventions fixture' },
  { projectId: project.id, profileId: 'fixture', baseRevision: 'a'.repeat(40) }
);
const snapshot = AgentRunSnapshotSchema.parse({
  service: SERVICE_NAME,
  enabled: true,
  status: 'settled',
  sequence: 1,
  runId: accepted.runId,
  pendingSteering: 0,
  timeline: [
    {
      id: randomUUID(),
      kind: 'task',
      title: 'User decision',
      text: 'Explizite Projektentscheidung: SQL-Tabellennamen stehen im Plural und verwenden snake_case. Das gilt nur für dieses Projekt.',
      at: new Date().toISOString(),
      state: 'complete',
    },
    {
      id: randomUUID(),
      kind: 'tool',
      title: 'npm run check',
      toolName: 'bash',
      outputText: 'Typecheck passed. Exit code 0.',
      at: new Date().toISOString(),
      state: 'complete',
    },
    {
      id: randomUUID(),
      kind: 'assistant',
      title: 'Agent',
      text: 'Die Tabellen users und order_items entsprechen der ausdrücklichen Benennungsregel.',
      at: new Date().toISOString(),
      state: 'complete',
    },
  ],
});
tasks.database
  .prepare("UPDATE agent_runs SET status='completed',latest_snapshot_json=? WHERE id=?")
  .run(JSON.stringify(snapshot), accepted.runId);
const memory = new MemoryStore(
  join(root, 'memory.sqlite'),
  new CpuMemoryEmbedder(
    resolve('build/memory-runtime/b70-memory-embedding'),
    resolve('build/embeddinggemma-2-BF16.gguf')
  ),
  resolve('build/memory-runtime/vec0.so')
);
try {
  const result = await distillRun(memory, tasks, config, accepted.runId);
  const proposals = memory.list({ owner: true }).filter((item) => item.kind === 'fact');
  assert(
    proposals.length > 0 &&
      proposals.every(
        (item) =>
          item.status === 'proposed' && item.scope === 'project' && item.projectId === project.id
      )
  );
  assert(proposals.some((item) => /snake_case/i.test(item.content)));
  await memory.indexPending();
  const report = {
    passed: true,
    model: config.model,
    ...result,
    checks: [
      'one bounded gateway completion without tools',
      'source-bound proposals recover explicit project convention',
      'no self-confirmation or global promotion',
      'CPU embeddings work alongside Qwen without engine reconfiguration',
    ],
    proposals: proposals.map((item) => ({
      title: item.title,
      content: item.content,
      status: item.status,
      sources: item.sources,
    })),
    productionChanged: false,
  };
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await memory.close();
  tasks.close();
}
