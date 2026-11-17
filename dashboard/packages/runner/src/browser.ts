/**
 * Node-only browser helper for the sandboxed agent preview.
 *
 * Chrome runs with `--no-sandbox` INSIDE the existing full bwrap isolation
 * (nested user namespaces stay disabled on purpose). CDP is connected over
 * `--remote-debugging-pipe` — no host namespaces, no sockets, no external
 * CDP endpoint, no port. All navigation, command and startup behaviour is
 * strictly bounded; every public method throws an honest error instead of
 * faking a success.
 */
import { DesktopSession } from './desktop.js';
import { launchFirefox } from './firefox.js';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { MAX_IMAGE_BYTES, validateAgentImage, type AgentImageMime } from './image-validation.js';

export interface BrowserViewport {
  width: number;
  height: number;
}

export interface BrowserLimits {
  viewportMin: number;
  viewportMax: number;
  fullPageMaxHeight: number;
  maxImageBytes: number;
  startupTimeoutMs: number;
  commandTimeoutMs: number;
  navigationTimeoutMs: number;
}

export const DEFAULT_BROWSER_LIMITS: Readonly<BrowserLimits> = Object.freeze({
  viewportMin: 320,
  viewportMax: 1920,
  fullPageMaxHeight: 8192,
  maxImageBytes: MAX_IMAGE_BYTES,
  startupTimeoutMs: 20_000,
  commandTimeoutMs: 10_000,
  navigationTimeoutMs: 30_000,
});

export interface BrowserAction {
  kind: 'click' | 'type' | 'press' | 'scroll' | 'reload';
  selector?: string;
  text?: string;
  key?: string;
  delta?: number;
}

/** Minimal structural interface so tests can inject a fake process. */
export interface BrowserProcess {
  diagnostic?: () => string;
  kill(signal?: NodeJS.Signals): boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  /** Writable CDP command pipe handed to the child as fd 3. */
  pipeIn: { write(chunk: string): boolean; end(): void };
  /** Readable CDP response pipe handed to the child as fd 4. */
  pipeOut: { on(event: string, listener: (chunk: Buffer) => void): unknown };
}

export interface BrowserProtocol {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  onEvent(type: string, handler: (params: Record<string, unknown>) => void): void;
  waitEvent(type: string, timeoutMs: number): Promise<unknown>;
  resetEvents(): void;
  close(): void;
}
export type BrowserEngine = 'chromium' | 'firefox';

export type BrowserSpawn = (args: string[]) => BrowserProcess;

export interface BrowserOptions {
  desktop?: DesktopSession;
  engine?: BrowserEngine;
  /** Fixed executable inside the sandbox; never request-controlled. */
  executable?: string;
  /** Private per-run profile directory under the sandbox /tmp. */
  userDataDir?: string;
  limits?: Partial<BrowserLimits>;
  /** Injectable process factory for isolated tests. */
  spawnProcess?: BrowserSpawn;
}

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
/** The runner inference relay port is never a legitimate preview target. */
const BLOCKED_PORTS = new Set([8081]);
const KEY_CODES: Record<string, { key: string; code: string; keyCode: number }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ' ': { key: ' ', code: 'Space', keyCode: 32 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
};

export class BrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserError';
  }
}

/** Invalid tool input or missing page elements do not invalidate a live browser. */
export class BrowserInputError extends BrowserError {}

/**
 * Only clean http URLs on the isolated loopback are accepted. No credentials,
 * no other protocol, no foreign host, and the inference relay port is
 * explicitly excluded.
 */
export function validatePreviewUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BrowserInputError('Die Vorschau-URL ist keine gültige URL.');
  }
  if (url.protocol !== 'http:') {
    throw new BrowserInputError('Nur http-Vorschauen auf dem isolierten Loopback sind erlaubt.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    throw new BrowserInputError('Die Vorschau muss unter 127.0.0.1, localhost oder [::1] laufen.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new BrowserInputError('Die Vorschau-URL darf keine Zugangsdaten enthalten.');
  }
  if (BLOCKED_PORTS.has(url.port === '' ? 80 : Number(url.port))) {
    throw new BrowserInputError('Der Inference-Brücken-Port ist keine Vorschau-Quelle.');
  }
  return url.toString();
}

/**
 * The Fetch-domain whitelist: the same loopback rule as validatePreviewUrl,
 * plus self-contained data:/blob: assets that the page itself produced. Used
 * for every request, redirect and subresource.
 */
