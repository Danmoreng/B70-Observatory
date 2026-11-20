import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BrowserError,
  BrowserInputError,
  BrowserSession,
  sanitizeSelector,
  validatePreviewUrl,
  type BrowserProcess,
} from '../src/browser.js';

const PNG_820x1180 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

interface CdpRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

interface FakeChrome {
  handle: BrowserProcess;
  push: (value: unknown) => void;
  pushEvent: (method: string, params: Record<string, unknown>) => void;
  requests: CdpRequest[];
  killed: string[];
  spawnArgs: string[];
  /** Simulates a sudden process crash (exit without cleanup). */
  die: () => void;
}

function fakeChrome(
  options: {
    auto?: boolean;
    title?: string;
    shotData?: string;
    navigation?: 'refused' | 'hash' | 'stalled';
    evaluate?: (expression: string) => unknown;
  } = {}
): FakeChrome {
  let dataListener: ((chunk: Buffer) => void) | undefined;
  let exitListener: (() => void) | undefined;
  const state = {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    requests: [] as CdpRequest[],
    killed: [] as string[],
  };
  let buffer = '';
  let loader = 0;

  const handle: BrowserProcess = {
    get exitCode() {
      return state.exitCode;
    },
    get signalCode() {
      return state.signalCode;
    },
    once(event: string, listener: (...args: unknown[]) => void) {
      if (event === 'exit') exitListener = listener as () => void;
    },
    on: () => {
      // No persistent process-level listeners are needed by the fake.
    },
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      state.killed.push(signal);
      if (state.exitCode === null) {
        state.exitCode = 0;
        exitListener?.();
      }
      return true;
    },
    pipeIn: {
      write(chunk: string) {
        buffer += chunk;
        while (true) {
          const separator = buffer.indexOf('\u0000');
          if (separator === -1) return true;
          const frame = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 1);
          if (frame.length === 0) continue;
          const request = JSON.parse(frame) as CdpRequest;
          state.requests.push(request);
          respond(request);
        }
        return true;
      },
      end() {
        // The pipe closes with the process.
      },
    },
    pipeOut: {
      on(event: string, listener: (chunk: Buffer) => void) {
        if (event === 'data') dataListener = listener;
      },
    },
  };

  function push(value: unknown): void {
    // Chrome --remote-debugging-pipe framing: NUL-terminated JSON on fd 4.
    dataListener?.(Buffer.from(`${JSON.stringify(value)}\u0000`, 'utf8'));
  }

  function respond(request: CdpRequest): void {
    if (options.auto === false) return;
    const result: Record<string, unknown> = {};
    switch (request.method) {
      case 'Target.createTarget':
        result.targetId = 'target-1';
        break;
      case 'Target.attachToTarget':
        result.sessionId = 'session-1';
        break;
      case 'Target.getTargets':
        result.targetInfos = [{ targetId: 'target-1', type: 'page' }];
        break;
      case 'Runtime.evaluate':
        result.result = {
          value:
            options.evaluate?.(String(request.params.expression)) ?? options.title ?? 'Testseite',
        };
        break;
      case 'Page.captureScreenshot':
        result.data = options.shotData ?? PNG_820x1180.toString('base64');
        break;
      case 'Page.getLayoutMetrics':
        result.cssContentSize = { width: 820, height: 9000 };
        break;
      case 'Page.getFrameTree':
        result.frameTree = { frame: { id: 'frame-1', loaderId: `loader-${loader}` } };
        break;
      case 'Page.navigate': {
        result.frameId = 'frame-1';
        if (options.navigation === 'hash' && String(request.params.url).includes('#')) break;
        if (options.navigation === 'refused') {
          result.errorText = 'net::ERR_CONNECTION_REFUSED';
          break;
        }
        result.loaderId = `loader-${++loader}`;
        if (options.navigation !== 'stalled') pushLifecycle('frame-1', String(result.loaderId));
        // A later frame must not replace the cached notification for the main frame.
        pushLifecycle('subframe', 'subframe-loader');
        break;
      }
      case 'Page.reload':
        pushLifecycle('frame-1', `loader-${++loader}`);
        break;
      default:
        break;
    }
    push({ id: request.id, result });
  }

  function pushLifecycle(frameId: string, loaderId: string) {
    push({
      method: 'Page.lifecycleEvent',
      params: { name: 'DOMContentLoaded', frameId, loaderId },
    });
  }

  return {
    handle,
    push,
    pushEvent: (method: string, params: Record<string, unknown>) => push({ method, params }),
    requests: state.requests,
    killed: state.killed,
    spawnArgs: [],
    die: (): void => {
      if (state.exitCode === null) {
        state.exitCode = 137;
        exitListener?.();
      }
    },
  };
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sessionWith(fake: FakeChrome, limits?: Record<string, number>): BrowserSession {
  return new BrowserSession({
    executable: '/browser/chrome',
    userDataDir: join(tmpdir(), `b70-browser-test-${Date.now()}`),
    ...(limits === undefined ? {} : { limits }),
    spawnProcess: (args) => {
      fake.spawnArgs = args;
      return fake.handle;
    },
  });
}

