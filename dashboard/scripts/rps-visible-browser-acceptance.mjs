/** Unmodified RPS source -> controlled npm install/build -> visible Chromium/Firefox
 * -> existing browser tools -> live dashboard. No model calls or production writes.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { getOrThrow } from '@earendil-works/pi-durable/env';
import { createNpmRegistry } from '../packages/server/dist/runner/npm-registry.js';
import { createDurableEnvironment } from '../packages/server/dist/durable/environment.js';
import { DurableAgentManager } from '../packages/server/dist/durable/manager.js';
import { sandboxToolCall } from '../packages/server/dist/durable/tools.js';
import { buildApp } from '../packages/server/dist/app.js';
import { loadServerConfig } from '../packages/server/dist/config.js';
import {
  AgentRunSnapshotSchema,
  DurableTaskDetailSchema,
  SERVICE_NAME,
} from '../packages/contracts/dist/index.js';
import { validateAgentImage } from '../packages/runner/dist/index.js';
import { openBrowser, pause, until } from './lib/browser-cdp.mjs';
const source = process.argv[2];
assert(source, 'Pass existing RPS repository and fresh evidence directory.');
const output = resolve(process.argv[3] ?? 'build/rps-visible-browser');
mkdirSync(output, { recursive: true });
const workspace = join(output, 'workspace');
execFileSync('/usr/bin/git', ['clone', '-q', '--no-hardlinks', resolve(source), workspace]);
const revision = execFileSync('/usr/bin/git', ['-C', workspace, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const ipc = join(output, 'ipc');
mkdirSync(ipc);
const registry = createNpmRegistry({ socketPath: join(ipc, 'npm.sock') });
await registry.start();
const token = randomBytes(32).toString('hex');
registry.register(token);
const sandboxId = randomBytes(16).toString('hex');
writeFileSync(output + '/sandbox-id.txt', sandboxId);
const env = createDurableEnvironment(
  {
    supportRoot: resolve('build/observatory-release/runtime'),
    browserRuntimeRoot: '/opt/google/chrome',
    desktopEnabled: true,
    inferenceSocketRoot: ipc,
  },
  { workdir: '.' },
  workspace,
  sandboxId,
  token
);
const runId = randomUUID(),
  taskId = randomUUID(),
  projectId = randomUUID();
const manager = new DurableAgentManager({
  runId,
  env: env.env,
  desktop: true,
  provider: 'fixture',
  model: 'fixture',
  thinkingLevel: 'off',
});
let app, observer;
const images = new Map();
const now = new Date().toISOString();
const run = {
  id: runId,
  taskId,
  turnId: randomUUID(),
  status: 'running',
  version: 1,
  profileId: 'durable-v1',
  baseRevision: revision,
  checkStatus: 'not_run',
  createdAt: now,
  startedAt: now,
};
const task = {
  id: taskId,
  title: 'RPS · bestehende 3D-GUI in Chromium und Firefox',
  projectId,
  projectName: 'RPS Strategy',
  status: 'open',
  version: 1,
  createdAt: now,
  updatedAt: now,
  latestRun: run,
};
const snapshot = AgentRunSnapshotSchema.parse({
  service: SERVICE_NAME,
  enabled: true,
  engine: 'pi-durable',
  desktopAvailable: true,
  status: 'running',
  runId,
  name: task.title,
  task: 'Teste die bestehende Vue-/Three.js-Oberfläche im sichtbaren Test-Desktop.',
  sequence: 1,
  startedAt: now,
  pendingSteering: 0,
  timeline: [],
});
const steps = [];
const cgroup =
  '/sys/fs/cgroup/user.slice/user-' +
  process.getuid() +
  '.slice/user@' +
  process.getuid() +
  '.service/app.slice/local-ai-b70-job-' +
  sandboxId +
  '.scope';
let maxTasks = 0;
let taskLimitHits = 0;
const diagnosticTimer = setInterval(() => {
  try {
    maxTasks = Math.max(maxTasks, Number(readFileSync(cgroup + '/pids.current', 'utf8')));
    taskLimitHits = Number(
      readFileSync(cgroup + '/pids.events', 'utf8').match(/max (\d+)/)?.[1] ?? 0
    );
  } catch {
    // The test scope may not have started yet or may have ended.
  }
}, 250);
diagnosticTimer.unref();
async function command(argv, timeout = 180) {
  let log = '';
  const result = getOrThrow(
    await env.env.exec(
      argv,
      {
        timeout,
        onOutput: (text) => {
          log = (log + text).slice(-65536);
          writeFileSync(output + '/commands.log', log);
        },
      },
      ctx
    )
  );
  assert.equal(result.exitCode, 0, log);
  return log;
}
async function tool(name, args = {}) {
  appendFileSync(
    output + '/steps.log',
    new Date().toISOString() + ' START ' + name + ' ' + JSON.stringify(args) + '\n'
  );
  const result = await sandboxToolCall(env.env, args, name, ctx);
  appendFileSync(
    output + '/steps.log',
    new Date().toISOString() +
      ' END ' +
      name +
      ' ' +
      JSON.stringify(result.output.filter((p) => p.type === 'text')) +
      '\n'
  );
  const text = result.output
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
  assert(!result.isError, text);
  const metadata = [];
  for (const p of result.output)
    if (p.type === 'image') {
      const data = Buffer.from(p.data, 'base64'),
        valid = validateAgentImage(p.mimeType, data);
      assert(valid.ok);
      const id = randomUUID();
      images.set(id, {
        mimeType: p.mimeType,
        data,
        byteLength: data.length,
        width: valid.width,
        height: valid.height,
      });
      metadata.push({
        id,
        runId,
        mimeType: p.mimeType,
        byteLength: data.length,
        width: valid.width,
        height: valid.height,
      });
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
  snapshot.sequence++;
  return { result, text };
}
async function capture(engine) {
  await tool('desktop_observe');
  // The observer deliberately skips busy capture and shares a two-second cache.
  await pause(2100);
  let frame;
  await until(async () => {
    frame = await manager.getDesktopFrame();
    return Boolean(frame);
  }, 'Live frame unavailable after successful desktop observation');
  writeFileSync(output + '/' + engine + '-rps-desktop.png', frame.data);
  const page = (await tool('browser_screenshot')).result.output.find((p) => p.type === 'image');
  writeFileSync(output + '/' + engine + '-rps-page.png', Buffer.from(page.data, 'base64'));
}
try {
  const install = await command(['/usr/bin/npm', 'ci', '--no-audit', '--no-fund']);
  writeFileSync(output + '/npm-ci.log', install);
  console.log('PASS npm ci through controlled relay in network-isolated workspace');
  const build = await command(['/usr/bin/npm', 'run', 'build']);
  writeFileSync(output + '/build.log', build);
  console.log('PASS existing RPS application builds without source changes');
  await command([
    '/usr/bin/bash',
    '-c',
    'PORT=8765 HOST=127.0.0.1 B70_APP_DATA=/tmp/rps-data /usr/bin/node server.mjs > /tmp/rps-server.log 2>&1 < /dev/null &',
  ]);
  await command(
    [
      '/usr/bin/bash',
      '-c',
      'for i in $(seq 1 40); do curl --fail --silent http://127.0.0.1:8765/ > /dev/null && exit 0; sleep .25; done; cat /tmp/rps-server.log; exit 1',
    ],
    20
  );
  const detail = () =>
    DurableTaskDetailSchema.parse({
      task,
      runs: [run],
      messages: [],
      latestSnapshot: snapshot,
      traceEventCount: 0,
    });
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
    getDesktopFrame: async (id) => (id === runId ? manager.getDesktopFrame() : undefined),
    getRunImage: async (id, imageId) => {
      assert.equal(id, runId);
      assert(images.has(imageId));
      return images.get(imageId);
    },
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
  app = buildApp({
    config: loadServerConfig(),
    version: 'visible-browser-rps',
    loggerLevel: 'silent',
    webRoot: resolve('packages/web/dist'),
    agent: controller,
    auth: { mode: 'development', sessions: {}, sessionDays: 1, cookieSecure: false },
  });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  observer = await openBrowser();
  await observer.send('Page.enable');
  await observer.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "localStorage.setItem('observatory.locale','de')",
  });
  await observer.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 960,
    deviceScaleFactor: 1,
    mobile: false,
  });
  for (const browser of ['chromium', 'firefox']) {
    await tool('browser_open', { url: 'http://127.0.0.1:8765', browser, width: 1100, height: 740 });
    await tool('browser_action', {
      action: 'click',
      selector: 'section[aria-labelledby="vsComputer"] button:nth-child(2)',
    });
    await pause(1500);
    let inspected = (await tool('browser_inspect')).text;
    writeFileSync(output + '/' + browser + '-inspect-setup.txt', inspected);
    assert(!inspected.includes('webgl-fallback'), inspected);
    const canvas = (await tool('browser_inspect', { selector: '.board3d canvas' })).text;
    assert(canvas.includes('CANVAS') || canvas.includes('canvas'), canvas);
    await tool('browser_action', {
      action: 'click',
      selector: '.side .btnrow button:nth-child(2)',
    });
    await pause(700);
    await tool('browser_action', { action: 'click', selector: '[data-rps="rock"]' });
    // Opening RPS ties require a new, observed choice; AI thinking is asynchronous.
    for (let attempt = 0; attempt < 15; attempt++) {
      await pause(1000);
      inspected = (await tool('browser_inspect', { selector: '[data-rps="paper"]:enabled' })).text;
      if (inspected.includes('Ihr Zug:')) break;
      // The sidebar says 'waiting for opponent' even before our own choice.
      // Observe the enabled control rather than inferring state from that text.
      if (JSON.parse(inspected.split('\n')[0]).target)
        await tool('browser_action', { action: 'click', selector: '[data-rps="paper"]' });
    }
    assert(inspected.includes('Ihr Zug:'), inspected);
    writeFileSync(output + '/' + browser + '-inspect-playing.txt', inspected);
    await tool('browser_action', { action: 'click', selector: '[data-pos="7"]' });
    await tool('browser_action', { action: 'click', selector: '[data-pos="14"]' });
    await pause(1200);
    inspected = (await tool('browser_inspect')).text;
    assert(inspected.includes('A2 → A3'), inspected);
    writeFileSync(output + '/' + browser + '-inspect-move.txt', inspected);
    await tool('browser_resize', { width: 1800, height: 1000 });
    inspected = (await tool('browser_inspect')).text;
    assert(inspected.includes('A2 → A3'), 'Resize lost the existing game: ' + inspected);
    await capture(browser);
    if (browser === 'chromium')
      await observer.send('Page.navigate', { url: url + '/#/agent/' + taskId });
    else await observer.send('Page.reload', { ignoreCache: true });
    await until(
      () =>
        observer.evaluate(
          "document.querySelector('.desktop-screen img')?.naturalWidth > 0 && document.querySelector('.desktop-status')?.textContent.includes('Live')"
        ),
      'Live browser pane missing'
    );
    await pause(500);
    await observer.capture(output + '/' + browser + '-dashboard.png');
    steps.push(
      browser +
        ': actual RPS 3D game, setup, opening choice, actual move and resize preserving the game via existing browser tools, visible in dashboard'
    );
    console.log('PASS ' + steps.at(-1));
  }
  const diff = execFileSync('/usr/bin/git', ['-C', workspace, 'diff', '--name-only'], {
    encoding: 'utf8',
  });
  assert.equal(diff, '', 'RPS source/lock changed');
  assert.equal(taskLimitHits, 0, 'Sandbox task limit reached during browser/capture work');
  writeFileSync(
    output + '/report.json',
    JSON.stringify(
      {
        passed: true,
        source: resolve(source),
        revision,
        steps,
        modelCalls: 0,
        sourceChanged: false,
        runId,
        images: images.size,
        maxTasks,
        taskLimitHits,
      },
      null,
      2
    )
  );
} catch (error) {
  writeFileSync(
    output + '/failure.json',
    JSON.stringify({ message: error.message, maxTasks, taskLimitHits }, null, 2)
  );
  await observer?.capture(output + '/failure.png').catch(() => {});
  throw error;
} finally {
  clearInterval(diagnosticTimer);
  await observer?.close();
  await app?.close();
  await env.close();
  registry.revoke(token);
  await registry.close();
}
