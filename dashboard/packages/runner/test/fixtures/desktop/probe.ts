/** Trusted acceptance probe, executed only through the real sandbox launcher. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { createServer } from 'node:http';
import { BrowserSession } from '../../../src/browser.js';
import registerDesktopTools from '../../../src/desktop-extension.js';
import { desktopEnvironment, type DesktopResult } from '../../../src/desktop.js';

const evidence = '/workspace/evidence';
mkdirSync(evidence, { recursive: true });
const tools = new Map<
  string,
  { execute: (id: string, input: unknown) => Promise<DesktopResult> }
>();
const cleanup: Array<() => void | Promise<void>> = [];
registerDesktopTools(
  {
    registerTool(tool) {
      tools.set(
        String(tool.name),
        tool as unknown as { execute: (id: string, input: unknown) => Promise<DesktopResult> }
      );
    },
    on(_event, handler) {
      cleanup.push(() => handler({}));
    },
  },
  true
);
let sequence = 0;
const results: Array<Record<string, unknown>> = [];
let latest: Record<string, unknown> = {};
function diagnostics(directory = '/tmp/b70-desktop', prefix = '') {
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = directory + '/' + entry.name;
      if (entry.isDirectory()) diagnostics(path, prefix + entry.name + '-');
      else if (entry.isFile() && entry.name.endsWith('.log') && statSync(path).size < 128 * 1024)
        writeFileSync(`${evidence}/${prefix}${entry.name}`, readFileSync(path));
    }
  } catch {
    /* Diagnostics must not hide the original failure. */
  }
}
async function call(name: string, input: unknown = {}, allowError = false) {
  const result = await tools.get(name)!.execute(`probe-${++sequence}`, input);
  const step = String(sequence).padStart(2, '0') + '-' + name;
  const text = result.content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n');
  const picture = result.content.find((part) => part.type === 'image');
  if (picture?.type === 'image') {
    writeFileSync(`${evidence}/${step}.png`, Buffer.from(picture.data, 'base64'));
    latest = JSON.parse(text.split('\n')[1]!) as Record<string, unknown>;
  }
  const log = {
    step,
    input,
    isError: result.isError ?? false,
    text,
    image: picture ? step + '.png' : null,
  };
  results.push(log);
  writeFileSync(`${evidence}/steps.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ step, isError: result.isError ?? false, screenshot: !!picture }));
  if (!allowError) assert(!result.isError, text);
  return result;
}
async function observeWindow(title: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    await call('desktop_observe');
    const found = (latest.windows as Array<Record<string, unknown>>).find(
      (window) => window.title === title
    );
    if (found)
      return found as {
        id: string;
        geometry: { x: number; y: number; width: number; height: number };
      };
    await new Promise((accept) => setTimeout(accept, 150));
  }
  throw new Error('Window did not appear: ' + title);
}
async function action(args: Record<string, unknown>) {
  await call('desktop_action', { ...args, snapshot: latest.snapshot });
}
try {
  // Verify the actual job boundary before launching any GUI.
  assert.equal(process.getuid!(), 65534);
  assert.equal(process.env.DISPLAY, undefined);
  assert.equal(process.env.DBUS_SESSION_BUS_ADDRESS, undefined);
  assert(!existsSync('/home/operator'));
  assert(!existsSync('/run/dbus/system_bus_socket'));
  assert(!existsSync('/dev/dri'));
  assert(!existsSync('/dev/uinput'));
  assert.equal(process.env.B70_RUNNER_GATEWAY_TOKEN, undefined);
  assert.equal(process.env.B70_RUNNER_CONTROL_TOKEN, undefined);
  assert.throws(() => writeFileSync('/runtime/desktop/.write-probe', 'denied'), /read-only|EROFS/i);
  assert.match(readFileSync('/proc/self/status', 'utf8'), /CapEff:\s+0000000000000000/);
  const networkBlocked = await new Promise<boolean>((accept) => {
    const socket = connect({ host: '192.168.50.10', port: 8090 });
    socket.setTimeout(1500, () => {
      socket.destroy();
      accept(true);
    });
    socket.once('error', () => accept(true));
    socket.once('connect', () => {
      socket.destroy();
      accept(false);
    });
  });
  assert(networkBlocked, 'Host network unexpectedly reachable');
  execFileSync('/usr/bin/g++', [
    '-std=c++17',
    '/workspace/canvas.cpp',
    '-lX11',
    '-o',
    '/workspace/canvas',
  ]);
  const qtFlags = execFileSync('/usr/bin/pkg-config', ['--cflags', '--libs', 'Qt6Widgets'], {
    encoding: 'utf8',
  })
    .trim()
    .split(/\s+/);
  execFileSync('/usr/bin/g++', [
    '-std=c++17',
    '-fPIC',
    '-pie',
    '/workspace/widgets.cpp',
    '-o',
    '/workspace/widgets',
    ...qtFlags,
  ]);
  const started = await call('desktop_start');
  assert(
    started.content.some((part) => part.type === 'image'),
    'Desktop start did not deliver an image'
  );
  await new Promise((accept) => setTimeout(accept, 1000));
  diagnostics();
  const attached = JSON.parse(
    execFileSync(
      '/runtime/desktop/bin/agent-workspace-linux',
      ['workspace', 'env', '--id', 'b70'],
      { env: desktopEnvironment(), encoding: 'utf8' }
    )
  );
  const variables = Object.fromEntries(
    attached.environment.variables.map((item: { name: string; value: string }) => [
      item.name,
      item.value,
    ])
  );
  const wm = execFileSync('/runtime/desktop/usr/bin/xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'], {
    env: { ...desktopEnvironment(), ...variables },
    encoding: 'utf8',
  });
  assert.match(wm, /window id # 0x[0-9a-f]+/i, 'Window manager is not running: ' + wm);
  if (process.env.B70_BROWSER_ROOT) {
    const server = createServer((_request, response) => response.end('<h1>Browser and native desktop coexist</h1>'));
    await new Promise<void>((accept) => server.listen(0, '127.0.0.1', accept));
    server.unref();
    const browser = new BrowserSession();
    try {
      const address = server.address();
      assert(address && typeof address !== 'string');
      await browser.navigate(`http://localhost:${address.port}`, { width: 820, height: 600 });
      const inspection = await browser.inspect();
      assert(inspection.includes('Browser and native desktop coexist'));
      const screenshot = await browser.screenshot(false);
      writeFileSync(`${evidence}/browser-coexistence.png`, screenshot.png);
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((accept) => server.close(() => accept()));
    }
  }
  await call('desktop_launch', { command: ['./canvas'] });
  const canvas = await observeWindow('B70 Native Canvas');
  const stale = latest.snapshot;
  await action({ action: 'click', x: canvas.geometry.x + 60, y: canvas.geometry.y + 80 });
  assert(
    (await call('desktop_action', { action: 'click', x: 1, y: 1, snapshot: stale }, true)).isError
  );
  await action({ action: 'type', text: 'canvas42' });
  await action({
    action: 'scroll',
    x: canvas.geometry.x + 300,
    y: canvas.geometry.y + 200,
    direction: 'down',
    amount: 2,
  });
  const state = readFileSync('/workspace/canvas-state.txt', 'utf8');
  assert.equal(state.split('\n')[0], '1', state);
  assert(Number(state.split('\n')[1]) >= 2, state);
  assert(state.includes('canvas42'), state);
  await action({ action: 'double_click', x: canvas.geometry.x + 60, y: canvas.geometry.y + 80 });
  assert.equal(readFileSync('/workspace/canvas-state.txt', 'utf8').split('\n')[0], '3');
  await action({
    action: 'drag',
    x: canvas.geometry.x + 300,
    y: canvas.geometry.y + 250,
    toX: canvas.geometry.x + 440,
    toY: canvas.geometry.y + 280,
  });
  assert.equal((latest.pointer as { x: number }).x, canvas.geometry.x + 440);
  assert.equal((latest.pointer as { y: number }).y, canvas.geometry.y + 280);
  await call('desktop_launch', { command: ['./widgets'] });
  const widgets = await observeWindow('B70 Native Widgets');
  await action({ action: 'focus', windowId: canvas.id });
  assert.equal((latest.activeWindow as { id: string }).id, canvas.id);
  await action({ action: 'close', windowId: canvas.id });
  await action({ action: 'click', x: widgets.geometry.x + 90, y: widgets.geometry.y + 50 });
  await action({ action: 'type', text: 'Grüße aus Köln — UTF-8' });
  await action({ action: 'press', key: 'ctrl+s' });
  assert.equal(readFileSync('/workspace/widgets-saved.txt', 'utf8'), 'Grüße aus Köln — UTF-8');
  await action({ action: 'press', key: 'ctrl+a' });
  await action({ action: 'paste', text: '--id Grüße aus Köln — 🦊' });
  await action({ action: 'press', key: 'ctrl+s' });
  assert.equal(readFileSync('/workspace/widgets-saved.txt', 'utf8'), '--id Grüße aus Köln — 🦊');
  diagnostics();
  await call('desktop_stop');
  assert((await call('desktop_observe', {}, true)).isError);
  await call('desktop_start', { width: 1024, height: 768 });
  assert.equal(latest.width, 1024);
  assert.equal((latest.windows as unknown[]).length, 0, 'Old application survived restart');
  await call('desktop_stop');
  writeFileSync(
    `${evidence}/report.json`,
    JSON.stringify(
      {
        ok: true,
        networkBlocked,
        steps: sequence,
        nativeCanvas: {
          click: true,
          doubleClick: true,
          dragPointer: true,
          focus: true,
          keyboard: true,
          scroll: true,
        },
        qtWidgets: { unicode: true, clipboardUnicode: true, shortcutSave: true },
      windowManagerReady: true,
      browserCoexistence: process.env.B70_BROWSER_ROOT !== undefined,
        staleSnapshotRejected: true,
        cleanupAndRestart: true,
        sandboxRuntimeReadOnly: true,
        noHostGraphicsOrInputDevices: true,
        sandboxUid: process.getuid!(),
      },
      null,
      2
    )
  );
} catch (error) {
  writeFileSync(`${evidence}/error.txt`, String(error instanceof Error ? error.stack : error));
  diagnostics();
  console.error(error);
  process.exitCode = 1;
} finally {
  await Promise.allSettled(cleanup.map(async (fn) => fn()));
}
