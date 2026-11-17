import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * Minimal in-process stand-in for the production vLLM service.
 *
 * Contract:
 * - Listens on 127.0.0.1 with an ephemeral port (NEVER 127.0.0.1:8081,
 *   where the production vLLM runs – tests must not touch it).
 * - Speaks just enough of the OpenAI chat-completions API: the behavior
 *   is selected via a test-only `mock` field in the JSON request body
 *   (the production gateway forwards bodies unmodified, so a real vLLM
 *   would simply ignore the unknown field).
 * - Records every request (method, path, raw headers, body) so tests can
 *   verify header allow-listing, id propagation and abort behavior.
 *
 * Known mock behaviors (`mock` field):
 * - `ok`            → 200, deterministic non-streaming JSON completion
 * - `stream`        → 200, SSE with small gaps between events (default 5 ms)
 * - `delay`         → waits `mockDelayMs` (default 5000) before any byte
 * - `hold_stream`   → SSE header + first event, then holds the socket open
 * - `reset_stream`  → SSE header + first event, then destroys the socket
 * - `http_400` / `http_429` / `http_500` → that status with an error body
 * - `big_response`  → 200 with a JSON body of ~`mockBytes` size
 * - `annotated_stream` → SSE starting with comment/heartbeat lines before
 *                         the first `data:` event
 * - `hold_error_stream` → 500 headers + *partial* error body, then the
 *                          socket is held open forever (the error response
 *                          never completes)
 * - `slow_error`    → 500 after `mockDelayMs` (default 100 ms); the error
 *                      body may still arrive within the total budget
 *
 * Bodies are plain test strings with fictional sentinel values – no real
 * secrets, no real LLM content.
 */

export interface MockRequestLog {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  bodyText: string;
  /** Response fully sent (HTTP `finish` on the server side). */
  finished: boolean;
  /**
   * The client closed the connection before the response finished.
   * Derived (closed && !finished) rather than relying on the
   * deprecated-ish `aborted` event.
   */
  aborted: boolean;
}

export interface MockVllm {
  baseUrl: string;
  requests(): MockRequestLog[];
  lastRequest(): MockRequestLog | undefined;
  /** Poll every 20 ms until `check()` is true or `timeoutMs` elapses. */
  waitFor(check: () => boolean, timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
}

/** Deterministic SSE stream: one part per event, each ending in `\n\n`. */
const MOCK_SSE_EVENTS: string[] = [
  chunkJson({ delta: { role: 'assistant', content: '' }, finish: null }),
  chunkJson({ delta: { content: 'Hello' }, finish: null }),
  chunkJson({
    delta: { content: ' world' },
    finish: 'stop',
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  }),
  '[DONE]',
].map((data) => `data: ${data}\n\n`);

/** Deterministic SSE payload (all events concatenated). */
export const MOCK_SSE_BODY = MOCK_SSE_EVENTS.join('');

/**
 * SSE preamble consisting of comment lines only (the OpenAI byte-patch
 * annotation plus a keepalive). It must be forwarded byte-for-byte and
 * must never count as the first token.
 */
export const MOCK_SSE_ANNOTATION = ': OPENAI-BYTE-PATCH-ANNOTATION\n\n: keepalive\n\n';

/** Deterministic non-streaming completion body (mock mode `ok`). */
export const MOCK_JSON_BODY = JSON.stringify({
  id: 'chatcmpl-mock-1',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: 'Qwen3.8-27B',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'Hello world' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
});

export function chunkJson(opts: {
  delta: Record<string, unknown>;
  finish: string | null;
  usage?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    id: 'chatcmpl-mock-1',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: 'Qwen3.8-27B',
    ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
    choices: [{ index: 0, delta: opts.delta, finish_reason: opts.finish }],
  });
}

function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Late writes (after a client abort) must never crash the mock. */
function writeIfAlive(res: ServerResponse, data: string): boolean {
  if (res.destroyed || res.writableEnded) return false;
  res.write(data);
  return true;
}

