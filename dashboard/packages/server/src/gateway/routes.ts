import type { EngineModes } from '../engine/mode-controller.js';
import type {
  FastifyError,
  FastifyInstance,
  FastifyLoggerInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { Readable } from 'node:stream';
import { RequestRepository } from '../db/index.js';
import type { ServerConfig } from '../config.js';
import {
  buildErrorBody,
  errorCodeForHttpStatus,
  errorFromFetchFailure,
  GatewayError,
  UPSTREAM_MESSAGES,
  type AbortCause,
  type GatewayErrorCode,
} from './errors.js';
import {
  REQUEST_ID_HEADER,
  pickForwardedHeaders,
  randomUuid,
  requestOrigin,
  resolveRequestId,
} from './headers.js';
import { extractUsage, SseMeter, type UpstreamUsage } from './sse.js';
import { normalizeReasoningEffort } from './reasoning.js';
import { registerTokenize } from './tokenize.js';
import { createInferenceTransport } from './inference-transport.js';
import type { GpuScheduler } from '../engine/gpu-scheduler.js';

/**
 * Inference gateway: forwards Chat Completions, Responses and Messages
 * to the upstream vLLM service with
 *
 * - request/response pass-through, with high → xhigh effort normalization
 *   for the Qwen serving profile (prompts, tools and answers are unchanged);
 * - unchanged SSE streaming with backpressure (Node stream `pipe`);
 * - client-abort propagation to the upstream (AbortController);
 * - configurable timeouts (total upstream budget + stream idle timeout);
 * - a stable request id (UUID) from ingress to the database row;
 * - metadata-only persistence through the M2 repositories (no raw
 *   content, no secrets; persistence failures never break a response);
 * - a tight request-header allowlist; `Authorization` is forwarded to the
 *   upstream but is never logged, persisted or put into URLs.
 */

export const CHAT_COMPLETIONS_ENDPOINT = '/v1/chat/completions';
// Fixed inference surface: never proxy model-server administration or /api.
const INFERENCE_ROUTES = [
  { method: 'POST', url: CHAT_COMPLETIONS_ENDPOINT, jsonBody: true },
  { method: 'POST', url: '/v1/completions', jsonBody: true },
  { method: 'POST', url: '/v1/responses', jsonBody: true },
  { method: 'GET', url: '/v1/responses/:responseId', jsonBody: false },
  { method: 'POST', url: '/v1/responses/:responseId/cancel', jsonBody: false },
  { method: 'POST', url: '/v1/messages', jsonBody: true },
  { method: 'POST', url: '/v1/messages/count_tokens', jsonBody: true },
  { method: 'GET', url: '/v1/models', jsonBody: false },
] as const;

export interface GatewayOptions {
  config: ServerConfig;
  /** M2 repository used for request metadata persistence. */
  requests: RequestRepository;
  gpu?: GpuScheduler;
  engineModes?: EngineModes;
  internalStudioToken?: string;
}

/** Per-request mutable state shared by both response modes. */
export interface GatewayContext {
  releaseGpu?: () => void;
  request: FastifyRequest;
  reply: FastifyReply;
  config: ServerConfig;
  requestId: string;
  raw: Buffer;
  startedAt: number;
  finished: boolean;
  /** Per-request capability proving that this run created its telemetry row. */
  telemetryOwner?: symbol;
  /** Set right before any `controller.abort()` to disambiguate the cause. */
  abortCause: AbortCause | null;
  controller: AbortController;
  upstreamUrl: string;
  headers: Record<string, string>;
  /** Invoked when the client socket closes before the request settles. */
  onClientGone: () => void;
}

export function registerGateway(app: FastifyInstance, options: GatewayOptions): void {
  const { config } = options;
  registerTokenize(
    app,
    config,
    options.gpu,
    (request) =>
      !options.engineModes ||
      options.engineModes.allowsText() ||
      request.headers.authorization === 'Bearer ' + options.internalStudioToken
  );
  const transport = createInferenceTransport(
    config.upstreamTimeoutMs,
    config.upstreamStreamIdleTimeoutMs
  );
  app.addHook('onClose', () => transport.close());
  const log = app.log;
  const telemetry = createTelemetry(options.requests, log);

  app.register(async (scope) => {
    // The gateway needs the *raw* bytes (forwarded unmodified), so JSON
    // is parsed to a Buffer inside this scope. The parser `limit` enforces
    // the configured request-size limit before the handler runs.
    scope.addContentTypeParser(
      ['application/json', 'text/plain'],
      { parseAs: 'buffer', bodyLimit: config.maxRequestBytes },
      (_request, payload: Buffer, done) => done(null, payload)
    );
    scope.addContentTypeParser(
      /^application\/[a-z0-9.+-]+\+json$/i,
      { parseAs: 'buffer', bodyLimit: config.maxRequestBytes },
      (_request, payload: Buffer, done) => done(null, payload)
    );
    // Parse every remaining media type as raw bytes as well. The route
    // rejects it with the gateway's 415 contract; without this fallback,
    // Fastify would fail before the route and the scoped error handler
    // could only see an opaque parser error.
    scope.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: config.maxRequestBytes },
      (_request, payload: Buffer, done) => done(null, payload)
    );

    // Content-Length fast path: a declared body above the limit is
    // rejected before any body byte is buffered, with the OpenAI error
    // contract, a stable `x-request-id` and terminal telemetry – and the
    // upstream is never contacted (M3 review finding 5). Chunked bodies
    // (no Content-Length) are covered by the scope error handler below,
    // which picks up Fastify's own body-limit rejection during parsing.
    const rejectDeclaredOversized = async (
      request: FastifyRequest,
      reply: FastifyReply
    ): Promise<void> => {
      const declared = Number(request.headers['content-length']);
      if (Number.isFinite(declared) && declared >= 0 && declared > config.maxRequestBytes) {
        rejectOversizedIncoming(request, reply, config, options.requests, telemetry, declared);
      }
    };

    scope.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
      if (error.statusCode === 413) {
        // Fastify's content-type parser enforces the limit for both
        // declared and chunked bodies (for a declared Content-Length the
        // rejection happens as soon as parsing starts). Same contract as
        // the declared-length fast path.
        if (!reply.sent) {
          const declared = Number(request.headers['content-length']);
          const promptBytes =
            Number.isFinite(declared) && declared > 0 ? declared : config.maxRequestBytes;
          rejectOversizedIncoming(request, reply, config, options.requests, telemetry, promptBytes);
        }
        return;
      }
      request.log.error({ err: error }, 'unhandled gateway error');
      if (!reply.sent) {
        const id = resolveRequestId(request.headers[REQUEST_ID_HEADER]).id;
        reply.header(REQUEST_ID_HEADER, id);
        reply
          .status(500)
          .header('content-type', 'application/json; charset=utf-8')
          .send(buildErrorBody('internal_error', UPSTREAM_MESSAGES.internal_error, id));
      }
    });

    for (const route of INFERENCE_ROUTES)
      scope.route({
        method: route.method,
        url: route.url,
        schema: route.url.includes(':responseId')
          ? {
              params: {
                type: 'object',
                required: ['responseId'],
                properties: {
                  responseId: { type: 'string', maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
                },
              },
            }
          : undefined,
        preHandler: [rejectDeclaredOversized],
        handler: async (request, reply) => {
          // The oversized-body preHandler may have already answered (413);
          // in that case nothing else in this handler may run.
          if (reply.sent) return;
          if (
            options.engineModes &&
            !options.engineModes.allowsText() &&
            request.headers.authorization !== 'Bearer ' + options.internalStudioToken
          )
            return reply
              .code(409)
              .send({ error: { message: 'Agent inference is disabled in Bildstudio mode.' } });

          const { id: proposedId, supplied } = resolveRequestId(request.headers[REQUEST_ID_HEADER]);
          // M3 review finding 3: a client-supplied UUID that already names an
          // existing request must never reuse that row – a second request with
          // the same id gets a fresh gateway id, and the existing row (and its
          // events) is left completely untouched. The gateway id stays stable
          // across the response header, the database row and the log lines.
          const requestId =
            supplied && isRequestIdTaken(options.requests, proposedId) ? randomUuid() : proposedId;
          reply.header(REQUEST_ID_HEADER, requestId);
          const startedAt = Date.now();
          const raw = request.body !== undefined ? (request.body as Buffer) : Buffer.alloc(0);

          // OpenAI clients must send JSON; anything else is rejected here so
          // every gateway response carries the same error contract and id.
          const contentType = String(request.headers['content-type'] ?? '');
          const isJson =
            contentType.toLowerCase().startsWith('application/json') ||
            /\+json$/i.test(contentType);
          if ((route.jsonBody || raw.byteLength > 0) && !isJson) {
            await rejectInvalidContentType(
              request,
              reply,
              config,
              requestId,
              raw,
              startedAt,
              telemetry
            );
            return;
          }

          // Validate just enough to extract *metadata* (never mutate the body).
          let parsed: unknown;
          try {
            parsed =
              raw.byteLength === 0 && !route.jsonBody ? {} : JSON.parse(raw.toString('utf8'));
          } catch {
            await rejectInvalidBody(request, reply, config, requestId, raw, startedAt, telemetry);
            return;
          }
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            await rejectInvalidBody(request, reply, config, requestId, raw, startedAt, telemetry);
            return;
          }
          const body = parsed as Record<string, unknown>;
          if (options.gpu && body.background === true)
            return reply.code(400).send({
              error: {
                message: 'Background model requests are unavailable with GPU orchestration.',
              },
            });
          const model =
            typeof body.model === 'string' && body.model.length > 0 && body.model.length <= 128
              ? body.model
              : null;
          const isStream =
            body.stream === true ||
            (request.method === 'GET' &&
              new URL(request.url, 'http://gateway').searchParams.get('stream') === 'true');

          const ctx = createContext(
            request,
            reply,
            config,
            requestId,
            normalizeReasoningEffort(body, raw),
            startedAt
          );
          // Telemetry failures must not break the request (see createTelemetry);
          // the outer try/ catch is belt-and-braces for unexpected sync throws.
          try {
            ctx.telemetryOwner = telemetry.recordStart(
              {
                id: requestId,
                origin: requestOrigin(request.headers),
                // `model` may legitimately be unknown (null) – the write
                // contract only accepts a string or absence of the field.
                model: model ?? undefined,
                endpoint: request.url.split('?')[0] ?? route.url,
                method: request.method,
                startedAtUtc: toUtcIso(startedAt),
                promptBytes: raw.byteLength,
              },
              requestId
            );
            telemetry.recordEvent(
              { requestId, eventType: 'start', atUtc: toUtcIso(startedAt) },
              requestId,
              ctx.telemetryOwner
            );
          } catch {
            // Telemetry is best-effort by contract; continue anyway.
          }

          try {
            const waitStarted = performance.now();
            ctx.releaseGpu = await options.gpu?.acquireText(
              AbortSignal.any([ctx.controller.signal, AbortSignal.timeout(45 * 60_000)])
            );
            ctx.reply.raw.setHeader(
              'x-observatory-engine-wait-ms',
              (options.gpu ? Math.max(0, performance.now() - waitStarted) : 0).toFixed(3)
            );
          } catch (error) {
            await settleUpstreamFailure(ctx, telemetry, error);
            return;
          }
          // Streaming handlers return before the model turn ends. cleanup(),
          // invoked by stream completion/abort, owns the admission release.
          await handleUpstream(ctx, telemetry, isStream, transport.fetch);
        },
      });
  });
}

