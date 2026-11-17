/**
 * M5C/M5E real-browser acceptance (Chrome, CDP over the native WebSocket
 * client – no new dependencies).
 *
 * Boots the production server (LAN mode, temporary database) on a free
 * loopback port, drives a real headless Chrome through the genuine user
 * journey and verifies the M5C live/reconnect contract on the wire:
 *
 *  1. login through the form (real user gesture), dashboard renders
 *  2. accessibility invariants in the real DOM (live regions, table
 *     header scope, label association, WCAG contrast of key text)
 *  3. network outage → honest "Verbindung getrennt" state; the server
 *     keeps publishing into the journal meanwhile
 *  4. reconnect → the browser sends Last-Event-ID; the server replays
 *     exactly the missed frames (ids strictly increasing, no duplicates);
 *     the chip goes through the replay phase back to "Verbunden"
 *  5. server restart → the old id is unknown, the server announces an
 *     explicit re-synchronisation ("Neue Daten …") and fresh snapshots
 *  6. tablet viewport (820×1180): no horizontal overflow, layout stacks
 *  7. compact navigation: real keyboard activation, responsive sidebar and
 *     labelled mobile bottom bar
 *
 * Exit code 0 = all checks passed. Screenshots land in
 * docs/milestones/m5c-browser-*.png and m5e-browser-*.png.
 */
import { spawn, execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createHash, randomBytes, scrypt as scryptCb } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = join(root, 'packages/web/dist');
const serverEntry = join(root, 'packages/server/dist/index.js');
const chrome = '/usr/bin/google-chrome-stable';
const screenshotsDir = join(root, 'docs/milestones');
const logFile = join(root, 'target', 'browser-acceptance-server.log');

const PASSWORD = randomBytes(24).toString('hex');

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!condition) process.exitCode = 1;
  return condition;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function scryptKey(password, salt) {
  return new Promise((resolveP, rejectP) => {
    scryptCb(
      password,
      salt,
      64,
      { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error !== null ? rejectP(error) : resolveP(key))
    );
  });
}

async function findFreePort() {
  return new Promise((resolveP, rejectP) => {
    const server = net.createServer();
    server.unref();
    server.on('error', rejectP);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolveP(port));
    });
  });
}

function startServer(port, env) {
  const child = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = fsLogChild(child);
  child.stdout?.on('data', out);
  child.stderr?.on('data', out);
  child.on('error', out);
  return child;
}

function fsLogChild() {
  return (data) => {
    try {
      appendFileSync(logFile, data);
    } catch {
      // logging must never break the acceptance run
    }
  };
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status > 0) return response.status;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error(`server did not come up at ${url}`);
}

/** Minimal CDP client on top of the Node WebSocket. */
class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
  }

  connect() {
    return new Promise((resolveP, rejectP) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener('open', () => resolveP());
      this.ws.addEventListener('error', (event) =>
        rejectP(new Error(`ws error: ${event.message ?? 'unknown'}`))
      );
      this.ws.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(String(event.data));
          if (process.env.CDP_DEBUG)
            process.stderr.write(
              `MSG ${message.method ?? 'resp:' + message.id} size=${String(event.data).length}\n`
            );
          if (message.id !== undefined && this.pending.has(message.id)) {
            const { resolveP: r, rejectP } = this.pending.get(message.id);
            this.pending.delete(message.id);
            if (message.error !== undefined) rejectP(new Error(message.error.message));
            else r(message.result);
          } else if (message.method !== undefined) {
            for (const handler of this.handlers.get(message.method) ?? []) handler(message.params);
          }
        } catch (error) {
          console.error('      (dropping malformed CDP message:', error.message, ')');
        }
      });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveP, rejectP) => this.pending.set(id, { resolveP, rejectP }));
  }

  on(method, handler) {
    const list = this.handlers.get(method) ?? [];
    list.push(handler);
    this.handlers.set(method, list);
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails !== undefined) {
      throw new Error(`page error: ${result.exceptionDetails.text}`);
    }
    return result.result?.value;
  }

  async waitFor(selector, timeoutMs = 15000, expected = true) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await this.eval(`document.querySelector(${JSON.stringify(selector)}) !== null`);
      if (found === expected) return true;
      await sleep(100);
    }
    return false;
  }

  async waitForText(selector, text, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await this.eval(
        `(document.querySelector(${JSON.stringify(selector)})?.textContent ?? '').trim()`
      );
      if (value.includes(text)) return value;
      await sleep(100);
    }
    throw new Error(`timeout waiting for ${JSON.stringify(text)} in ${selector}`);
  }

  async click(selector) {
    const box = await this.eval(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.focus();
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`
    );
    if (box === null) throw new Error(`click target not found: ${selector}`);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
    });
  }

  async screenshot(name, suite = 'm5c') {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = join(screenshotsDir, `${suite}-browser-${name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`      screenshot: ${file}`);
  }
}

