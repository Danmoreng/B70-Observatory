import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { request } from 'node:http';
import { Writable } from 'node:stream';
import { newTempDb } from '../helpers.js';
import { buildApp, type AppOptions } from '../../src/app.js';
import { loadServerConfig, type ServerConfig } from '../../src/config.js';
import { RequestRepository } from '../../src/db/index.js';
import {
  startMockVllm,
  MOCK_JSON_BODY,
  MOCK_SSE_ANNOTATION,
  MOCK_SSE_BODY,
  type MockVllm,
} from './mock-vllm.js';

/** Fictional credential used only as a canary: it must never persist. */
const SECRET = 'sk-observatory-test-sentinel-0001';

interface Harness {
  app: ReturnType<typeof buildApp>;
  db: DatabaseSync;
  requests: RequestRepository;
  mock: MockVllm;
  base: string;
  config: ServerConfig;
  closeAll: () => Promise<void>;
  logText: () => string;
}

/**
 * Full integration harness: a real loopback socket for the gateway and a
 * separate loopback socket for the mock upstream, plus a temp-file
 * database. The production vLLM service (127.0.0.1:8081) is never
 * contacted by any test in this repository.
 */
async function startHarness(env: Record<string, string>): Promise<Harness> {
  const mock = await startMockVllm();
  const temp = newTempDb();
  const config = loadServerConfig({ OBSERVATORY_UPSTREAM_URL: mock.baseUrl, ...env });
  const requests = new RequestRepository(temp.db);

  const collected: string[] = [];
  const logStream = new Writable({
    write(chunk: Buffer | string, _encoding, callback: (error?: Error) => void) {
      collected.push(String(chunk));
      callback();
    },
  });
  const options: AppOptions = {
    version: 'gateway-test',
    config,
    startedAt: new Date('2025-06-01T12:00:00.000Z'),
    loggerLevel: 'info',
    loggerStream: logStream,
    database: temp.db,
    gateway: { config, requests },
  };
  const app = buildApp(options);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;

  return {
    app,
    db: temp.db,
    requests,
    mock,
    base: `http://127.0.0.1:${port}`,
    config,
    logText: () => collected.join('\n'),
    closeAll: async () => {
      await app.close();
      await mock.close();
      temp.close();
    },
  };
}

/** All persisted telemetry as one string (for secret/content canaries). */
function allPersistedText(db: DatabaseSync): string {
  const tables = ['requests', 'request_events', 'metric_samples', 'service_events'];
  return tables
    .map((table) =>
      (db.prepare(`SELECT * FROM ${table}`).all() as object[])
        .map((row) => JSON.stringify(row))
        .join('\n')
    )
    .join('\n');
}

function chatBody(mockMode?: string, stream?: boolean): string {
  const payload: Record<string, unknown> = {
    model: 'Qwen3.8-27B',
    messages: [{ role: 'user', content: 'Say hello' }],
  };
  if (mockMode !== undefined) payload.mock = mockMode;
  if (stream !== undefined) payload.stream = stream;
  return JSON.stringify(payload);
}

async function postChat(
  base: string,
  body: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal
): Promise<Response> {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    // `connection: close` makes the undici pool drop the socket after the
    // response, so `app.close()` in afterAll cannot hang on keep-alives.
    // The header is *not* on the gateway's forward allowlist, so the
    // upstream is unaffected.
    headers: { 'content-type': 'application/json', connection: 'close', ...headers },
    body,
    signal,
  });
}