function createContext(
  request: FastifyRequest,
  reply: FastifyReply,
  config: ServerConfig,
  requestId: string,
  raw: Buffer,
  startedAt: number
): GatewayContext {
  const controller = new AbortController();
  const ctx: GatewayContext = {
    request,
    reply,
    config,
    requestId,
    raw,
    startedAt,
    finished: false,
    abortCause: null,
    controller,
    upstreamUrl: new URL(request.url, config.upstreamUrl).toString(),
    headers: pickForwardedHeaders(request.headers),
    onClientGone: () => {
      if (!ctx.finished && !ctx.controller.signal.aborted) {
        ctx.abortCause = 'client';
        ctx.controller.abort();
      }
    },
  };
  if (request.url.split('?')[0] === CHAT_COMPLETIONS_ENDPOINT) {
    const mode = request.headers['x-b70-output-budget'];
    const origin = requestOrigin(request.headers);
    if (mode === 'visible' || (mode === undefined && (origin === 'pi' || origin === 'web'))) {
      ctx.headers['x-b70-output-budget'] = 'visible';
    }
  }
  // The client socket is the reliable abort signal: it closes when the
  // client really goes away. (The request's own 'close' event fires as
  // soon as the request body is fully received – too early for this.)
  // On keep-alive sockets this listener is shared per connection; the
  // per-request `finished` flag disambiguates, cleanup() removes it.
  const socket = request.raw.socket;
  socket.on('close', ctx.onClientGone);
  socket.on('error', ctx.onClientGone);
  return ctx;
}