/** Poll `predicate` (async) until true or timeout. */
async function until(asyncFn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await asyncFn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await sleep(120);
  }
}

/**
 * Transparent TCP proxy (loopback) so the acceptance run can partition
 * the browser <-> server at the socket level – exactly what a dropped
 * Wi-Fi connection does. Chrome's CDP 'offline' emulation only blocks new
 * connections and would never fire the EventSource error that the M5C
 * reconnection contract is built on.
 */
function createProxy(targetPort) {
  let proxyPort;
  let mode = 'forward';
  const active = new Set();
  const server = net.createServer((client) => {
    if (mode !== 'forward') {
      // Partitioned: fail every (re)connect instantly with a reset.
      client.destroy();
      return;
    }
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      client.pipe(upstream);
      upstream.pipe(client);
    });
    active.add(client);
    client.on('close', () => {
      active.delete(client);
      upstream.destroy();
    });
    upstream.on('close', () => {
      active.delete(client);
      client.destroy();
    });
    upstream.on('error', () => upstream.destroy());
  });
  server.on('error', () => {});
  return new Promise((resolveP, rejectP) => {
    server.listen(0, '127.0.0.1', () => {
      proxyPort = server.address().port;
      resolveP({
        port: proxyPort,
        partition() {
          mode = 'partition';
          for (const socket of active) socket.destroy();
          active.clear();
        },
        resume() {
          mode = 'forward';
        },
        close() {
          server.close();
          for (const socket of active) socket.destroy();
        },
      });
    });
    server.once('error', rejectP);
  });
}

