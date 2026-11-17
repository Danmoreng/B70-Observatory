import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request, type RequestListener } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { InferenceRequestTelemetry } from '@observatory/contracts';
import { createInferenceRelay } from '../../src/runner/inference-relay.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function unixRequest(
  socketPath: string,
  path: string,
  token: string,
  requestBody = '{"model":"Qwen3.8-27B","stream":true}'
): Promise<{
  status: number;
  body: string;
}> {
  return new Promise((resolvePromise, reject) => {
    const client = request(
      {
        socketPath,
        path,
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.once('end', () => resolvePromise({ status: response.statusCode ?? 0, body }));
      }
    );
    client.once('error', reject);
    client.end(requestBody);
  });
}

describe('inference relay', () => {
  it('revokes a silent model request immediately despite its long idle budget', async () => {
    let received!: () => void;
    let disconnected!: () => void;
    const started = new Promise<void>((resolve) => {
      received = resolve;
    });
    const closed = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const upstream = createServer((_req, response) => {
      response.once('close', disconnected);
      received();
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const root = await mkdtemp(join(tmpdir(), 'b70-revoke-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const socketPath = join(root, 'relay.sock');
    const relay = createInferenceRelay({
      socketPath,
      upstreamUrl: new URL(`http://127.0.0.1:${address.port}`),
    });
    await relay.start();
    cleanups.push(() => relay.close());
    const token = 'a'.repeat(64);
    const samples: InferenceRequestTelemetry[] = [];
    relay.register(token, (sample) => samples.push(sample));
    const pending = unixRequest(socketPath, '/v1/chat/completions', token);
    await started;
    relay.revoke(token);
    expect((await pending).status).toBe(502);
    await closed;
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      outcome: 'failed',
      usage: null,
      prefill: null,
      decode: null,
    });
  });

  it.each([
    { idleTimeoutMs: 2_000, expectedStatus: 200 },
    { idleTimeoutMs: 30, expectedStatus: 502 },
  ])(
    'honors a bounded idle budget of $idleTimeoutMs ms',
    async ({ idleTimeoutMs, expectedStatus }) => {
      const upstream = createServer((_req, response) => {
        const timer = setTimeout(() => response.end('after prefill'), 120);
        response.once('close', () => clearTimeout(timer));
      });
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      cleanups.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
      const address = upstream.address();
      if (!address || typeof address === 'string') throw new Error('no port');
      const root = await mkdtemp(join(tmpdir(), 'b70-idle-'));
      cleanups.push(() => rm(root, { recursive: true, force: true }));
      const socketPath = join(root, 'relay.sock');
      const relay = createInferenceRelay({
        socketPath,
        upstreamUrl: new URL(`http://127.0.0.1:${address.port}`),
        upstreamIdleTimeoutMs: idleTimeoutMs,
      });
      await relay.start();
      cleanups.push(() => relay.close());
      relay.register('a'.repeat(64));
      const result = await unixRequest(socketPath, '/v1/chat/completions', 'a'.repeat(64));
      expect(result.status).toBe(expectedStatus);
      if (expectedStatus === 200) expect(result.body).toBe('after prefill');
    }
  );

  it('limits main and child model streams together to four requests', async () => {
    let active = 0;
    let maximum = 0;
    const upstream = createServer((_req, response) => {
      active++;
      maximum = Math.max(maximum, active);
      setTimeout(() => {
        active--;
        response.end('ok');
      }, 60);
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const root = await mkdtemp(join(tmpdir(), 'biq-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const socketPath = join(root, 'relay.sock');
    const relay = createInferenceRelay({
      socketPath,
      upstreamUrl: new URL(`http://127.0.0.1:${address.port}`),
    });
    await relay.start();
    cleanups.push(() => relay.close());
    relay.register('a'.repeat(64));
    relay.register('b'.repeat(64));
    const results = await Promise.all(
      Array.from({ length: 7 }, (_, index) =>
        unixRequest(socketPath, '/v1/chat/completions', (index % 2 ? 'a' : 'b').repeat(64))
      )
    );
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(maximum).toBe(4);
  });

  it('accepts one capability and exposes only chat completions', async () => {
    let upstreamAuthorization: string | undefined;
    const upstream = createServer((incoming, outgoing) => {
      upstreamAuthorization = incoming.headers.authorization;
      expect(incoming.url).toBe('/v1/chat/completions');
      outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
      outgoing.end('data: {"ok":true}\n\n');
    });
    await new Promise<void>((resolvePromise) => upstream.listen(0, '127.0.0.1', resolvePromise));
    cleanups.push(
      () => new Promise<void>((resolvePromise) => upstream.close(() => resolvePromise()))
    );
    const address = upstream.address();
    if (address === null || typeof address === 'string') throw new Error('missing test port');

    const root = await mkdtemp(join(tmpdir(), 'b70-relay-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const socketPath = join(root, 'relay.sock');
    const relay = createInferenceRelay({
      socketPath,
      upstreamUrl: new URL(`http://127.0.0.1:${address.port}`),
    });
    await relay.start();
    cleanups.push(() => relay.close());
    const token = 'a'.repeat(64);
    relay.register(token);

    expect((await unixRequest(socketPath, '/v1/chat/completions', 'b'.repeat(64))).status).toBe(
      401
    );
    expect((await unixRequest(socketPath, '/v1/models', token)).status).toBe(404);
    const accepted = await unixRequest(socketPath, '/v1/chat/completions', token);
    expect(accepted).toEqual({ status: 200, body: 'data: {"ok":true}\n\n' });
    expect(upstreamAuthorization).toBeUndefined();

    relay.revoke(token);
    expect((await unixRequest(socketPath, '/v1/chat/completions', token)).status).toBe(401);
  });
});

async function fixture(handler: RequestListener) {
  const upstream = createServer(handler);
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('missing test port');
  const root = await mkdtemp(join(tmpdir(), 'b70-relay-metrics-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const socketPath = join(root, 'relay.sock');
  const relay = createInferenceRelay({
    socketPath,
    upstreamUrl: new URL(`http://127.0.0.1:${address.port}`),
  });
  await relay.start();
  cleanups.push(() => relay.close());
  return { relay, socketPath };
}

const reported = {
  choices: [{ finish_reason: 'stop' }],
  usage: {
    prompt_tokens: 500,
    completion_tokens: 40,
    prompt_tokens_details: { cached_tokens: 300 },
  },
  timings: { prompt_n: 200, prompt_ms: 250, predicted_n: 40, predicted_ms: 800 },
};

describe('inference relay telemetry', () => {
  it('preserves request/response bytes and attributes each sample only to its registered capability', async () => {
    const bodies: string[] = [];
    const responseBody = JSON.stringify(reported);
    const { relay, socketPath } = await fixture((incoming, outgoing) => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk) => {
        body += chunk;
      });
      incoming.on('end', () => {
        bodies.push(body);
        expect(incoming.headers.authorization).toBeUndefined();
        outgoing.writeHead(200, { 'content-type': 'application/json' });
        outgoing.end(responseBody);
      });
    });
    const a: InferenceRequestTelemetry[] = [];
    const b: InferenceRequestTelemetry[] = [];
    relay.register('a'.repeat(64), (sample) => a.push(sample));
    relay.register('b'.repeat(64), (sample) => b.push(sample));
    const requestBody =
      '{ "messages": [{"role":"user", "content":"Grüße. Preserve whitespace."}], "stream":false }';
    expect(
      (await unixRequest(socketPath, '/v1/chat/completions', 'a'.repeat(64), requestBody)).body
    ).toBe(responseBody);
    await unixRequest(socketPath, '/v1/chat/completions', 'b'.repeat(64));
    expect(bodies[0]).toBe(requestBody);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]?.requestId).not.toBe(b[0]?.requestId);
    expect(a[0]).toMatchObject({
      outcome: 'completed',
      prefill: { tokens: 200, durationMs: 250 },
      decode: { tokens: 40, durationMs: 800 },
    });
    expect(JSON.stringify(a)).not.toContain('a'.repeat(64));
    expect(JSON.stringify(a)).not.toContain('Preserve whitespace');
  });

  it.each([
    {
      status: 200,
      type: 'text/event-stream',
      body: `data: ${JSON.stringify(reported)}\n\ndata: {"error":{"message":"failed"}}\n\ndata: [DONE]\n\n`,
    },
    { status: 503, type: 'application/json', body: JSON.stringify(reported) },
    {
      status: 200,
      type: 'text/event-stream',
      body: `data: ${JSON.stringify({ timings: reported.timings })}\n\n`,
    },
  ])(
    'does not count phases from unsuccessful responses ($status, $type)',
    async ({ status, type, body }) => {
      const { relay, socketPath } = await fixture((_incoming, outgoing) => {
        outgoing.writeHead(status, { 'content-type': type });
        outgoing.end(body);
      });
      const samples: InferenceRequestTelemetry[] = [];
      relay.register('a'.repeat(64), (sample) => samples.push(sample));
      await unixRequest(socketPath, '/v1/chat/completions', 'a'.repeat(64));
      expect(samples).toHaveLength(1);
      expect(samples[0]).toMatchObject({
        outcome: 'failed',
        usage: null,
        prefill: null,
        decode: null,
      });
    }
  );

  it('isolates telemetry callback errors from inference delivery', async () => {
    const body = `data: ${JSON.stringify(reported)}\n\ndata: [DONE]\n\n`;
    const { relay, socketPath } = await fixture((_incoming, outgoing) => {
      outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
      outgoing.end(body);
    });
    relay.register('a'.repeat(64), () => {
      throw new Error('simulated telemetry persistence failure');
    });
    expect(await unixRequest(socketPath, '/v1/chat/completions', 'a'.repeat(64))).toEqual({
      status: 200,
      body,
    });
  });

  it('starts request timing after relay admission and never counts a revoked queued request', async () => {
    let arrived = 0;
    let ready!: () => void;
    const active = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const held: import('node:http').ServerResponse[] = [];
    const { relay, socketPath } = await fixture((_incoming, outgoing) => {
      arrived++;
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      if (arrived <= 4) {
        held.push(outgoing);
        if (held.length === 4) ready();
      } else outgoing.end(JSON.stringify(reported));
    });
    const queuedSamples: InferenceRequestTelemetry[] = [];
    const revokedSamples: InferenceRequestTelemetry[] = [];
    relay.register('a'.repeat(64));
    relay.register('b'.repeat(64), (sample) => queuedSamples.push(sample));
    relay.register('c'.repeat(64), (sample) => revokedSamples.push(sample));
    const initial = Array.from({ length: 4 }, () =>
      unixRequest(socketPath, '/v1/chat/completions', 'a'.repeat(64))
    );
    await active;
    const queued = unixRequest(socketPath, '/v1/chat/completions', 'b'.repeat(64));
    const revoked = unixRequest(socketPath, '/v1/chat/completions', 'c'.repeat(64)).catch(
      () => undefined
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    relay.revoke('c'.repeat(64));
    await revoked;
    const releasedAt = Date.now();
    for (const response of held) response.end(JSON.stringify(reported));
    await Promise.all([...initial, queued]);
    expect(arrived).toBe(5);
    expect(revokedSamples).toEqual([]);
    expect(queuedSamples).toHaveLength(1);
    expect(Date.parse(queuedSamples[0]!.startedAt)).toBeGreaterThanOrEqual(releasedAt);
    expect(queuedSamples[0]?.outcome).toBe('completed');
  });

  it('keeps upstream backpressure while observing a large stream', async () => {
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(3 * 1024 * 1024) } }] })}\n\ndata: ${JSON.stringify(reported)}\n\ndata: [DONE]\n\n`;
    let backpressure = false;
    const { relay, socketPath } = await fixture((_incoming, outgoing) => {
      outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
      backpressure = !outgoing.write(body);
      outgoing.end();
    });
    const samples: InferenceRequestTelemetry[] = [];
    relay.register('a'.repeat(64), (sample) => samples.push(sample));
    const received = await new Promise<string>((resolve, reject) => {
      const client = request(
        {
          socketPath,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: { authorization: `Bearer ${'a'.repeat(64)}` },
        },
        (response) => {
          response.pause();
          setTimeout(() => response.resume(), 40);
          let receivedBody = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            receivedBody += chunk;
          });
          response.on('end', () => resolve(receivedBody));
          response.on('error', reject);
        }
      );
      client.on('error', reject);
      client.end('{"stream":true}');
    });
    expect(backpressure).toBe(true);
    expect(received).toBe(body);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.decode).toEqual({ tokens: 40, durationMs: 800 });
  });
});
