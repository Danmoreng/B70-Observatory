import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { registerTokenize } from '../../src/gateway/tokenize.js';
import { loadServerConfig } from '../../src/config.js';
afterEach(() => vi.unstubAllGlobals());
it('only forwards fixed CPU tokenization, strips token IDs and enforces a bounded input shape', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ count: 7, tokens: [1, 2, 3], token_strs: ['private'] })
  );
  vi.stubGlobal('fetch', fetcher);
  const app = Fastify();
  registerTokenize(app, loadServerConfig({ OBSERVATORY_UPSTREAM_URL: 'http://engine:8081' }));
  try {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/tokenize',
      payload: { model: 'Qwen', prompt: 'hello' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ count: 7 });
    expect(String(fetcher.mock.calls[0]![0])).toBe('http://engine:8081/tokenize');
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({
      model: 'Qwen',
      prompt: 'hello',
      add_special_tokens: false,
    });
    for (const payload of [
      { model: 'Qwen', prompt: 'hello', max_tokens: 20 },
      {
        model: 'Qwen',
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'http://external/image.png' } }],
          },
        ],
      },
    ]) {
      expect((await app.inject({ method: 'POST', url: '/v1/tokenize', payload })).statusCode).toBe(
        400
      );
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});
it('reports an unavailable tokenizer honestly', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ count: -1 }))
  );
  const app = Fastify();
  registerTokenize(app, loadServerConfig());
  try {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/tokenize',
          payload: { model: 'Qwen', prompt: 'hello' },
        })
      ).statusCode
    ).toBe(503);
  } finally {
    await app.close();
  }
});

it('requires the existing gateway credential and creates no inference accounting row', async () => {
  const { registerAuth } = await import('../../src/auth/routes.js');
  const { hashOpaqueToken } = await import('../../src/auth/crypto.js');
  const { AuthSessionRepository } = await import('../../src/db/auth-sessions.js');
  const { newTempDb } = await import('../helpers.js');
  const temp = newTempDb();
  const app = Fastify();
  const upstream = vi.fn<typeof fetch>(async () => Response.json({ count: 7, tokens: [1] }));
  vi.stubGlobal('fetch', upstream);
  registerAuth(app, {
    mode: 'lan',
    gatewayTokenHash: hashOpaqueToken('test-gateway'),
    sessions: new AuthSessionRepository(temp.db),
    sessionDays: 1,
    cookieSecure: false,
  });
  registerTokenize(app, loadServerConfig());
  try {
    const request = {
      method: 'POST' as const,
      url: '/v1/tokenize',
      payload: { model: 'Qwen', prompt: 'hello' },
    };
    expect((await app.inject(request)).statusCode).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
    expect(
      (await app.inject({ ...request, headers: { authorization: 'Bearer test-gateway' } }))
        .statusCode
    ).toBe(200);
    expect(temp.db.prepare('SELECT COUNT(*) AS n FROM requests').get()?.n).toBe(0);
  } finally {
    await app.close();
    temp.close();
  }
});