async function main() {
  mkdirSync(screenshotsDir, { recursive: true });
  mkdirSync(dirname(logFile), { recursive: true });
  rmSync(logFile, { force: true });

  const serverPort = await findFreePort();
  const tempDir = join(root, 'target', 'browser-acceptance');
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });

  const salt = randomBytes(16);
  const passwordHash = `scrypt$16384$8$1$${salt.toString('base64url')}$${(
    await scryptKey(PASSWORD, salt)
  ).toString('base64url')}`;
  const gatewayTokenHash = createHash('sha256')
    .update(`gateway-${randomBytes(16).toString('hex')}`)
    .digest('hex');

  const serverEnv = {
    OBSERVATORY_MODE: 'lan',
    OBSERVATORY_HOST: '127.0.0.1',
    OBSERVATORY_PORT: String(serverPort),
    OBSERVATORY_PASSWORD_HASH: passwordHash,
    OBSERVATORY_GATEWAY_TOKEN_HASH: gatewayTokenHash,
    OBSERVATORY_DB_PATH: join(tempDir, 'observatory.db'),
    OBSERVATORY_WEB_ROOT: webRoot,
    OBSERVATORY_DISK_PATH: tempDir,
    OBSERVATORY_METRICS_INTERVAL_MS: '1500',
    OBSERVATORY_SYSTEM_INTERVAL_MS: '1500',
    OBSERVATORY_UPSTREAM_URL: 'http://127.0.0.1:9',
    OBSERVATORY_EVENT_BUFFER_SIZE: '512',
  };

  let server = startServer(serverPort, serverEnv);
  const proxy = await createProxy(serverPort);
  const baseUrl = `http://127.0.0.1:${proxy.port}`;
  console.log(
    `server: 127.0.0.1:${serverPort} behind proxy 127.0.0.1:${proxy.port} (LAN mode, temp db ${tempDir})`
  );
  const chromeProfile = join(tempDir, 'chrome-profile');

  // ---------------------------------------------------------------- Chrome
  const cdpHttpPort = await findFreePort();
  const chromeProcess = spawn(
    chrome,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      `--remote-debugging-port=${cdpHttpPort}`,
      `--user-data-dir=${chromeProfile}`,
      '--window-size=1440,900',
      '--lang=de-DE',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let chromeStderr = '';
  chromeProcess.stderr?.on('data', (d) => (chromeStderr += String(d)));
  chromeProcess.stdout?.on('data', (d) => (chromeStderr += String(d)));

  const cleanup = () => {
    try {
      chromeProcess.kill('SIGKILL');
    } catch {
      // already gone
    }
    try {
      server.kill('SIGKILL');
    } catch {
      // already gone
    }
    try {
      proxy.close();
    } catch {
      // already gone
    }
  };
  process.on('exit', cleanup);

  try {
    // Wait for the DevTools endpoint, then reuse the initial about:blank page.
    let target;
    try {
      target = await until(
        async () => {
          try {
            const response = await fetch(`http://127.0.0.1:${cdpHttpPort}/json`);
            const list = (await response.json()).filter((entry) => entry.type === 'page');
            return list.find((entry) => entry.webSocketDebuggerUrl !== undefined);
          } catch {
            return undefined; // DevTools not ready yet
          }
        },
        20000,
        'Chrome DevTools endpoint'
      );
    } catch {
      target = undefined;
    }
    check('Chrome DevTools endpoint is reachable', target !== undefined);
    if (target === undefined) return;

    const cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // Capture exactly what the browser receives on the stream: a proxy
    // around EventSource records every named frame (id + type + data) in
    // window.__m5cCapture. CDP does not buffer EventSource bodies, so this
    // is the only faithful way to assert the replayed/resynced frames.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        (() => {
          if (window.__m5cHooked) return;
          window.__m5cHooked = true;
          window.__m5cCapture = [];
          const original = window.EventSource;
          window.EventSource = new Proxy(original, {
            construct(target, args, newTarget) {
              const source = new target(...args);
              for (const type of ['health', 'telemetry', 'system', 'stream', 'history']) {
                source.addEventListener(type, (event) => {
                  window.__m5cCapture.push({ id: event.lastEventId ?? null, type, data: event.data });
                });
              }
              return source;
            },
          });
        })();
      `,
    });

    // Track every request to the shared event stream. The Last-Event-ID
    // header is added by Blink right before the request goes out, so CDP
    // reports it in requestWillBeSentExtraInfo (and the server log proves it arrives on the
    // wire); merge it into the entry once both events are in.
    const streamRequests = [];
    cdp.on('Network.requestWillBeSent', (params) => {
      const urlValue = params.request?.url ?? params.url;
      if (process.env.CDP_DEBUG) process.stderr.write(`REQ ${urlValue}\n`);
      if (typeof urlValue !== 'string' || urlValue === '') return;
      const url = new URL(urlValue, baseUrl);
      if (url.pathname === '/api/events') {
        const entry = {
          requestId: params.requestId,
          lastEventId:
            params.request.headers['last-event-id'] ??
            params.request.headers['Last-Event-ID'] ??
            null,
        };
        streamRequests.push(entry);
      }
    });
    cdp.on('Network.requestWillBeSentExtraInfo', (params) => {
      const entry = streamRequests.find((item) => item.requestId === params.requestId);
      const header = params.headers?.['Last-Event-ID'] ?? params.headers?.['last-event-id'];
      if (entry !== undefined && header !== undefined) entry.lastEventId = header;
    });
    cdp.on('Network.loadingFailed', (params) => {
      const entry = streamRequests.find((item) => item.requestId === params.requestId);
      if (entry !== undefined) entry.failed = true;
    });
    const receivedIds = [];
    cdp.on('Network.eventSourceMessageReceived', (params) => {
      if (typeof params.eventId === 'string' && params.eventId !== '')
        receivedIds.push(params.eventId);
    });
    // ------------------------------------------------------------ 1. login
    console.log('\n[1] initial load + login (real form, real click)');
    await cdp.send('Page.navigate', { url: baseUrl + '/' });
    await cdp.waitFor('#password', 20000);
    check(
      'login form is shown first (LAN mode)',
      (await cdp.eval("!!document.querySelector('#password')")) === true
    );

    // Accessibility of the login panel, checked in the real DOM.
    const loginA11y = await cdp.eval(`(() => {
      const label = document.querySelector('label[for="password"]');
      const form = document.querySelector('form.login-panel, form[aria-labelledby]');
      return {
        labelText: label?.textContent?.trim() ?? null,
        formNamed: form?.matches('form[aria-labelledby]') === true,
        heading: document.querySelector('h1')?.textContent?.trim() ?? null,
      };
    })()`);
    check(
      'login label is programmatically associated (label[for])',
      loginA11y.labelText === 'Passwort'
    );
    check('login form has an accessible name (aria-labelledby)', loginA11y.formNamed === true);
    check('page has a level-1 heading', loginA11y.heading !== null);
    await cdp.screenshot('01-login');

    await cdp.eval(`document.querySelector('#password').focus()`);
    await cdp.send('Input.insertText', { text: PASSWORD });
    await cdp.click(
      'form.login-panel button[type="submit"], form[aria-labelledby] button[type="submit"]'
    );
    await until(
      async () => (await cdp.eval(`document.querySelector('.primary-kpis') !== null`)) === true,
      20000,
      'signed-in dashboard after login'
    );
    check('login succeeds and the dashboard renders', true);

    // ------------------------------------------------- 2. accessibility (live view)
    console.log('\n[2] accessibility invariants in the real DOM');
    await cdp.waitForText('.status-bar', 'Server', 15000).catch(() => '');
    const a11y = await cdp.eval(`(() => {
      const ratio = (fg, bg) => {
        const parse = (value) => (value.match(/\\d+(?:\\.\\d+)?/g) ?? [0, 0, 0]).slice(0, 3).map(Number);
        const channel = (v) => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        };
        const [r1, g1, b1] = parse(fg);
        const [r2, g2, b2] = parse(bg);
        const l1 = 0.2126 * channel(r1) + 0.7152 * channel(g1) + 0.0722 * channel(b1);
        const l2 = 0.2126 * channel(r2) + 0.7152 * channel(g2) + 0.0722 * channel(b2);
        const [a, b] = l1 > l2 ? [l1, l2] : [l2, l1];
        return (a + 0.05) / (b + 0.05);
      };
      const style = (el, prop) => getComputedStyle(el)[prop];
      const bodyBg = style(document.body, 'backgroundColor');
      const status = document.querySelector('.status-bar');
      const chip = document.querySelector('.live-chip');
      const value = document.querySelector('.kpi-value');
      const headers = [...document.querySelectorAll('table th')];
      const times = [...document.querySelectorAll('time')];
      return {
        statusRole: status?.getAttribute('role') ?? null,
        chipRole: chip?.getAttribute('role') ?? null,
        chipText: chip?.textContent?.trim() ?? null,
        statusText: status?.textContent?.trim() ?? '',
        bodyContrast: ratio(style(document.body, 'color'), bodyBg),
        valueContrast: value ? ratio(style(value, 'color'), style(value.closest('.kpi-card, article, section') ?? value, 'backgroundColor')) : null,
        thCount: headers.length,
        thAllScoped: headers.length > 0 && headers.every((th) => th.getAttribute('scope') === 'col'),
        timeCount: times.length,
        timeAllDatetimied: times.length > 0 && times.every((t) => t.getAttribute('datetime') !== null),
        timeCount0Ok: times.length === 0,
      };
    })()`);
    check(
      'status bar is a live region (role=status)',
      a11y.statusRole === 'status',
      a11y.statusText
    );
    check(
      'live-state chip is a live region (role=status)',
      a11y.chipRole === 'status',
      a11y.chipText
    );
    check(
      'body text contrast ≥ 4.5:1',
      a11y.bodyContrast >= 4.5,
      `ratio ${a11y.bodyContrast.toFixed(2)}`
    );
    if (a11y.valueContrast !== null)
      check(
        'KPI value contrast ≥ 4.5:1',
        a11y.valueContrast >= 4.5,
        `ratio ${a11y.valueContrast.toFixed(2)}`
      );
    if (a11y.thCount > 0)
      check('table headers carry scope=col', a11y.thAllScoped, `${a11y.thCount} headers`);
    if (a11y.timeCount > 0)
      check(
        'all <time> elements carry datetime',
        a11y.timeAllDatetimied,
        `${a11y.timeCount} times`
      );
    await cdp.screenshot('02-desktop-dashboard');

    // ------------------------------------------------- 3. outage + replay (4.)
    console.log('\n[3] network outage: honest "getrennt" state, journal keeps filling');
    const requestsBeforeOutage = streamRequests.length;
    // The browser's Last-Event-ID is the id of the last frame it received.
    const idBeforeOutage = receivedIds.at(-1);

    const captureIndexBeforeOutage = await cdp.eval(`(window.__m5cCapture ?? []).length`);
    // Socket-level partition: the established SSE connection is reset,
    // every browser reconnect attempt fails instantly, while the server
    // keeps running and publishing into the shared journal.
    proxy.partition();
    await until(
      async () =>
        (await cdp.eval(`document.querySelector('.live-chip')?.textContent ?? ''`)).includes(
          'Getrennt'
        ),
      15000,
      'chip shows "Getrennt" during the outage'
    );
    check('outage: chip switches to "Getrennt" (no false "Verbunden")', true);
    await cdp.screenshot('03-outage');

    // While the browser is partitioned the server keeps
    // publishing into the shared journal: change the watched disk so a
    // new system snapshot is guaranteed to be semantically different.
    writeFileSync(join(tempDir, 'fill.bin'), new Uint8Array(8 * 1024 * 1024));
    await sleep(4000); // ≥ 2 system collections at 1.5 s

    console.log('\n[4] reconnect: Last-Event-ID → exact replay, no gaps, no duplicates');
    proxy.resume();
    let secondRequest;
    try {
      secondRequest = await until(
        async () =>
          streamRequests
            .slice(requestsBeforeOutage)
            .find((entry) => entry.lastEventId !== null && entry.failed !== true),
        20000,
        'browser reconnects to /api/events with Last-Event-ID after the outage'
      );
    } catch (error) {
      console.error(
        '      diagnostics: streamRequests=' +
          JSON.stringify(
            streamRequests.map((entry) => ({ id: entry.requestId, lastEventId: entry.lastEventId }))
          ) +
          ' chip=' +
          (await cdp.eval(`document.querySelector('.live-chip')?.textContent ?? ''`))
      );
      throw error;
    }
    check(
      'reconnect request carries Last-Event-ID of the last received frame',
      secondRequest.lastEventId !== null &&
        idBeforeOutage !== null &&
        secondRequest.lastEventId === idBeforeOutage,
      `sent=${secondRequest.lastEventId}`
    );

    await until(
      async () =>
        (await cdp.eval(`document.querySelector('.live-chip')?.textContent ?? ''`)).includes(
          'Verbunden'
        ),
      20000,
      'chip returns to "Verbunden" after replay/resync'
    );
    await cdp.screenshot('04-reconnected');
    await sleep(600); // let the remaining replayed frames arrive
    const replayReport = await cdp.eval(`(() => {
      const frames = (window.__m5cCapture ?? []).slice(${captureIndexBeforeOutage});
    const noticeIndex = frames.findIndex((f) => f.type === 'stream');
      const notice = noticeIndex >= 0 ? frames[noticeIndex] : undefined;
      const parsed = notice ? JSON.parse(notice.data) : null;
      return {
        count: frames.length,
        noticeIndex,
        dataIds: frames.filter((f) => f.type !== 'stream').map((f) => f.id).filter(Boolean),
        notice: parsed,
        types: parsed?.types ?? null,
        hasSystem: frames.some((f) => f.type === 'system'),
        hasHealth: frames.some((f) => f.type === 'health'),
      };
    })()`);
    check(
      'the FIRST frame of the replay burst is the stream notice (client resets freshness on it)',
      replayReport.count > 0 && replayReport.noticeIndex === 0,
      `count=${replayReport.count} noticeIndex=${replayReport.noticeIndex}`
    );
    check(
      'notice kind is "replay" (outage stayed inside the replay window)',
      replayReport.notice?.kind === 'replay',
      JSON.stringify(replayReport.notice)
    );
    check(
      'replay covers the source that changed while partitioned ("system")',
      Array.isArray(replayReport.types) && replayReport.types.includes('system'),
      JSON.stringify(replayReport.types)
    );
    check(
      'every replayed data frame carries an id (unbroken Last-Event-ID chain)',
      replayReport.count > 0 && replayReport.dataIds.length === replayReport.count - 1
    );
    check(
      'replayed data ids are strictly increasing (global journal order preserved)',
      replayReport.dataIds.every((id, i) =>
        i === 0 ? true : compareIds(replayReport.dataIds[i - 1], id) < 0
      ),
      `first=${replayReport.dataIds[0]} last=${replayReport.dataIds.at(-1)}`
    );
    check(
      'replay starts right after the last received id – no gap, no duplicates',
      idBeforeOutage !== null &&
        replayReport.dataIds.length > 0 &&
        compareIds(idBeforeOutage, replayReport.dataIds[0]) < 0 &&
        new Set(replayReport.dataIds).size === replayReport.dataIds.length
    );
    check(
      'replayed "system" frame re-validated the hardware KPIs',
      replayReport.hasSystem === true
    );
    check('chip is "Verbunden" again and all values are validated current', true);

    // ------------------------------------------------- 5. restart → resync
    console.log('\n[5] server restart: unknown id → explicit re-synchronisation');
    const requestsBeforeRestart = streamRequests.length;
    // Snapshot the capture position and the current journal generation
    // before killing the server: everything after this index belongs to
    // the reconnection saga (which may include a brief replay against the
    // old server during its drain grace period).
    const captureIndexBeforeRestart = await cdp.eval(`(window.__m5cCapture ?? []).length`);
    const generationBeforeRestart = await cdp.eval(
      `((window.__m5cCapture ?? []).at(-1)?.id ?? '').split('-')[0] || null`
    );
    server.kill('SIGTERM');
    await until(
      async () => server.exitCode !== null || server.signalCode !== null,
      10000,
      'old server process exited'
    );
    server = startServer(serverPort, serverEnv);
    await waitForHttp(`http://127.0.0.1:${serverPort}/`, 15000);
    await waitForHttp(baseUrl + '/', 15000);
    const thirdRequest = await until(
      async () =>
        streamRequests
          .slice(requestsBeforeRestart)
          .find((entry) => entry.lastEventId !== null && entry.failed !== true),
      25000,
      'browser reconnects to the restarted server'
    );
    check(
      'reconnect after restart still carries the (now unknown) Last-Event-ID',
      thirdRequest.lastEventId !== null,
      `sent=${thirdRequest.lastEventId}`
    );
    await until(
      async () =>
        (await cdp.eval(`document.querySelector('.live-chip')?.textContent ?? ''`)).includes(
          'Verbunden'
        ),
      20000,
      'chip returns to "Verbunden" after re-synchronisation'
    );
    await sleep(600);
    const resyncReport = await cdp.eval(`(() => {
      const frames = (window.__m5cCapture ?? []).slice(${captureIndexBeforeRestart});
      let noticeIndex = -1;
      for (let i = 0; i < frames.length; i++) if (frames[i].type === 'stream') noticeIndex = i;
      const after = frames.slice(noticeIndex + 1);
      const notice = noticeIndex >= 0 ? JSON.parse(frames[noticeIndex].data) : null;
      return {
        count: frames.length,
        ids: frames.map((f) => f.id).filter(Boolean),
        notice,
        hasHealthAfterNotice: after.some((f) => f.type === 'health'),
        hasSystemAfterNotice: after.some((f) => f.type === 'system'),
        lastId: frames.at(-1)?.id ?? null,
      };
    })()`);
    check(
      'restarted server announces kind "resync" (no silent data gap)',
      resyncReport.notice?.kind === 'resync',
      JSON.stringify(resyncReport.notice)
    );
    check(
      'resync re-sends current snapshots (fresh health + system frames after the notice)',
      resyncReport.hasHealthAfterNotice === true && resyncReport.hasSystemAfterNotice === true
    );
    check(
      'new journal generation after restart (fresh id space, old ids unresolvable)',
      generationBeforeRestart !== null &&
        resyncReport.lastId !== null &&
        resyncReport.lastId.split('-')[0] !== generationBeforeRestart,
      `old=${generationBeforeRestart} new=${resyncReport.lastId?.split('-')[0]}`
    );
    await cdp.screenshot('05-after-resync'); // ------------------------------------------------- 6. tablet viewport
    console.log('\n[6] tablet viewport 820×1180');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 820,
      height: 1180,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await cdp.send('Page.reload');
    await until(
      async () => (await cdp.eval(`document.querySelector('.primary-kpis') !== null`)) === true,
      20000,
      'dashboard renders in tablet viewport'
    );
    const tablet = await cdp.eval(`(() => ({
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      kpiTops: [...document.querySelectorAll('.kpi-card, article')].slice(0, 4).map((el) => Math.round(el.getBoundingClientRect().top)),
      statusRole: document.querySelector('.status-bar')?.getAttribute('role') ?? null,
      chip: document.querySelector('.live-chip')?.textContent?.trim() ?? null,
    }))()`);
    check(
      'no horizontal overflow at 820 px',
      tablet.overflowX === false,
      `${tablet.scrollWidth}/${tablet.clientWidth}`
    );
    const stacked = new Set(tablet.kpiTops).size >= Math.min(2, tablet.kpiTops.length);
    check('KPI cards stack vertically on tablet', stacked, JSON.stringify(tablet.kpiTops));
    check(
      'live region survives the viewport change',
      tablet.statusRole === 'status',
      `chip=${tablet.chip}`
    );
    await cdp.screenshot('06-tablet');

    // --------------------------------------------- 7. M5E shell + responsive UI
    console.log('\n[7] M5E navigation, keyboard path and responsive shell');
    const tabletNavigation = await cdp.eval(`(() => {
      const sidebar = document.querySelector('.app-sidebar');
      const links = [...document.querySelectorAll('.app-sidebar nav a')];
      return {
        labels: links.map((link) => link.querySelector('.sidebar-label')?.textContent?.trim()),
        current: links.find((link) => link.getAttribute('aria-current') === 'page')?.getAttribute('href') ?? null,
        collapsed: sidebar?.classList.contains('collapsed') ?? false,
        width: Math.round(sidebar?.getBoundingClientRect().width ?? 0),
      };
    })()`);
    check(
      'application navigation contains exactly the two real destinations',
      JSON.stringify(tabletNavigation.labels) === JSON.stringify(['Übersicht', 'Aufgaben']),
      JSON.stringify(tabletNavigation.labels)
    );
    check(
      'active destination is exposed through aria-current',
      tabletNavigation.current === '#/overview'
    );
    check(
      'tablet starts with a compact sidebar that leaves the live view usable',
      tabletNavigation.collapsed === true && tabletNavigation.width <= 72,
      `width=${tabletNavigation.width}`
    );
    await cdp.eval(`window.scrollTo({ top: 0, left: 0, behavior: 'instant' })`);
    await cdp.screenshot('01-tablet-navigation', 'm5e');

    await cdp.click('.sidebar-toggle');
    const expandedWidth = await until(
      async () => {
        const width = await cdp.eval(
          `Math.round(document.querySelector('.app-sidebar')?.getBoundingClientRect().width ?? 0)`
        );
        return width >= 200 ? width : undefined;
      },
      3000,
      'tablet sidebar expands as an overlay'
    );
    check('sidebar collapse control expands the tablet overlay', expandedWidth >= 200);

    await cdp.eval(`document.querySelector('a[href="#/agent"]').focus()`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
    await until(
      async () => (await cdp.eval(`document.querySelector('.cockpit') !== null`)) === true,
      5000,
      'keyboard navigation opens the agent page'
    );
    const agentText = await cdp.eval(`document.querySelector('.cockpit')?.textContent ?? ''`);
    check(
      'keyboard activation navigates to Aufgaben and updates aria-current',
      (await cdp.eval(
        `document.querySelector('a[href="#/agent"]')?.getAttribute('aria-current')`
      )) === 'page'
    );
    check(
      'removed duplicate cockpit explanations stay absent',
      !agentText.includes('Was sichtbar ist') && !agentText.includes('Live in die Arbeit schauen')
    );

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send('Page.reload');
    await cdp.waitFor('.cockpit', 15000);
    const desktopShell = await cdp.eval(`(() => ({
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      sidebarWidth: Math.round(document.querySelector('.app-sidebar')?.getBoundingClientRect().width ?? 0),
      agentHeadings: [...document.querySelectorAll('.cockpit h2')].filter((el) => el.textContent?.trim() === 'Agent').length,
      pageMasthead: document.querySelector('.stage-content > .masthead') !== null,
      sidebarStatus: document.querySelector('.sidebar-connection')?.textContent?.trim() ?? null,
      sidebarSignOut: document.querySelector('.sidebar-signout')?.getAttribute('aria-label') ?? null,
    }))()`);
    check(
      'desktop Agent view has one page heading and no horizontal overflow',
      desktopShell.agentHeadings === 1 && desktopShell.overflowX === false,
      `headings=${desktopShell.agentHeadings} sidebar=${desktopShell.sidebarWidth}`
    );
    check(
      'session controls live in the sidebar and no page masthead remains',
      desktopShell.pageMasthead === false &&
        desktopShell.sidebarStatus === 'Verbunden' &&
        desktopShell.sidebarSignOut === 'Abmelden',
      JSON.stringify(desktopShell)
    );
    await cdp.eval(`window.scrollTo({ top: 0, left: 0, behavior: 'instant' })`);
    await cdp.screenshot('02-desktop-agent', 'm5e');

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await cdp.send('Page.reload');
    await cdp.waitFor('.cockpit', 15000);
    const mobileShell = await cdp.eval(`(() => {
      const sidebar = document.querySelector('.app-sidebar');
      const rect = sidebar?.getBoundingClientRect();
      const labels = [...document.querySelectorAll('.sidebar-label')];
      return {
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        position: sidebar ? getComputedStyle(sidebar).position : null,
        bottomGap: rect ? Math.round(innerHeight - rect.bottom) : null,
        height: rect ? Math.round(rect.height) : null,
        labelsVisible: labels.every((label) => getComputedStyle(label).display !== 'none'),
      };
    })()`);
    check(
      'mobile view has no horizontal overflow',
      mobileShell.overflowX === false,
      JSON.stringify(mobileShell)
    );
    check(
      'mobile navigation becomes a visible fixed bottom bar',
      mobileShell.position === 'fixed' &&
        mobileShell.bottomGap === 0 &&
        mobileShell.height <= 64 &&
        mobileShell.labelsVisible === true,
      JSON.stringify(mobileShell)
    );
    await cdp.screenshot('03-mobile-agent', 'm5e');

    await cdp.ws.close();
  } finally {
    cleanup();
  }

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} acceptance checks passed.`);
  if (failed.length > 0) {
    console.log(`failed: ${failed.map((entry) => entry.name).join(' | ')}`);
    process.exit(1);
  }
}

/** Compare two journal ids `<8-hex gen>-<seq>` like the server does. */
function compareIds(a, b) {
  const [genA, seqA] = a.split('-');
  const [genB, seqB] = b.split('-');
  if (genA !== genB) return genA < genB ? -1 : 1;
  const nA = Number(seqA);
  const nB = Number(seqB);
  return Number.isFinite(nA) && Number.isFinite(nB) ? nA - nB : a.localeCompare(b);
}

/**
 * The acceptance run must test the CURRENT source, not a stale build: the
 * server entry and the web bundle are loaded from `dist/`. If either dist
 * artifact is missing or older than any source file, rebuild first so a
 * forgotten `npm run build` cannot silently test yesterday's code.
 */
function ensureFreshBuild() {
  const distServer = join(root, 'packages/server/dist/index.js');
  const distWeb = join(root, 'packages/web/dist');
  const staleOrMissing = () => {
    if (!existsSync(distServer) || !existsSync(distWeb)) return true;
    const distMtime = Math.min(statSync(distServer).mtimeMs, statSync(distWeb).mtimeMs);
    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === 'dist' ? [] : walk(path);
        return [path];
      });
    return ['packages/server/src', 'packages/web/src', 'packages/contracts/src']
      .flatMap((dir) => walk(join(root, dir)))
      .some((path) => statSync(path).mtimeMs > distMtime);
  };
  if (staleOrMissing()) {
    console.log('dist/ missing or older than source – running `npm run build` first …');
    execSync('npm run build', { cwd: root, stdio: 'inherit' });
  }
}

ensureFreshBuild();

main().catch((error) => {
  console.error('\nacceptance run aborted:', error.message ?? error);
  process.exit(1);
});
