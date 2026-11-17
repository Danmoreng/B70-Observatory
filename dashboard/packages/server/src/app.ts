import { registerModeRoutes, type EngineModes } from './engine/mode-controller.js';
import type { Studio } from './engine/studio.js';
import type { EngineMetrics } from '@observatory/contracts';
import { registerSpeechRoutes } from './speech/routes.js';
import type { SpeechTranscriber } from './speech/service.js';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { DatabaseSync } from 'node:sqlite';
import {
  HealthPayloadSchema,
  HistoryChangeSchema,
  StreamNoticeSchema,
  type ApiErrorCode,
  type HealthCheck,
  type HealthPayload,
  type SseEventType,
} from '@observatory/contracts';
import type { ServerConfig } from './config.js';
import { databaseHealthCheck } from './db/database.js';
import { buildHealthPayload, type HealthInputs } from './health.js';
import { registerGateway, type GatewayOptions } from './gateway/routes.js';
import { registerAuth, type AuthOptions } from './auth/routes.js';
import { registerHistory, type HistoryOptions } from './history/routes.js';
import { HealthEventHub } from './health-events.js';
import { TelemetryHub, SystemHub } from './telemetry/hub.js';
import { encodeSseFrame, EventJournal, type JournalEntry } from './events/journal.js';
import type { VllmCollector } from './telemetry/collector.js';
import type { SystemCollector } from './telemetry/system-collector.js';
import { registerAgentRoutes } from './agent/routes.js';
import type { AgentController } from './agent/manager.js';
import { registerEngineRoutes } from './engine/routes.js';
import type { EngineServiceController } from './engine/service.js';
import { registerImageRoutes } from './engine/image-routes.js';
import type { ImageJobs } from './engine/image-jobs.js';

/**
 * Structured-log sink (pino's `stream` option). `node:stream` `Writable`
 * instances satisfy this, which is what the tests inject.
 */
export interface AppLogStream {
  write(message: string): void | boolean;
}

export interface AppOptions {
  engineMetrics?: () => Promise<EngineMetrics>;
  imageJobs?: ImageJobs;
  engineModes?: EngineModes;
  studio?: Studio;
  version: string;
  config: ServerConfig;
  /** Process start time; injectable for deterministic tests. */
  startedAt?: Date;
  /** Override logger level, e.g. 'silent' in tests. */
  loggerLevel?: 'info' | 'warn' | 'error' | 'silent';
  /**
   * Test seam: redirect log output to a custom stream (e.g. an in-memory
   * collector). The request redaction below is applied regardless, so the
   * logger is always configured through the same code path.
   */
  loggerStream?: AppLogStream;
  /** When set, `/api/health` probes the database as an extra check. */
  database?: DatabaseSync;
  /** When set, the OpenAI-compatible gateway routes are registered (M3). */
  gateway?: GatewayOptions;
  /**
   * Read-only historical API (M5A): request list/detail and metric
   * history. Protected by the same session rules as the rest of /api.
   */
  history?: HistoryOptions;
  /** Browser/API authentication. Required before binding in LAN mode. */
  auth?: AuthOptions;
  /**
   * vLLM telemetry (M4A): a running (or manually driven in tests)
   * collector whose semantically changed snapshots are broadcast on the
   * shared SSE stream as `event: telemetry` frames.
   */
  telemetry?: { collector: VllmCollector };
  /**
   * System & GPU telemetry (M4B): a running (or manually driven in
   * tests) collector whose semantically changed snapshots are broadcast on
   * the shared SSE stream as `event: system` frames.
   */
  system?: { collector: SystemCollector };
  /** Optional Pi RPC process exposed through the authenticated Agent Cockpit. */
  agent?: AgentController;
  engineService?: EngineServiceController;
  speech?: SpeechTranscriber;
  /** Absolute path of the built Vue app. When set, Fastify serves it same-origin. */
  webRoot?: string;
}