async function eventually(check: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

// ───────────────────── Group 1: happy paths & metadata ─────────────────────

describe('gateway group 1: chat completions against the mock vLLM', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({
      OBSERVATORY_UPSTREAM_TIMEOUT_MS: '3000',
      OBSERVATORY_UPSTREAM_STREAM_IDLE_TIMEOUT_MS: '5000',
    });
  });
  afterAll(async () => {
    await h.closeAll();
  });

  it('forwards a non-streaming request byte-for-byte and returns the upstream body unchanged', async () => {
    const body = chatBody('ok');
    const response = await postChat(h.base, body, {
      authorization: `Bearer ${SECRET}`,
      accept: 'application/json',
      'x-custom-evil': 'should-not-be-forwarded',
      'x-observatory-origin': 'pi',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('x-observatory-engine-wait-ms')).toBe('0.000');
    const text = await response.text();
    // Unchanged upstream payload (byte-level pass-through).
    expect(text).toBe(MOCK_JSON_BODY);

    // Upstream saw only allowlisted headers…
    const upstreamHeaders = h.mock.lastRequest()?.headers ?? {};
    expect(upstreamHeaders['authorization']).toBe(`Bearer ${SECRET}`);
    expect(upstreamHeaders['accept']).toBe('application/json');
    expect(upstreamHeaders['content-type']).toBeDefined();
    // …and nothing that is not on the allowlist.
    expect(upstreamHeaders['x-custom-evil']).toBeUndefined();
    expect(upstreamHeaders['cookie']).toBeUndefined();
    expect(JSON.stringify(upstreamHeaders)).not.toContain('x-custom-evil');
  });

  it('assigns a stable request id: response header == database row', async () => {
    const body = chatBody('ok');
    const response = await postChat(h.base, body);
    await response.text();
    const requestId = response.headers.get('x-request-id');
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const stored = h.requests.get(requestId ?? '');
    expect(stored).toBeDefined();
    expect(stored?.id).toBe(requestId);
    expect(stored?.status).toBe('completed');
    expect(stored?.httpStatus).toBe(200);
    expect(stored?.endpoint).toBe('/v1/chat/completions');
    expect(stored?.model).toBe('Qwen3.8-27B');
    expect(stored?.origin).toBe('unknown');
    expect(stored?.promptBytes).toBe(Buffer.byteLength(body));
    expect(stored?.responseBytes).toBe(Buffer.byteLength(MOCK_JSON_BODY));
    expect(stored?.promptTokens).toBe(11);
    expect(stored?.completionTokens).toBe(7);
    expect(stored?.totalTokens).toBe(18);
    expect(stored?.ttftMs).not.toBeNull();
    expect(stored?.errorCode).toBeNull();
    const eventTypes = h.requests.listEvents(requestId ?? '').map((e) => e.eventType);
    expect(eventTypes).toEqual(['start', 'complete']);
  });

  it('honors a client-supplied UUID x-request-id end to end', async () => {
    const supplied = 'c8f1a3d2-9b6e-4c1a-8d5f-0a1b2c3d4e5f';
    const response = await postChat(h.base, chatBody('ok'), { 'x-request-id': supplied });
    await response.text();
    expect(response.headers.get('x-request-id')).toBe(supplied);
    expect(h.requests.get(supplied)?.id).toBe(supplied);
  });

  it('ignores non-UUID x-request-id values and generates its own', async () => {
    const response = await postChat(h.base, chatBody('ok'), {
      'x-request-id': 'not a uuid at all',
    });
    await response.text();
    const requestId = response.headers.get('x-request-id');
    expect(requestId).not.toBe('not a uuid at all');
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.requests.get(requestId ?? '')).toBeDefined();
  });

  it('never mutates an existing row when the client reuses an x-request-id (M3 review finding 3)', async () => {
    const supplied = 'e71b04cf-52aa-4f3b-9c0d-6f8e1d2c3b4a';
    const first = await postChat(h.base, chatBody('ok'), { 'x-request-id': supplied });
    await first.text();
    // First use: the client id is honored end to end.
    expect(first.headers.get('x-request-id')).toBe(supplied);

    // Snapshot the existing row and all of its events.
    const firstRowBefore = h.requests.get(supplied);
    const firstEventsBefore = h.requests.listEvents(supplied).map((event) => ({ ...event }));
    expect(firstRowBefore?.status).toBe('completed');

    const countBefore = h.requests.count();
    const eventsBefore = h.requests.countEvents();

    // Second request reuses the same (now existing) client UUID.

    const second = await postChat(h.base, chatBody('ok'), { 'x-request-id': supplied });
    await second.text();

    // The second request got a fresh, stable gateway id – in both the
    // response header and its database row.
    const secondId = second.headers.get('x-request-id');
    expect(secondId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(secondId).not.toBe(supplied);
    const secondRow = h.requests.get(secondId ?? '');
    expect(secondRow).toBeDefined();
    expect(secondRow?.id).toBe(secondId);
    expect(secondRow?.status).toBe('completed');
    expect(secondRow?.httpStatus).toBe(200);
    expect(h.requests.listEvents(secondId ?? '').map((event) => event.eventType)).toEqual([
      'start',
      'complete',
    ]);

    // The first row and its events are byte-identical to the snapshot:
    // the collision never touched them.
    expect(h.requests.get(supplied)).toEqual(firstRowBefore);
    expect(h.requests.listEvents(supplied)).toEqual(firstEventsBefore);

    // Exactly one new row and its two events (start + complete) appeared;
    // the existing row's event count is unchanged.
    expect(h.requests.count()).toBe(countBefore + 1);
    expect(h.requests.countEvents()).toBe(eventsBefore + 2);
  });

  it('streams SSE unmodified (event order, bytes and [DONE]) with token usage', async () => {
    const response = await postChat(h.base, chatBody('stream', true));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-observatory-engine-wait-ms')).toBe('0.000');
    const text = await response.text();
    // Byte-for-byte pass-through of the upstream SSE stream.
    expect(text).toBe(MOCK_SSE_BODY);
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);

    const requestId = response.headers.get('x-request-id') ?? '';
    const stored = h.requests.get(requestId);
    expect(stored?.status).toBe('completed');
    expect(stored?.httpStatus).toBe(200);
    expect(stored?.responseBytes).toBe(Buffer.byteLength(MOCK_SSE_BODY));
    expect(stored?.promptTokens).toBe(11);
    expect(stored?.completionTokens).toBe(7);
    expect(stored?.totalTokens).toBe(18);
    expect(stored?.ttftMs).not.toBeNull();
    expect(stored?.errorCode).toBeNull();
    const eventTypes = h.requests.listEvents(requestId).map((e) => e.eventType);
    expect(eventTypes).toEqual(['start', 'first_token', 'complete']);
  });

  it('stamps first_token at the first real data: field, not at leading SSE comments, and forwards the preamble byte-identical (M3 review finding 4)', async () => {
    const response = await postChat(h.base, chatBody('annotated_stream', true));
    expect(response.status).toBe(200);
    const text = await response.text();
    // The comment/heartbeat preamble is part of the forwarded bytes.
    expect(text).toBe(MOCK_SSE_ANNOTATION + MOCK_SSE_BODY);

    const requestId = response.headers.get('x-request-id') ?? '';
    const stored = h.requests.get(requestId);
    expect(stored?.status).toBe('completed');
    // The comments arrived before any data; TTFT must still be > 0.
    expect(stored?.ttftMs).toBeGreaterThan(0);

    const events = h.requests.listEvents(requestId);
    expect(events.map((event) => event.eventType)).toEqual(['start', 'first_token', 'complete']);
    // The first_token timestamp must be later than the start timestamp
    // (the comment chunks arrived first and must not have moved it).
    const start = events.find((event) => event.eventType === 'start');
    const firstToken = events.find((event) => event.eventType === 'first_token');
    // Canonical ISO-8601 UTC strings compare correctly lexicographically.
    expect(
      firstToken?.atUtc !== undefined &&
        start?.atUtc !== undefined &&
        firstToken.atUtc > start.atUtc
    ).toBe(true);
  });

  it('maps x-observatory-origin to the database origin label', async () => {
    const response = await postChat(h.base, chatBody('ok'), {
      'x-observatory-origin': 'web',
    });
    await response.text();
    const stored = h.requests.get(response.headers.get('x-request-id') ?? '');
    expect(stored?.origin).toBe('web');
  });

  it('maps an invalid origin header to unknown instead of failing', async () => {
    const response = await postChat(h.base, chatBody('ok'), {
      'x-observatory-origin': 'definitely-not-a-known-origin',
    });
    await response.text();
    const stored = h.requests.get(response.headers.get('x-request-id') ?? '');
    expect(stored?.origin).toBe('unknown');
  });

  it('rejects non-JSON bodies with a 400, an error row and no upstream call', async () => {
    const before = h.mock.requests().length;
    const response = await postChat(h.base, '{this is not json');
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: string; request_id: string } };
    expect(payload.error.code).toBe('invalid_request_body');
    expect(h.mock.requests().length).toBe(before);

    const stored = h.requests.get(payload.error.request_id);
    expect(stored?.status).toBe('error');
    expect(stored?.errorCode).toBe('invalid_request_body');
    expect(stored?.httpStatus).toBe(400);
  });

  it('rejects JSON arrays (non-object payloads) with a 400', async () => {
    const response = await postChat(h.base, '[1, 2, 3]');
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe('invalid_request_body');
  });

  it('rejects non-JSON content types with a 415', async () => {
    const response = await fetch(`${h.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', connection: 'close' },
      body: chatBody('ok'),
    });
    expect(response.status).toBe(415);
    await response.text();
  });

  it('rejects an otherwise unsupported media type with the gateway 415 contract', async () => {
    const before = h.mock.requests().length;
    const response = await fetch(`${h.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/xml', connection: 'close' },
      body: '<request />',
    });
    expect(response.status).toBe(415);
    const payload = (await response.json()) as {
      error: { code: string; request_id: string };
    };
    expect(payload.error.code).toBe('invalid_content_type');
    expect(payload.error.request_id).toBe(response.headers.get('x-request-id'));
    expect(h.mock.requests().length).toBe(before);
    const stored = h.requests.get(payload.error.request_id);
    expect(stored?.status).toBe('error');
    expect(stored?.httpStatus).toBe(415);
    expect(stored?.errorCode).toBe('invalid_content_type');
    expect(h.requests.listEvents(payload.error.request_id).map((event) => event.eventType)).toEqual(
      ['start', 'error']
    );
  });

  it('passes upstream 4xx/5xx error bodies through unchanged with the same status', async () => {
    const cases = [
      { mode: 'http_400', status: 400, code: 'upstream_rejected' },
      { mode: 'http_429', status: 429, code: 'upstream_rate_limited' },
      { mode: 'http_500', status: 500, code: 'upstream_error' },
    ] as const;
    for (const c of cases) {
      const response = await postChat(h.base, chatBody(c.mode));
      expect(response.status).toBe(c.status);
      const text = await response.text();
      expect(text).toContain(`"code":"mock_${String(c.status)}"`);
      const stored = h.requests.get(response.headers.get('x-request-id') ?? '');
      expect(stored?.status).toBe('error');
      expect(stored?.httpStatus).toBe(c.status);
      expect(stored?.errorCode).toBe(c.code);
      const events = h.requests.listEvents(response.headers.get('x-request-id') ?? '');
      expect(events.at(-1)?.eventType).toBe('error');
    }
  });

  it('keeps secrets out of logs and the database', async () => {
    expect(h.logText()).not.toContain(SECRET);
    expect(allPersistedText(h.db)).not.toContain(SECRET);
  });
});

