/** Real browser regression: streamed trace growth, reading position and delivered messages.
 * Disposable controller/HTTP server, no model calls or production changes.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { buildApp } from '../packages/server/dist/app.js';
import { loadServerConfig } from '../packages/server/dist/config.js';
import {
  AgentRunSnapshotSchema,
  DurableTaskDetailSchema,
  SERVICE_NAME,
} from '../packages/contracts/dist/index.js';
import { openBrowser, pause, until } from './lib/browser-cdp.mjs';

const output = resolve(process.argv[2] ?? 'build/cockpit-follow-acceptance');
mkdirSync(output, { recursive: true });
const runId = randomUUID(),
  taskId = randomUUID(),
  projectId = randomUUID(),
  imageId = randomUUID();
const now = new Date().toISOString();
const run = {
  id: runId,
  taskId,
  turnId: randomUUID(),
  status: 'running',
  version: 1,
  profileId: 'fixture',
  baseRevision: 'a'.repeat(40),
  checkStatus: 'not_run',
  createdAt: now,
  startedAt: now,
};
const task = {
  id: taskId,
  title: 'Following and delivery regression',
  projectId,
  projectName: 'Disposable fixture',
  status: 'open',
  version: 1,
  createdAt: now,
  updatedAt: now,
  latestRun: run,
};
let snapshot = AgentRunSnapshotSchema.parse({
  service: SERVICE_NAME,
  enabled: true,
  status: 'running',
  runId,
  sequence: 0,
  startedAt: now,
  pendingSteering: 0,
  timeline: Array.from({ length: 30 }, (_, i) => ({
    id: randomUUID(),
    at: now,
    kind: 'tool',
    title: 'Tool ' + i,
    toolName: 'bash',
    argumentsText: '{"command":"fixture"}',
    outputText: 'Existing output\n'.repeat(8),
    state: 'complete',
  })),
});
const listeners = new Set();
const deliveries = [];
const checks = [];
let detailReads = 0,
  app,
  browser,
  confirmation;
const png = readFileSync('packages/runner/test/fixtures/desktop/blank.png');
function emit(event) {
  snapshot.sequence++;
  for (const listener of listeners) listener({ ...event, runId, sequence: snapshot.sequence });
}
function append(item) {
  snapshot.timeline.push(item);
  emit({ operation: 'append', item });
}
function replace(item) {
  snapshot.timeline[snapshot.timeline.findIndex((x) => x.id === item.id)] = item;
  emit({ operation: 'replace', item });
}
function state() {
  const { timeline, ...value } = snapshot;
  void timeline;
  value.sequence = snapshot.sequence + 1;
  emit({ operation: 'state', state: value });
}
const controller = {
  snapshot: () => snapshot,
  subscribe: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  close: async () => {},
  start: async () => snapshot,
  listTasks: async () => ({ items: [task], activeTaskId: taskId, activeTaskIds: [taskId] }),
  getTask: async () => {
    detailReads++;
    return DurableTaskDetailSchema.parse({
      task,
      runs: [run],
      messages: [],
      traceEventCount: snapshot.sequence,
      latestSnapshot: snapshot,
      steering: deliveries,
    });
  },
  listProjects: async () => [],
  getRunTrace: async () => ({ runId, items: [], hasMore: false }),
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
  getRunImage: async () => {
    await pause(700);
    return { mimeType: 'image/png', data: png, byteLength: png.length, width: 640, height: 480 };
  },
  steer: async (input) => {
    run.version++;
    task.version++;
    const entry = {
      id: randomUUID(),
      runId,
      text: input.message,
      status: 'acknowledged',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    deliveries.push(entry);
    snapshot.pendingSteering = 1;
    state();
    confirmation = setTimeout(() => {
      entry.confirmedAt = new Date().toISOString();
      entry.updatedAt = entry.confirmedAt;
      append({
        id: randomUUID(),
        at: entry.confirmedAt,
        kind: 'steering',
        title: 'Delivered',
        text: entry.text,
        state: 'complete',
      });
      snapshot.pendingSteering = 0;
      state();
    }, 1200);
    return snapshot;
  },
};
async function pinned(label) {
  await until(
    () =>
      browser.evaluate(
        "(()=>{const e=document.querySelector('.agent-timeline');return e && e.scrollHeight-e.clientHeight-e.scrollTop<=2 && !document.querySelector('.follow-button')})()"
      ),
    label
  );
  checks.push(label);
  console.log('PASS ' + label);
}
async function wheel(deltaY) {
  const rect = await browser.evaluate(
    "(()=>{const r=document.querySelector('.agent-timeline').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()"
  );
  await browser.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: rect.x,
    y: rect.y,
    deltaX: 0,
    deltaY,
  });
  await pause(250);
}
const tool = (text) => ({
  id: randomUUID(),
  at: new Date().toISOString(),
  kind: 'tool',
  title: 'Streaming tool',
  toolName: 'bash',
  argumentsText: '{}',
  outputText: text,
  state: 'running',
});
try {
  app = buildApp({
    config: loadServerConfig(),
    version: 'follow-acceptance',
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
    height: 960,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await browser.send('Page.navigate', { url: url + '/#/agent/' + taskId });
  await until(
    () => browser.evaluate("document.querySelectorAll('.timeline-item').length===30"),
    'Fixture did not load'
  );
  await pinned('Live conversation starts pinned');
  assert.equal(
    await browser.evaluate(
      "getComputedStyle(document.querySelector('.agent-timeline')).scrollBehavior"
    ),
    'auto'
  );
  for (let i = 0; i < 10; i++) {
    append(tool('Streaming ' + i + '\n' + 'line\n'.repeat(15)));
    await pause(30);
  }
  await pinned('Tool-call bursts do not cancel following');
  replace({ ...snapshot.timeline[2], outputText: 'Late output in an earlier tool\n'.repeat(200) });
  await pinned('Output growth in an earlier tool keeps the end visible');
  const picture = tool('Delayed screenshot');
  picture.images = [
    { id: imageId, runId, mimeType: 'image/png', byteLength: png.length, width: 640, height: 480 },
  ];
  append(picture);
  await pause(1200);
  await pinned('Delayed inline image stays pinned');
  await browser.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await pause(200);
  await pinned('Viewport height change stays pinned');
  await browser.capture(join(output, '01-following.png'));
  await wheel(-10);
  await until(
    () => browser.evaluate("!!document.querySelector('.follow-button')"),
    'Small upward scroll did not pause following'
  );
  append(tool('Output after a small upward gesture'));
  await pause(150);
  assert.equal(await browser.evaluate("!!document.querySelector('.follow-button')"), true);
  checks.push('A small upward gesture inside the bottom tolerance pauses following');
  await browser.evaluate("document.querySelector('.follow-button').click()");
  await pinned('Follow resumes after small upward gesture');
  await wheel(-650);
  await until(
    () => browser.evaluate("!!document.querySelector('.follow-button')"),
    'User scroll did not pause following'
  );
  append(tool('New output while reading\n'.repeat(80)));
  await pause(200);
  assert(
    await browser.evaluate(
      "(()=>{const e=document.querySelector('.agent-timeline');return e.scrollHeight-e.clientHeight-e.scrollTop>200 && !!document.querySelector('.follow-button')})()"
    )
  );
  checks.push('Real upward wheel input pauses follow and new output leaves the reader in place');
  await browser.capture(join(output, '02-reading.png'));
  await browser.evaluate("document.querySelector('.follow-button').click()");
  await pinned('Follow button resumes pinning');
  await wheel(-500);
  await wheel(100000);
  append(tool('After scrolling to the end\n'.repeat(20)));
  await pinned('Manual scroll to the bottom resumes follow');
  // Native scrollbar input must pause even if its scroll event follows pointerup.
  const bounds = await browser.evaluate(
    "(()=>{const r=document.querySelector('.agent-timeline').getBoundingClientRect();return {x:r.right-7,y:r.bottom-24}})()"
  );
  await browser.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: bounds.x,
    y: bounds.y,
    button: 'left',
    clickCount: 1,
  });
  await browser.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: bounds.x,
    y: bounds.y - 120,
    button: 'left',
    buttons: 1,
  });
  await browser.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: bounds.x,
    y: bounds.y - 120,
    button: 'left',
    clickCount: 1,
  });
  await until(
    () => browser.evaluate("!!document.querySelector('.follow-button')"),
    'Scrollbar drag failed to pause follow'
  );
  append(tool('Output while scrollbar-paused'));
  await pause(150);
  assert(await browser.evaluate("!!document.querySelector('.follow-button')"));
  checks.push('Native scrollbar dragging pauses following');
  await browser.evaluate("document.querySelector('.follow-button').click()");
  await pinned('Follow resumes after scrollbar drag');
  await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  const touch = await browser.evaluate(
    "(()=>{const r=document.querySelector('.agent-timeline').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+70}})()"
  );
  await browser.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ ...touch, id: 1 }],
  });
  for (let dy = 30; dy <= 150; dy += 30) {
    await browser.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: touch.x, y: touch.y + dy, id: 1 }],
    });
    await pause(30);
  }
  await browser.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await until(
    () => browser.evaluate("!!document.querySelector('.follow-button')"),
    'Touch upward scroll failed to pause follow'
  );
  append(tool('Output while touch-paused'));
  await pause(250);
  assert(await browser.evaluate("!!document.querySelector('.follow-button')"));
  checks.push('Real touch scrolling pauses following');
  await browser.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await browser.evaluate("document.querySelector('.follow-button').click()");
  await pinned('Follow resumes after touch scroll');
  await browser.evaluate(
    "(()=>{const e=document.querySelector('.task-input textarea');e.value='Apply the existing UI';e.dispatchEvent(new Event('input',{bubbles:true}));e.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));})()"
  );
  await until(
    () =>
      browser.evaluate(
        "document.querySelector('.pending-messages')?.textContent.includes('Apply the existing UI')"
      ),
    'Pending message missing'
  );
  await pinned('Pending-message area does not detach the timeline');
  await until(
    () =>
      browser.evaluate(
        "!document.querySelector('.pending-messages') && [...document.querySelectorAll('.timeline-item.steering')].some(e=>e.textContent.includes('Apply the existing UI'))"
      ),
    'Delivered message remained in Send Messages'
  );
  await pinned('Confirmed delivery leaves the queue and remains in the transcript');
  await pause(250);
  const reads = detailReads;
  await pause(1300);
  assert.equal(detailReads, reads, 'Delivery polling did not stop after confirmation');
  checks.push('Delivery polling stops after confirmation');
  await browser.capture(join(output, '03-delivered.png'));
  writeFileSync(
    join(output, 'report.json'),
    JSON.stringify(
      { passed: true, checks, detailReads, modelCalls: 0, productionChanged: false },
      null,
      2
    ) + '\n'
  );
} catch (error) {
  await browser?.capture(join(output, 'failure.png')).catch(() => {});
  writeFileSync(
    join(output, 'failure.json'),
    JSON.stringify({ error: String(error), checks }, null, 2)
  );
  throw error;
} finally {
  clearTimeout(confirmation);
  await browser?.close();
  await app?.close();
}