function respondJson(
  res: ServerResponse,
  status: number,
  body: string,
  extra?: Record<string, string>
): void {
  if (res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json', ...extra });
  res.end(body);
}

function startSse(res: ServerResponse): void {
  if (res.destroyed) return;
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
}

function events(): string[] {
  return MOCK_SSE_EVENTS;
}

function sendStream(res: ServerResponse, gapMs: number): void {
  const parts = events();
  startSse(res);
  parts.forEach((part, index) => {
    setTimeout(() => {
      writeIfAlive(res, part);
      if (index === parts.length - 1) {
        res.end();
      }
    }, gapMs * index);
  });
}

/** Like `sendStream`, but leads with the comment/heartbeat preamble. */
function sendAnnotatedStream(res: ServerResponse, gapMs: number): void {
  const parts = [MOCK_SSE_ANNOTATION, ...events()];
  startSse(res);
  parts.forEach((part, index) => {
    setTimeout(() => {
      writeIfAlive(res, part);
      if (index === parts.length - 1) {
        res.end();
      }
    }, gapMs * index);
  });
}

export async function startMockVllm(): Promise<MockVllm> {
  const logs: MockRequestLog[] = [];

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const entry: MockRequestLog = {
      method: req.method ?? '',
      path: req.url ?? '',
      headers: req.headers,
      bodyText: '',
      finished: false,
      aborted: false,
    };
    logs.push(entry);

    res.on('finish', () => {
      entry.finished = true;
    });
    res.on('close', () => {
      entry.aborted = !entry.finished;
    });
    req.on('error', () => {
      entry.aborted = true;
    });

    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      respondJson(res, 404, JSON.stringify({ error: { message: 'unknown mock route' } }));
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      entry.bodyText = body;
      let payload: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(body);
        if (typeof parsed === 'object' && parsed !== null) {
          payload = parsed as Record<string, unknown>;
        }
      } catch {
        respondJson(res, 400, JSON.stringify({ error: { message: 'mock: body is not JSON' } }));
        return;
      }
      const mode =
        typeof payload.mock === 'string' ? payload.mock : payload.stream === true ? 'stream' : 'ok';

      switch (mode) {
        case 'ok':
          respondJson(res, 200, MOCK_JSON_BODY);
          break;
        case 'stream':
          sendStream(res, number(payload.mockGapMs, 5));
          break;
        case 'annotated_stream':
          // Comment/heartbeat lines first, then the regular events – each
          // part is sent as its own chunk, so the `data:` marker of the
          // first real event starts in a later chunk than the comments.
          sendAnnotatedStream(res, number(payload.mockGapMs, 5));
          break;
        case 'delay':
          setTimeout(
            () => {
              respondJson(res, 200, MOCK_JSON_BODY);
            },
            number(payload.mockDelayMs, 5000)
          );
          break;
        case 'hold_stream':
          // First event, then keep the socket open indefinitely.
          startSse(res);
          writeIfAlive(res, events()[0] ?? '');
          break;
        case 'hold_error_stream':
          // Error status + headers arrive immediately, a partial error
          // body is sent, and then the socket is held open forever: the
          // error response never reaches a clean end.
          if (!res.destroyed) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
            res.write('{"error":{"message":"partial failure that never completes"');
          }
          break;
        case 'slow_error':
          // A 5xx that arrives late but still within the total budget.
          setTimeout(
            () =>
              respondJson(
                res,
                500,
                JSON.stringify({
                  error: {
                    message: 'mock: slow error',
                    type: 'server_error',
                    code: 'mock_slow_500',
                  },
                })
              ),
            number(payload.mockDelayMs, 100)
          );
          break;
        case 'reset_stream':
          startSse(res);
          writeIfAlive(res, events()[0] ?? '');
          setTimeout(
            () => {
              res.destroy();
            },
            number(payload.mockGapMs, 20)
          );
          break;
        case 'http_400':
          respondJson(
            res,
            400,
            JSON.stringify({
              error: {
                message: 'mock: invalid request',
                type: 'invalid_request_error',
                code: 'mock_400',
              },
            })
          );
          break;
        case 'http_429':
          respondJson(
            res,
            429,
            JSON.stringify({
              error: { message: 'mock: rate limited', type: 'rate_limit_error', code: 'mock_429' },
            })
          );
          break;
        case 'http_500':
          respondJson(
            res,
            500,
            JSON.stringify({
              error: { message: 'mock: internal error', type: 'server_error', code: 'mock_500' },
            })
          );
          break;
        case 'big_response': {
          const size = number(payload.mockBytes, 4096);
          const filler = 'x'.repeat(Math.max(0, size));
          respondJson(res, 200, JSON.stringify({ id: 'chatcmpl-mock-1', filler }));
          break;
        }
        default:
          respondJson(
            res,
            400,
            JSON.stringify({
              error: { message: `mock: unknown mode ${String(mode)}`, code: 'unknown_mode' },
            })
          );
      }
    });
  });

  // Never crash on malformed probes or premature disconnects.
  server.on('clientError', (err, socket) => {
    void err;
    socket.destroy();
  });

  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests: () => logs,
    lastRequest: () => logs[logs.length - 1],
    async waitFor(check: () => boolean, timeoutMs = 3000): Promise<boolean> {
      const start = Date.now();
      while (Date.now() - start < (timeoutMs ?? 3000)) {
        if (check()) return true;
        await new Promise((r) => setTimeout(r, 20));
      }
      return check();
    },
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        // Drop keep-alive sockets from the undici pool so close() cannot
        // hang waiting for them.
        try {
          server.closeAllConnections();
        } catch {
          // Node < 18.2 would not have the method; close() alone suffices.
        }
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      }),
  };
}