// ───────────────────── Group 2: failures & aborts ───────────────────────────

describe('gateway group 2: failures, timeouts and aborts', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({
      OBSERVATORY_UPSTREAM_TIMEOUT_MS: '300',
      OBSERVATORY_UPSTREAM_STREAM_IDLE_TIMEOUT_MS: '200',
    });
  });
  afterAll(async () => {
    await h.closeAll();
  });

  it('maps an unreachable upstream to 502 upstream_unreachable', async () => {
    const dead = await startMockVllm();
    const deadUrl = dead.baseUrl;
    await dead.close();

    const config = loadServerConfig({
      OBSERVATORY_UPSTREAM_URL: deadUrl,
      OBSERVATORY_UPSTREAM_TIMEOUT_MS: '500',
    });
    const temp = newTempDb();
    const app = buildApp({
      version: 't',
      config,
      startedAt: new Date(),
      loggerLevel: 'silent',
      database: temp.db,
      gateway: { config, requests: new RequestRepository(temp.db) },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const response = await postChat(
        `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
        chatBody('ok')
      );
      expect(response.status).toBe(502);
      const payload = (await response.json()) as {
        error: { code: string; type: string; request_id: string };
      };
      expect(payload.error.code).toBe('upstream_unreachable');
      expect(payload.error.type).toBe('server_error');
      const stored = new RequestRepository(temp.db).get(payload.error.request_id) ?? undefined;
      expect(stored?.status).toBe('error');
      expect(stored?.errorCode).toBe('upstream_unreachable');
      expect(stored?.httpStatus).toBe(502);
    } finally {
      await app.close();
      temp.close();
    }
  });

  it('bounds a held-open error body on a streaming request to the total budget (M3 review finding 2)', async () => {
    // stream=true + upstream 5xx: the mock sends the error headers and a
    // partial error body, then holds the socket open forever. The total
    // upstream budget (300 ms in this harness) must still apply to the
    // full error body – not only to the headers.
    const startedAt = Date.now();
    const response = await postChat(h.base, chatBody('hold_error_stream', true));
    const elapsedMs = Date.now() - startedAt;

    expect(response.status).toBe(504);
    expect(elapsedMs).toBeLessThan(1500);
    const payload = (await response.json()) as {
      error: { message: string; type: string; code: string; request_id: string };
    };
    expect(payload.error.code).toBe('upstream_timeout');
    expect(payload.error.type).toBe('server_error');

    // Classified and persisted as a terminal error row.
    const stored = h.requests.get(payload.error.request_id);
    expect(stored?.status).toBe('error');
    expect(stored?.errorCode).toBe('upstream_timeout');
    expect(stored?.httpStatus).toBe(504);
    expect(h.requests.listEvents(payload.error.request_id).map((e) => e.eventType)).toEqual([
      'start',
      'error',
    ]);

    // The upstream connection was actively aborted, not leaked.
    expect(await h.mock.waitFor(() => h.mock.lastRequest()?.aborted === true)).toBe(true);
  });

  it('still passes through an upstream error that completes within the budget', async () => {
    const response = await postChat(
      h.base,
      chatBody('slow_error').replace('"mock":"slow_error"', '"mock":"slow_error","mockDelayMs":50')
    );
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain('"code":"mock_slow_500"');
    const stored = h.requests.get(response.headers.get('x-request-id') ?? '');
    expect(stored?.status).toBe('error');
    expect(stored?.errorCode).toBe('upstream_error');
    expect(stored?.httpStatus).toBe(500);
  });

  it('maps an upstream that never responds to 504 upstream_timeout', async () => {
    const response = await postChat(h.base, chatBody('delay'));
    expect(response.status).toBe(504);
    const payload = (await response.json()) as { error: { code: string; request_id: string } };
    expect(payload.error.code).toBe('upstream_timeout');
    const stored = h.requests.get(payload.error.request_id);
    expect(stored?.status).toBe('error');
    expect(stored?.errorCode).toBe('upstream_timeout');
    // The mock's socket must have been actively aborted (the delayed 5 s
    // reply must never reach the client).
    expect(await h.mock.waitFor(() => h.mock.lastRequest()?.aborted === true)).toBe(true);
  });

  it('aborts an idle SSE stream (upstream went silent) and records the error', async () => {
    // Gap of 1000 ms between events vs. a 200 ms idle timeout.
    const response = await postChat(
      h.base,
      chatBody('stream', true).replace('"mock":"stream"', '"mock":"stream","mockGapMs":1000')
    );
    expect(response.status).toBe(200);
    let received = '';
    try {
      received = await response.text();
    } catch {
      // Socket cut mid-stream: fetch rejects – both are acceptable.
    }
    expect(received.length).toBeGreaterThan(0);
    expect(received.endsWith('data: [DONE]\n\n')).toBe(false);

    const stored = h.requests.get(response.headers.get('x-request-id') ?? '');
    expect(stored?.status).toBe('error');
    expect(stored?.errorCode).toBe('upstream_stream_idle');
    expect(stored?.httpStatus).toBe(200);
    // The upstream connection was actively aborted…
    expect(await h.mock.waitFor(() => h.mock.lastRequest()?.aborted === true)).toBe(true);
  });

  it('records upstream_stream_interrupted when vLLM resets the connection mid-stream', async () => {
    const response = await postChat(h.base, chatBody('reset_stream', true));
    expect(response.status).toBe(200);
    let received = '';
    try {
      received = await response.text();
    } catch {
      // Expected: the socket is destroyed by the mock.
    }
    expect(received.length).toBeGreaterThan(0);
    const stored = h.requests.get(response.headers.get('x-request-id') ?? '');
    expect(stored?.status).toBe('error');
    expect(stored?.errorCode).toBe('upstream_stream_interrupted');
  });

  it('propagates a client abort to the upstream and records status=aborted', async () => {
    const controller = new AbortController();
    const response = await postChat(h.base, chatBody('hold_stream', true), {}, controller.signal);
    expect(response.status).toBe(200);
    expect(response.body).not.toBeNull();
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('test: missing response body');
    const first = await reader.read();
    expect(first.done).toBe(false);
    // Let the gateway start piping, then hang up like a real client would.
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    try {
      await response.body?.cancel();
    } catch {
      // aborting a fetch always rejects the body – ignore
    }

    expect(await h.mock.waitFor(() => h.mock.lastRequest()?.aborted === true)).toBe(true);
    const settled = await eventually(() => {
      const row = h.requests.get(response.headers.get('x-request-id') ?? '');
      return row !== undefined && row.status !== 'in_progress';
    });
    expect(settled).toBe(true);
    const stored = h.requests.get(response.headers.get('x-request-id') ?? '');
    expect(stored?.status).toBe('aborted');
    expect(stored?.errorCode).toBeNull();
    expect(stored?.responseBytes).toBeGreaterThan(0);
    const eventTypes = h.requests.listEvents(response.headers.get('x-request-id') ?? '');
    expect(eventTypesOf(eventTypes)).toEqual(['start', 'first_token', 'abort']);
  });
});

/** Small helper to keep the assertion above readable. */
function eventTypesOf(events: Array<{ eventType: string }>): string[] {
  return events.map((event) => event.eventType);
}

// ───────────────────── Group 3: limits & resilience ─────────────────────────

describe('gateway group 3: size limits and telemetry resilience', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({
      // Request limit stays at the default (1 MiB) here: only the
      // *upstream response* limit is shrunk. The request-side 413 case is
      // covered by its own harness below.
      OBSERVATORY_UPSTREAM_MAX_RESPONSE_BYTES: '512',
      OBSERVATORY_UPSTREAM_TIMEOUT_MS: '3000',
    });
  });
  afterAll(async () => {
    await h.closeAll();
  });

  it('rejects oversized upstream responses with 502 upstream_response_too_large', async () => {
    const response = await postChat(
      h.base,
      chatBody('big_response').replace(
        '"mock":"big_response"',
        '"mock":"big_response","mockBytes":4096'
      )
    );
    expect(response.status).toBe(502);
    const payload = (await response.json()) as { error: { code: string; request_id: string } };
    expect(payload.error.code).toBe('upstream_response_too_large');
    const stored = h.requests.get(payload.error.request_id);
    expect(stored?.status).toBe('error');
    expect(stored?.errorCode).toBe('upstream_response_too_large');
  });
});

describe('gateway group 3b: request size limit', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({
      OBSERVATORY_MAX_REQUEST_BYTES: '64',
      OBSERVATORY_UPSTREAM_TIMEOUT_MS: '3000',
    });
  });
  afterAll(async () => {
    await h.closeAll();
  });

  it('rejects a declared-oversized body (Content-Length) with the OpenAI contract, a stable id and terminal telemetry, without touching the upstream (M3 review finding 5)', async () => {
    const upstreamCallsBefore = h.mock.requests().length;
    const countBefore = h.requests.count();
    const body = `"${'x'.repeat(900)}`;
    const response = await postChat(h.base, `{"model":"Qwen3.8-27B","pad":${body}`);
    // `fetch` sends string bodies with a Content-Length header, so this
    // exercises the declared-length pre-check path.
    expect(response.status).toBe(413);
    const payload = (await response.json()) as {
      error: { message: string; type: string; code: string; request_id: string };
    };
    expect(payload.error.code).toBe('request_too_large');
    expect(payload.error.type).toBe('invalid_request_error');
    expect(payload.error.message.length).toBeGreaterThan(0);
    // The error envelope and the response header agree on the id.
    expect(payload.error.request_id).toBe(response.headers.get('x-request-id'));
    expect(payload.error.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    // Terminal telemetry row with the full event trail.
    const stored = h.requests.get(payload.error.request_id);
    expect(stored?.status).toBe('error');
    expect(stored?.errorCode).toBe('request_too_large');
    expect(stored?.httpStatus).toBe(413);
    expect(stored?.promptBytes).toBeGreaterThan(64);
    expect(h.requests.listEvents(payload.error.request_id).map((e) => e.eventType)).toEqual([
      'start',
      'error',
    ]);
    expect(h.requests.count()).toBe(countBefore + 1);
    // The upstream was never contacted.
    expect(h.mock.requests().length).toBe(upstreamCallsBefore);
  });

  it('rejects a chunked body above the limit (no Content-Length) with the same contract (M3 review finding 5)', async () => {
    const countBefore = h.requests.count();
    const upstreamCallsBefore = h.mock.requests().length;
    // A raw `Transfer-Encoding: chunked` request: there is no
    // Content-Length to pre-check, so Fastify's own body limit (enforced
    // while parsing the payload) must produce the same contract.
    const { status, headers, text } = await new Promise<{
      status: number;
      headers: import('node:http').IncomingHttpHeaders;
      text: string;
    }>((resolvePromise, rejectPromise) => {
      const url = new URL(`${h.base}/v1/chat/completions`);
      const req = request({
        host: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'transfer-encoding': 'chunked',
          connection: 'close',
        },
      });
      req.on('error', rejectPromise);
      req.on('response', (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk;
        });
        res.on('error', rejectPromise);
        res.on('end', () =>
          resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, text: data })
        );
      });
      // Two writes below the limit individually, above it in total.
      req.write(`{"model":"Qwen3.8-27B","pa`);
      req.write(`d":"${'y'.repeat(200)}"}`);
      req.end();
    });

    expect(status).toBe(413);
    const payload = JSON.parse(text) as { error: { code: string; request_id: string } };
    expect(payload.error.code).toBe('request_too_large');
    expect(payload.error.request_id).toBe(headers['x-request-id']);
    const stored = h.requests.get(payload.error.request_id);
    expect(stored?.status).toBe('error');
    expect(stored?.errorCode).toBe('request_too_large');
    expect(stored?.httpStatus).toBe(413);
    // No Content-Length was declared, so the limit is the conservative
    // byte figure for the row.
    expect(stored?.promptBytes).toBe(64);
    expect(h.requests.count()).toBe(countBefore + 1);
    expect(h.mock.requests().length).toBe(upstreamCallsBefore);
  });
});

describe('gateway group 4: a broken database must not break responses', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ OBSERVATORY_UPSTREAM_TIMEOUT_MS: '3000' });
  });

  it('still serves (and streams from) the upstream when the database is closed', async () => {
    // Kill the database: every telemetry write from now on must fail
    // silently and the LLM path must stay healthy.
    h.db.close();

    const response = await postChat(h.base, chatBody('ok'));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(MOCK_JSON_BODY);

    const stream = await postChat(h.base, chatBody('stream', true));
    expect(stream.status).toBe(200);
    expect(await stream.text()).toBe(MOCK_SSE_BODY);
  });

  afterAll(async () => {
    // db is already closed; closeAll must not throw.
    await h.app.close();
    await h.mock.close();
  });
});
