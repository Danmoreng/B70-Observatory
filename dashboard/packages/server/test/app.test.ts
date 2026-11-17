import { get as httpGet } from 'node:http';
import { describe, expect, it } from 'vitest';
import { closeDatabase } from '../src/db/database.js';
import { newTempDb } from './helpers.js';
import { parseApiError, parseHealthPayload, type HealthPayload } from '@observatory/contracts';
import { buildApp, closeWithDrainTimeout, type AppOptions } from '../src/app.js';
import { loadServerConfig } from '../src/config.js';

const baseOptions = (overrides: Partial<AppOptions> = {}): AppOptions => ({
  version: 'test-version',
  config: loadServerConfig(),
  startedAt: new Date('2025-01-01T10:00:00.000Z'),
  loggerLevel: 'silent',
  ...overrides,
});

it('bounds shutdown while an SSE client stays connected (M5C restart)', async () => {
  const app = buildApp(baseOptions());
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as { port: number };
  // Open a real SSE connection and keep it alive: the connection must
  // not block the bounded close.
  const response = await new Promise<import('node:http').IncomingMessage>((resolveP, rejectP) => {
    const request = httpGet({ host: '127.0.0.1', port, path: '/api/events' }, resolveP);
    request.on('error', rejectP);
  });
  response.resume();
  const started = Date.now();
  await closeWithDrainTimeout(app, 300);
  expect(Date.now() - started).toBeLessThan(2000);
  response.destroy();
});

describe('buildApp (in-process integration)', () => {
  it('serves a contract-valid health payload with UTC timestamps', async () => {
    const app = buildApp(baseOptions());
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');

    const body = parseHealthPayload(response.json());
    expect(body.service).toBe('local-ai-b70-observatory');
    expect(body.version).toBe('test-version');
    expect(body.status).toBe('ok');
    expect(body.startedAt).toBe('2025-01-01T10:00:00.000Z');
    expect(body.timestamp.endsWith('Z')).toBe(true);
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(body.checks.some((check) => check.name === 'server' && check.status === 'ok')).toBe(
      true
    );
    await app.close();
  });

  it('reports uptime against the configured start time', async () => {
    const app = buildApp(baseOptions({ startedAt: new Date('2025-01-01T10:00:00.000Z') }));
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    const body = response.json() as HealthPayload;
    const elapsedSeconds = Math.floor(
      (Date.now() - new Date('2025-01-01T10:00:00.000Z').getTime()) / 1000
    );
    // Uptime may cross a second boundary during the request.
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(elapsedSeconds - 1);
    expect(body.uptimeSeconds).toBeLessThanOrEqual(elapsedSeconds + 1);
    await app.close();
  });

  it('maps unknown routes to the ApiError contract (404)', async () => {
    const app = buildApp(baseOptions());
    const response = await app.inject({ method: 'GET', url: '/api/does-not-exist' });

    expect(response.statusCode).toBe(404);
    const body = parseApiError(response.json());
    expect(body.error.code).toBe('not_found');
    expect(body.error.message.length).toBeGreaterThan(0);
    await app.close();
  });

  it('maps unhandled exceptions to a sanitized 500', async () => {
    const app = buildApp(baseOptions());
    app.get('/boom', () => {
      throw new Error('secret internal detail: api-key=abc123');
    });

    const response = await app.inject({ method: 'GET', url: '/boom' });
    expect(response.statusCode).toBe(500);

    const body = parseApiError(response.json());
    expect(body.error.code).toBe('internal_error');
    // Internal details must never leak to the client.
    expect(response.body).not.toContain('secret internal detail');
    expect(response.body).not.toContain('abc123');
    await app.close();
  });

  it('treats unknown methods as not found (fastify maps them to 404, see fastify/fastify#862)', async () => {
    const app = buildApp(baseOptions());
    const response = await app.inject({ method: 'POST', url: '/api/health' });
    expect(response.statusCode).toBe(404);
    const body = parseApiError(response.json());
    expect(body.error.code).toBe('not_found');
    await app.close();
  });

  it('enforces the configured request size limit', async () => {
    const app = buildApp(baseOptions({ config: { ...loadServerConfig(), maxRequestBytes: 16 } }));
    app.post('/api/echo', async (request, reply) => reply.send({ bytes: request.body }));

    const ok = await app.inject({
      method: 'POST',
      url: '/api/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify('tiny'),
    });
    expect(ok.statusCode).toBe(200);

    const tooBig = await app.inject({
      method: 'POST',
      url: '/api/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify('x'.repeat(64)),
    });
    expect(tooBig.statusCode).toBe(413);
    expect(() => parseApiError(tooBig.json())).not.toThrow();
    await app.close();
  });
});

describe('buildApp with a database (M2)', () => {
  it('adds a passing database health check', async () => {
    const temp = newTempDb();
    const app = buildApp({ ...baseOptions(), database: temp.db });

    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);

    const body = parseHealthPayload(response.json());
    expect(body.status).toBe('ok');
    expect(body.checks.some((check) => check.name === 'database' && check.status === 'ok')).toBe(
      true
    );
    expect(body.checks.some((check) => check.name === 'server')).toBe(true);

    await app.close();
    temp.close();
  });

  it('reports the database check as error when the handle is unusable', async () => {
    const temp = newTempDb();
    const db = temp.db;
    closeDatabase(db); // simulate a lost/corrupted connection

    const app = buildApp({ ...baseOptions(), database: db });
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    const body = parseHealthPayload(response.json());
    const dbCheck = body.checks.find((check) => check.name === 'database');
    expect(dbCheck?.status).toBe('error');
    expect(body.status).toBe('error');
    expect(body.checks.find((check) => check.name === 'server')?.status).toBe('ok');

    await app.close();
  });

  it('does not crash on health probes and works without a database (M1 shape)', async () => {
    const app = buildApp(baseOptions());
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    const body = response.json() as HealthPayload;
    expect(body.checks).toEqual([{ name: 'server', status: 'ok' }]);
    await app.close();
  });
});