const SAFE_HTTP_CODES = new Set([
  400, 401, 403, 404, 405, 406, 409, 410, 411, 413, 414, 415, 422, 429, 500, 502, 503, 504,
]);

function errorCodeFor(statusCode: number): ApiErrorCode {
  if (statusCode === 401) return 'unauthorized';
  if (statusCode === 403) return 'forbidden';
  if (statusCode === 429) return 'too_many_requests';
  if (statusCode === 404) return 'not_found';
  if (
    statusCode === 400 ||
    statusCode === 409 ||
    statusCode === 410 ||
    statusCode === 413 ||
    statusCode === 415 ||
    statusCode === 422
  ) {
    return 'bad_request';
  }
  if (statusCode === 503) return 'service_unavailable';
  if (statusCode >= 500) return 'internal_error';
  return 'bad_request';
}

/**
 * Request-log serializer (review finding R1): the raw request URL is
 * replaced by its path component because query strings are the classic
 * carrier for secrets (`?token=…`). The redacted form never contains
 * anything after the first `?`.
 */
function sanitizedRequestLog(req: {
  id: string;
  method: string;
  url: string;
  remoteAddress?: string;
  remotePort?: number;
}) {
  return {
    id: req.id,
    method: req.method,
    url: req.url.split('?')[0] ?? req.url,
    remoteAddress: req.remoteAddress,
    remotePort: req.remotePort,
  };
}

/** Path-only view of a request URL, safe to include in client-facing text. */
function requestPath(url: string): string {
  return url.split('?')[0] ?? url;
}

/**
 * M5C: maximum bytes a connected SSE client may buffer without reading before
 * the server drops the connection. Bounded memory per client; the browser's
 * EventSource reconnects and re-synchronises via its `Last-Event-ID`, so no
 * event is lost – it stays in the journal's replay window.
 */
const SSE_MAX_INFLIGHT_BYTES = 128 * 1024;

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(self), geolocation=()',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
    "connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; " +
    "form-action 'self'",
} as const;

/**
 * Builds the Fastify application. All error responses follow the shared
 * `ApiError` contract; internal error details are never leaked to clients,
 * and structured logs never contain query strings (R1).
 */
