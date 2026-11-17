/** Firefox WebDriver BiDi transport for the bounded shared browser tool API.
 * The listener is ephemeral loopback INSIDE bwrap; it is never published to the host.
 * References: https://developer.mozilla.org/en-US/docs/Web/WebDriver/How_to/Create_BiDi_connection
 * https://www.w3.org/TR/webdriver-bidi/
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  BrowserError,
  type BrowserProtocol,
  type BrowserProcess,
  type BrowserLimits,
} from './browser.js';
type Json = Record<string, unknown>;
const obj = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const keys: Record<string, string> = {
  Enter: '\uE007',
  Tab: '\uE004',
  Escape: '\uE00C',
  Backspace: '\uE003',
  Delete: '\uE017',
  Home: '\uE011',
  End: '\uE010',
  ArrowLeft: '\uE012',
  ArrowUp: '\uE013',
  ArrowRight: '\uE014',
  ArrowDown: '\uE015',
};

export class FirefoxProtocol implements BrowserProtocol {
  private nextId = 0;
  private context = '';
  private closed = false;
  private readonly pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly handlers = new Map<string, Array<(p: Json) => void>>();
  private readonly waiters = new Map<string, Set<(error?: Error) => void>>();
  private readonly seen = new Set<string>();
  constructor(
    private readonly socket: WebSocket,
    private readonly timeout: number
  ) {
    socket.addEventListener('message', (event) => {
      const raw = String(event.data);
      if (raw.length > 8 * 1024 * 1024) {
        this.close();
        return;
      }
      let message: Json;
      try {
        message = obj(JSON.parse(raw));
      } catch {
        this.close();
        return;
      }
      if (typeof message.id === 'number') {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(message.id);
        if (message.type === 'error')
          entry.reject(
            new BrowserError(
              `Firefox: ${String(message.error)}: ${String(message.message).slice(0, 300)}`
            )
          );
        else entry.resolve(message.result);
      } else if (typeof message.method === 'string')
        this.event(message.method, obj(message.params));
    });
    socket.addEventListener('close', () => this.close());
    socket.addEventListener('error', () => this.close());
  }
  private command(method: string, params: Json = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new BrowserError('Firefox connection closed.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserError(`Firefox ${method} timeout.`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BrowserError('Firefox transport unavailable.'));
      }
    });
  }
  async initialize() {
    await this.command('session.new', { capabilities: {} });
    await this.command('session.subscribe', {
      events: [
        'browsingContext.load',
        'browsingContext.contextCreated',
        'network.beforeRequestSent',
      ],
    });
  }
  private emit(type: string, params: Json) {
    this.seen.add(type);
    for (const fn of this.waiters.get(type) ?? []) fn();
    for (const handler of this.handlers.get(type) ?? []) handler(params);
  }
  private event(method: string, params: Json) {
    if (method === 'browsingContext.load' && params.context === this.context)
      this.emit('Page.loadEventFired', params);
    if (method === 'network.beforeRequestSent' && params.isBlocked === true)
      this.emit('Fetch.requestPaused', {
        requestId: obj(params.request).request,
        request: { url: obj(params.request).url },
      });
    if (method === 'browsingContext.contextCreated')
      this.emit('Target.targetCreated', { targetInfo: { targetId: params.context, type: 'page' } });
  }
  onEvent(type: string, handler: (params: Json) => void) {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }
  resetEvents() {
    this.seen.clear();
  }
  waitEvent(type: string, timeout: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new BrowserError('Firefox closed.'));
    if (this.seen.delete(type)) return Promise.resolve({});
    return new Promise((resolve, reject) => {
      const list = this.waiters.get(type) ?? new Set<(error?: Error) => void>();
      const done = (error?: Error) => {
        clearTimeout(timer);
        list.delete(done);
        if (error) reject(error);
        else resolve({});
      };
      const timer = setTimeout(() => {
        list.delete(done);
        reject(new BrowserError(`Firefox event ${type} timeout.`));
      }, timeout);
      list.add(done);
      this.waiters.set(type, list);
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new BrowserError('Firefox closed.'));
    }
    this.pending.clear();
    for (const list of this.waiters.values())
      for (const finish of list) finish(new BrowserError('Firefox closed.'));
    this.waiters.clear();
    this.handlers.clear();
    this.seen.clear();
    this.socket.close();
  }
  async send(method: string, params: Json = {}): Promise<unknown> {
    switch (method) {
      case 'Target.createTarget': {
        const tree = obj(await this.command('browsingContext.getTree'));
        const contexts = Array.isArray(tree.contexts) ? tree.contexts : [];
        const initial = obj(contexts[0]).context;
        this.context =
          typeof initial === 'string'
            ? initial
            : String(obj(await this.command('browsingContext.create', { type: 'window' })).context);
        return { targetId: this.context };
      }
      case 'Target.attachToTarget':
        return { sessionId: this.context };
      case 'Target.getTargets': {
        const result = obj(await this.command('browsingContext.getTree'));
        return {
          targetInfos: (Array.isArray(result.contexts) ? result.contexts : []).map((c) => ({
            targetId: obj(c).context,
            type: 'page',
          })),
        };
      }
      case 'Target.closeTarget':
        return this.command('browsingContext.close', { context: params.targetId });
      case 'Page.enable':
      case 'DOM.enable':
      case 'Runtime.enable':
      case 'Network.enable':
      case 'Network.setBlockedURLs':
        return {};
      case 'Fetch.enable':
        return this.command('network.addIntercept', { phases: ['beforeRequestSent'] });
      case 'Fetch.continueRequest':
        return this.command('network.continueRequest', { request: params.requestId });
      case 'Fetch.failRequest':
        return this.command('network.failRequest', { request: params.requestId });
      case 'Browser.setDownloadBehavior':
        return this.command('browser.setDownloadBehavior', {
          downloadBehavior: { type: 'denied' },
        });
      case 'Page.bringToFront':
        return this.command('browsingContext.activate', { context: this.context });
      case 'Emulation.setDeviceMetricsOverride':
        return this.command('browsingContext.setViewport', {
          context: this.context,
          viewport: { width: params.width, height: params.height },
          devicePixelRatio: 1,
        });
      case 'Page.navigate':
        await this.command('browsingContext.navigate', {
          context: this.context,
          url: params.url,
          wait: 'complete',
        });
        return {};
      case 'Page.reload':
        return this.command('browsingContext.reload', { context: this.context, wait: 'complete' });
      case 'Runtime.evaluate': {
        const result = obj(
          await this.command('script.evaluate', {
            expression: `(async () => JSON.stringify({value: await (${String(params.expression)})}))()`,
            target: { context: this.context },
            awaitPromise: true,
          })
        );
        if (result.type === 'exception')
          return {
            exceptionDetails: {
              exception: {
                description: String(
                  obj(result.exceptionDetails).text ?? 'Firefox evaluation failed'
                ),
              },
            },
          };
        const encoded = obj(result.result).value;
        if (typeof encoded !== 'string')
          throw new BrowserError('Firefox returned no serialized result.');
        return { result: { value: obj(JSON.parse(encoded)).value } };
      }
      case 'Page.getLayoutMetrics': {
        const result = obj(
          await this.send('Runtime.evaluate', {
            expression:
              '({width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight})',
          })
        );
        return { cssContentSize: obj(result.result).value };
      }
      case 'Page.captureScreenshot': {
        const clip = obj(params.clip);
        return this.command('browsingContext.captureScreenshot', {
          context: this.context,
          origin: params.captureBeyondViewport ? 'document' : 'viewport',
          format: { type: 'image/png' },
          ...(params.clip
            ? {
                clip: { type: 'box', x: clip.x, y: clip.y, width: clip.width, height: clip.height },
              }
            : {}),
        });
      }
      case 'Input.dispatchMouseEvent': {
        const action =
          params.type === 'mouseMoved'
            ? {
                type: 'pointerMove',
                x: Math.round(Number(params.x)),
                y: Math.round(Number(params.y)),
                duration: 0,
                origin: 'viewport',
              }
            : { type: params.type === 'mousePressed' ? 'pointerDown' : 'pointerUp', button: 0 };
        return this.command('input.performActions', {
          context: this.context,
          actions: [
            {
              type: 'pointer',
              id: 'b70-mouse',
              parameters: { pointerType: 'mouse' },
              actions: [action],
            },
          ],
        });
      }
      case 'Input.insertText':
        return this.command('input.performActions', {
          context: this.context,
          actions: [
            {
              type: 'key',
              id: 'b70-key',
              actions: [...String(params.text)].flatMap((value) => [
                { type: 'keyDown', value },
                { type: 'keyUp', value },
              ]),
            },
          ],
        });
      case 'Input.dispatchKeyEvent':
        return this.command('input.performActions', {
          context: this.context,
          actions: [
            {
              type: 'key',
              id: 'b70-key',
              actions: [
                {
                  type: params.type === 'keyDown' ? 'keyDown' : 'keyUp',
                  value: keys[String(params.key)] ?? String(params.key),
                },
              ],
            },
          ],
        });
      default:
        throw new BrowserError(`Unsupported Firefox operation: ${method}`);
    }
  }
}

export async function launchFirefox(
  executable: string,
  profile: string,
  environment: NodeJS.ProcessEnv,
  limits: BrowserLimits
): Promise<{ protocol: FirefoxProtocol; handle: BrowserProcess }> {
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const prefs: Record<string, unknown> = {
    // One tested page; do not fill the job task budget with spare content processes.
    'dom.ipc.processCount': 1,
    'dom.ipc.processCount.webIsolated': 1,
    'dom.ipc.processPrelaunch.enabled': false,
    'browser.shell.checkDefaultBrowser': false,
    'browser.startup.homepage_override.mstone': 'ignore',
    'browser.aboutwelcome.enabled': false,
    'browser.newtabpage.enabled': false,
    'browser.startup.homepage': 'about:blank',
    'datareporting.policy.dataSubmissionEnabled': false,
    'toolkit.telemetry.enabled': false,
    'app.update.auto': false,
    'webgl.force-enabled': true,
    'gfx.webrender.software': true,
    'dom.disable_window_move_resize': false,
    'security.sandbox.content.level': 0,
    'security.sandbox.gpu.level': 0,
  };
  await writeFile(
    profile + '/user.js',
    Object.entries(prefs)
      .map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`)
      .join('\n')
  );
  const child = spawn(
    executable,
    [
      '--no-remote',
      '--new-instance',
      '--profile',
      profile,
      '--remote-debugging-port',
      '0',
      'about:blank',
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...environment,
        MOZ_ENABLE_WAYLAND: '0',
        MOZ_DISABLE_CONTENT_SANDBOX: '1',
        MOZ_DISABLE_RDD_SANDBOX: '1',
        MOZ_DISABLE_GMP_SANDBOX: '1',
        MOZ_DISABLE_GPU_SANDBOX: '1',
        MOZ_CRASHREPORTER_DISABLE: '1',
      },
    }
  );
  let socket: WebSocket | undefined;
  let protocol: FirefoxProtocol | undefined;
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let stderr = '';
      const timer = setTimeout(
        () => reject(new BrowserError('Firefox startup timeout.')),
        limits.startupTimeoutMs
      );
      const finish = (error?: Error, endpoint?: string) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(endpoint!);
      };
      child.once('error', (error) => finish(error));
      child.once('exit', () =>
        finish(new BrowserError(`Firefox exited before connection: ${stderr.slice(-500)}`))
      );
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + String(chunk)).slice(-16384);
        const match = stderr.match(/WebDriver BiDi listening on (ws:\/\/127\.0\.0\.1:\d+)/);
        if (match) finish(undefined, match[1] + '/session');
      });
    });
    const connection = new WebSocket(endpoint);
    socket = connection;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.close();
        reject(new BrowserError('Firefox connection timeout.'));
      }, limits.startupTimeoutMs);
      connection.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
      connection.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new BrowserError('Firefox connection failed.'));
        },
        { once: true }
      );
    });
    const connected = new FirefoxProtocol(connection, limits.commandTimeoutMs);
    protocol = connected;
    child.once('exit', () => connected.close());
    await connected.initialize();
    return {
      protocol: connected,
      handle: {
        kill: (signal) => child.kill(signal),
        get exitCode() {
          return child.exitCode;
        },
        get signalCode() {
          return child.signalCode;
        },
        once: (event, fn) => child.once(event, fn),
        on: (event, fn) => child.on(event, fn),
        pipeIn: {
          write: () => {
            throw new BrowserError('Firefox uses BiDi.');
          },
          end: () => {},
        },
        pipeOut: { on: () => {} },
      },
    };
  } catch (error) {
    if (protocol) protocol.close();
    else socket?.close();
    child.kill('SIGKILL');
    throw error;
  }
}
