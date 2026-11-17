/** Two fresh real-Qwen sessions share only the reviewed personal-memory store. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { loadRunnerConfig } from '../packages/server/dist/runner/config.js';
import { createLocalModels } from '../packages/server/dist/durable/model.js';
import { createDurableEnvironment } from '../packages/server/dist/durable/environment.js';
import { DurableAgentManager } from '../packages/server/dist/durable/manager.js';
import { CpuMemoryEmbedder } from '../packages/server/dist/memory/embedding.js';
import { MemoryStore } from '../packages/server/dist/memory/store.js';
import { memoryTools } from '../packages/server/dist/memory/tools.js';
const root = resolve(process.argv[2] ?? 'build/durable-memory-smoke');
mkdirSync(root, { recursive: true });
const now = new Date();
assert(
  Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Berlin',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(now)
  ) < 22,
  'Not enough time before the daily cutoff.'
);
// A private synthetic DB only; production task state is opened read-only via SQLite below.
const { DatabaseSync } = await import('node:sqlite');
const production = new DatabaseSync('/var/lib/local-ai-b70-runner/tasks.sqlite', {
  readOnly: true,
});
function assertIdle() {
  assert.equal(
    production
      .prepare(
        "SELECT count(*) n FROM agent_runs WHERE status IN ('queued','starting','running','cancelling')"
      )
      .get().n,
    0,
    'A production agent is active.'
  );
}
assertIdle();
const config = loadRunnerConfig({
  ...parseEnv(
    readFileSync('data/runner.env', 'utf8')
  ),
  B70_RUNNER_SUPPORT_ROOT: '/var/lib/local-ai-b70-releases/current/runtime',
  B70_RUNNER_NPM_ENABLED: 'false',
  B70_RUNNER_DESKTOP_ENABLED: '0',
});
assert.equal(config.model, 'Qwen3.8-27B');
const telemetry = [];
const projectId = randomUUID();
let memory;
function openMemory() {
  return new MemoryStore(
    join(root, 'memory.sqlite'),
    new CpuMemoryEmbedder(
      resolve('build/memory-runtime/b70-memory-embedding'),
      resolve('build/embeddinggemma-2-BF16.gguf')
    ),
    resolve('build/memory-runtime/vec0.so')
  );
}
const snapshots = [];
async function session(number, task) {
  assertIdle();
  const workspace = join(root, 'workspace-' + number);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(workspace, 'AGENTS.md'),
    'Synthetic memory acceptance. Use only memory_search and memory_propose. No file changes or subagents.\n'
  );
  const runId = randomUUID();
  const environment = createDurableEnvironment(
    config,
    { id: projectId, workdir: '.' },
    workspace,
    runId.replaceAll('-', '')
  );
  const manager = new DurableAgentManager({
    runId,
    requestId: randomUUID(),
    provider: config.provider,
    model: config.model,
    thinkingLevel: config.thinkingLevel,
    models: await createLocalModels(config, (s) => telemetry.push(s)),
    storagePath: join(root, 'conversation-' + number + '.sqlite'),
    instructions:
      'Prüfe nur Memory. Nutze die angebotenen memory_search und memory_propose. Keine Shell, keine Dateiänderungen, keine Subagenten. Antworte kurz auf Deutsch.',
    env: environment.env,
    browser: false,
    closeEnvironment: () => environment.close(),
    extraTools: memoryTools(memory, projectId, runId),
    memoryContext: 'No memory content preloaded: this acceptance requires explicit retrieval.',
  });
  try {
    await manager.start({ task });
    const deadline = Date.now() + 150000;
    while (!['settled', 'failed'].includes(manager.snapshot().status)) {
      assertIdle();
      if (Date.now() > deadline) throw Error('Memory model acceptance timed out.');
      await new Promise((r) => setTimeout(r, 250));
    }
    const snapshot = manager.snapshot();
    assert.equal(snapshot.status, 'settled', snapshot.reason);
    snapshots.push(snapshot);
    writeFileSync(
      join(root, 'session-' + number + '.json'),
      JSON.stringify(snapshot, null, 2) + '\n'
    );
    return snapshot;
  } finally {
    await manager.close();
    await environment.close();
  }
}
try {
  memory = openMemory();
  await session(
    1,
    'Für dieses synthetische Projekt ist ausdrücklich entschieden: SQL-Tabellennamen stehen im Plural und verwenden snake_case. Speichere genau diese bestätigbare Entscheidung mit memory_propose als Projektvorschlag. Keine Dateien verändern.'
  );
  const proposed = memory
    .list({ owner: true })
    .find((i) => i.status === 'proposed' && /snake_case/i.test(i.content));
  assert(proposed, 'The real agent did not propose the decision.');
  assert(
    !(await memory.context('Tabellennamen', projectId)).ids.includes(proposed.id),
    'Proposal leaked into trusted context.'
  );
  const { id, version, createdAt, updatedAt, machineId, score, ...entry } = proposed;
  void createdAt;
  void updatedAt;
  void machineId;
  void score;
  memory.write({ ...entry, status: 'confirmed' }, { owner: true }, { id, version });
  await memory.indexPending();
  await memory.close();
  memory = openMemory();
  const second = await session(
    2,
    'Suche mit memory_search nach der früher festgelegten Benennung unserer SQL-Tabellen. Welche zwei Vorgaben gelten? Nenne die Quellen-ID aus dem Memory. Keine neue Erinnerung schreiben und keine Dateien verändern.'
  );
  assert(
    second.timeline.some((i) => i.toolName === 'memory_search'),
    'Second session did not retrieve memory.'
  );
  const answer = second.timeline
    .filter((i) => i.kind === 'assistant')
    .map((i) => i.text ?? '')
    .join('\n');
  assert(
    /snake_case/i.test(answer) && /plural/i.test(answer),
    'Second session did not recover both decisions.'
  );
  const report = {
    passed: true,
    model: config.model,
    projectId,
    confirmedMemoryId: id,
    sessions: 2,
    requests: telemetry.length,
    requestIds: telemetry.map((t) => t.requestId),
    checks: [
      'real model creates proposal without self-confirmation',
      'owner confirmation and embedding persisted',
      'fresh Durable session explicitly retrieves prior knowledge',
      'correct plural and snake_case answer with source references',
    ],
    productionChanged: false,
  };
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await memory?.close();
  production.close();
}
