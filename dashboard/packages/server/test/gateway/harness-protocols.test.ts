import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createPasswordHash } from '../../src/auth/crypto.js';
import { loadServerConfig } from '../../src/config.js';
import { AuthSessionRepository } from '../../src/db/auth-sessions.js';
import { RequestRepository } from '../../src/db/index.js';
import { newTempDb } from '../helpers.js';

const sse =
  'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","name":"read_file","arguments":"{}"}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}\n\n';

describe('LAN inference protocols without gateway credentials', () => {
  const temp = newTempDb();
  const received: Array<{
    method: string;
    url: string;
    raw: string;
    headers: Record<string, unknown>;
  }> = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    received.push({ method: req.method ?? '', url: req.url ?? '', raw, headers: req.headers });
    if (raw.includes('"stream":true') || req.url?.includes('stream=true')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sse.slice(0, 40));
      setTimeout(() => res.end(sse.slice(40)), 5);
    } else {
      res.writeHead(req.url?.includes('reject=true') ? 429 : 200, {
        'content-type': 'application/json',
        'retry-after': '3',
      });
      res.end('{"ok":true,"usage":{"input_tokens":4,"output_tokens":2}}');
    }
  });
  let app: ReturnType<typeof buildApp>;
  let base: string;
  beforeAll(async () => {
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const port = (upstream.address() as AddressInfo).port;
    const config = loadServerConfig({
      OBSERVATORY_MODE: 'lan',
      OBSERVATORY_HOST: '127.0.0.1',
      OBSERVATORY_PASSWORD_HASH: await createPasswordHash('local test password'),
      OBSERVATORY_GATEWAY_AUTH_MODE: 'none',
      OBSERVATORY_UPSTREAM_URL: `http://127.0.0.1:${port}`,
    });
    app = buildApp({
      webRoot: temp.dir,
      version: 'protocol-test',
      config,
      loggerLevel: 'silent',
      database: temp.db,
      gateway: { config, requests: new RequestRepository(temp.db) },
      auth: {
        mode: 'lan',
        gatewayAuthMode: config.gatewayAuthMode,
        passwordHash: config.passwordHash,
        sessions: new AuthSessionRepository(temp.db),
        sessionDays: 30,
        cookieSecure: false,
      },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app?.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    temp.close();
  });

  it.each([
    ['POST', '/v1/chat/completions'],
    ['POST', '/v1/completions'],
    ['POST', '/v1/responses'],
    ['POST', '/v1/messages?beta=true'],
    ['POST', '/v1/messages/count_tokens'],
    ['GET', '/v1/models'],
    ['GET', '/v1/responses/resp_test'],
    ['POST', '/v1/responses/resp_test/cancel'],
  ])('passes %s %s through without an API key', async (method, path) => {
    const raw =
      method === 'POST' && !path.endsWith('/cancel')
        ? '{ "model": "Qwen3.8-27B", "tools": [{"name":"read_file"}] }'
        : undefined;
    const response = await fetch(base + path, {
      method,
      body: raw,
      headers: raw
        ? {
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'tools-test',
            cookie: 'private-cookie',
          }
        : {},
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty('ok', true);
    expect(received.at(-1)).toMatchObject({ method, url: path, raw: raw ?? '' });
    expect(received.at(-1)?.headers.cookie).toBeUndefined();
    if (raw)
      expect(received.at(-1)?.headers).toMatchObject({
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'tools-test',
      });
  });

  it.each([
    ['/v1/chat/completions', { reasoning_effort: 'high' }, { reasoning_effort: 'xhigh' }],
    [
      '/v1/responses',
      { reasoning: { effort: 'high', summary: 'auto' } },
      { reasoning: { effort: 'xhigh', summary: 'auto' } },
    ],
    ['/v1/messages', { output_config: { effort: 'high' } }, { output_config: { effort: 'xhigh' } }],
    [
      '/v1/chat/completions',
      { chat_template_kwargs: { reasoning_effort: 'high' } },
      { chat_template_kwargs: { reasoning_effort: 'xhigh' } },
    ],
  ])(
    'normalizes high effort on %s without changing tools or content',
    async (path, effort, expected) => {
      const shared = {
        model: 'Qwen3.8-27B',
        messages: [{ role: 'user', content: 'high' }],
        tools: [{ name: 'high' }],
      };
      const response = await fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...shared, ...effort }),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(JSON.parse(received.at(-1)?.raw ?? '')).toEqual({ ...shared, ...expected });
    }
  );

  it.each(['/v1/responses', '/v1/messages', '/v1/chat/completions'])(
    'preserves %s SSE and tool events byte for byte',
    async (path) => {
      const response = await fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"model":"Qwen3.8-27B","stream":true}',
      });
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      expect(await response.text()).toBe(sse);
    }
  );

  it('streams a retrieved response and forwards its query', async () => {
    const response = await fetch(base + '/v1/responses/resp_test?stream=true&starting_after=2');
    expect(await response.text()).toBe(sse);
    expect(received.at(-1)?.url).toBe('/v1/responses/resp_test?stream=true&starting_after=2');
  });

  it('preserves upstream errors and retry instructions', async () => {
    const response = await fetch(base + '/v1/responses?reject=true', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('3');
    expect(await response.text()).toBe('{"ok":true,"usage":{"input_tokens":4,"output_tokens":2}}');
  });

  it('keeps dashboard and control APIs protected and never proxies administration', async () => {
    const count = received.length;
    for (const path of ['/api/health', '/api/engine/service', '/api/agent/tasks']) {
      expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(401);
    }
    for (const path of ['/load', '/metrics', '/v1/unknown']) {
      expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
    }
    expect(received).toHaveLength(count);
  });

  it('records endpoint and counters without request contents or queries', () => {
    const rows = temp.db
      .prepare('SELECT endpoint, method, promptTokens, completionTokens FROM requests')
      .all();
    expect(rows).toContainEqual({
      endpoint: '/v1/models',
      method: 'GET',
      promptTokens: 4,
      completionTokens: 2,
    });
    expect(rows).toContainEqual({
      endpoint: '/v1/responses',
      method: 'POST',
      promptTokens: 4,
      completionTokens: 2,
    });
    expect(JSON.stringify(rows)).not.toContain('beta=true');
  });
});
