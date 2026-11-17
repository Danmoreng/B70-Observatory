import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  MetricsHistoryResponseSchema,
  parseApiError,
  parseRequestDetail,
  parseRequestListResponse,
} from '@observatory/contracts';
import { buildApp } from '../../src/app.js';
import { createPasswordHash, hashOpaqueToken } from '../../src/auth/crypto.js';
import { loadServerConfig } from '../../src/config.js';
import { AuthSessionRepository } from '../../src/db/auth-sessions.js';
import { MetricRepository } from '../../src/db/metrics.js';
import { RequestRepository } from '../../src/db/requests.js';
import { newTempDb } from '../helpers.js';

const PASSWORD = 'a very local password';
const GATEWAY_TOKEN = 'gateway-token-for-tests';
const ORIGIN = 'http://localhost';
const SENTINEL = 'sk-SMOKING-GUN-SENTINEL';

/** Fixed reference instant: 2025-06-01T12:00:00.000Z. */
const BASE = 1748740800_000;
const t = (seconds: number): string => new Date(BASE + seconds * 1000).toISOString();

/** Deterministic, lexicographically ordered UUIDs (all valid). */
function uuidAt(index: number): string {
  return `a0000000-0000-4000-8000-${(10000000 + index).toString(16).padStart(12, '0')}`;
}