/**
 * Shared upstream round trip. Non-streaming requests buffer the upstream
 * body (size-limited, bounded by the total timeout) and send it as one
 * reply; streaming requests hijack the socket and pipe the upstream SSE
 * stream through with backpressure.
 */
async function handleUpstream(
  ctx: GatewayContext,
  telemetry: GatewayTelemetry,
  streaming: boolean,
  fetchUpstream: typeof fetch
): Promise<void> {
  const { config, reply, raw } = ctx;
  const deadline = setTimeout(() => {
    if (!ctx.finished && !ctx.controller.signal.aborted) {
      ctx.abortCause = 'upstream_timeout';
      ctx.controller.abort();
    }
  }, config.upstreamTimeoutMs);

  let upstream: Response;
  try {
    upstream = await fetchUpstream(ctx.upstreamUrl, {
      method: ctx.request.method,
      headers: ctx.headers,
      body: ctx.request.method === 'GET' || raw.byteLength === 0 ? undefined : raw,
      redirect: 'manual',
      signal: ctx.controller.signal,
    });
  } catch (error) {
    clearTimeout(deadline);
    await settleUpstreamFailure(ctx, telemetry, error);
    return;
  }

  for (const name of ['retry-after', 'anthropic-version', 'openai-processing-ms']) {
    const value = upstream.headers.get(name);
    if (value !== null) reply.header(name, value);
  }
  const status = upstream.status;
  const contentType = upstream.headers.get('content-type') ?? defaultContentType(streaming);

  if (status >= 400) {
    // Error bodies are buffered (with a size limit) and forwarded as-is;
    // the SSE code path would misinterpret them.
    //
    // The total-budget deadline stays armed while the error body is being
    // read – also for `stream: true` requests (M3 review finding 2): an
    // upstream that sends error headers and then holds the body open must
    // still hit the deadline, be classified as `upstream_timeout` and be
    // persisted, instead of hanging forever.
    let firstByteAt: number | null = null;
    try {
      const buffer = await readBodyWithLimit(
        upstream,
        config.upstreamMaxResponseBytes,
        (at) => {
          if (firstByteAt === null) firstByteAt = at;
        },
        ctx
      );
      clearTimeout(deadline);
      const code = errorCodeForHttpStatus(status);
      finishRequest(
        ctx,
        telemetry,
        'error',
        status,
        code,
        { at: Date.now(), responseBytes: buffer.byteLength, firstByteAt, usage: null },
        'error'
      );
      if (!reply.sent) {
        reply.status(status).header('content-type', contentType).send(buffer);
      }
      cleanup(ctx);
    } catch (error) {
      clearTimeout(deadline);
      await settleUpstreamFailure(ctx, telemetry, error);
    }
    return;
  }

  if (!streaming && !contentType.toLowerCase().startsWith('text/event-stream')) {
    let firstByteAt: number | null = null;
    let buffer: Buffer;
    try {
      buffer = await readBodyWithLimit(
        upstream,
        config.upstreamMaxResponseBytes,
        (at) => {
          if (firstByteAt === null) firstByteAt = at;
        },
        ctx
      );
    } catch (error) {
      clearTimeout(deadline);
      await settleUpstreamFailure(ctx, telemetry, error);
      return;
    }
    clearTimeout(deadline);
    const usage = extractUsage(safeParseJson(buffer));
    finishRequest(
      ctx,
      telemetry,
      'completed',
      status,
      undefined,
      { at: Date.now(), responseBytes: buffer.byteLength, firstByteAt, usage },
      'complete'
    );
    if (!reply.sent) {
      reply.status(status).header('content-type', contentType).send(buffer);
    }
    cleanup(ctx);
    return;
  }

  // 2xx + `stream: true`: SSE pass-through from here on.
  clearTimeout(deadline);
  pipeStream(ctx, telemetry, upstream, contentType);
}