export function buildApp(options: AppOptions): FastifyInstance {
  const startedAt = options.startedAt ?? new Date();
  const healthInputs: HealthInputs = { version: options.version, startedAt };

  const app = Fastify({
    bodyLimit: options.config.maxRequestBytes,
    logger:
      options.loggerLevel === 'silent'
        ? false
        : {
            level: options.loggerLevel,
            stream: options.loggerStream,
            serializers: { req: sanitizedRequestLog },
          },
  });

  app.addHook('onSend', (request, reply, payload, done) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    if (request.url.startsWith('/api/auth/')) reply.header('cache-control', 'no-store');
    done(null, payload);
  });

  // Note: the request size limit above (`bodyLimit`) is enforced by
  // Fastify while parsing bodies (Content-Length and chunked uploads).
  // The gateway additionally pre-checks Content-Length itself so that an
  // oversized OpenAI request gets the OpenAI error contract, a stable
  // `x-request-id` and terminal telemetry before any byte is buffered.

  if (
    options.config.mode === 'lan' &&
    (options.auth === undefined || options.webRoot === undefined)
  ) {
    throw new Error('LAN mode requires authentication and a built web root');
  }

  if (options.auth !== undefined) {
    registerAuth(app, options.auth);
  }

  if (options.gateway !== undefined) {
    registerGateway(app, options.gateway);
  }
  if (options.imageJobs) registerImageRoutes(app, options.imageJobs, options.engineModes);
  registerModeRoutes(app, options.engineModes);
  app.get('/api/engine/metrics', async (_request, reply) =>
    options.engineMetrics
      ? options.engineMetrics()
      : reply.code(503).send({ error: { message: 'Engine metrics unavailable.' } })
  );
  options.studio?.register(app);

  if (options.history !== undefined) {
    registerHistory(app, options.history);
  }

  // Register the route even when disabled so the UI can distinguish a server
  // without Agent configuration from a network failure.
  registerAgentRoutes(app, options.agent);
  registerEngineRoutes(app, options.engineService);
  registerSpeechRoutes(app, options.speech);

  if (options.webRoot !== undefined) {
    app.register(fastifyStatic, {
      root: options.webRoot,
      index: false,
      // Vite uses content-hashed asset names. A wildcard route resolves the
      // current files at request time, so an atomic frontend rebuild cannot
      // leave a long-running server with routes for yesterday's hashes.
      wildcard: true,
      maxAge: '1h',
      immutable: false,
    });
    app.get('/', async (_request, reply) => reply.sendFile('index.html', { maxAge: 0 }));
  }

  const healthSnapshot = (): HealthPayload => {
    const checks: HealthCheck[] = [{ name: 'server', status: 'ok' }];
    if (options.gateway !== undefined) {
      // Registered means the routes are live and the upstream config is
      // valid (validated at startup). The active upstream liveness check is
      // the telemetry collector (M4A).
      checks.push({ name: 'gateway', status: 'ok' });
    }
    if (options.database !== undefined) {
      checks.push(databaseHealthCheck(options.database));
    }
    if (options.telemetry !== undefined) {
      checks.push(options.telemetry.collector.healthCheck());
    }
    if (options.system !== undefined) {
      const systemCollector = options.system.collector;
      checks.push(systemCollector.healthCheck());
      checks.push(systemCollector.gpuHealthCheck());
    } else if (options.telemetry !== undefined) {
      const gpu = options.telemetry.collector.gpuProbe;
      checks.push(
        gpu.available
          ? { name: 'gpu', status: 'ok', message: 'Schnittstelle verfügbar' }
          : { name: 'gpu', status: 'degraded', message: gpu.reason }
      );
    }
    return buildHealthPayload(new Date(), { ...healthInputs, checks });
  };

  // M5C: one shared journal assigns strictly increasing ids to every frame
  // of the shared stream and owns the bounded replay window. The per-source
  // hubs keep their semantic-change deduplication and feed the journal.
  const events = new EventJournal({ capacity: options.config.eventBufferSize });
  const healthEvents = new HealthEventHub(healthSnapshot, 5000, (payload) => {
    events.publish('health', JSON.stringify(payload));
  });
  // Keep the health watcher running for the whole process lifetime; the
  // journal – not per-connection hub subscriptions – fans values out.
  const stopHealthWatch = healthEvents.subscribe(() => undefined);
  healthEvents.checkNow(); // seed the journal with the initial health state

  let telemetryHub: TelemetryHub | undefined;
  if (options.telemetry !== undefined) {
    const { collector } = options.telemetry;
    telemetryHub = new TelemetryHub();
    telemetryHub.setSink((payload) => events.publish('telemetry', JSON.stringify(payload)));
    collector.onSnapshot = (payload) => {
      telemetryHub?.publish(payload);
    };
    if (collector.latestSnapshot !== undefined) telemetryHub.publish(collector.latestSnapshot);
  }

  let systemHub: SystemHub | undefined;
  if (options.system !== undefined) {
    const { collector } = options.system;
    systemHub = new SystemHub();
    systemHub.setSink((payload) => events.publish('system', JSON.stringify(payload)));
    collector.onSnapshot = (payload) => {
      systemHub?.publish(payload);
    };
    if (collector.latestSnapshot !== undefined) systemHub.publish(collector.latestSnapshot);
  }

  app.get('/api/health', async () => healthSnapshot());

  // M5A/M5C: repository writes are coalesced globally (one bounded
  // `history` frame per 250 ms for all clients) instead of per connection,
  // so the shared journal stays small and every client sees the same ids.
  let historyPending: Set<'requests' | 'metrics'> | undefined;
  let historyTimer: NodeJS.Timeout | undefined;
  if (options.history !== undefined) {
    historyPending = new Set();
    const invalidate = (): void => {
      if (historyPending === undefined || historyTimer !== undefined) return;
      historyTimer = setTimeout(() => {
        historyTimer = undefined;
        const pending = historyPending;
        if (pending === undefined || pending.size === 0) return;
        const payload = HistoryChangeSchema.parse({
          resources: [...pending],
          timestamp: new Date().toISOString(),
        });
        pending.clear();
        events.publish('history', JSON.stringify(payload));
      }, 250);
      historyTimer.unref();
    };
    options.history.requests.changes.subscribe(() => {
      historyPending?.add('requests');
      invalidate();
    });
    options.history.metrics.changes.subscribe(() => {
      historyPending?.add('metrics');
      invalidate();
    });
  }

  /**
   * Shared authenticated event stream.
   *
   * Every replayable data frame carries a validated `id:` (SSE
   * `Last-Event-ID`) of the form `<generation>-<sequence>`. Connection-local
   * control frames do not advance that cursor. On (re)connect the server decides:
   * - unknown/missing/invalid/future id or id from a previous process
   *   generation (restart): explicit re-synchronisation – fresh current
   *   snapshots are sent to that client at a captured checkpoint;
   * - id inside the bounded replay window: all missed frames with a higher
   *   sequence are replayed exactly once, in global order, before live
   *   frames continue; an up-to-date client (id = last published) receives
   *   no duplicates.
   *
   * The replay snapshot is taken synchronously before the live listener is
   * registered. Live entries are queued until the initial burst is written,
   * so an event is either replayed or delivered live – never both, never lost.
   */
  app.get('/api/events', (request, reply) => {
    reply.hijack();
    const raw = reply.raw;
    request.raw.socket.setKeepAlive(true, 30_000);
    raw.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    raw.write('retry: 3000\n\n');

    const decision = events.resolveReconnect(request.headers['last-event-id']);
    let replay: JournalEntry[] = [];
    let replayedTypes: SseEventType[] | undefined;
    let notice: ReturnType<typeof StreamNoticeSchema.parse>;
    let noticeId: string | undefined;
    const snapshots: Array<{ id?: string; type: JournalEntry['type']; data: string }> = [];
    if (decision.mode === 'resync') {
      notice = StreamNoticeSchema.parse({ kind: 'resync' });
      // Capture one atomic checkpoint and the current state. These frames
      // are connection-local: a new/recovering browser must never force
      // healthy clients into resync or add duplicate snapshots to the
      // global replay journal. Reusing the checkpoint id is intentional;
      // the snapshots describe state at that boundary and the next journal
      // event continues with a strictly greater sequence.
      const checkpoint = events.lastId;
      noticeId = checkpoint;
      const health = healthEvents.current;
      if (health !== undefined)
        snapshots.push({ id: checkpoint, type: 'health', data: JSON.stringify(health) });
      const telemetry = telemetryHub?.latestSnapshot;
      if (telemetry !== undefined)
        snapshots.push({ id: checkpoint, type: 'telemetry', data: JSON.stringify(telemetry) });
      const system = systemHub?.latestSnapshot;
      if (system !== undefined)
        snapshots.push({ id: checkpoint, type: 'system', data: JSON.stringify(system) });
    } else {
      replayedTypes = events.typesAfter(decision.from);
      notice = StreamNoticeSchema.parse({ kind: 'replay', types: replayedTypes });
      replay = events.entriesAfter(decision.from) ?? [];
    }

    app.log.info(
      {
        lastEventId:
          typeof request.headers['last-event-id'] === 'string'
            ? request.headers['last-event-id']
            : undefined,
        mode: decision.mode,
        replayed: replay.length,
        types: replayedTypes ?? [],
      },
      'event stream connection established'
    );

    let initializing = true;
    const pending: JournalEntry[] = [];
    const writeEntry = (entry: Parameters<typeof encodeSseFrame>[0]): boolean => {
      if (raw.destroyed || raw.writableEnded) return false;
      raw.write(encodeSseFrame(entry));
      // A client that stops reading would otherwise buffer unbounded data;
      // dropping it is safe because the journal can replay or re-sync it on
      // the automatic reconnect.
      if (raw.writableLength > SSE_MAX_INFLIGHT_BYTES) {
        raw.destroy();
        return false;
      }
      return true;
    };
    const unsubscribe = events.subscribe((entry) => {
      if (initializing) {
        pending.push(entry);
        return;
      }
      writeEntry(entry);
    });
    // Control notices are deliberately not journaled and carry no new id.
    // A resync notice repeats the captured checkpoint; a replay notice leaves
    // Last-Event-ID untouched. Neither can move the cursor past older replay
    // entries which follow.
    writeEntry({ id: noticeId, type: 'stream', data: JSON.stringify(notice) });
    for (const entry of snapshots) writeEntry(entry);
    for (const entry of replay) writeEntry(entry);
    initializing = false;
    for (const entry of pending) {
      if (!writeEntry(entry)) break;
    }
    request.raw.once('close', () => unsubscribe());
  });

  app.addHook('onClose', async () => {
    if (historyTimer !== undefined) clearTimeout(historyTimer);
    stopHealthWatch?.();
    healthEvents.close();
    events.close();
    telemetryHub?.close();
    systemHub?.close();
    options.telemetry?.collector.stop();
    options.system?.collector.stop();
    await options.agent?.close();
  });

  app.setNotFoundHandler((request, reply) => {
    const routeOptions = request.routeOptions;
    const allowedMethods = routeOptions?.method;
    if (allowedMethods !== undefined && !allowedMethods.includes(request.method)) {
      reply.status(405).send({
        error: {
          code: 'bad_request',
          message: `Method ${request.method} is not allowed for ${requestPath(request.url)}.`,
        },
      });
      return;
    }
    const path = requestPath(request.url);
    if (
      options.webRoot !== undefined &&
      request.method === 'GET' &&
      !path.startsWith('/api/') &&
      !path.startsWith('/v1/') &&
      request.headers.accept?.includes('text/html')
    ) {
      void reply.sendFile('index.html', { maxAge: 0 });
      return;
    }
    reply.status(404).send({
      error: {
        code: 'not_found',
        message: `Route ${request.method} ${requestPath(request.url)} was not found.`,
      },
    });
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode =
      typeof error.statusCode === 'number' && SAFE_HTTP_CODES.has(error.statusCode)
        ? error.statusCode
        : 500;
    const code = errorCodeFor(statusCode);
    const message =
      statusCode >= 500
        ? 'Internal server error.'
        : (error.message || 'Request could not be processed.').slice(0, 512);
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'unhandled error');
    } else {
      request.log.warn({ err: error }, 'request rejected');
    }
    if (!reply.sent) {
      reply.status(statusCode).send({ error: { code, message } });
    }
  });

  app.addHook('onSend', (request, reply, payload, done) => {
    // Defense in depth: successful health payloads must always satisfy the
    // shared contract before leaving the process.
    if (
      request.routeOptions.url === '/api/health' &&
      reply.statusCode < 400 &&
      typeof payload === 'string'
    ) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        parsed = undefined;
      }
      if (!HealthPayloadSchema.safeParse(parsed).success) {
        reply.code(500);
        done(
          null,
          JSON.stringify({ error: { code: 'internal_error', message: 'Internal server error.' } })
        );
        return;
      }
    }
    done(null, payload);
  });

  return app;
}

/**
 * Bounded close (M5C): hijacked SSE connections stay open for the whole
 * process lifetime, so a plain `app.close()` – which drains every
 * connection – would hang forever while a dashboard tab is open. Wait at
 * most `timeoutMs` for the connections to drain and resolve either way;
 * the caller exits immediately and connected clients reconnect and
 * re-synchronise instead of blocking the restart.
 */
export function closeWithDrainTimeout(app: FastifyInstance, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs);
    timer.unref?.();
    void app.close().then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      }
    );
  });
}
