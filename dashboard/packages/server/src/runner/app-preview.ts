import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import { join } from 'node:path';
import { createServer as createUnixServer, type Socket } from 'node:net';
import type { AppPreview } from '@observatory/contracts';
import {
  createWorkspaceSnapshot,
  launchWorkspaceUtility,
  stopSandboxedJob,
  type SandboxedJob,
} from '@observatory/runner';
import { AgentControlError } from '../agent/manager.js';
import type { NpmRegistryAccess } from './npm-registry.js';
import { prepareNpmWorkspace } from './npm-workspace.js';

interface AppRelay {
  take(): Socket | undefined;
  acquire(signal: AbortSignal): Promise<Socket | undefined>;
  close(): void;
}

/** The host only accepts sandbox connections. It never follows an app-controlled socket path. */
export async function createAppRelay(path: string): Promise<AppRelay> {
  const sockets = new Set<Socket>();
  const available: Socket[] = [];
  const waiters = new Set<{ deliver(socket?: Socket): void }>();
  let closed = false;
  const take = () => {
    let socket: Socket | undefined;
    do {
      socket = available.shift();
    } while (socket !== undefined && socket.destroyed);
    return socket;
  };
  const server = createUnixServer((socket) => {
    if (closed || sockets.size >= 32) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const waiter = waiters.values().next().value;
    if (waiter) waiter.deliver(socket);
    else available.push(socket);
    socket.once('error', () => socket.destroy());
    socket.once('close', () => {
      sockets.delete(socket);
      const index = available.indexOf(socket);
      if (index >= 0) available.splice(index, 1);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return {
    take,
    acquire: (signal) => {
      if (closed || signal.aborted) return Promise.resolve(undefined);
      const socket = take();
      if (socket) return Promise.resolve(socket);
      if (waiters.size >= 32) return Promise.resolve(undefined);
      return new Promise((resolve) => {
        const abort = () => waiter.deliver();
        const timer = setTimeout(abort, 5000);
        const waiter = {
          deliver(value?: Socket) {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            waiters.delete(waiter);
            resolve(value);
          },
        };
        waiters.add(waiter);
        signal.addEventListener('abort', abort, { once: true });
      });
    },
    close: () => {
      closed = true;
      for (const waiter of waiters) waiter.deliver();
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

function transportOptions(transport: string | (() => Socket | undefined)) {
  if (typeof transport === 'string') return { socketPath: transport };
  const socket = transport();
  if (socket === undefined) return undefined;
  // Supplying createConnection without an Agent uses this one already connected stream.
  return { createConnection: () => socket, agent: undefined };
}

function appCookieHeader(raw: string | undefined, prefix: string): string | undefined {
  const values = (raw ?? '')
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value.startsWith(prefix))
    .map((value) => value.slice(prefix.length));
  return values.length ? values.join('; ') : undefined;
}

function appSetCookies(values: string[], prefix: string): string[] {
  return values.flatMap((value) => {
    const [pair, ...attributes] = value.split(';');
    const separator = pair?.indexOf('=') ?? -1;
    const name = pair?.slice(0, separator) ?? '';
    if (separator < 1 || !/^[A-Za-z0-9_!#$%&'*+.^`|~-]{1,80}$/.test(name)) return [];
    const safe = attributes
      .map((attribute) => attribute.trim())
      .filter((attribute) =>
        /^(?:HttpOnly|Secure|SameSite=(?:Strict|Lax|None)|Max-Age=-?\d+|Expires=[^;\r\n]+)$/i.test(
          attribute
        )
      );
    return [`${prefix}${pair}; Path=/; ${safe.join('; ')}`];
  });
}

/** One dedicated browser origin per app; no dashboard cookies/headers reach app code. */
export async function createAppBridge(
  transport: string | ((signal: AbortSignal) => Socket | undefined | Promise<Socket | undefined>),
  host: string,
  token: string,
  cookieScope = token.slice(0, 16)
): Promise<Server> {
  const cookieName = `b70_app_${token.slice(0, 16)}`;
  const userCookiePrefix = `b70_user_${cookieScope.replace(/[^a-z0-9]/gi, '')}_`;
  let active = 0;
  const server = createServer(async (incoming, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('x-frame-options', 'DENY');
    const url = new URL(incoming.url ?? '/', 'http://app.invalid');
    if (incoming.method === 'GET' && url.pathname === `/_b70/open/${token}` && url.search === '') {
      response.writeHead(303, {
        location: '/',
        'set-cookie': `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict`,
      });
      response.end();
      return;
    }
    const authenticated = incoming.headers.cookie
      ?.split(';')
      .some((value) => value.trim() === `${cookieName}=${token}`);
    if (!authenticated || url.pathname.startsWith('/_b70/')) {
      response.writeHead(403);
      response.end('Open this app using the dashboard link.');
      return;
    }
    // A different app port is a different origin, even on the same LAN server.
    if (
      incoming.headers.origin !== undefined &&
      incoming.headers.origin !== `http://${incoming.headers.host ?? ''}`
    ) {
      response.writeHead(403);
      response.end('Foreign origin rejected.');
      return;
    }
    if (active >= 32 || Number(incoming.headers['content-length'] ?? 0) > 1024 * 1024) {
      response.writeHead(active >= 32 ? 503 : 413);
      response.end();
      return;
    }
    // Count waiting requests too; normal asset bursts wait for the fixed reverse
    // pool to replenish instead of receiving a transient 503. Never replay HTTP.
    active++;
    const waiting = new AbortController();
    response.once('close', () => {
      active--;
      waiting.abort();
    });
    let connection;
    try {
      if (typeof transport === 'string') connection = { socketPath: transport };
      else {
        const socket = await transport(waiting.signal);
        if (waiting.signal.aborted) {
          socket?.destroy();
          return;
        }
        if (socket) connection = { createConnection: () => socket, agent: undefined };
      }
    } catch {
      // Transport failures use the same bounded unavailability response below.
    }
    if (waiting.signal.aborted) return;
    if (connection === undefined) {
      response.writeHead(503);
      response.end('App is reconnecting. Try again.');
      return;
    }
    const headers: Record<string, string> = {};
    for (const name of ['accept', 'content-type', 'content-length', 'range', 'if-none-match']) {
      const value = incoming.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    const cookie = appCookieHeader(incoming.headers.cookie, userCookiePrefix);
    if (cookie !== undefined) headers.cookie = cookie;
    const upstream = request(
      {
        ...connection,
        method: incoming.method,
        path: url.pathname + url.search,
        headers,
        timeout: 30_000,
      },
      (appResponse) => {
        const output: Record<string, string> = {};
        for (const name of [
          'content-type',
          'content-length',
          'content-encoding',
          'content-range',
          'accept-ranges',
          'etag',
        ]) {
          const value = appResponse.headers[name];
          if (typeof value === 'string') output[name] = value;
        }
        const location = appResponse.headers.location;
        if (
          location !== undefined &&
          location.startsWith('/') &&
          !location.startsWith('//') &&
          !location.includes('\\')
        )
          output.location = location;
        output['content-security-policy'] =
          "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";
        const cookies = appSetCookies(appResponse.headers['set-cookie'] ?? [], userCookiePrefix);
        if (cookies.length) response.setHeader('set-cookie', cookies);
        response.writeHead(appResponse.statusCode ?? 502, output);
        let bytes = 0;
        appResponse.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 16 * 1024 * 1024) upstream.destroy(new Error('App response too large'));
        });
        appResponse.once('error', () => response.destroy());
        appResponse.pipe(response);
      }
    );
    let bytes = 0;
    incoming.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        if (!response.headersSent) response.writeHead(413);
        response.end();
        upstream.destroy();
      }
    });
    upstream.once('timeout', () => upstream.destroy(new Error('App request timed out')));
    upstream.once('error', () => {
      if (!response.headersSent) {
        response.writeHead(502);
        response.end('App unavailable. Check its runtime log in the dashboard.');
      } else response.destroy();
    });
    incoming.once('aborted', () => upstream.destroy());
    response.once('close', () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.maxConnections = 64;
  server.on('upgrade', (_request, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return server;
}

async function ready(transport: () => Socket | undefined): Promise<boolean> {
  const connection = transportOptions(transport);
  if (connection === undefined) return false;
  return new Promise((resolve) => {
    const check = request({ ...connection, path: '/', timeout: 300 }, (response) => {
      response.destroy();
      resolve(true);
    });
    check.once('timeout', () => check.destroy());
    check.once('error', () => resolve(false));
    check.end();
  });
}

interface RunningApp {
  state: AppPreview;
  runId: string;
  job: SandboxedJob;
  bridge?: Server;
  exited: boolean;
  snapshotRoot: string;
  relay: AppRelay;
}

export class AppPreviewManager {
  private readonly apps = new Map<string, RunningApp>();
  private readonly preparations = new Map<string, AppPreview>();
  private readonly pending = new Set<string>();
  private closed = false;
  constructor(
    private readonly root: string,
    private readonly supportRoot: string,
    private readonly host: string,
    private readonly npmRegistry?: NpmRegistryAccess
  ) {}

  status(projectId: string): AppPreview {
    const state = this.preparations.get(projectId) ?? this.apps.get(projectId)?.state;
    return state === undefined ? { projectId, status: 'stopped', logs: '' } : { ...state };
  }

  async start(projectId: string, repository: string, revision: string): Promise<AppPreview> {
    if (this.closed) throw new AgentControlError('unavailable', 'App runtime is shutting down.');
    if (this.pending.has(projectId))
      throw new AgentControlError('busy', 'An app operation is already running.');
    const activeProjects = new Set([
      ...this.pending,
      ...[...this.apps.entries()]
        .filter(([, app]) => ['starting', 'running'].includes(app.state.status))
        .map(([id]) => id),
    ]);
    if (activeProjects.size >= 3 && !activeProjects.has(projectId)) {
      throw new AgentControlError('busy', 'Stop an app first; at most three apps may run.');
    }
    this.pending.add(projectId);
    let app: RunningApp | undefined;
    let snapshotRoot: string | undefined;
    let relay: AppRelay | undefined;
    try {
      await this.stopInternal(projectId);
      this.preparations.set(projectId, {
        projectId,
        status: 'starting',
        revision,
        logs: 'Preparing an isolated app build.\n',
      });
      const root = join(this.root, projectId);
      const socketRoot = join(root, 'socket');
      const dataRoot = join(root, 'data');
      await mkdir(root, { recursive: true, mode: 0o700 });
      await rm(socketRoot, { recursive: true, force: true });
      await mkdir(socketRoot, { mode: 0o700 });
      await mkdir(dataRoot, { recursive: true, mode: 0o700 });
      const runId = randomBytes(16).toString('hex');
      const snapshots = join(this.root, 'snapshots');
      await mkdir(snapshots, { recursive: true, mode: 0o700 });
      const workspace = await createWorkspaceSnapshot({
        repository,
        revision,
        stateRoot: snapshots,
        runId,
      });
      snapshotRoot = join(snapshots, runId);
      const buildLog = await prepareNpmWorkspace(
        this.supportRoot,
        this.npmRegistry,
        workspace.path,
        true
      );
      relay = await createAppRelay(join(socketRoot, 'relay.sock'));
      const job = launchWorkspaceUtility({
        runId,
        workspacePath: workspace.path,
        runtimeRoot: this.supportRoot,
        runtimeExecutable: 'app-entry.js',
        application: { socketRoot, dataRoot },
        limits: {
          memoryBytes: 512 * 1024 * 1024,
          cpuQuotaPercent: 100,
          tasksMax: 64,
          runtimeSeconds: 8 * 60 * 60,
          tmpBytes: 128 * 1024 * 1024,
        },
      });
      app = {
        state: { projectId, status: 'starting', revision, logs: buildLog.slice(-16384) },
        runId,
        job,
        exited: false,
        snapshotRoot,
        relay,
      };
      const current = app;
      this.apps.set(projectId, current);
      this.preparations.delete(projectId);
      const log = (chunk: Buffer): void => {
        current.state.logs = (current.state.logs + chunk.toString('utf8')).slice(-16384);
      };
      job.child.stdout.on('data', log);
      job.child.stderr.on('data', log);
      job.child.once('error', (error) => log(Buffer.from(error.message)));
      job.child.once('close', () => {
        current.exited = true;
        if (current.state.status !== 'stopped') current.state.status = 'failed';
        delete current.state.port;
        delete current.state.accessPath;
        current.bridge?.closeAllConnections();
        current.bridge?.close();
      });
      job.child.stdin.end();
      const transport = relay.take;
      const deadline = Date.now() + 10_000;
      while (!current.exited && Date.now() < deadline) {
        if (await ready(transport)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (current.exited || !(await ready(transport)))
        throw new Error('App did not start. Expected server.mjs listening on 127.0.0.1:3000.');
      if (this.closed) throw new Error('App runtime is shutting down.');
      const token = randomBytes(32).toString('hex');
      current.bridge = await createAppBridge(relay.acquire, this.host, token, projectId);
      if (current.exited) {
        current.bridge.close();
        throw new Error('App exited during startup.');
      }
      const address = current.bridge.address();
      if (address === null || typeof address === 'string')
        throw new Error('App bridge address unavailable.');
      current.state = {
        ...current.state,
        status: 'running',
        port: address.port,
        accessPath: `/_b70/open/${token}`,
      };
      return this.status(projectId);
    } catch (error) {
      if (app !== undefined) {
        await this.stopInternal(projectId);
        app.state.status = 'failed';
        app.state.logs = (
          app.state.logs +
          '\n' +
          (error instanceof Error ? error.message : 'App start failed.')
        ).slice(-16384);
      }
      if (app === undefined) relay?.close();
      if (app === undefined) {
        this.preparations.set(projectId, {
          projectId,
          status: 'failed',
          revision,
          logs: (error instanceof Error ? error.message : 'App start failed.').slice(-16384),
        });
      }
      if (app === undefined && snapshotRoot !== undefined)
        await rm(snapshotRoot, { recursive: true, force: true });
      throw new AgentControlError(
        'unavailable',
        error instanceof Error ? error.message : 'App start failed.'
      );
    } finally {
      this.pending.delete(projectId);
    }
  }

  async stop(projectId: string): Promise<AppPreview> {
    if (this.pending.has(projectId))
      throw new AgentControlError('busy', 'An app operation is already running.');
    this.pending.add(projectId);
    try {
      await this.stopInternal(projectId);
      return this.status(projectId);
    } finally {
      this.pending.delete(projectId);
    }
  }

  private async stopInternal(projectId: string): Promise<void> {
    this.preparations.delete(projectId);
    const app = this.apps.get(projectId);
    if (app === undefined) return;
    app.bridge?.closeAllConnections();
    app.bridge?.close();
    app.relay.close();
    app.state.status = 'stopped';
    delete app.state.port;
    delete app.state.accessPath;
    if (!app.exited) {
      await stopSandboxedJob(app.runId).catch(() => undefined);
      const waitForExit = async (milliseconds: number): Promise<void> => {
        const deadline = Date.now() + milliseconds;
        while (!app.exited && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 50));
      };
      await waitForExit(1500);
      if (!app.exited) {
        await stopSandboxedJob(app.runId, 'SIGKILL').catch(() => undefined);
        app.job.child.kill('SIGKILL');
        await waitForExit(1500);
      }
      if (!app.exited) throw new AgentControlError('unavailable', 'App could not be stopped.');
    }
    await rm(app.snapshotRoot, { recursive: true, force: true });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.apps.keys()].map((id) => this.stopInternal(id)));
  }
}