/**
 * Forward the upstream SSE stream byte-for-byte.
 *
 * Termination semantics:
 * - upstream ends (after `[DONE]`)            → `completed`;
 * - client socket closes/resets mid-stream    → `aborted`, upstream aborted;
 * - upstream idle timeout fires                → `error` (`upstream_stream_idle`);
 * - upstream connection reset mid-stream      → `error` (`upstream_stream_interrupted`).
 *
 * Backpressure comes from `pipe()` (the socket's `drain`/`writable` state
 * pauses upstream reads). When the client disconnects, `onClientGone`
 * aborts the upstream request so vLLM can stop generating.
 */
function pipeStream(
  ctx: GatewayContext,
  telemetry: GatewayTelemetry,
  upstream: Response,
  contentType: string
): void {
  const { reply, requestId, config } = ctx;
  if (upstream.body === null) {
    // A 2xx SSE response with an empty body cannot contain tokens.
    finishRequest(
      ctx,
      telemetry,
      'completed',
      upstream.status,
      undefined,
      { at: Date.now(), responseBytes: 0, firstByteAt: null, usage: null },
      'complete'
    );
    cleanup(ctx);
    if (!reply.sent) {
      reply.status(upstream.status).header('content-type', contentType).send(Buffer.alloc(0));
    }
    return;
  }

  const watchdog = startIdleWatchdog(config.upstreamStreamIdleTimeoutMs, () => {
    if (!ctx.finished && !ctx.controller.signal.aborted) {
      ctx.abortCause = 'upstream_stream_idle';
      ctx.controller.abort();
    }
  });

  const nodeStream = Readable.fromWeb(upstream.body);
  // The meter is the single source of truth for the first-token moment
  // (M3 review finding 4): it triggers only on a real `data:` field, so
  // SSE comments, heartbeats and blank lines never move the TTFT – not
  // the `first_token` event and not the persisted `ttftMs`. Both are
  // derived from `meter.firstDataAt` below.
  const meter = new SseMeter();
  let firstByteAt: number | null = null;

  nodeStream.on('data', (chunk: Buffer) => {
    meter.onChunk(chunk, Date.now());
    if (firstByteAt === null && meter.firstDataAt !== null) {
      firstByteAt = meter.firstDataAt;
      telemetry.recordEvent(
        { requestId, eventType: 'first_token', atUtc: toUtcIso(firstByteAt) },
        requestId,
        ctx.telemetryOwner
      );
    }
    watchdog.reset();
  });

  // Force-close the upstream side whenever *we* abort (client, idle or
  // total timeout), independently of what undici does internally.
  ctx.controller.signal.addEventListener('abort', () => nodeStream.destroy(), { once: true });

  reply.hijack();
  const socket = reply.raw;

  const settle = (): void => {
    if (ctx.finished) return;
    watchdog.stop();
    let status: 'completed' | 'error' | 'aborted';
    let code: GatewayErrorCode | undefined;
    if (ctx.abortCause === 'client') {
      status = 'aborted';
    } else if (nodeStream.readableEnded) {
      status = 'completed';
    } else if (ctx.abortCause === 'upstream_stream_idle') {
      status = 'error';
      code = 'upstream_stream_idle';
    } else if (ctx.abortCause === 'upstream_timeout') {
      status = 'error';
      code = 'upstream_timeout';
    } else {
      status = 'error';
      code = 'upstream_stream_interrupted';
    }
    if (status === 'error') {
      reply.log.warn({ requestId, code }, 'upstream stream ended abnormally');
    }
    try {
      socket.end();
    } catch {
      // Socket already destroyed; the client got what it got.
    }
    finishRequest(
      ctx,
      telemetry,
      status,
      upstream.status,
      code,
      { at: Date.now(), responseBytes: meter.bytes, firstByteAt, usage: meter.usage },
      status === 'completed' ? 'complete' : status === 'aborted' ? 'abort' : 'error'
    );
    // Telemetry failure here must not throw into the event emitter.
    cleanup(ctx);
  };

  nodeStream.on('end', settle);
  nodeStream.on('error', (error: Error) => {
    if (!ctx.finished) {
      reply.log.debug({ requestId, errorName: error.name }, 'upstream stream error');
    }
    settle();
  });
  nodeStream.on('close', settle);

  socket.writeHead(upstream.status, {
    ...(upstream.headers.has('retry-after')
      ? { 'retry-after': upstream.headers.get('retry-after')! }
      : {}),
    'content-type': contentType,
    'cache-control': 'no-store',
    // Disables proxy buffering at nginx if one ever sits in front.
    'x-accel-buffering': 'no',
    [REQUEST_ID_HEADER]: requestId,
  });
  nodeStream.pipe(socket);
}