interface Fixture {
  app: ReturnType<typeof buildApp>;
  db: DatabaseSync;
  requests: RequestRepository;
  cookie: string;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** Build a LAN-mode app (session auth active) with an established session. */
async function setup(): Promise<Fixture> {
  const temp = newTempDb();
  const webRoot = mkdtempSync(join(tmpdir(), 'observatory-web-'));
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Observatory M5A</title>');
  const passwordHash = await createPasswordHash(PASSWORD);
  const gatewayTokenHash = hashOpaqueToken(GATEWAY_TOKEN);
  const config = loadServerConfig({
    OBSERVATORY_MODE: 'lan',
    OBSERVATORY_HOST: '0.0.0.0',
    OBSERVATORY_PASSWORD_HASH: passwordHash,
    OBSERVATORY_GATEWAY_TOKEN_HASH: gatewayTokenHash,
  });
  const requests = new RequestRepository(temp.db);
  const metrics = new MetricRepository(temp.db);
  const sessions = new AuthSessionRepository(temp.db);
  const app = buildApp({
    version: 'test',
    config,
    loggerLevel: 'silent',
    database: temp.db,
    auth: {
      mode: 'lan',
      passwordHash,
      gatewayTokenHash,
      sessions,
      sessionDays: 30,
      cookieSecure: false,
    },
    history: { requests, metrics },
    webRoot,
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: ORIGIN, host: 'localhost', 'content-type': 'application/json' },
    payload: { password: PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';

  cleanups.push(() => rmSync(webRoot, { recursive: true, force: true }));
  cleanups.push(() => temp.close());
  cleanups.push(() => void app.close());
  return { app, db: temp.db, requests, cookie };
}

function seedRequest(
  requests: RequestRepository,
  index: number,
  atUtc: string,
  status: 'in_progress' | 'completed' | 'error' | 'aborted' = 'completed',
  model: string | null = 'Qwen3.8-27B'
): string {
  const id = uuidAt(index);
  requests.create({
    id,
    endpoint: '/v1/chat/completions',
    startedAtUtc: atUtc,
    model: model ?? undefined,
    promptBytes: 100,
  });
  if (status !== 'in_progress') {
    requests.finish({
      requestId: id,
      status,
      completedAtUtc: atUtc,
      durationMs: 100,
      responseBytes: 200,
      httpStatus: status === 'error' ? 502 : 200,
      ...(status === 'error' ? { errorCode: 'upstream_timeout' } : {}),
    });
  }
  return id;
}

describe('M5A history API (LAN mode, browser session)', () => {
  it('protects all three endpoints behind the session (401 before login)', async () => {
    const { app } = await setup();
    const anonymous = [
      await app.inject({ method: 'GET', url: '/api/requests' }),
      await app.inject({
        method: 'GET',
        url: '/api/requests/0e19369e-8060-4a9b-9a4d-1c2b3e4f5a6b',
      }),
      await app.inject({
        method: 'GET',
        url: `/api/metrics/history?series=vllm.requests-running&from=${t(0)}&to=${t(3600)}&bucketSeconds=60`,
      }),
    ];

    for (const response of anonymous) {
      expect(response.statusCode).toBe(401);
      expect(parseApiError(response.json()).error.code).toBe('unauthorized');
    }
  });

  it('lists requests newest first with metadata but never content or secrets', async () => {
    const { app, db, requests, cookie } = await setup();
    const older = seedRequest(requests, 1, t(0), 'completed');
    const middle = seedRequest(requests, 2, t(3600), 'error');
    const newest = seedRequest(requests, 3, t(7200), 'completed');
    const inProgress = seedRequest(requests, 4, t(7200), 'in_progress');
    // Force a free-text column the API must never expose.
    db.prepare('UPDATE requests SET errorMessage = ? WHERE id = ?').run(SENTINEL, older);

    const response = await app.inject({ method: 'GET', url: '/api/requests', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const body = parseRequestListResponse(response.json());
    // Both 7200-rows share a timestamp: id DESC breaks the tie, so the
    // in-progress row (higher id) comes first.
    expect(body.items.map((item) => item.id)).toEqual([inProgress, newest, middle, older]);
    expect(body.nextCursor).toBeNull();

    const byId = body.items.find((item) => item.id === middle);
    expect(byId).toMatchObject({
      status: 'error',
      httpStatus: 502,
      errorCode: 'upstream_timeout',
      model: 'Qwen3.8-27B',
      durationMs: 100,
      promptBytes: 100,
      responseBytes: 200,
    });
    // The in-progress row omits unknown fields instead of faking them.
    const running = body.items.find((item) => item.id === inProgress);
    expect(running).toMatchObject({ status: 'in_progress' });
    expect(running?.durationMs).toBeUndefined();
    expect(running?.httpStatus).toBeUndefined();

    expect(response.body).not.toContain(SENTINEL);
    expect(response.body).not.toContain('errorMessage');
    expect(response.body).not.toContain('"prompt"');
    expect(response.body).not.toContain('"messages"');
    expect(response.body).not.toContain('"authorization"');
  });

  it('paginates newest-first over multiple pages without duplicates or gaps', async () => {
    const { app, requests, cookie } = await setup();
    const total = 120;
    const allIds: string[] = [];
    for (let index = 0; index < total; index += 1) {
      allIds.push(seedRequest(requests, index, t(0)));
    }
    const expected = [...allIds].sort((a, b) => (a < b ? 1 : -1));

    const page1 = parseRequestListResponse(
      (
        await app.inject({ method: 'GET', url: '/api/requests?limit=50', headers: { cookie } })
      ).json()
    );
    expect(page1.items).toHaveLength(50);
    expect(page1.items.map((item) => item.id)).toEqual(expected.slice(0, 50));
    expect(page1.nextCursor).not.toBeNull();

    const page2 = parseRequestListResponse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/requests?limit=50&cursor=${encodeURIComponent(page1.nextCursor ?? '')}`,
          headers: { cookie },
        })
      ).json()
    );
    expect(page2.items).toHaveLength(50);
    expect(page2.items.map((item) => item.id)).toEqual(expected.slice(50, 100));
    expect(page2.nextCursor).not.toBeNull();

    const page3 = parseRequestListResponse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/requests?limit=50&cursor=${encodeURIComponent(page2.nextCursor ?? '')}`,
          headers: { cookie },
        })
      ).json()
    );
    expect(page3.items).toHaveLength(20);
    expect(page3.items.map((item) => item.id)).toEqual(expected.slice(100, 120));
    expect(page3.nextCursor).toBeNull();

    const seen = [...page1.items, ...page2.items, ...page3.items].map((item) => item.id);
    expect(new Set(seen).size).toBe(total);
    expect(seen).toEqual(expected);
  });

  it('binds cursors to their filter set (mixing filters is a 400)', async () => {
    const { app, requests, cookie } = await setup();
    for (let index = 0; index < 6; index += 1) {
      seedRequest(requests, index, t(index * 60), 'completed');
    }
    for (let index = 100; index < 106; index += 1) {
      seedRequest(requests, index, t(index * 60 + 30), 'error');
    }
    const completedPage = parseRequestListResponse(
      (
        await app.inject({
          method: 'GET',
          url: '/api/requests?status=completed&limit=4',
          headers: { cookie },
        })
      ).json()
    );
    const cursor = completedPage.nextCursor;
    expect(cursor).not.toBeNull();

    // Same cursor under a different filter must be rejected.
    const mixed = await app.inject({
      method: 'GET',
      url: `/api/requests?status=error&limit=4&cursor=${encodeURIComponent(cursor ?? '')}`,
      headers: { cookie },
    });
    expect(mixed.statusCode).toBe(400);
    expect(parseApiError(mixed.json()).error.code).toBe('bad_request');

    // The same cursor stays valid for the filter set that minted it.
    const followUp = await app.inject({
      method: 'GET',
      url: `/api/requests?status=completed&limit=4&cursor=${encodeURIComponent(cursor ?? '')}`,
      headers: { cookie },
    });
    expect(followUp.statusCode).toBe(200);
    const body = parseRequestListResponse(followUp.json());
    expect(body.items.every((item) => item.status === 'completed')).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
  });

  it('applies id/status/model/time filters and returns empty pages on demand', async () => {
    const { app, requests, cookie } = await setup();
    const atFrom = seedRequest(requests, 1, t(600), 'completed');
    const inside = seedRequest(requests, 2, t(1200), 'error');
    const atTo = seedRequest(requests, 3, t(1800), 'completed');
    const outsideBefore = seedRequest(requests, 4, t(100), 'completed');
    const outsideAfter = seedRequest(requests, 5, t(300000), 'completed', 'other-model');

    const list = async (url: string) =>
      parseRequestListResponse(
        (await app.inject({ method: 'GET', url, headers: { cookie } })).json()
      );

    const byStatus = await list('/api/requests?status=completed');
    expect(byStatus.items.map((item) => item.id)).not.toContain(inside);
    const byModel = await list('/api/requests?model=other-model');
    expect(byModel.items.map((item) => item.id)).toEqual([outsideAfter]);
    const byId = await list(`/api/requests?id=${inside}`);
    expect(byId.items.map((item) => item.id)).toEqual([inside]);
    expect(byId.nextCursor).toBeNull();
    const window = await list(`/api/requests?from=${t(600)}&to=${t(1800)}`);
    const windowIds = window.items.map((item) => item.id);
    expect(windowIds).toContain(atFrom);
    expect(windowIds).toContain(atTo);
    expect(windowIds).not.toContain(outsideBefore);
    expect(windowIds).not.toContain(outsideAfter);

    const empty = await list(
      '/api/requests?status=completed&model=other-model&from=2030-01-01T00:00:00.000Z'
    );
    expect(empty.items).toEqual([]);
    expect(empty.nextCursor).toBeNull();
  });

  it('rejects invalid query parameters with the sanitized error contract', async () => {
    const { app, cookie } = await setup();
    const invalidQueries = [
      '/api/requests?limit=0',
      '/api/requests?limit=201',
      '/api/requests?limit=abc',
      '/api/requests?limit=-1',
      '/api/requests?status=done',
      '/api/requests?id=not-a-uuid',
      '/api/requests?from=2025-06-01T12:00:00Z',
      '/api/requests?to=2025-06-01T14:00:00.000+02:00',
      '/api/requests?from=2025-06-02T00:00:00.000Z&to=2025-06-01T00:00:00.000Z',
      `/api/requests?model=${'x'.repeat(129)}`,
      '/api/requests?cursor=!!not-base64',
      `/api/requests?cursor=${'A'.repeat(513)}`,
      `/api/requests?cursor=${Buffer.from('complete garbage').toString('base64url')}`,
      '/api/requests?status=completed&status=error',
      '/api/requests?foo=bar',
      '/api/metrics/history?from=2025-06-01T12:00:00.000Z&to=2025-06-01T13:00:00.000Z&bucketSeconds=60',
      `/api/metrics/history?series=vllm.requests-running&from=${t(3600)}&to=${t(0)}&bucketSeconds=60`,
      '/api/metrics/history?series=vllm.requests-running&from=2025-06-01T12:00:00Z&to=2025-06-01T13:00:00.000Z&bucketSeconds=60',
      `/api/metrics/history?series=vllm.requests-running&from=${t(0)}&to=${t(3600)}&bucketSeconds=0`,
      `/api/metrics/history?series=vllm.requests-running&from=${t(0)}&to=${t(3600)}&bucketSeconds=abc`,
      `/api/metrics/history?series=nginx.rps&from=${t(0)}&to=${t(3600)}&bucketSeconds=60`,
      `/api/metrics/history?series=vllm.requests_running%3B%20DROP%20TABLE%20requests&from=${t(0)}&to=${t(60)}&bucketSeconds=60`,
    ];
    for (const url of invalidQueries) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(response.statusCode, url).toBe(400);
      const body = parseApiError(response.json());
      expect(body.error.code).toBe('bad_request');
      expect(response.body).not.toContain('SELECT');
      expect(response.body.toLowerCase()).not.toContain('sqlite');
    }
  });

  it('returns the full detail with ordered lifecycle events; 404 unknown, 400 invalid', async () => {
    const { app, db, requests, cookie } = await setup();
    const id = seedRequest(requests, 7, t(0), 'completed');
    requests.appendEvent({ requestId: id, eventType: 'start', atUtc: t(0) });
    requests.appendEvent({ requestId: id, eventType: 'first_token', atUtc: t(1) });
    requests.appendEvent({ requestId: id, eventType: 'token', atUtc: t(2) });
    requests.appendEvent({ requestId: id, eventType: 'complete', atUtc: t(3) });
    db.prepare('UPDATE requests SET errorMessage = ? WHERE id = ?').run(SENTINEL, id);

    const response = await app.inject({
      method: 'GET',
      url: `/api/requests/${id}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const detail = parseRequestDetail(response.json());
    expect(detail.id).toBe(id);
    expect(detail.events.map((event) => [event.sequence, event.eventType])).toEqual([
      [1, 'start'],
      [2, 'first_token'],
      [3, 'token'],
      [4, 'complete'],
    ]);
    expect(response.body).not.toContain(SENTINEL);

    const unknown = await app.inject({
      method: 'GET',
      url: '/api/requests/9f6b1d2c-3e4f-4a5b-8c6d-0a1b2c3d4e5f',
      headers: { cookie },
    });
    expect(unknown.statusCode).toBe(404);
    expect(parseApiError(unknown.json()).error.code).toBe('not_found');

    const invalid = await app.inject({
      method: 'GET',
      url: '/api/requests/not-a-uuid',
      headers: { cookie },
    });
    expect(invalid.statusCode).toBe(400);
    expect(parseApiError(invalid.json()).error.code).toBe('bad_request');
    expect(invalid.body).not.toContain('SELECT');
  });
});

describe('M5A metric history endpoint', () => {
  async function seededFixture() {
    const fixture = await setup();
    const metrics = new MetricRepository(fixture.db);
    // 11 samples at 60s spacing: t(0) … t(600), values 1 … 11.
    metrics.insertMany(
      Array.from({ length: 11 }, (_, index) => ({
        source: 'vllm' as const,
        name: 'vllm.requests_running',
        value: index + 1,
        unit: 'count',
        atUtc: t(index * 60),
      }))
    );
    return { ...fixture, metrics };
  }

  it('aggregates one allowlisted series into epoch-aligned buckets', async () => {
    const { app, cookie } = await seededFixture();
    const response = await app.inject({
      method: 'GET',
      url: `/api/metrics/history?series=vllm.requests-running&from=${t(0)}&to=${t(660)}&bucketSeconds=120`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = MetricsHistoryResponseSchema.parse(response.json());
    expect(body.series).toBe('vllm.requests-running');
    expect(body.unit).toBe('count');
    expect(body.bucketSeconds).toBe(120);
    expect(body.buckets.map((bucket) => [bucket.min, bucket.max, bucket.count])).toEqual([
      [1, 2, 2],
      [3, 4, 2],
      [5, 6, 2],
      [7, 8, 2],
      [9, 10, 2],
      [11, 11, 1],
    ]);
    expect(body.buckets[0]).toMatchObject({ atUtc: t(0), avg: 1.5 });
    expect(body.buckets[2]).toMatchObject({ avg: 5.5 });
    // Chronological order.
    const stamps = body.buckets.map((bucket) => bucket.atUtc);
    expect([...stamps].sort()).toEqual(stamps);
    // No samples between t(600) and t(660) → no trailing empty bucket.
    expect(body.buckets).toHaveLength(6);
  });

  it('returns an (empty) 200 for a window without samples', async () => {
    const { app, cookie } = await seededFixture();
    const response = await app.inject({
      method: 'GET',
      url: `/api/metrics/history?series=vllm.requests-running&from=${t(100_000)}&to=${t(200_000)}&bucketSeconds=120`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = MetricsHistoryResponseSchema.parse(response.json());
    expect(body.buckets).toEqual([]);
  });

  it('enforces the 1000-bucket cap and the window bound', async () => {
    const { app, cookie } = await seededFixture();
    // Exactly 1000 buckets: 999 intervals × 60s plus the boundary bucket.
    const maxOk = await app.inject({
      method: 'GET',
      url: `/api/metrics/history?series=vllm.requests-running&from=${t(0)}&to=${t(999 * 60)}&bucketSeconds=60`,
      headers: { cookie },
    });
    expect(maxOk.statusCode).toBe(200);
    // One interval more → 1001 buckets → 400.
    const tooMany = await app.inject({
      method: 'GET',
      url: `/api/metrics/history?series=vllm.requests-running&from=${t(0)}&to=${t(1000 * 60)}&bucketSeconds=60`,
      headers: { cookie },
    });
    expect(tooMany.statusCode).toBe(400);
    expect(parseApiError(tooMany.json()).error.code).toBe('bad_request');
    expect(tooMany.body).toContain('1000');

    // The window spans only 999 full intervals plus one second, but starts
    // one second before an epoch-aligned boundary. It therefore touches 1001
    // actual buckets and must be rejected before response validation.
    const misalignedTooMany = await app.inject({
      method: 'GET',
      url:
        `/api/metrics/history?series=vllm.requests-running&from=${t(59)}` +
        `&to=${t(59 + 999 * 60 + 1)}&bucketSeconds=60`,
      headers: { cookie },
    });
    expect(misalignedTooMany.statusCode).toBe(400);
    expect(parseApiError(misalignedTooMany.json()).error.code).toBe('bad_request');

    const tooWide = await app.inject({
      method: 'GET',
      url: `/api/metrics/history?series=vllm.requests-running&from=${t(0)}&to=${t(367 * 86_400)}&bucketSeconds=3600`,
      headers: { cookie },
    });
    expect(tooWide.statusCode).toBe(400);
  });

  it('returns a bounded, sanitized 400 for an unknown series', async () => {
    const { app, cookie } = await seededFixture();
    const response = await app.inject({
      method: 'GET',
      url: `/api/metrics/history?series=attacker.metric&from=${t(0)}&to=${t(60)}&bucketSeconds=60`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
    expect(parseApiError(response.json()).error.code).toBe('bad_request');
    expect(response.body).toContain('Unknown metric series');
    expect(response.body.length).toBeLessThan(512);
  });

  it('exposes persisted generation-throughput, total-VRAM and GPU-clock series', async () => {
    const { app, db, cookie } = await setup();
    const metrics = new MetricRepository(db);
    metrics.insertMany([
      {
        source: 'vllm',
        name: 'vllm.generation_tokens_per_second',
        value: 42,
        unit: 'tokens_per_second',
        atUtc: t(0),
      },
      {
        source: 'gpu',
        name: 'gpu.vram_total_bytes',
        value: 32 * 1024 ** 3,
        unit: 'bytes',
        atUtc: t(0),
      },
      {
        source: 'gpu',
        name: 'gpu.clock_mhz',
        value: 2400,
        unit: 'megahertz',
        atUtc: t(0),
      },
    ]);

    const expected = [
      ['vllm.generation-tokens-per-second', 'tokens_per_second', 42],
      ['gpu.vram-total-bytes', 'bytes', 32 * 1024 ** 3],
      ['gpu.clock-mhz', 'megahertz', 2400],
    ] as const;
    for (const [series, unit, value] of expected) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/metrics/history?series=${series}&from=${t(0)}&to=${t(60)}&bucketSeconds=60`,
        headers: { cookie },
      });
      expect(response.statusCode, series).toBe(200);
      const body = MetricsHistoryResponseSchema.parse(response.json());
      expect(body.unit).toBe(unit);
      expect(body.buckets).toHaveLength(1);
      expect(body.buckets[0]).toMatchObject({ min: value, max: value, avg: value, count: 1 });
    }
  });
});
