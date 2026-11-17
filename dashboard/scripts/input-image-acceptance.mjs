/** Real GUI → Unix control → sandboxed fixture agent → hosted app, no production services. */
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { buildApp } from '../packages/server/dist/app.js';
import { loadServerConfig } from '../packages/server/dist/config.js';
import { createRunner } from '../packages/server/dist/runner/service.js';
import { RunnerAgentClient } from '../packages/server/dist/agent/runner-client.js';

const root = mkdtempSync(join(tmpdir(), 'bqa-'));
const output = resolve('target/input-images');
mkdirSync(output, { recursive: true });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, message, milliseconds = 15000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(100);
  }
  throw new Error(message);
}
const repository = join(root, 'repo');
for (const directory of [
  'repo/dashboard/node_modules',
  'runs',
  'profile',
  'agent',
  'inference',
  'control',
])
  mkdirSync(join(root, directory), { recursive: true });
const git = (...args) =>
  execFileSync('/usr/bin/git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'App QA');
git('config', 'user.email', 'qa@b70.invalid');
writeFileSync(join(repository, 'README.md'), '# QA\n');
git('add', '.');
git('commit', '-qm', 'QA fixture');
writeFileSync(join(root, 'profile/models.json'), '{}\n');
writeFileSync(
  join(root, 'agent/fixture.mjs'),
  `
import readline from 'node:readline';
import { writeFileSync } from 'node:fs';
readline.createInterface({ input: process.stdin }).on('line', (line) => {
 const command = JSON.parse(line);
 console.log(JSON.stringify({ type: 'response', id: command.id, success: true, data: {} }));
 if (command.type === 'prompt') {
  console.log(JSON.stringify({ type: 'agent_start' }));
  if (command.images?.length !== 1 || command.images[0].type !== 'image') throw new Error('Reference missing from Pi prompt');
  writeFileSync('/workspace/reference-received.json', JSON.stringify({ mimeType: command.images[0].mimeType, bytes: Buffer.from(command.images[0].data, 'base64').length }));
  writeFileSync('/workspace/index.html', '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><title>App QA</title><h1>App aus dem Dashboard</h1><p>GUI und Sandbox funktionieren.</p></html>');
  console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'App erstellt. Über App starten ausprobieren.' }], stopReason: 'stop' } }));
  console.log(JSON.stringify({ type: 'agent_settled' }));
 }
});
`
);
// Exercise originals beyond both of the former source limits, without putting
// the large source bytes into JSON, RPC, or a browser data URL.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k += 1) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function pngChunk(type, payload) {
  const data = Buffer.concat([Buffer.from(type), payload]);
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, data, checksum]);
}
function largePixelPng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = width * 3 + 1;
  const pixels = Buffer.alloc(stride * height, 102);
  for (let row = 0; row < height; row += 1) pixels[row * stride] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