/** Mark the in-flight request as oversized and abort the upstream read. */
function abortOversizedUpstream(ctx: GatewayContext): void {
  if (!ctx.finished && !ctx.controller.signal.aborted) {
    ctx.abortCause = 'upstream';
    ctx.controller.abort();
  }
}

/** Read an upstream body into a buffer, aborting the request past `limit`. */
async function readBodyWithLimit(
  response: Response,
  limit: number,
  onFirstByte: (atMs: number) => void,
  ctx: GatewayContext
): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) {
    abortOversizedUpstream(ctx);
    throw new GatewayError(
      'upstream_response_too_large',
      502,
      'The upstream response exceeds the configured size limit.'
    );
  }
  const source = Readable.fromWeb(response.body);
  const chunks: Buffer[] = [];
  let total = 0;
  let firstByteSent = false;
  for await (const chunk of source) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!firstByteSent) {
      firstByteSent = true;
      onFirstByte(Date.now());
    }
    total += buffer.byteLength;
    chunks.push(buffer);
    if (total > limit) {
      source.destroy();
      abortOversizedUpstream(ctx);
      throw new GatewayError(
        'upstream_response_too_large',
        502,
        'The upstream response exceeds the configured size limit.'
      );
    }
  }
  return Buffer.concat(chunks);
}