export function isAllowedPreviewUrl(raw: string): boolean {
  if (raw.startsWith('data:') || raw.startsWith('blob:') || raw.startsWith('about:')) return true;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return false;
  if (url.username !== '' || url.password !== '') return false;
  return !BLOCKED_PORTS.has(url.port === '' ? 80 : Number(url.port));
}

/** Rejects the wrapped operation when the caller aborts (tool cancellation). */
function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  label: string
): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(new BrowserError(`${label}: abgebrochen.`));
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(new BrowserError(`${label}: abgebrochen.`));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new BrowserError(`${label} time out nach ${ms} ms.`)),
      ms
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

interface CdpPending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type CdpEventHandler = (params: Record<string, unknown>) => void;

/**
 * One CDP session over Chrome's `--remote-debugging-pipe`: commands are
 * written NUL-terminated to the child's fd 3 and responses are read from its
 * fd 4. No host namespaces, no sockets, no external CDP endpoint, no port.
 */
class CdpConnection {
  /** Chrome frames with a single NUL; this bound keeps a stuck peer honest. */
  private static readonly MAX_FRAME_BYTES = 8 * 1024 * 1024;

  private buffer = Buffer.alloc(0);
  private nextId = 0;
  private readonly pending = new Map<number, CdpPending>();
  private readonly eventWaiters = new Map<string, Array<() => void>>();
  private readonly eventHandlers = new Map<string, Array<CdpEventHandler>>();
  private readonly eventSeen = new Set<string>();
  private readonly events: unknown[] = [];
  private closed = false;
  private transportFailed = false;