let runner, client, app, chrome, ws;
try {
  runner = await createRunner({
    controlSocket: join(root, 'control/control.sock'),
    controlToken: 'a'.repeat(64),
    inferenceSocketRoot: join(root, 'inference'),
    databasePath: join(root, 'tasks.sqlite'),
    repository,
    targetBranch: 'main',
    stateRoot: join(root, 'runs'),
    supportRoot: resolve('packages/runner/dist'),
    supportExecutable: 'sandbox-entry.js',
    agentRuntimeRoot: join(root, 'agent'),
    agentExecutable: 'fixture.mjs',
    profileRoot: join(root, 'profile'),
    dependencyRoot: join(repository, 'dashboard/node_modules'),
    revision: git('rev-parse', 'HEAD'),
    upstreamUrl: 'http://127.0.0.1:9',
    provider: 'fixture',
    model: 'fixture',
    thinkingLevel: 'off',
    profileId: 'qa',
    maxActiveRuns: 2,
    releaseSocket: join(root, 'unused.sock'),
    appHost: '127.0.0.1',
  });
  await runner.relay.start();
  await runner.control.start();
  client = new RunnerAgentClient(join(root, 'control/control.sock'), 'a'.repeat(64));
  app = buildApp({
    config: loadServerConfig(),
    version: 'app-qa',
    loggerLevel: 'silent',
    webRoot: resolve('packages/web/dist'),
    agent: client,
    auth: { mode: 'development', sessions: {}, sessionDays: 1, cookieSecure: false },
  });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  chrome = spawn(
    '/usr/bin/google-chrome-stable',
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--remote-debugging-port=0',
      `--user-data-dir=${join(root, 'chrome')}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  let port;
  await until(() => {
    try {
      port = Number(readFileSync(join(root, 'chrome/DevToolsActivePort'), 'utf8').split('\n')[0]);
      return port > 0;
    } catch {
      return false;
    }
  }, 'Chrome did not start');
  const target = await (
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
  ).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await once(ws, 'open');
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data));
    if (pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const key = ++id;
      pending.set(key, { resolve, reject });
      ws.send(JSON.stringify({ id: key, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  const visible = (selector) => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
  const set = (selector, value) =>
    evaluate(
      `(() => { const el=document.querySelector(${JSON.stringify(selector)}); el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', {bubbles:true})); })()`
    );
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try { localStorage.setItem('observatory.locale', 'de'); } catch {}",
  });
  await send('Emulation.setDeviceMetricsOverride', {
    width: 820,
    height: 1180,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.navigate', { url: url + '/#/agent' });
  await until(() => visible('#agent-project-mode'), 'Task GUI missing');
  await set('#agent-project-mode', 'app');
  await until(() => visible('#new-project-name'), 'New app fields missing');
  await set('#new-project-name', 'Meine App vom iPad');
  await set('#agent-name', 'App QA');
  await set('#agent-task', 'Erstelle meine Web-App');
  // A real oversized PNG is resized/compressed by the actual browser picker.
  const sourceImage = await evaluate(`(() => {
    const canvas = document.createElement('canvas'); canvas.width = 2100; canvas.height = 1000;
    const ctx = canvas.getContext('2d'); const pixels = ctx.createImageData(canvas.width, canvas.height);
    let seed = 12345;
    for (let i = 0; i < pixels.data.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pixels.data[i] = seed & 255; pixels.data[i + 1] = seed >>> 8 & 255; pixels.data[i + 2] = seed >>> 16 & 255; pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0); return canvas.toDataURL('image/png').split(',')[1];
  })()`);
  const referencePath = join(root, 'reference.png');
  const png = Buffer.from(sourceImage, 'base64');
  const padding = pngChunk(
    'tEXt',
    Buffer.concat([Buffer.from('ReferenceComment\0'), Buffer.alloc(24 * 1024 * 1024, 65)])
  );
  writeFileSync(referencePath, Buffer.concat([png.subarray(0, 33), padding, png.subarray(33)]));
  const largePixelsPath = join(root, '48-megapixels.png');
  writeFileSync(largePixelsPath, largePixelPng(8000, 6000));
  console.log('Checking original >24 MiB and a second original with 48 megapixels.');
  async function attach(selector, path = referencePath) {
    const { root: documentRoot } = await send('DOM.getDocument');
    const { nodeId } = await send('DOM.querySelector', { nodeId: documentRoot.nodeId, selector });
    if (!nodeId) throw new Error('Image picker missing');
    await send('DOM.setFileInputFiles', { nodeId, files: [path] });
    await until(
      () =>
        evaluate(
          `document.querySelector(${JSON.stringify(selector.replace('input[type=file]', '.image-previews img'))})?.naturalWidth === 1920`
        ),
      'Prepared image preview missing'
    );
  }
  await attach('form.agent-form input[type=file]');
  await evaluate("document.querySelector('form.agent-form .image-open').click()");
  await until(() => visible('form.agent-form dialog[open]'), 'Enlarged reference missing');
  await evaluate("document.querySelector('form.agent-form dialog button').click()");

  await send('Page.captureScreenshot', { format: 'png' }).then(({ data }) =>
    writeFileSync(join(output, '01-new-app-ipad.png'), Buffer.from(data, 'base64'))
  );
  await evaluate("document.querySelector('form.agent-form').requestSubmit()");
  await until(
    () =>
      evaluate("!!document.querySelector('.agent-app-panel button.primary-button:not(:disabled)')"),
    'Completed app result missing'
  );

  const initialTasks = await client.listTasks();
  const imageTaskId = initialTasks.items[0].id;
  const initialDetail = await client.getTask(imageTaskId);
  const initialRunId = initialDetail.task.latestRun.id;
  const initialReference = initialDetail.latestSnapshot.timeline.find(
    (item) => item.kind === 'task'
  ).images[0];
  if (initialReference.width !== 1920 || initialReference.byteLength > 1024 * 1024)
    throw new Error('Image preparation limits not applied');
  if (initialReference.byteLength < 128 * 1024)
    throw new Error('Fixture must exercise the expanded control body limit');
  const originalBinary = await client.getRunImage(initialRunId, initialReference.id);
  if (originalBinary.data.length !== initialReference.byteLength)
    throw new Error('Reference binary did not survive IPC/storage');
  await until(() => visible('.task-input input[type=file]'), 'Continuation image picker missing');
  await attach('.task-input input[type=file]', largePixelsPath);
  await set('#task-input', 'Passe die App an dieses Referenzbild an und prüfe sie im Browser.');
  await evaluate("document.querySelector('form.task-input').requestSubmit()");
  await until(
    async () => {
      const detail = await client.getTask(imageTaskId);
      return (
        detail.task.latestRun.id !== initialRunId && detail.task.latestRun.status === 'completed'
      );
    },
    'Continuation with reference failed',
    30000
  );
  const continued = await client.getTask(imageTaskId);
  if (!continued.latestSnapshot.timeline.find((item) => item.kind === 'task')?.images?.length)
    throw new Error('Continuation reference missing from transcript');
  // A later continuation without uploading again must receive the same reference set.
  const inherited = await client.continueTask({
    taskId: imageTaskId,
    message: 'Prüfe die gespeicherte Referenz nochmals.',
    idempotencyKey: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
  });
  await until(
    async () => (await client.getTask(imageTaskId)).task.latestRun.status === 'completed',
    'Reference inheritance failed',
    30000
  );
  const latest = await client.getTask(imageTaskId);
  if (latest.task.latestRun.id !== inherited.runId) throw new Error('Wrong continuation run');
  const inheritedReference = latest.latestSnapshot.timeline.find((item) => item.kind === 'task')
    ?.images?.[0];
  if (!inheritedReference || inheritedReference.runId !== inherited.runId)
    throw new Error('Inherited reference was not rebound to the new run');
  await send('Page.reload');
  await until(
    () => visible('.agent-app-panel button.primary-button:not(:disabled)'),
    'Completed continuation missing from GUI'
  );
  await until(
    () => evaluate('!!document.querySelector(\'img[src*="/images/"]\')'),
    'Inline reference missing after reload'
  );
  await evaluate("document.querySelector('.agent-app-panel button.primary-button').click()");
  await until(() => visible('.agent-app-panel a'), 'Hosted app link missing');
  const appUrl = await evaluate("document.querySelector('.agent-app-panel a').href");
  if (!appUrl.startsWith('http://127.0.0.1:'))
    throw new Error('App link must use dashboard hostname');
  if (await evaluate('document.documentElement.scrollWidth > window.innerWidth'))
    throw new Error('Horizontal overflow on iPad');
  await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }).then(
    ({ data }) =>
      writeFileSync(join(output, '02-running-app-ipad.png'), Buffer.from(data, 'base64'))
  );
  await send('Page.navigate', { url: appUrl });
  await until(
    () => evaluate("document.querySelector('h1')?.textContent === 'App aus dem Dashboard'"),
    'App did not render'
  );
  await send('Page.captureScreenshot', { format: 'png' }).then(({ data }) =>
    writeFileSync(join(output, '03-open-app-ipad.png'), Buffer.from(data, 'base64'))
  );
  const projects = await client.listProjects();
  const created = projects.find((entry) => entry.name === 'Meine App vom iPad');
  if (!created?.appCapable) throw new Error('Managed project missing');
  const tasks = await client.listTasks();
  const task = tasks.items.find((entry) => entry.projectId === created.id);
  const detail = await client.getTask(task.id);
  const state = await client.getAppPreview(created.id);
  if (state.revision !== detail.latestResult.resultRevision)
    throw new Error('Preview did not use the selected task revision');
  try {
    await client.startAppPreview({
      projectId: created.id,
      runId: task.latestRun.id,
      revision: 'f'.repeat(40),
    });
    throw new Error('Stale revision was accepted');
  } catch (error) {
    if (error.code !== 'conflict') throw error;
  }
  const otherProject = await client.createProject({
    name: 'Separate app',
    idempotencyKey: 'abababab-abab-4bab-8bab-abababababab',
    source: { kind: 'app' },
  });
  try {
    await client.startAppPreview({
      projectId: otherProject.id,
      runId: task.latestRun.id,
      revision: state.revision,
    });
    throw new Error('Foreign project run was accepted');
  } catch (error) {
    if (error.code !== 'conflict') throw error;
  }
  try {
    await client.getAppPreview('99999999-9999-4999-8999-999999999999');
    throw new Error('Unknown project was accepted');
  } catch (error) {
    if (error.code !== 'not_found') throw error;
  }
  await client.stopAppPreview(created.id);
  if ((await client.getAppPreview(created.id)).status !== 'stopped') throw new Error('Stop failed');
  console.log(
    'PASS: real tablet browser prepares/uploads reference images; Unix IPC delivers them to the sandboxed Pi fixture; transcript/reload, continuation with images, and inherited references work. App preview still works.'
  );
  console.log(`Screenshots: ${output}`);
} finally {
  ws?.close();
  if (chrome) {
    const exited = once(chrome, 'exit');
    chrome.kill('SIGKILL');
    await exited;
  }
  if (app) {
    app.server.closeAllConnections();
    await app.close();
  }
  await client?.close();
  await runner?.control.close();
  await runner?.service.close();
  await runner?.relay.close();
  rmSync(root, { recursive: true, force: true });
}