/**
 * Terminal bookkeeping for every code path. All values go through the M2
 * write contracts (validated inside the repository); raw content and
 * secrets have no field to land in.
 */
function finishRequest(
  ctx: GatewayContext,
  telemetry: GatewayTelemetry,
  status: 'completed' | 'error' | 'aborted',
  httpStatus: number | null,
  errorCode: GatewayErrorCode | undefined,
  info: {
    at: number;
    responseBytes: number;
    firstByteAt: number | null;
    usage: UpstreamUsage | null;
  },
  terminalEventType?: 'complete' | 'abort' | 'error'
): void {
  if (ctx.finished) return;
  const durationMs = Math.max(0, Math.round(info.at - ctx.startedAt));
  telemetry.recordFinish(
    {
      requestId: ctx.requestId,
      status,
      completedAtUtc: toUtcIso(info.at),
      durationMs,
      responseBytes: Math.max(0, info.responseBytes),
      ttftMs:
        info.firstByteAt === null
          ? undefined
          : Math.max(0, Math.round(info.firstByteAt - ctx.startedAt)),
      httpStatus: httpStatus === null ? undefined : httpStatus,
      promptTokens: info.usage?.promptTokens ?? undefined,
      completionTokens: info.usage?.completionTokens ?? undefined,
      totalTokens: info.usage?.totalTokens ?? undefined,
      errorCode,
    },
    ctx.requestId,
    ctx.telemetryOwner
  );
  if (terminalEventType !== undefined) {
    telemetry.recordEvent(
      { requestId: ctx.requestId, eventType: terminalEventType, atUtc: toUtcIso(info.at) },
      ctx.requestId,
      ctx.telemetryOwner
    );
  }
  telemetry.release(ctx.requestId, ctx.telemetryOwner);
  ctx.finished = true;
}

/**
 * Shared failure settlement after the upstream `fetch` rejected
 * (connection refused, timeout, DNS, reset, client abort).
 */
async function settleUpstreamFailure(
  ctx: GatewayContext,
  telemetry: GatewayTelemetry,
  error: unknown
): Promise<void> {
  const { requestId, reply } = ctx;
  if (ctx.abortCause === 'client') {
    // The client went away; there is no one left to answer.
    reply.log.info({ requestId }, 'client aborted before the upstream answered');
    finishRequest(
      ctx,
      telemetry,
      'aborted',
      null,
      undefined,
      {
        at: Date.now(),
        responseBytes: 0,
        firstByteAt: null,
        usage: null,
      },
      'abort'
    );
    cleanup(ctx);
    return;
  }
  const gatewayError =
    error instanceof GatewayError
      ? error
      : ctx.abortCause === 'upstream_stream_idle'
        ? new GatewayError(
            'upstream_stream_idle',
            502,
            'The upstream stream stopped producing data and was aborted.'
          )
        : errorFromFetchFailure(ctx.abortCause ?? undefined, error);
  reply.log.warn({ requestId, code: gatewayError.code }, 'upstream failure');
  finishRequest(
    ctx,
    telemetry,
    'error',
    gatewayError.httpStatus,
    gatewayError.code,
    { at: Date.now(), responseBytes: 0, firstByteAt: null, usage: null },
    'error'
  );
  if (!reply.sent) {
    reply
      .status(gatewayError.httpStatus)
      .header('content-type', 'application/json; charset=utf-8')
      .send(buildErrorBody(gatewayError.code, gatewayError.clientMessage, requestId));
  }
  cleanup(ctx);
}

