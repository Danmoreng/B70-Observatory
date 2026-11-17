import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadServerConfig } from '../../src/config.js';
import { RequestRepository } from '../../src/db/index.js';
import { GpuScheduler } from '../../src/engine/gpu-scheduler.js';
import { newTempDb } from '../helpers.js';

it('holds leases through real SSE completion and queues both agents while the image engine owns the GPU', async () => {
  const responses: ServerResponse[] = [],
    events: string[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      responses.push(res);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = loadServerConfig({
    OBSERVATORY_UPSTREAM_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  });
  const gpu = new GpuScheduler({
    image: async () => {
      events.push('image');
    },
    text: async () => {
      events.push('text');
    },
  });
  const temp = newTempDb();
  const app = buildApp({
    version: 'test',
    config,
    gateway: { config, requests: new RequestRepository(temp.db), gpu },
    loggerLevel: 'silent',
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const call = () =>
    fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake', stream: true, messages: [] }),
    });
  let completeImage: () => void = () => {};
  try {
    const a = await call(),
      b = await call();
    const aBody = a.text(),
      bBody = b.text();
    expect(gpu.status().activeText).toBe(2);
    const image = gpu.runImage(
      async () =>
        new Promise<void>((resolve) => {
          completeImage = resolve;
        })
    );
    const a2 = call(),
      b2 = call();
    await vi.waitFor(() => expect(gpu.status().waitingText).toBe(2));
    responses[0]!.end('data: [DONE]\n\n');
    await aBody;
    expect(events).toEqual([]);
    expect(responses).toHaveLength(2);
    responses[1]!.end('data: [DONE]\n\n');
    await bBody;
    await vi.waitFor(() => expect(events).toEqual(['image']));
    expect(responses).toHaveLength(2);
    const abort = new AbortController();
    const cancelled = fetch(base + '/v1/models', { signal: abort.signal }).catch(() => undefined);
    await vi.waitFor(() => expect(gpu.status().waitingText).toBe(3));
    abort.abort();
    await cancelled;
    await vi.waitFor(() => expect(gpu.status().waitingText).toBe(2));
    completeImage();
    await image;
    const second = await Promise.all([a2, b2]);
    expect(events).toEqual(['image', 'text']);
    const bodies = second.map((r) => r.text());
    responses.slice(2).forEach((r) => r.end('data: [DONE]\n\n'));
    await Promise.all(bodies);
    await vi.waitFor(() => expect(gpu.status().activeText).toBe(0));
  } finally {
    completeImage();
    gpu.pause();
    responses.forEach((r) => r.end());
    server.closeAllConnections();
    app.server.closeAllConnections();
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    temp.close();
    await gpu.close();
  }
});
