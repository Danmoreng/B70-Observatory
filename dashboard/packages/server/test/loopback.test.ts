import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { parseHealthPayload } from '@observatory/contracts';
import { buildApp, type AppOptions } from '../src/app.js';
import { loadServerConfig } from '../src/config.js';

/**
 * Integration test against a real socket. The server always binds to
 * 127.0.0.1 on an ephemeral port, so the production vLLM service on
 * 127.0.0.1:8081 is never touched.
 */
describe('server on a real loopback socket', () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const options: AppOptions = {
      version: 'socket-test',
      config: loadServerConfig({ OBSERVATORY_HOST: '127.0.0.1' }),
      loggerLevel: 'silent',
    };
    const app = buildApp(options);
    await app.listen({ host: '127.0.0.1', port: 0 });
    port = (app.server.address() as AddressInfo).port;
    close = () => app.close();
  });

  afterAll(async () => {
    await close();
  });

  it('answers GET /api/health over the network with a contract-valid payload', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');

    const body = parseHealthPayload(await response.json());
    expect(body.status).toBe('ok');
    expect(body.version).toBe('socket-test');
    expect(body.checks.length).toBeGreaterThan(0);
  });

  it('returns the ApiError contract for unknown routes over the network', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(response.status).toBe(404);
    const json = (await response.json()) as { error: { code: string } };
    expect(json.error.code).toBe('not_found');
  });

  it('opens one SSE stream and sends an initial named health event', async () => {
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
      signal: controller.signal,
      headers: { accept: 'text/event-stream' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-cache');
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('SSE response body missing');
    let received = '';
    while (!received.includes('event: health')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += new TextDecoder().decode(chunk.value, { stream: true });
    }
    expect(received).toContain('event: health');
    expect(received).toContain('"service":"local-ai-b70-observatory"');
    controller.abort();
  });
});
