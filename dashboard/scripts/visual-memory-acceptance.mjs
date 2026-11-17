/** Bounded UI acceptance with isolated data. Native CPU retrieval is qualified separately. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../packages/server/dist/app.js';
import { loadServerConfig } from '../packages/server/dist/config.js';
import { AgentTaskStore } from '../packages/server/dist/runner/task-store.js';
import { MemoryStore } from '../packages/server/dist/memory/store.js';
import { MemoryError } from '../packages/server/dist/memory/store.js';
import { AgentControlError } from '../packages/server/dist/agent/manager.js';
import { memoryControl } from '../packages/server/dist/memory/controller.js';
import { AgentRunSnapshotSchema, SERVICE_NAME } from '../packages/contracts/dist/index.js';
import { openBrowser, until, pause } from './lib/browser-cdp.mjs';
assert(process.argv[3], 'Pass an existing PNG screenshot as third argument.');
const output = resolve(process.argv[2]),
  original = readFileSync(process.argv[3]);
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(tmpdir(), 'b70-visual-acceptance-')),
  tasks = new AgentTaskStore(join(root, 'tasks.sqlite')),
  memory = new MemoryStore(join(root, 'memory.sqlite'));
const project = tasks.registerProject({
  name: 'Visual fixture',
  repositoryPath: root,
  targetBranch: 'main',
  workdir: '.',
  editPaths: ['.'],
  checks: [],
});
const accepted = tasks.acceptRun(
  { projectId: project.id, task: 'Visual memory fixture' },
  { projectId: project.id, profileId: 'fixture', baseRevision: 'a'.repeat(40) }
);
const source = tasks.storeImage(accepted.runId, {
  mimeType: 'image/png',
  data: original,
  label: 'Reference game interface',
});
const snapshot = AgentRunSnapshotSchema.parse({
  service: SERVICE_NAME,
  enabled: true,
  status: 'settled',
  sequence: 1,
  runId: accepted.runId,
  pendingSteering: 0,
  timeline: [],
});
tasks.database
  .prepare("UPDATE agent_runs SET status='completed',latest_snapshot_json=? WHERE id=?")
  .run(JSON.stringify(snapshot), accepted.runId);
let app, browser;
async function value(selector, value) {
  await browser.evaluate(
    `(()=>{let e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`
  );
  await pause(50);
}
try {
  app = buildApp({
    config: loadServerConfig(),
    version: 'visual-memory-acceptance',
    loggerLevel: 'silent',
    webRoot: resolve('packages/web/dist'),
    agent: {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      start: async () => snapshot,
      steer: async () => snapshot,
      close: async () => {},
      listTasks: async () => tasks.listTasks(),
      listProjects: async () => tasks.listProjects(),
      getRunImage: async (runId, imageId) => tasks.getRunImage(runId, imageId),
      memoryCall: async (input) => {
        try {
          return await memoryControl(memory, tasks, input);
        } catch (error) {
          if (error instanceof MemoryError)
            throw new AgentControlError(
              error.code === 'invalid' ? 'protocol' : error.code,
              error.message
            );
          throw error;
        }
      },
    },
    auth: { mode: 'development', sessions: {}, sessionDays: 1, cookieSecure: false },
  });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await openBrowser();
  await browser.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await browser.send('Page.navigate', { url: url + '/#/memory' });
  await until(
    () => browser.evaluate("document.querySelector('.memory-import select')?.options.length===2"),
    'Run list failed to load'
  );
  await value('.memory-import select', accepted.runId);
  await until(
    () => browser.evaluate("document.querySelectorAll('.memory-image-picker img').length===1"),
    'Run image missing'
  );
  await browser.evaluate("document.querySelector('.memory-image-picker input').click()");
  await value('form.memory-import:last-of-type input[maxlength="160"]', 'Accepted game interface');
  await value(
    'form.memory-import:last-of-type textarea',
    'Reference screenshot of the implemented board game. Compare the original image before drawing conclusions.'
  );
  await browser.evaluate(
    "document.querySelector('form.memory-import:last-of-type').requestSubmit()"
  );
  await until(() => memory.list({ owner: true }).some((i) => i.image), 'Visual proposal not saved');
  const item = memory.list({ owner: true }).find((i) => i.image);
  assert.equal(item.status, 'proposed');
  assert.equal(item.projectId, project.id);
  assert.equal(item.image.sourceImageId, source.id);
  await until(
    () =>
      browser.evaluate(
        "!!document.querySelector('.memory-record .memory-image img')?.naturalWidth"
      ),
    'Original memory image not displayed'
  );
  assert.equal(memory.image(item.id, { owner: true }).data, original.toString('base64'));
  await browser.evaluate(
    "[...document.querySelector('.memory-record').querySelectorAll('button')].find(b=>b.textContent.trim()==='Confirm knowledge').click()"
  );
  await until(
    () => memory.get(item.id, { owner: true }).status === 'confirmed',
    'Visual proposal did not confirm'
  );
  await browser.capture(join(output, '01-visual-memory.png'));
  tasks.database.prepare('DELETE FROM agent_images WHERE id=?').run(source.id);
  const copied = await fetch(url + '/api/agent/memory/' + item.id + '/image');
  assert.equal(copied.status, 200);
  assert(Buffer.from(await copied.arrayBuffer()).equals(original));
  await browser.send('Emulation.setDeviceMetricsOverride', {
    width: 820,
    height: 1180,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await browser.evaluate("localStorage.setItem('observatory.locale','de');location.reload()");
  await until(
    () =>
      browser.evaluate(
        "document.querySelector('.memory-record')?.textContent.includes('Bild-Memory')"
      ),
    'German visual memory UI missing'
  );
  assert(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth+1'));
  await browser.capture(join(output, '02-visual-memory-tablet.png'));
  await browser.evaluate(
    "window.confirm=()=>true;[...document.querySelector('.memory-record').querySelectorAll('button')].find(b=>b.textContent.trim()==='Löschen').click()"
  );
  await until(() => memory.status().records === 0, 'Image memory deletion failed');
  assert.equal((await fetch(url + '/api/agent/memory/' + item.id + '/image')).status, 404);
  const report = {
    passed: true,
    checks: [
      'saved run image selectable in dashboard',
      'source-bound image proposal and owner confirmation',
      'original image displayed and survives deletion of source run image',
      'German tablet layout has no overflow',
      'delete removes canonical memory and original image endpoint',
    ],
    modelCalls: 0,
    productionChanged: false,
  };
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await app?.close();
  await memory.close();
  tasks.close();
  rmSync(root, { recursive: true, force: true });
}
