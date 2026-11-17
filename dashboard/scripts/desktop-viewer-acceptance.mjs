/** Real native desktop -> private Unix control -> authenticated API -> real Chrome.
 * Scripted test inputs, no model calls, production changes or host desktop access.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { getOrThrow } from '@earendil-works/pi-durable/env';
import { buildApp } from '../packages/server/dist/app.js';
import { loadServerConfig } from '../packages/server/dist/config.js';
import { createRunnerControlServer } from '../packages/server/dist/runner/service.js';
import { RunnerAgentClient } from '../packages/server/dist/agent/runner-client.js';
import { createDurableEnvironment } from '../packages/server/dist/durable/environment.js';
import { DurableAgentManager } from '../packages/server/dist/durable/manager.js';
import { sandboxToolCall } from '../packages/server/dist/durable/tools.js';
import {
  AgentRunSnapshotSchema,
  DurableTaskDetailSchema,
  SERVICE_NAME,
} from '../packages/contracts/dist/index.js';
import { validateAgentImage } from '../packages/runner/dist/index.js';
import { openBrowser, until, pause } from './lib/browser-cdp.mjs';

const dashboard = resolve(import.meta.dirname, '..');
const output = resolve(process.argv[2] ?? 'build/desktop-viewer-acceptance');
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(tmpdir(), 'b70-desktop-viewer-'));
const workspace = join(root, 'workspace');
mkdirSync(workspace);
cpSync(
  join(dashboard, 'packages/runner/test/fixtures/desktop/canvas.cpp'),
  join(workspace, 'canvas.cpp')
);
const runId = randomUUID(),
  taskId = randomUUID(),
  projectId = randomUUID();
const config = {
  supportRoot: join(dashboard, 'build/observatory-release/runtime'),
  desktopEnabled: true,
  controlSocket: join(root, 'control.sock'),
  controlToken: randomBytes(32).toString('hex'),
};
const environment = createDurableEnvironment(
  config,
  { workdir: '.' },
  workspace,
  randomBytes(16).toString('hex')
);
const manager = new DurableAgentManager({
  runId,
  requestId: randomUUID(),
  provider: 'b70-vllm',
  model: 'Qwen3.8-27B',
  thinkingLevel: 'medium',
  env: environment.env,
  desktop: true,
});
const checks = [];
const check = (name, condition) => {
  assert.ok(condition, name);
  checks.push(name);
  console.log('PASS ' + name);
};
let app, browser, control, client;
const images = new Map();
const now = new Date().toISOString();
let snapshot = AgentRunSnapshotSchema.parse({
  service: SERVICE_NAME,
  enabled: true,
  engine: 'pi-durable',
  status: 'running',
  runId,
  name: 'Nativer GUI-Test · Live-Desktop',
  task: 'Prüfe die native C++ Oberfläche, klicke die Schaltfläche und kontrolliere das Ergebnis.',
  provider: 'b70-vllm',
  model: 'Qwen3.8-27B',
  thinkingLevel: 'medium',
  sequence: 1,
  startedAt: now,
  pendingSteering: 0,
  timeline: [],
});
const run = {
  id: runId,
  taskId,
  turnId: randomUUID(),
  status: 'running',
  version: 1,
  profileId: 'coding-default-v1',
  baseRevision: 'a'.repeat(40),
  checkStatus: 'not_run',
  createdAt: now,
  startedAt: now,
};
const task = {
  id: taskId,
  title: snapshot.name,
  projectId,
  projectName: 'Native C++ · Desktop-Abnahme',
  status: 'open',
  version: 1,
  createdAt: now,
  updatedAt: now,
  latestRun: run,
};
const detail = () =>
  DurableTaskDetailSchema.parse({
    task,
    runs: [run],
    messages: [],
    latestSnapshot: snapshot,
    traceEventCount: 0,
  });
let latest;
async function tool(name, args = {}, persist = true) {
  const result = await sandboxToolCall(environment.env, args, name, ctx);
  assert(!result.isError, JSON.stringify(result));
  const text = result.output
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
  const state = text.split('\n').find((line) => line.startsWith('{"snapshot"'));
  if (state) latest = JSON.parse(state);
  if (persist) {
    const metadata = [];
    for (const part of result.output)
      if (part.type === 'image') {
        const data = Buffer.from(part.data, 'base64'),
          valid = validateAgentImage(part.mimeType, data);
        assert(valid.ok);
        const id = randomUUID();
        const image = {
          mimeType: part.mimeType,
          data,
          byteLength: data.length,
          width: valid.width,
          height: valid.height,
        };
        images.set(id, image);
        metadata.push({
          id,
          runId,
          mimeType: part.mimeType,
          byteLength: data.length,
          width: valid.width,
          height: valid.height,
        });
        writeFileSync(join(output, id + '.png'), data);
      }
    snapshot.timeline.push({
      id: randomUUID(),
      at: new Date().toISOString(),
      kind: 'tool',
      title: name,
      toolName: name,
      argumentsText: JSON.stringify(args, null, 2),
      outputText: text,
      state: 'complete',
      ...(metadata.length ? { images: metadata } : {}),
    });
  }
  return result;
}
try {
  getOrThrow(
    await environment.env.exec(
      ['/usr/bin/g++', '-std=c++17', '/workspace/canvas.cpp', '-lX11', '-o', '/workspace/canvas'],
      { timeout: 30 },
      ctx
    )
  );
  await tool('desktop_start');
  await pause(700);
  await tool('desktop_launch', { command: ['./canvas'] });
  await until(async () => {
    await tool('desktop_observe', {}, false);
    return latest.windows.some((w) => w.title === 'B70 Native Canvas');
  }, 'Native window missing');
  await tool('desktop_observe');
  const token = latest.snapshot;
  const window = latest.windows.find((w) => w.title === 'B70 Native Canvas');
  const controller = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    start: async () => snapshot,
    steer: async () => snapshot,
    close: async () => {},
    listTasks: async () => ({ items: [task], activeTaskId: taskId, activeTaskIds: [taskId] }),
    getTask: async () => detail(),
    listProjects: async () => [
      {
        id: projectId,
        name: task.projectName,
        repositoryPath: workspace,
        targetBranch: 'main',
        workdir: '.',
        editPaths: ['.'],
        checks: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    getRunTrace: async () => ({ runId, items: [], hasMore: false }),
    getRunImage: async (selected, id) => {
      assert.equal(selected, runId);
      assert(images.has(id));
      return images.get(id);
    },
    getDesktopFrame: async (selected) =>
      selected === runId ? manager.getDesktopFrame() : undefined,
    getTaskTelemetry: async () => ({
      taskId,
      totals: {
        requests: 0,
        completedRequests: 0,
        failedRequests: 0,
        usage: null,
        prefill: null,
        decode: null,
      },
      runs: [],
    }),
    getTaskChanges: async () => ({
      taskId,
      runId,
      capturedAt: now,
      status: 'live',
      stale: false,
      truncated: false,
      files: [],
      diff: '',
    }),
  };
  control = createRunnerControlServer(config, controller);
  await control.start();
  client = new RunnerAgentClient(config.controlSocket, config.controlToken);
  await until(() => client.snapshot().enabled, 'Control unavailable');
  app = buildApp({
    config: loadServerConfig(),
    version: 'desktop-observer-acceptance',
    loggerLevel: 'silent',
    webRoot: join(dashboard, 'packages/web/dist'),
    agent: client,
    auth: { mode: 'development', sessions: {}, sessionDays: 1, cookieSecure: false },
  });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await openBrowser();
  await browser.send('Page.enable');
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "localStorage.setItem('observatory.locale','de')",
  });
  const viewport = async (width, height) => {
    await browser.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await pause(200);
  };
  const evaluate = browser.evaluate;
  await viewport(1440, 960);
  await browser.send('Page.navigate', { url: `${url}/#/agent/${taskId}` });
  await until(
    () =>
      evaluate(
        "!!document.querySelector('.desktop-screen img')?.complete && document.querySelector('.desktop-status')?.textContent.includes('Live')"
      ),
    'Live desktop pane missing'
  );
  check(
    'Real isolated desktop reaches Chrome through Unix control and API',
    await evaluate("document.querySelector('.desktop-screen img').naturalWidth === 1280")
  );
  check(
    'Transcript and desktop are side by side',
    await evaluate(
      "document.querySelector('.conversation-view').getBoundingClientRect().right <= document.querySelector('.desktop-panel').getBoundingClientRect().left"
    )
  );
  check(
    'All original tool screenshots remain inline',
    await evaluate(
      `document.querySelectorAll('.timeline-item .image-thumb img').length === ${images.size}`
    )
  );
  check(
    'Desktop pane accepts no keyboard or mouse forwarding',
    await evaluate(
      "!document.querySelector('.desktop-screen input,.desktop-screen canvas,[contenteditable]')"
    )
  );
  await browser.capture(join(output, '01-live-desktop-wide.png'));
  const first = await client.getDesktopFrame(runId);
  check(
    'Foreign run has no desktop access',
    (await client.getDesktopFrame(randomUUID())) === undefined
  );
  await tool(
    'desktop_action',
    { action: 'click', snapshot: token, x: window.geometry.x + 80, y: window.geometry.y + 80 },
    false
  );
  check(
    'Observer captures preserve the model snapshot identifier',
    readFileSync(join(workspace, 'canvas-state.txt'), 'utf8').startsWith('1\n')
  );
  const oldSrc = await evaluate("document.querySelector('.desktop-screen img').src");
  await until(
    () =>
      evaluate(`document.querySelector('.desktop-screen img').src !== ${JSON.stringify(oldSrc)}`),
    'Live frame did not refresh'
  );
  const second = await client.getDesktopFrame(runId);
  check(
    'Live image updates after native input',
    createHash('sha256').update(first.data).digest('hex') !==
      createHash('sha256').update(second.data).digest('hex')
  );
  await browser.capture(join(output, '02-live-desktop-updated.png'));
  await evaluate("document.querySelector('.desktop-toolbar button').click()");
  const pausedSrc = await evaluate("document.querySelector('.desktop-screen img').src");
  await pause(2400);
  check(
    'Pause retains the image and stops polling',
    await evaluate(
      `document.querySelector('.desktop-screen img').src === ${JSON.stringify(pausedSrc)} && document.querySelector('.desktop-status').textContent.includes('pausiert')`
    )
  );
  await viewport(1280, 882);
  check(
    'Landscape tablet keeps the split and avoids horizontal overflow',
    await evaluate(
      "document.querySelector('.task-live-workspace').classList.contains('split-workspace') && document.documentElement.scrollWidth <= innerWidth"
    )
  );
  await browser.capture(join(output, '03-tablet-landscape.png'));
  await viewport(820, 1180);
  await evaluate(
    "Array.from(document.querySelectorAll('.task-view-tabs button')).find(b => b.textContent.includes('Testumgebung')).click()"
  );
  check(
    'Portrait tablet provides a usable dedicated desktop tab',
    await evaluate(
      "document.querySelector('.desktop-screen img').getBoundingClientRect().width > 400 && document.documentElement.scrollWidth <= innerWidth"
    )
  );
  await browser.capture(join(output, '04-tablet-portrait.png'));
  await viewport(390, 844);
  check(
    'Phone does not overflow',
    await evaluate('document.documentElement.scrollWidth <= innerWidth')
  );
  await browser.capture(join(output, '05-phone.png'));
  // Reload a completed task: only persisted tool images remain; there is no live desktop to reconnect.
  run.status = 'completed';
  task.status = 'open';
  snapshot.status = 'settled';
  await viewport(1440, 960);
  await browser.send('Page.reload', { ignoreCache: true });
  await until(
    () =>
      evaluate(
        "document.querySelector('.desktop-status')?.textContent.includes('Letztes Desktop-Bild')"
      ),
    'Historical desktop fallback missing'
  );
  check(
    'Completed run reloads the persisted desktop image',
    await evaluate("document.querySelector('.desktop-screen img').src.includes('/images/')")
  );
  await browser.capture(join(output, '06-completed-desktop.png'));
  writeFileSync(
    join(output, 'report.json'),
    JSON.stringify(
      { passed: true, runId, checks, modelCalls: 0, productionChanged: false },
      null,
      2
    )
  );
} catch (error) {
  if (browser) {
    await browser.capture(join(output, 'failure.png')).catch(() => {});
    writeFileSync(
      join(output, 'failure-dom.txt'),
      await browser.evaluate('document.body.innerText').catch(() => 'unavailable')
    );
  }
  throw error;
} finally {
  await browser?.close();
  await app?.close();
  await client?.close();
  await control?.close();
  await environment.close();
  rmSync(root, { recursive: true, force: true });
}