it('resizes the current viewport without navigating or replacing the browser session', async () => {
  const chrome = fakeChrome();
  const browser = new BrowserSession({ spawnProcess: () => chrome.handle });
  try {
    await browser.navigate('http://127.0.0.1:5173', { width: 900, height: 900 });
    const before = chrome.requests.length;
    expect(await browser.resize({ width: 1800, height: 1000 })).toEqual({
      width: 1800,
      height: 1000,
    });
    const operations = chrome.requests.slice(before);
    expect(
      operations.some(
        (request) =>
          request.method === 'Page.navigate' ||
          request.method === 'Page.reload' ||
          request.method === 'Target.createTarget'
      )
    ).toBe(false);
    expect(
      operations.find((request) => request.method === 'Emulation.setDeviceMetricsOverride')?.params
    ).toMatchObject({ width: 1800, height: 1000 });
    await expect(browser.resize({ width: 0, height: 1000 })).rejects.toBeInstanceOf(
      BrowserInputError
    );
    expect(browser.isRunning).toBe(true);
  } finally {
    await browser.close();
  }
});

describe('browser preview helper', () => {
  it('accepts ordinary CSS attributes, pseudo-classes and combinators while bounding input', () => {
    for (const selector of [
      '.langswitch button[aria-pressed="false"]',
      '.langswitch button:nth-child(2)',
      '.langswitch button + button',
      'main > button:not([disabled])',
      'a[href="#/projects"]',
      '[data-value="a;b"]',
      '#ergebnis\\:1',
    ]) {
      expect(sanitizeSelector(selector)).toBe(selector);
    }
    for (const selector of ['', '   ', 'a'.repeat(257)]) {
      expect(() => sanitizeSelector(selector)).toThrowError(BrowserInputError);
    }
  });

  it('uses distinct browser profiles for agents sharing one sandbox', async () => {
    const first = fakeChrome();
    const second = fakeChrome();
    const a = new BrowserSession({
      spawnProcess: (args) => {
        first.spawnArgs = args;
        return first.handle;
      },
    });
    const b = new BrowserSession({
      spawnProcess: (args) => {
        second.spawnArgs = args;
        return second.handle;
      },
    });
    try {
      await a.start();
      await b.start();
      expect(first.spawnArgs.find((arg) => arg.startsWith('--user-data-dir='))).not.toBe(
        second.spawnArgs.find((arg) => arg.startsWith('--user-data-dir='))
      );
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  it('only accepts clean http URLs on the isolated loopback', () => {
    expect(validatePreviewUrl('http://127.0.0.1:5173/')).toContain('5173');
    expect(validatePreviewUrl('http://localhost:4173/app')).toContain('4173');
    expect(validatePreviewUrl('http://[::1]:5173/')).toContain('::1');
    expect(() => validatePreviewUrl('https://127.0.0.1/')).toThrowError(BrowserError);
    expect(() => validatePreviewUrl('http://example.com/')).toThrowError(BrowserError);
    expect(() => validatePreviewUrl('file:///workspace/index.html')).toThrowError(BrowserError);
    expect(() => validatePreviewUrl('chrome://settings/')).toThrowError(BrowserError);
    expect(() => validatePreviewUrl('javascript:alert(1)')).toThrowError(BrowserError);
    expect(() => validatePreviewUrl('http://user:pass@127.0.0.1/')).toThrowError(BrowserError);
    expect(() => validatePreviewUrl('http://127.0.0.1:8081/')).toThrowError(/8081|Inference/);
  });

  it('starts chrome inside the sandbox with bounded flags and navigates', async () => {
    const fake = fakeChrome();
    const session = sessionWith(fake);
    const info = await session.navigate('http://127.0.0.1:5173/', {
      width: 820,
      height: 1180,
    });
    expect(info).toMatchObject({ url: expect.stringContaining('5173'), title: 'Testseite' });
    expect(fake.spawnArgs).toEqual(
      expect.arrayContaining([
        '--headless=new',
        '--no-sandbox',
        '--no-zygote',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--remote-debugging-pipe',
        '--renderer-process-limit=1',
        '--num-raster-threads=1',
      ])
    );
    expect(fake.spawnArgs.some((arg) => arg.includes('--remote-debugging-port'))).toBe(false);
    const metrics = fake.requests.find(
      (request) => request.method === 'Emulation.setDeviceMetricsOverride'
    );
    expect(metrics?.params).toMatchObject({ width: 820, height: 1180 });
    const blocked = fake.requests.find((request) => request.method === 'Network.setBlockedURLs');
    expect(blocked?.params).toMatchObject({
      urls: expect.arrayContaining(['*://127.0.0.1:8081/*']),
    });
    expect(blocked?.params['urls']).not.toContain('*://*/*');
    // The Fetch whitelist is the enforcing point for every request path.
    expect(fake.requests.some((request) => request.method === 'Fetch.enable')).toBe(true);
    await session.close();
  });

  it('enforces the Fetch request whitelist for every subresource and redirect', async () => {
    const fake = fakeChrome();
    const session = sessionWith(fake);
    await session.navigate('http://127.0.0.1:5173/', { width: 820, height: 1180 });
    fake.pushEvent('Fetch.requestPaused', {
      requestId: 'req-allowed',
      request: { url: 'http://127.0.0.1:5173/app.js', method: 'GET' },
    });
    fake.pushEvent('Fetch.requestPaused', {
      requestId: 'req-data',
      request: { url: 'data:image/png;base64,AAA=', method: 'GET' },
    });
    fake.pushEvent('Fetch.requestPaused', {
      requestId: 'req-remote',
      request: { url: 'https://example.com/steal.js', method: 'GET' },
    });
    fake.pushEvent('Fetch.requestPaused', {
      requestId: 'req-file',
      request: { url: 'file:///etc/passwd', method: 'GET' },
    });
    fake.pushEvent('Fetch.requestPaused', {
      requestId: 'req-relay',
      request: { url: 'http://127.0.0.1:8081/model', method: 'GET' },
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    const continued = fake.requests
      .filter((request) => request.method === 'Fetch.continueRequest')
      .map((request) => request.params.requestId);
    const failed = fake.requests
      .filter((request) => request.method === 'Fetch.failRequest')
      .map((request) => request.params.requestId);
    expect(continued).toEqual(['req-allowed', 'req-data']);
    expect(failed.sort()).toEqual(['req-file', 'req-relay', 'req-remote'].sort());
    await session.close();
  });

  it('reports an unconfirmed reload as an honest error instead of success', async () => {
    const fake = fakeChrome();
    const session = sessionWith(fake, { navigationTimeoutMs: 80, commandTimeoutMs: 200 });
    await session.navigate('http://127.0.0.1:5173/', { width: 820, height: 1180 });
    // The browser process dies right before the reload is confirmed, so no
    // load event can arrive; the action must reject, never report success.
    fake.die();
    await expect(session.act({ kind: 'reload' })).rejects.toThrowError(BrowserError);
    await session.close();
  });

  it('distinguishes an unreachable server from a stalled document and waits only for the main frame', async () => {
    const rejected = sessionWith(fakeChrome({ navigation: 'refused' }));
    const stalled = sessionWith(fakeChrome({ navigation: 'stalled' }), { navigationTimeoutMs: 30 });
    const viewport = { width: 820, height: 1180 };
    try {
      await expect(rejected.navigate('http://127.0.0.1:5173/', viewport)).rejects.toMatchObject({
        code: 'connection_refused',
        message: expect.stringContaining('Vorschau-Server'),
      });
      await expect(rejected.inspect()).rejects.toMatchObject({ code: 'preview_not_open' });
      await expect(stalled.navigate('http://127.0.0.1:5173/', viewport)).rejects.toMatchObject({
        code: 'navigation_timeout',
        message: expect.stringContaining('browser_inspect'),
      });
      expect(stalled.isRunning).toBe(true);
      await expect(stalled.inspect()).resolves.toBe('Testseite');
    } finally {
      await Promise.all([rejected.close(), stalled.close()]);
    }
  });

  it('opens hash routes without waiting for a new document and confirms a full reload', async () => {
    const session = sessionWith(fakeChrome({ navigation: 'hash' }), { navigationTimeoutMs: 30 });
    const viewport = { width: 820, height: 1180 };
    try {
      await session.navigate('http://127.0.0.1:5173/', viewport);
      await expect(
        session.navigate('http://127.0.0.1:5173/#/projects', viewport)
      ).resolves.toMatchObject({ url: 'http://127.0.0.1:5173/#/projects' });
      await expect(session.act({ kind: 'reload' })).resolves.toBe('Seite neu geladen.');
    } finally {
      await session.close();
    }
  });

  it('inspects without a selector without issuing a querySelector', async () => {
    const fake = fakeChrome({ title: 'Ohne Selector' });
    const session = sessionWith(fake);
    await session.navigate('http://127.0.0.1:5173/', { width: 820, height: 1180 });
    const report = await session.inspect();
    expect(report).toContain('Ohne Selector');
    const evaluations = fake.requests
      .filter((request) => request.method === 'Runtime.evaluate')
      .map((request) => String(request.params.expression));
    expect(
      evaluations.every((expression) => !expression.includes("document.querySelector('')"))
    ).toBe(true);
    await session.close();
  });

  it('captures and validates a bounded screenshot, including clipped full pages', async () => {
    const fake = fakeChrome();
    const session = sessionWith(fake);
    await session.navigate('http://127.0.0.1:5173/', { width: 820, height: 1180 });
    const shot = await session.screenshot(false);
    expect(shot.mimeType).toBe('image/png');
    expect(shot.png.equals(PNG_820x1180)).toBe(true);
    expect(shot.byteLength).toBe(PNG_820x1180.length);

    const clipped = await session.screenshot(true);
    const layout = fake.requests.find((request) => request.method === 'Page.getLayoutMetrics');
    expect(layout).toBeDefined();
    const capture = fake.requests
      .filter((request) => request.method === 'Page.captureScreenshot')
      .at(-1);
    expect(capture?.params).toMatchObject({ captureBeyondViewport: true });
    expect(clipped.clipped).toBe(true);
    await session.close();
  });

  it('rejects screenshots that violate the byte policy instead of faking success', async () => {
    const fake = fakeChrome({
      shotData: Buffer.concat([PNG_820x1180, Buffer.alloc(2 * 1024 * 1024)]).toString('base64'),
    });
    const session = sessionWith(fake);
    await session.navigate('http://127.0.0.1:5173/', { width: 820, height: 1180 });
    await expect(session.screenshot(false)).rejects.toThrowError(/verworfen/);
    await session.close();
  });

  it('bounds actions and reports honest element errors', async () => {
    const fake = fakeChrome({
      evaluate: (expression) => {
        if (expression.includes('button:has-text')) return { error: 'invalid_selector' };
        if (expression.includes('#missing')) return { error: 'missing_target' };
        return 'Testseite';
      },
    });
    const session = sessionWith(fake);
    await session.navigate('http://127.0.0.1:5173/', { width: 820, height: 1180 });
    await expect(session.act({ kind: 'click', selector: '#missing' })).rejects.toMatchObject({
      code: 'target_not_found',
    });
    await expect(session.act({ kind: 'press', key: 'F12' })).rejects.toThrowError(/Taste/);
    await expect(session.act({ kind: 'type', text: '' })).rejects.toThrowError(/Text/);
    await expect(
      session.act({ kind: 'scroll', selector: 'button:has-text("Normal")' })
    ).rejects.toMatchObject({ code: 'invalid_selector' });
    await session.close();
  });

  it('sends logical and physical game keys with their DOM key and code', async () => {
    const fake = fakeChrome();
    const session = sessionWith(fake);
    try {
      await session.navigate('http://127.0.0.1:5173/', { width: 820, height: 1180 });
      for (const key of ['W', 'KeyZ', '0', 'Digit1', 'Space'])
        await session.act({ kind: 'press', key });
      expect(
        fake.requests
          .filter(
            (request) =>
              request.method === 'Input.dispatchKeyEvent' && request.params.type === 'keyDown'
          )
          .map(({ params }) => [params.key, params.code, params.text])
      ).toEqual([
        ['W', 'KeyW', 'W'],
        ['z', 'KeyZ', 'z'],
        ['0', 'Digit0', '0'],
        ['1', 'Digit1', '1'],
        [' ', 'Space', ' '],
      ]);
      await expect(session.act({ kind: 'press', key: 'Control+L' })).rejects.toMatchObject({
        code: 'invalid_key',
      });
    } finally {
      await session.close();
    }
  });

  it('times out a stuck startup and cleans up the private profile on close', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'b70-browser-profile-'));
    tempDirs.push(userDataDir);
    mkdirSync(join(userDataDir, 'SingletonLock'), { recursive: true });
    writeFileSync(join(userDataDir, 'marker.txt'), 'profile');
    const fake = fakeChrome({ auto: false });
    const session = new BrowserSession({
      executable: '/browser/chrome',
      userDataDir,
      limits: { startupTimeoutMs: 60, commandTimeoutMs: 60, navigationTimeoutMs: 80 },
      spawnProcess: (args) => {
        fake.spawnArgs = args;
        return fake.handle;
      },
    });
    await expect(session.start()).rejects.toThrowError(/Timeout|time out/i);
    expect(fake.killed.length).toBeGreaterThan(0);
    expect(existsSync(userDataDir)).toBe(false);
  });
});
