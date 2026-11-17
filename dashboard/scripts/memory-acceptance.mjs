import { distillRun } from '../packages/server/dist/memory/distill.js';
/** Real dashboard + canonical SQLite/vector index + pinned CPU model. Synthetic data only. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../packages/server/dist/app.js';
import { loadServerConfig } from '../packages/server/dist/config.js';
import { AgentTaskStore } from '../packages/server/dist/runner/task-store.js';
import { MemoryStore } from '../packages/server/dist/memory/store.js';
import { CpuMemoryEmbedder } from '../packages/server/dist/memory/embedding.js';
import { memoryControl } from '../packages/server/dist/memory/controller.js';
import { AgentRunSnapshotSchema, SERVICE_NAME } from '../packages/contracts/dist/index.js';
import { openBrowser, until, pause } from './lib/browser-cdp.mjs';
const output = resolve(process.argv[2] ?? 'build/memory-acceptance');
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(tmpdir(), 'b70-memory-browser-'));
const tasks = new AgentTaskStore(join(root, 'tasks.sqlite'));
const project = tasks.registerProject({
  name: 'Memory acceptance project',
  repositoryPath: root,
  targetBranch: 'main',
  workdir: '.',
  editPaths: ['.'],
  checks: [],
});
const foreign = tasks.registerProject({
  name: 'Private second project',
  repositoryPath: join(root, 'other'),
  targetBranch: 'main',
  workdir: '.',
  editPaths: ['.'],
  checks: [],
});
const accepted = tasks.acceptRun(
  { projectId: project.id, task: 'Synthetic source run' },
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
      kind: 'tool',
      title: 'npm test',
      toolName: 'bash',
      at: new Date().toISOString(),
      state: 'complete',
      outputText: '90 tests passed. Exit code 0.',
    },
    {
      id: randomUUID(),
      kind: 'assistant',
      title: 'Agent',
      at: new Date().toISOString(),
      state: 'complete',
      text: 'The source run was finished.',
    },
  ],
});
tasks.database
  .prepare(
    "UPDATE agent_runs SET status='completed',latest_snapshot_json=?,latest_snapshot_sequence=1 WHERE id=?"
  )
  .run(JSON.stringify(snapshot), accepted.runId);
const memory = new MemoryStore(
  join(root, 'memory.sqlite'),
  new CpuMemoryEmbedder(
    resolve('build/memory-runtime/b70-memory-embedding'),
    resolve('build/embeddinggemma-2-BF16.gguf')
  ),
  resolve('build/memory-runtime/vec0.so')
);
const base = {
  scope: 'project',
  projectId: project.id,
  kind: 'procedure',
  status: 'confirmed',
  visibility: 'local',
  sources: [{ kind: 'user', ref: 'Synthetic acceptance source' }],
};
const buildNote = memory.write(
  {
    ...base,
    title: 'Build and type validation',
    content: 'The project is built using npm run build and checked with npm run check.',
  },
  { owner: true }
);
memory.write(
  {
    ...base,
    projectId: foreign.id,
    title: 'Unrelated secret',
    content: 'The private launch phrase is hidden-feline-779.',
  },
  { owner: true }
);
memory.write(
  {
    ...base,
    scope: 'developer',
    projectId: undefined,
    title: 'Developer preference',
    content: 'Answer in German with concrete reviewable results.',
    visibility: 'shared',
  },
  { owner: true }
);
await memory.indexPending();
const checks = [];
let browser, app;
const controller = {
  snapshot: () => snapshot,
  subscribe: () => () => {},
  start: async () => snapshot,
  steer: async () => snapshot,
  close: async () => {},
  listTasks: async () => tasks.listTasks(),
  listProjects: async () => tasks.listProjects(),
  memoryCall: async (input) => {
    if (input.operation === 'distill')
      return {
        enabled: true,
        distillation: await distillRun(
          memory,
          tasks,
          { model: 'fixture', gatewayUrl: 'http://127.0.0.1:1' },
          input.runId,
          async (_url, init) => {
            const source = JSON.parse(JSON.parse(init.body).messages[1].content).source.find(
              (item) => item.title.startsWith('tool ·')
            );
            return new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        notes: [
                          {
                            title: 'Project verification procedure',
                            content:
                              'Use npm test to verify this project. The observed source run reported 90 passing tests; recheck after changes.',
                            sourceIds: [source.id],
                          },
                        ],
                      }),
                    },
                  },
                ],
              })
            );
          }
        ),
      };
    return await memoryControl(memory, tasks, input);
  },
};
async function value(selector, text) {
  await browser.evaluate(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(text)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`
  );
  await pause(50);
}
async function click(selector) {
  await browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await pause(100);
}
async function loaded() {
  await until(
    () =>
      browser.evaluate(
        "!!document.querySelector('.memory-record')&&!document.querySelector('.inline-error')"
      ),
    'Memory dashboard did not load'
  );
}
try {
  app = buildApp({
    config: loadServerConfig(),
    version: 'memory-acceptance',
    loggerLevel: 'silent',
    webRoot: resolve('packages/web/dist'),
    agent: controller,
    auth: { mode: 'development', sessions: {}, sessionDays: 1, cookieSecure: false },
  });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await openBrowser();
  await browser.send('Page.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await browser.send('Page.navigate', { url: url + '/#/memory' });
  await loaded();
  checks.push('Memory navigation and real authenticated same-origin API load');
  await browser.capture(join(output, '01-memory.png'));
  await value(
    '.memory-filters input[type=search]',
    'Wie kann ich das Projekt kompilieren und die Typen prüfen?'
  );
  await browser.evaluate("document.querySelector('.memory-filters').requestSubmit()");
  await until(
    () =>
      browser.evaluate(
        "document.querySelector('.memory-record h2')?.textContent.includes('Build and type validation')"
      ),
    'Cross-language semantic query did not retrieve the correct source'
  );
  checks.push('German query retrieves English build instructions through real CPU embeddings');
  const boundary = await memory.search(
    'hidden-feline-779',
    { owner: false, projectId: project.id },
    { includeEpisodes: true }
  );
  assert(!boundary.items.some((i) => i.projectId === foreign.id));
  checks.push('Foreign-project memory is excluded by trusted agent policy');
  await value('.memory-filters input[type=search]', '');
  await browser.evaluate("document.querySelector('.memory-filters').requestSubmit()");
  await loaded();
  await click('.memory-heading button');
  await value('.memory-editor input[maxlength="160"]', 'Naming convention');
  await value(
    '.memory-editor textarea[maxlength="16000"]',
    'Use singular table names. Evidence: explicit developer decision.'
  );
  await browser.evaluate("document.querySelector('.memory-editor').requestSubmit()");
  await until(
    () =>
      browser.evaluate(
        "!document.querySelector('.memory-editor')&&document.querySelector('.memory-records')?.textContent.includes('Naming convention')"
      ),
    'New proposal did not save'
  );
  let note = memory.list({ owner: true }).find((i) => i.title === 'Naming convention');
  assert(note && note.status === 'proposed');
  assert(!(await memory.context('singular', project.id)).ids.includes(note.id));
  checks.push('New proposals do not silently become trusted start context');
  await browser.evaluate(
    "(()=>{const row=[...document.querySelectorAll('.memory-record')].find(e=>e.querySelector('h2').textContent==='Naming convention');[...row.querySelectorAll('button')].find(b=>b.textContent==='Confirm knowledge').click()})()"
  );
  await until(
    () => memory.get(note.id, { owner: true }).status === 'confirmed',
    'Confirmation did not persist'
  );
  assert((await memory.context('singular', project.id)).ids.includes(note.id));
  checks.push('Owner confirmation makes sourced project knowledge retrievable');
  await pause(200);
  await browser.evaluate(
    "(()=>{const row=[...document.querySelectorAll('.memory-record')].find(e=>e.querySelector('h2').textContent==='Naming convention');[...row.querySelectorAll('button')].find(b=>b.textContent==='Edit').click()})()"
  );
  await value(
    '.memory-editor textarea[maxlength="16000"]',
    'Use plural table names. Corrected developer decision.'
  );
  await browser.evaluate("document.querySelector('.memory-editor').requestSubmit()");
  await until(
    () => memory.get(note.id, { owner: true }).version === 3,
    'Correction did not persist'
  );
  assert.equal(memory.history(note.id).length, 3);
  checks.push(
    'Corrections preserve source-linked version history and invalidate old search content'
  );
  await value('.memory-import select', accepted.runId);
  await browser.evaluate("document.querySelector('.memory-import').requestSubmit()");
  await until(
    () => memory.status().episodes === 2,
    'Finished run import did not include the tool result'
  );
  assert(memory.list({ owner: true }).some((i) => i.content.includes('90 tests passed')));
  checks.push('Finished-run import includes original tool outcomes as labeled historical evidence');
  await pause(200);
  await browser.evaluate(
    "(()=>{const row=[...document.querySelectorAll('.memory-record')].find(e=>e.querySelector('h2').textContent==='Naming convention');[...row.querySelectorAll('button')].find(b=>b.textContent==='Version history').click()})()"
  );
  await until(
    () => browser.evaluate("document.querySelectorAll('.memory-history article').length===3"),
    'Version history is not visible'
  );
  await browser.capture(join(output, '02-history.png'));
  await browser.evaluate(
    "window.confirm=()=>true;(()=>{const row=[...document.querySelectorAll('.memory-record')].find(e=>e.querySelector('h2').textContent==='Naming convention');[...row.querySelectorAll('button')].find(b=>b.textContent==='Delete').click()})()"
  );
  await until(
    () => !memory.list({ owner: true }).some((i) => i.id === note.id),
    'Delete did not remove canonical record'
  );
  assert.throws(() => memory.history(note.id));
  checks.push('Delete removes canonical content, revisions and vectors');
  await browser.evaluate("document.querySelector('.memory-import button[type=button]').click()");
  await until(
    () =>
      memory
        .list({ owner: true })
        .some(
          (item) => item.title === 'Project verification procedure' && item.status === 'proposed'
        ),
    'Distillation did not create an owner-review proposal'
  );
  checks.push(
    'Owner-triggered retrospective processing creates proposals with original tool evidence'
  );
  await pause(200);
  await browser.evaluate(
    "(()=>{const row=[...document.querySelectorAll('.memory-record')].find(e=>e.querySelector('h2').textContent==='Project verification procedure');[...row.querySelectorAll('button')].find(b=>b.textContent==='View source evidence').click()})()"
  );
  await until(
    () =>
      browser.evaluate(
        "document.querySelector('.memory-evidence')?.textContent.includes('90 tests passed')"
      ),
    'Original source evidence was not resolved'
  );
  checks.push('Source evidence opens the original tool outcome and task reference');
  await browser.send('Emulation.setDeviceMetricsOverride', {
    width: 820,
    height: 1180,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await browser.evaluate("localStorage.setItem('observatory.locale','de');location.reload()");
  await loaded();
  assert(
    await browser.evaluate(
      "document.querySelector('.memory-heading')?.textContent.includes('Neue Erinnerung')"
    )
  );
  assert(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth+1'));
  await browser.capture(join(output, '03-memory-tablet-de.png'));
  checks.push('German tablet layout has no horizontal page overflow');
  await memory.indexPending();
  writeFileSync(
    join(output, 'report.json'),
    JSON.stringify(
      {
        passed: true,
        checks,
        status: memory.status(),
        reasoningModelCalls: 0,
        embeddingModel: 'google/embeddinggemma-2',
        productionChanged: false,
        buildNoteId: buildNote.id,
      },
      null,
      2
    ) + '\n'
  );
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  await browser?.close();
  await app?.close();
  await memory.close();
  tasks.close();
  rmSync(root, { recursive: true, force: true });
}
