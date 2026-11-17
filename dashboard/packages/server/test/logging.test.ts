import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { parseApiError, parseHealthPayload } from '@observatory/contracts';
import { buildApp, type AppOptions } from '../src/app.js';
import { loadServerConfig } from '../src/config.js';

const SECRET = 'B70-QUERY-SECRET-DO-NOT-LEAK';

function baseOptions(): AppOptions {
  return {
    version: 'logging-test',
    config: loadServerConfig(),
    startedAt: new Date('2025-01-01T10:00:00.000Z'),
    loggerLevel: 'info',
  };
}

/** Collect the JSON log lines written to the given app. */
function createLogCollector(): {
  app: ReturnType<typeof buildApp>;
  lines: () => string[];
  close: () => Promise<void>;
} {
  const collected: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback: (error?: Error) => void) {
      collected.push(String(chunk));
      callback();
    },
  });
  const app = buildApp({ ...baseOptions(), loggerStream: stream });
  return {
    app,
    lines: () => collected,
    close: () => app.close(),
  };
}

/**
 * Regression test for review finding R1 (M1): Fastify's default logger
 * serialized the full request URL including the query string, so
 * `GET /nope?token=…` leaked the token into the structured log. The
 * sentinel below must appear neither in the logs nor in the response.
 */
describe('request logging (R1 regression)', () => {
  it('never logs the query string of an unknown route', async () => {
    const { app, lines, close } = createLogCollector();
    const response = await app.inject({
      method: 'GET',
      url: `/nope?token=${SECRET}&page=2`,
    });

    expect(response.statusCode).toBe(404);
    const body = response.body;
    // The response body is clean…
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain('token=');
    expect(parseApiError(response.json()).error.code).toBe('not_found');
    // …and so are the structured logs.
    const logged = lines().join('\n');
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain('?token=');
    // The path is still logged (useful, safe).
    expect(logged).toContain('/nope');
    await close();
  });

  it('logs the path but not the query for known routes', async () => {
    const { app, lines, close } = createLogCollector();
    const response = await app.inject({
      method: 'GET',
      url: `/api/health?session=${SECRET}`,
    });

    expect(response.statusCode).toBe(200);
    parseHealthPayload(response.json());
    const logged = lines().join('\n');
    expect(logged).not.toContain(SECRET);
    expect(logged).toContain('/api/health');
    // The serialized request object must carry only the path.
    const requestLogs = lines()
      .map((line) => JSON.parse(line) as { req?: { url?: string } })
      .filter((entry) => entry.req !== undefined);
    for (const entry of requestLogs) {
      if (entry.req?.url !== undefined) {
        expect(entry.req.url).not.toContain('?');
      }
    }
    await close();
  });

  it('keeps 404 messages path-only even with a secret query', async () => {
    const { app, lines, close } = createLogCollector();
    const response = await app.inject({
      method: 'POST',
      url: `/api/unknown?key=${SECRET}`,
      payload: JSON.stringify({ x: 1 }),
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(404);
    const message = parseApiError(response.json()).error.message;
    expect(message).toContain('/api/unknown');
    expect(message).not.toContain(SECRET);
    expect(lines().join('\n')).not.toContain(SECRET);
    await close();
  });
});