/** 400 for undecodable or non-object request bodies (recorded as errors). */
async function rejectInvalidBody(
  request: FastifyRequest,
  reply: FastifyReply,
  config: ServerConfig,
  requestId: string,
  raw: Buffer,
  startedAt: number,
  telemetry: GatewayTelemetry
): Promise<void> {
  const ctx = createContext(request, reply, config, requestId, raw, startedAt);
  ctx.telemetryOwner = telemetry.recordStart(
    {
      id: requestId,
      origin: requestOrigin(request.headers),
      model: undefined,
      endpoint: request.url.split('?')[0] ?? CHAT_COMPLETIONS_ENDPOINT,
      method: request.method,
      startedAtUtc: toUtcIso(startedAt),
      promptBytes: raw.byteLength,
    },
    requestId
  );
  telemetry.recordEvent(
    { requestId, eventType: 'start', atUtc: toUtcIso(startedAt) },
    requestId,
    ctx.telemetryOwner
  );
  const error = new GatewayError(
    'invalid_request_body',
    400,
    'Request body must be a JSON object (OpenAI chat completion payload).'
  );
  finishRequest(
    ctx,
    telemetry,
    'error',
    400,
    error.code,
    {
      at: Date.now(),
      responseBytes: 0,
      firstByteAt: null,
      usage: null,
    },
    'error'
  );
  reply
    .status(error.httpStatus)
    .header('content-type', 'application/json; charset=utf-8')
    .send(buildErrorBody(error.code, error.clientMessage, requestId));
  cleanup(ctx);
}

/**
 * Settle an incoming request that must be refused before the upstream is
 * contacted (body above the configured limit). The client gets the OpenAI
 * error envelope with a stable `x-request-id`, and the database receives a
 * terminal `error` row plus `start`/`error` events (M3 review finding 5).
 * `promptBytes` is the declared content length or, for chunked bodies
 * (no Content-Length), the configured limit as a conservative lower bound
 * on what actually arrived.
 */
function rejectOversizedIncoming(
  request: FastifyRequest,
  reply: FastifyReply,
  config: ServerConfig,
  requests: RequestRepository,
  telemetry: GatewayTelemetry,
  promptBytes: number
): void {
  const { id: proposedId, supplied } = resolveRequestId(request.headers[REQUEST_ID_HEADER]);
  // Same collision rule as the main handler: an existing row is never
  // reused or mutated by an oversized request.
  const requestId = supplied && isRequestIdTaken(requests, proposedId) ? randomUuid() : proposedId;
  const startedAt = Date.now();
  reply.header(REQUEST_ID_HEADER, requestId);
  const error = new GatewayError('request_too_large', 413, UPSTREAM_MESSAGES.request_too_large);
  const telemetryOwner = telemetry.recordStart(
    {
      id: requestId,
      origin: requestOrigin(request.headers),
      endpoint: request.url.split('?')[0] ?? CHAT_COMPLETIONS_ENDPOINT,
      method: request.method,
      startedAtUtc: toUtcIso(startedAt),
      promptBytes: Math.max(0, Math.trunc(promptBytes)),
    },
    requestId
  );
  const nowIso = toUtcIso(startedAt);
  telemetry.recordEvent(
    { requestId, eventType: 'start', atUtc: nowIso },
    requestId,
    telemetryOwner
  );
  telemetry.recordEvent(
    { requestId, eventType: 'error', atUtc: nowIso },
    requestId,
    telemetryOwner
  );
  telemetry.recordFinish(
    {
      requestId,
      status: 'error',
      completedAtUtc: nowIso,
      durationMs: 0,
      responseBytes: 0,
      httpStatus: error.httpStatus,
      errorCode: error.code,
    },
    requestId,
    telemetryOwner
  );
  telemetry.release(requestId, telemetryOwner);
  reply
    .status(error.httpStatus)
    .header('content-type', 'application/json; charset=utf-8')
    .send(buildErrorBody(error.code, error.clientMessage, requestId));
}

/**
 * Whether a request row with this id already exists. A broken database
 * must not turn a rejected request into a 500, so errors fall back to
 * `false`; the subsequent guarded `create` then fails and the telemetry
 * simply degrades (no row is ever mutated).
 */
function isRequestIdTaken(requests: RequestRepository, id: string): boolean {
  try {
    return requests.exists(id);
  } catch {
    return false;
  }
}