  constructor(
    private readonly processHandle: BrowserProcess,
    private readonly commandTimeoutMs: number
  ) {
    // `on` (not `once`): every data chunk of the pipe carries bytes, and a
    // large frame regularly spans several chunks.
    this.processHandle.pipeOut.on('data', (chunk: Buffer) => {
      if (this.closed || this.transportFailed) return;
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > CdpConnection.MAX_FRAME_BYTES + 8 * 1024) {
        this.fail(new BrowserError('Die CDP-Antwort überschreitet das Framing-Limit.'));
        return;
      }
      this.drain();
    });
    this.processHandle.pipeOut.on('error', () =>
      this.fail(new BrowserError('Browser response pipe closed.'))
    );
    this.processHandle.once('exit', () =>
      this.fail(
        new BrowserError(
          'Der Browserprozess ist vor dem Abschluss beendet worden. ' +
            (this.processHandle.diagnostic?.() ?? '')
        )
      )
    );
    this.processHandle.once('error', () =>
      this.fail(new BrowserError('Die Browser-Pipe ist nicht verfügbar.'))
    );
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new BrowserError('Der Browser ist bereits geschlossen.'));
    const id = ++this.nextId;
    const frame = JSON.stringify({
      id,
      method,
      params,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserError(`CDP-Befehl ${method} hatte keine Antwort (Timeout).`));
      }, this.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        // NUL-terminated JSON on the dedicated pipe (child fd 3).
        this.processHandle.pipeIn.write(`${frame}\u0000`);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BrowserError('Die Browser-Kommandopipe ist nicht verfügbar.'));
      }
    });
  }

  /**
   * Subscribes a persistent handler to one event type. Unlike waitEvent, the
   * handler is invoked for every occurrence (e.g. every Fetch.requestPaused)
   * and stays active until the connection closes.
   */
  onEvent(type: string, handler: CdpEventHandler): void {
    const handlers = this.eventHandlers.get(type) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(type, handlers);
  }

  waitEvent(type: string, timeoutMs: number): Promise<unknown> {
    if (this.eventSeen.has(type)) {
      this.eventSeen.delete(type);
      const event = this.events.at(-1);
      return Promise.resolve(isObject(event) ? (event as { params: unknown }).params : undefined);
    }
    return withTimeout(
      new Promise<unknown>((resolve) => {
        const waiters = this.eventWaiters.get(type) ?? [];
        waiters.push(() => {
          const event = this.events.at(-1);
          resolve(isObject(event) ? (event as { params: unknown }).params : undefined);
        });
        this.eventWaiters.set(type, waiters);
      }),
      timeoutMs,
      `Warten auf ${type}`
    );
  }

  /**
   * Drops all already-seen events so that a later wait cannot be satisfied by
   * a stale event (e.g. the about:blank load of the fresh session).
   */
  resetEvents(): void {
    this.events.length = 0;
    this.eventSeen.clear();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new BrowserError('Der Browser wurde geschlossen.'));
      this.pending.delete(id);
    }
  }

  /** Rejects every pending command once the transport itself died. */
  fail(error: Error): void {
    if (this.closed || this.transportFailed) return;
    this.transportFailed = true;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }

  private drain(): void {
    while (true) {
      const separator = this.buffer.indexOf(0);
      if (separator === -1) return;
      const frame = this.buffer.subarray(0, separator).toString('utf8');
      this.buffer = this.buffer.subarray(separator + 1);
      if (frame.length > 0) this.dispatch(frame);
    }
  }

  private dispatch(payload: string): void {
    let value: unknown;
    try {
      value = JSON.parse(payload);
    } catch {
      return;
    }
    if (!isObject(value)) return;
    // CDP events carry `method`; responses carry `id`. Events are checked
    // first so a frame that contains both is never misrouted into a pending
    // command (which would swallow the real response).
    if (typeof value.method === 'string') {
      this.events.push(value);
      if (this.events.length > 512) this.events.shift();
      this.eventSeen.add(value.method);
      const waiters = this.eventWaiters.get(value.method);
      if (waiters !== undefined) {
        this.eventWaiters.set(value.method, []);
        for (const waiter of waiters) waiter();
      }
      const params = isObject(value.params) ? value.params : {};
      const handlers = this.eventHandlers.get(value.method);
      if (handlers !== undefined) {
        for (const handler of [...handlers]) {
          try {
            handler(params);
          } catch {
            // A misbehaving handler must not wedge the transport; per-event
            // failures are handled by the owning code path.
          }
        }
      }
      return;
    }
    if (typeof value.id === 'number' && this.pending.has(value.id)) {
      const entry = this.pending.get(value.id)!;
      this.pending.delete(value.id);
      clearTimeout(entry.timer);
      if (value.error !== undefined) {
        const message =
          isObject(value.error) && typeof value.error.message === 'string'
            ? value.error.message
            : 'CDP-Befehl fehlgeschlagen.';
        entry.reject(new BrowserError(message));
      } else {
        entry.resolve(value.result);
      }
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class BrowserSession {
  private readonly limits: BrowserLimits;
  private readonly executable: string;
  private readonly userDataDir: string;
  private readonly spawnProcess: BrowserSpawn;
  private processHandle: BrowserProcess | undefined;
  private cdp: BrowserProtocol | undefined;
  private readonly desktop?: DesktopSession;
  private readonly engine: BrowserEngine;
  private desktopGeneration?: number;
  private display?: Awaited<ReturnType<DesktopSession['prepareBrowser']>>;
  private targetId: string | undefined;
  private sessionId: string | undefined;
  private currentPageUrl: string | undefined;
  private closed = false;
  /** Recorded request-gate failures, surfaced on the next operation. */
  private fetchErrors: string[] = [];

  constructor(options: BrowserOptions = {}) {
    this.desktop = options.desktop;
    this.engine = options.engine ?? 'chromium';
    this.limits = { ...DEFAULT_BROWSER_LIMITS, ...(options.limits ?? {}) };
    this.executable =
      options.executable ??
      (this.engine === 'firefox'
        ? '/usr/lib/firefox/firefox'
        : this.desktop
          ? '/runtime/browsers/chromium/chromium'
          : '/browser/chrome');
    this.userDataDir = options.userDataDir ?? `/tmp/b70-browser-profile-${randomUUID()}`;
    this.spawnProcess =
      options.spawnProcess ??
      ((args) => {
        // fd 0/1 ignored, fd 2 captured and ignored, fd 3 = CDP commands in,
        // fd 4 = CDP responses out (Chrome --remote-debugging-pipe).
        const child = spawn(this.executable, args, {
          stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
          ...(this.display
            ? {
                env: {
                  ...this.display.env,
                  LD_LIBRARY_PATH:
                    dirname(this.executable) + ':' + this.display.env.LD_LIBRARY_PATH,
                },
              }
            : {}),
        });
        let diagnostic = '';
        child.stdio[2]?.on('data', (chunk) => {
          diagnostic = (diagnostic + String(chunk)).slice(-2000);
        });
        child.stdio[3]?.on('error', () => undefined);
        child.stdio[4]?.on('error', () => undefined);
        return {
          diagnostic: () => diagnostic.slice(-1000),
          kill: (signal?: NodeJS.Signals) => child.kill(signal as NodeJS.Signals),
          get exitCode() {
            return child.exitCode;
          },
          get signalCode() {
            return child.signalCode;
          },
          once: (event: string, listener: (...args: unknown[]) => void) =>
            child.once(event as 'exit', listener),
          on: (event: string, listener: (...args: unknown[]) => void) =>
            child.on(event as 'exit', listener),
          pipeIn: child.stdio[3] as unknown as BrowserProcess['pipeIn'],
          pipeOut: child.stdio[4] as unknown as BrowserProcess['pipeOut'],
        };
      });
  }

  get isRunning(): boolean {
    return (
      this.cdp !== undefined &&
      !this.closed &&
      this.processHandle?.exitCode === null &&
      this.processHandle?.signalCode === null &&
      (!this.desktop || this.desktopGeneration === this.desktop.generation)
    );
  }

  /** Launches the sandboxed browser and prepares one dedicated page. */
  async start(): Promise<void> {
    if (this.cdp !== undefined) return;
    if (this.closed) throw new BrowserError('Die Browser-Instanz ist bereits geschlossen.');
    if (this.desktop) {
      this.display = await this.desktop.prepareBrowser();
      this.desktopGeneration = this.display.generation;
    }
    const args = [
      ...(this.desktop
        ? [
            '--ozone-platform=x11',
            '--window-position=8,8',
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
          ]
        : ['--headless=new']),
      // Nested user namespaces stay disabled by the launcher; the inner
      // --no-zygote is the documented single-process requirement inside bwrap.
      '--no-sandbox',
      '--no-zygote',
      ...(this.desktop ? [] : ['--disable-gpu']),
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-pipe',
      `--user-data-dir=${this.userDataDir}`,
      // Single renderer/raster processes for the resource-limited scope
      // (matches the verified root probe).
      '--renderer-process-limit=1',
      '--num-raster-threads=1',
      'about:blank',
    ];
    if (this.engine === 'firefox') {
      if (!this.display) throw new BrowserError('Firefox requires the isolated test desktop.');
      const launched = await launchFirefox(
        this.executable,
        this.userDataDir,
        this.display.env,
        this.limits
      );
      this.processHandle = launched.handle;
      this.cdp = launched.protocol;
    } else {
      const handle = this.spawnProcess(args);
      this.processHandle = handle;
      this.cdp = new CdpConnection(handle, this.limits.commandTimeoutMs);
    }
    try {
      await withTimeout(
        this.cdp.send('Target.createTarget', { url: 'about:blank' }),
        this.limits.startupTimeoutMs,
        'Browser-Start'
      ).then((result) => {
        if (!isObject(result) || typeof result.targetId !== 'string') {
          throw new BrowserError('Der Browser hat kein Ziel erstellt.');
        }
        this.targetId = result.targetId;
      });
      const attach = await this.cdp.send('Target.attachToTarget', {
        targetId: this.targetId,
        flatten: true,
      });
      if (!isObject(attach) || typeof attach.sessionId !== 'string') {
        throw new BrowserError('Die Browser-Seite konnte nicht angehängt werden.');
      }
      this.sessionId = attach.sessionId;
      await Promise.all([
        this.send('Page.enable'),
        this.send('Runtime.enable'),
        this.send('DOM.enable'),
      ]);
      // Network.setBlockedURLs stays as a second layer for the inference
      // relay port, but the enforcing point for EVERY request (main frame,
      // redirects, subresources) is the Fetch whitelist below. Both are
      // security setup: a failure here fails the start, it is not swallowed.
      await this.send('Network.enable');
      await this.send('Network.setBlockedURLs', {
        urls: ['*://127.0.0.1:8081/*', '*://localhost:8081/*', '*://[::1]:8081/*'],
      });
      await this.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      this.cdp.onEvent('Fetch.requestPaused', (params) => this.handleFetchRequest(params));
      // No uncontrolled downloads inside the sandbox.
      await this.cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' });
      // Never let the page open uncontrolled extra targets: react to new
      // targets immediately and keep a bounded sweep as a safety net.
      this.cdp.onEvent('Target.targetCreated', async (params) => {
        const info = isObject(params.targetInfo) ? params.targetInfo : undefined;
        if (
          info !== undefined &&
          info.type === 'page' &&
          typeof info.targetId === 'string' &&
          info.targetId !== this.targetId
        ) {
          await this.cdp?.send('Target.closeTarget', { targetId: info.targetId });
        }
      });
      this.autoCloseForeignTargets();
    } catch (error) {
      await this.close();
      if (error instanceof Error) throw error;
      throw new BrowserError('Der Browser konnte nicht gestartet werden.');
    }
  }

  /**
   * The single request gate: only the own sandbox loopback (except the
   * inference relay port) plus self-contained data:/blob: assets may proceed.
   * Every other request (foreign hosts, file:, other schemes, redirects to
   * them) is aborted. Continue/abort failures are recorded and surfaced on
   * the next preview operation instead of being swallowed.
   */
  private handleFetchRequest(params: Record<string, unknown>): void {
    if (this.closed || this.cdp === undefined) return;
    const requestId = typeof params.requestId === 'string' ? params.requestId : undefined;
    if (requestId === undefined) return;
    const request = isObject(params.request) ? params.request : undefined;
    const url = request !== undefined && typeof request.url === 'string' ? request.url : '';
    const command = isAllowedPreviewUrl(url)
      ? this.cdp.send('Fetch.continueRequest', { requestId })
      : this.cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    void command.catch((error) => {
      if (this.closed) return;
      this.fetchErrors.push(
        `${url.slice(0, 200)}: ${error instanceof Error ? error.message.slice(0, 160) : 'unbekannter Fehler'}`
      );
    });
  }

  /** Raises recorded request-gate failures instead of hiding them. */
  private ensureFetchHealthy(): void {
    if (this.fetchErrors.length > 0) {
      const details = this.fetchErrors.splice(0, 3).join(' · ');
      throw new BrowserError(
        `Die Vorschau-Netzwerkprüfung konnte nicht vollständig ausgeführt werden: ${details}`
      );
    }
  }

  private autoCloseForeignTargets(): void {
    const check = (): void => {
      if (this.closed || !this.isRunning) return;
      void (async () => {
        try {
          const targets = (await this.cdp?.send('Target.getTargets')) as
            Record<string, unknown> | undefined;
          const list =
            isObject(targets) && Array.isArray(targets.targetInfos)
              ? (targets.targetInfos as Array<Record<string, unknown>>)
              : [];
          for (const info of list) {
            if (
              typeof info.targetId === 'string' &&
              info.targetId !== this.targetId &&
              info.type === 'page'
            ) {
              await this.cdp?.send('Target.closeTarget', { targetId: info.targetId });
            }
          }
        } catch {
          // A transient CDP failure must not take the preview down.
        }
      })().catch(() => undefined);
      setTimeout(check, 2_000).unref?.();
    };
    setTimeout(check, 2_000).unref?.();
  }

  private async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.cdp === undefined || this.sessionId === undefined) {
      throw new BrowserError('Der Browser ist nicht gestartet.');
    }
    return await this.cdp.send(method, params, this.sessionId);
  }

  /** Resize the current page without navigation, preserving its JS/game state. */
  async resize(viewport: BrowserViewport, signal?: AbortSignal): Promise<BrowserViewport> {
    if (this.cdp === undefined)
      throw new BrowserInputError('Erst eine Vorschau öffnen (browser_open).');
    if (
      !Number.isInteger(viewport.width) ||
      viewport.width < 320 ||
      viewport.width > 1920 ||
      !Number.isInteger(viewport.height) ||
      viewport.height < 320 ||
      viewport.height > 8192
    )
      throw new BrowserInputError('Ungültige Viewport-Größe (Breite 320–1920, Höhe 320–8192).');
    this.ensureFetchHealthy();
    return await abortable(this.setViewport(viewport), signal, 'Vorschau-Größe ändern');
  }

  private async setViewport(viewport: BrowserViewport): Promise<BrowserViewport> {
    let width = clampInt(viewport.width, this.limits.viewportMin, this.limits.viewportMax, 820);
    let height = clampInt(
      viewport.height,
      this.limits.viewportMin,
      this.limits.fullPageMaxHeight,
      1180
    );

    this.desktop?.invalidateSnapshot();
    if (this.display) {
      width = Math.min(width, this.display.width - 40);
      height = Math.min(height, this.display.height - 160);
      if (this.engine === 'chromium') {
        const window = (await this.cdp!.send('Browser.getWindowForTarget', {
          targetId: this.targetId,
        })) as { windowId: number };
        await this.cdp!.send('Browser.setWindowBounds', {
          windowId: window.windowId,
          bounds: {
            windowState: 'normal',
            left: 8,
            top: 8,
            width: width + 16,
            height: height + 140,
          },
        });
      }
      await this.send('Page.bringToFront');
    }
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    return { width, height };
  }

  /** Loads one own loopback preview URL with an explicitly bounded viewport. */
  async navigate(
    url: string,
    viewport: BrowserViewport,
    signal?: AbortSignal
  ): Promise<{ url: string; title: string }> {
    const normalized = validatePreviewUrl(url);
    if (this.cdp === undefined) await this.start();
    await this.setViewport(viewport);
    this.ensureFetchHealthy();
    const operation = (async () => {
      // Only events after this point belong to the requested navigation.
      this.cdp!.resetEvents();
      const loaded = this.cdp!.waitEvent(
        'Page.loadEventFired',
        this.limits.navigationTimeoutMs
      ).then(
        () => true,
        () => false
      );
      const navigation = await this.send('Page.navigate', { url: normalized });
      const result = isObject(navigation) ? navigation : {};
      if (result.errorText !== undefined) {
        throw new BrowserError(`Navigation fehlgeschlagen: ${String(result.errorText)}`);
      }
      if (!(await loaded)) {
        throw new BrowserError(
          `Die Vorschau unter ${hostOf(normalized)} hat das Laden nicht abgeschlossen.`
        );
      }
      const title = await this.evaluate('document.title').catch(() => '');
      this.currentPageUrl = normalized;
      return { url: normalized, title: typeof title === 'string' ? title.slice(0, 200) : '' };
    })();
    return await abortable(operation, signal, 'Vorschau öffnen');
  }

  /** Bounded DOM/text/controls summary of the current page. */
  async inspect(selector?: string, signal?: AbortSignal): Promise<string> {
    if (this.cdp === undefined) throw new BrowserError('Erst eine Vorschau öffnen (browser_open).');
    this.ensureFetchHealthy();
    if (this.desktop) await this.send('Page.bringToFront');
    const clean = selector === undefined ? undefined : sanitizeSelector(selector);
    const expression = buildInspectExpression(clean);
    const raw = await abortable(this.evaluate(expression), signal, 'Vorschau prüfen');
    if (typeof raw !== 'string') {
      throw new BrowserError('Die Seiteninspektion lieferte kein Ergebnis.');
    }
    return raw.length > 12_000 ? `${raw.slice(0, 12_000)}\n[ausgewertet, gekürzt]` : raw;
  }

  /** One bounded user action on the current page. */
  async act(action: BrowserAction, signal?: AbortSignal): Promise<string> {
    if (this.cdp === undefined) throw new BrowserError('Erst eine Vorschau öffnen (browser_open).');
    this.ensureFetchHealthy();
    this.desktop?.invalidateSnapshot();
    if (this.desktop) await this.send('Page.bringToFront');
    return await abortable(this.performAction(action), signal, 'Vorschau-Aktion');
  }

  private async performAction(action: BrowserAction): Promise<string> {
    const cdp = this.cdp;
    if (cdp === undefined) throw new BrowserError('Erst eine Vorschau öffnen (browser_open).');
    switch (action.kind) {
      case 'reload': {
        cdp.resetEvents();
        // Attach both handlers immediately: the load event may time out
        // before the reload command itself settles, and a late-attached
        // handler would surface as an unhandled rejection.
        const confirmed = cdp
          .waitEvent('Page.loadEventFired', this.limits.navigationTimeoutMs)
          .then(
            () => true,
            () => false
          );
        const navigationStarted = this.send('Page.reload').then(
          () => true,
          () => false
        );
        const [started, ok] = await Promise.all([navigationStarted, confirmed]);
        if (!started || !ok) {
          throw new BrowserError(
            `Neuladen unter ${hostOf(this.currentPageUrl ?? 'der Vorschau')} hat das Ladeereignis nicht bestätigt.`
          );
        }
        return 'Seite neu geladen.';
      }
      case 'click': {
        const point = await this.elementCenter(action.selector);
        await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
        await this.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: point.x,
          y: point.y,
          button: 'left',
          clickCount: 1,
        });
        await this.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: point.x,
          y: point.y,
          button: 'left',
          clickCount: 1,
        });
        return `Klick bei ${Math.round(point.x)},${Math.round(point.y)} ausgeführt.`;
      }
      case 'type': {
        const text = action.text === undefined ? '' : action.text.slice(0, 4096);
        if (text.length === 0) throw new BrowserInputError('Kein Text zum Einfügen angegeben.');
        await this.focusElement(action.selector);
        await this.send('Input.insertText', { text });
        return `${text.length} Zeichen eingegeben.`;
      }
      case 'press': {
        const code = action.key === undefined ? undefined : KEY_CODES[action.key];
        if (code === undefined) {
          throw new BrowserInputError(
            `Taste nicht erlaubt. Erlaubt: ${Object.keys(KEY_CODES)
              .map((key) => key.trim() || 'Leertaste')
              .join(', ')}.`
          );
        }
        await this.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: code.key,
          code: code.code,
          windowsVirtualKeyCode: code.keyCode,
          nativeVirtualKeyCode: code.keyCode,
        });
        if (code.key === 'Enter' && this.engine === 'chromium')
          await this.send('Input.dispatchKeyEvent', {
            type: 'char',
            text: '\r',
            unmodifiedText: '\r',
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
          });
        await this.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: code.key,
          code: code.code,
          windowsVirtualKeyCode: code.keyCode,
          nativeVirtualKeyCode: code.keyCode,
        });
        return `Taste ${action.key === ' ' ? 'Leertaste' : action.key} gedrückt.`;
      }
      case 'scroll': {
        if (action.selector !== undefined) {
          const selector = sanitizeSelector(action.selector);
          const found = await this.evaluate(
            `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'missing'; el.scrollIntoView({ block: 'center' }); return 'ok'; })()`
          );
          if (found !== 'ok') {
            throw new BrowserInputError(`Element für Scrollen nicht gefunden: ${selector}`);
          }
          return 'Element in Ansicht gescrolled.';
        }
        const delta = clampInt(action.delta ?? 800, -20_000, 20_000, 800);
        await this.evaluate(`window.scrollBy(0, ${delta})`);
        return `Um ${delta}px gescrolled.`;
      }
      default:
        throw new BrowserInputError('Unbekannte Aktion.');
    }
  }

  /**
   * Captures a bounded PNG of the current page (viewport or clipped
   * full-page) and validates it against the fixed byte/pixel policy.
   */
  async screenshot(
    fullPage = false,
    signal?: AbortSignal
  ): Promise<{
    png: Buffer;
    mimeType: AgentImageMime;
    width: number;
    height: number;
    byteLength: number;
    clipped: boolean;
  }> {
    if (this.cdp === undefined) throw new BrowserError('Erst eine Vorschau öffnen (browser_open).');
    this.ensureFetchHealthy();
    if (this.desktop) await this.send('Page.bringToFront');
    return await abortable(this.performScreenshot(fullPage), signal, 'Screenshot');
  }

  private async performScreenshot(fullPage: boolean): Promise<{
    png: Buffer;
    mimeType: AgentImageMime;
    width: number;
    height: number;
    byteLength: number;
    clipped: boolean;
  }> {
    let clip: Record<string, number> | undefined;
    let clipped = false;
    if (fullPage) {
      const metrics = (await this.send('Page.getLayoutMetrics')) as Record<string, unknown>;
      const size = isObject(metrics.cssContentSize)
        ? (metrics.cssContentSize as Record<string, unknown>)
        : isObject(metrics.contentSize)
          ? (metrics.contentSize as Record<string, unknown>)
          : undefined;
      const width = size && typeof size.width === 'number' ? Math.ceil(size.width) : 0;
      const height = size && typeof size.height === 'number' ? Math.ceil(size.height) : 0;
      if (width > 0 && height > this.limits.fullPageMaxHeight) {
        clipped = true;
      }
      if (width > 0 && height > 0) {
        clip = {
          x: 0,
          y: 0,
          scale: 1,
          width: Math.min(width, this.limits.viewportMax),
          height: Math.min(height, this.limits.fullPageMaxHeight),
        };
      }
    }
    const capture = (await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: fullPage,
      ...(clip === undefined ? {} : { clip }),
    })) as Record<string, unknown>;
    if (!isObject(capture) || typeof capture.data !== 'string') {
      throw new BrowserError('Der Screenshot wurde nicht erzeugt.');
    }
    const png = Buffer.from(capture.data, 'base64');
    const validation = validateAgentImage('image/png', png);
    if (!validation.ok) throw new BrowserError(`Screenshot verworfen: ${validation.reason}`);
    return {
      png,
      mimeType: 'image/png',
      width: validation.width,
      height: validation.height,
      byteLength: png.length,
      clipped,
    };
  }

  /** Terminates the browser process and removes its private profile. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.desktop?.invalidateSnapshot();
    this.cdp?.close();
    this.cdp = undefined;
    const handle = this.processHandle;
    this.processHandle = undefined;
    if (handle !== undefined) {
      await new Promise<void>((resolve) => {
        if (handle.exitCode !== null || handle.signalCode !== null) {
          resolve();
          return;
        }
        let settled = false;
        const done = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          handle.kill('SIGKILL');
          done();
        }, 3_000);
        timer.unref?.();
        handle.once('exit', done);
        handle.kill('SIGTERM');
        setTimeout(done, 4_000).unref?.();
      });
    }
    await rm(this.userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }

  private async evaluate(expression: string): Promise<unknown> {
    const result = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as Record<string, unknown>;
    if (!isObject(result) || isObject(result.exceptionDetails)) {
      const details = isObject(result) ? result.exceptionDetails : undefined;
      const text =
        isObject(details) &&
        isObject(details.exception) &&
        typeof details.exception.description === 'string'
          ? details.exception.description
          : 'Seitenauswertung fehlgeschlagen.';
      throw text.startsWith('SyntaxError:')
        ? new BrowserInputError(text.slice(0, 300))
        : new BrowserError(text.slice(0, 300));
    }
    const value = isObject(result.result) ? result.result.value : undefined;
    return value;
  }

  private async elementCenter(selector?: string): Promise<{ x: number; y: number }> {
    const clean = sanitizeSelector(selector);
    const value = await this.evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(clean)});
        if (!el) return null;
        // The target must be in the viewport before CDP mouse events reach
        // its coordinates.
        el.scrollIntoView({ block: 'center' });
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return null;
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`
    );
    if (value === null || value === undefined || !isObject(value)) {
      throw new BrowserInputError(`Element nicht gefunden: ${clean}`);
    }
    if (typeof value.x !== 'number' || typeof value.y !== 'number') {
      throw new BrowserInputError(`Element liefert keine Position: ${clean}`);
    }
    return { x: value.x, y: value.y };
  }

  private async focusElement(selector?: string): Promise<void> {
    const clean = sanitizeSelector(selector);
    const value = await this.evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(clean)});
        if (!el) return false;
        el.focus();
        return document.activeElement === el;
      })()`
    );
    if (value !== true) {
      throw new BrowserInputError(`Feld nicht fokussierbar: ${clean}`);
    }
  }
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  const candidate = Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, candidate));
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'der Vorschau';
  }
}

/** CSS is passed as a JSON string to querySelector, never interpolated as code. */
export function sanitizeSelector(selector: string | undefined): string {
  const value = (selector ?? '').trim();
  if (value.length === 0) throw new BrowserInputError('Kein Selector angegeben.');
  if (value.length > 256)
    throw new BrowserInputError('Der Selector ist zu lang (maximal 256 Zeichen).');
  if (
    value.includes('javascript:') ||
    !/^[A-Za-z0-9_\u00c0-\u024f#.*:\-[\]=,'"\s()+>~|^$]+$/.test(value)
  ) {
    throw new BrowserInputError('Der Selector enthält nicht erlaubte Zeichen.');
  }
  return value;
}

function buildInspectExpression(selector: string | undefined): string {
  // Without a selector no querySelector is issued at all: an empty
  // selector is a page-level SyntaxError, not a valid "no target" state.
  const targetExpression =
    selector === undefined ? 'null' : `document.querySelector(${JSON.stringify(selector)})`;
  return `(() => {
    const pick = (el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      name: el.getAttribute('name') || undefined,
      type: el.getAttribute('type') || undefined,
      label: ((el.getAttribute('aria-label')) || (el.textContent) || '').trim().replace(/\\s+/g, ' ').slice(0, 80)
    });
    const controls = Array.from(document.querySelectorAll('button, a[href], input, select, textarea')).slice(0, 100).map(pick);
    const target = ${targetExpression};
    const rect = target ? target.getBoundingClientRect() : null;
    return JSON.stringify({
      url: location.href,
      title: document.title,
      controls,
      target: target
        ? { tag: target.tagName.toLowerCase(), text: (target.innerText || '').slice(0, 400), rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } }
        : null,
      body: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 6000)
    });
  })()`;
}