/** Remove the client-abort listeners once the request has settled. */
function cleanup(ctx: GatewayContext): void {
  ctx.releaseGpu?.();
  ctx.releaseGpu = undefined;
  const socket = ctx.request.raw.socket;
  socket.off('close', ctx.onClientGone);
  socket.off('error', ctx.onClientGone);
}

/** 415 for bodies whose content type is not JSON (recorded as errors). */
async function rejectInvalidContentType(
  request: FastifyRequest,
  reply: FastifyReply,
  config: ServerConfig,
  requestId: string,
  raw: Buffer,
  startedAt: number,
  telemetry: GatewayTelemetry
): Promise<void> {
  const ctx = createContext(request, reply, config, requestId, raw, startedAt);
  ctx.telemetryOwner = telemetry.recordStart(
    {
      id: requestId,
      origin: requestOrigin(request.headers),
      model: undefined,
      endpoint: request.url.split('?')[0] ?? CHAT_COMPLETIONS_ENDPOINT,
      method: request.method,
      startedAtUtc: toUtcIso(startedAt),
      promptBytes: raw.byteLength,
    },
    requestId
  );
  telemetry.recordEvent(
    { requestId, eventType: 'start', atUtc: toUtcIso(startedAt) },
    requestId,
    ctx.telemetryOwner
  );
  const error = new GatewayError(
    'invalid_content_type',
    415,
    'Content-Type must be application/json (or a JSON media type).'
  );
  finishRequest(
    ctx,
    telemetry,
    'error',
    415,
    error.code,
    {
      at: Date.now(),
      responseBytes: 0,
      firstByteAt: null,
      usage: null,
    },
    'error'
  );
  reply
    .status(error.httpStatus)
    .header('content-type', 'application/json; charset=utf-8')
    .send(buildErrorBody(error.code, error.clientMessage, requestId));
  cleanup(ctx);
}

/**
 * Telemetry sink that can never throw: a full or broken database must not
 * be able to kill an otherwise healthy LLM response (project brief).
 * Repository contract errors and SQLite errors are logged with the request
 * id and swallowed.
 */
export interface GatewayTelemetry {
  /** Returns an opaque owner token only when this call created the row. */
  recordStart(input: unknown, requestId: string): symbol | undefined;
  recordEvent(input: unknown, requestId: string, owner: symbol | undefined): void;
  recordFinish(input: unknown, requestId: string, owner: symbol | undefined): void;
  release(requestId: string, owner: symbol | undefined): void;
}

export function createTelemetry(
  requests: RequestRepository,
  log: FastifyLoggerInstance
): GatewayTelemetry {
  // Ownership is per concrete request, not merely per id. If a concurrent
  // or external writer wins an id collision, the failed request receives
  // no token and therefore cannot mutate the winner's row. Tokens are
  // released at settlement, so memory is bounded by in-flight requests.
  const owners = new Map<string, symbol>();
  const guarded =
    (what: string, action: (input: unknown) => void) =>
    (input: unknown, requestId: string, owner: symbol | undefined): void => {
      if (owner === undefined || owners.get(requestId) !== owner) return;
      try {
        action(input);
      } catch (error) {
        log.warn(
          { requestId, what, errorName: (error as Error).name },
          'telemetry persistence failed; request continues'
        );
      }
    };
  return {
    recordStart: (input: unknown, requestId: string): symbol | undefined => {
      try {
        requests.create(input);
        const owner = Symbol(requestId);
        owners.set(requestId, owner);
        return owner;
      } catch (error) {
        log.warn(
          { requestId, what: 'start', errorName: (error as Error).name },
          'telemetry persistence failed; request continues'
        );
        return undefined;
      }
    },
    recordEvent: guarded('event', (input) => requests.appendEvent(input)),
    recordFinish: guarded('finish', (input) => requests.finish(input)),
    release: (requestId: string, owner: symbol | undefined): void => {
      if (owner !== undefined && owners.get(requestId) === owner) {
        owners.delete(requestId);
      }
    },
  };
}

function startIdleWatchdog(
  milliseconds: number,
  onIdle: () => void
): { reset: () => void; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const reset = (): void => {
    stop();
    timer = setTimeout(() => {
      timer = undefined;
      onIdle();
    }, milliseconds);
  };
  reset();
  return { reset, stop };
}

function toUtcIso(ms: number): string {
  return new Date(ms).toISOString();
}

function defaultContentType(streaming: boolean): string {
  return streaming ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8';
}

function safeParseJson(buffer: Buffer): unknown {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
}
