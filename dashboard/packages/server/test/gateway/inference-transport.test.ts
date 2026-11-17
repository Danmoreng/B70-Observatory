import { createServer, type ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import { createInferenceTransport } from '../../src/gateway/inference-transport.js';

it('honors explicit transport limits for delayed headers and idle body, and preserves abort', async () => {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  function later(response: ServerResponse, callback: () => void, delay = 150) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!response.destroyed) callback();
    }, delay);
    timers.add(timer);
  }
  const server = createServer((request, response) => {
    if (request.url === '/slow-headers') later(response, () => response.end('too late'), 2000);
    else if (request.url === '/slow-body') {
      response.write('first ');
      later(response, () => response.end('too late'), 2000);
    } else if (request.url === '/headers') later(response, () => response.end('headers allowed'));
    else if (request.url === '/body') {
      response.write('first ');
      later(response, () => response.end('second'));
    } else {
      response.write('waiting');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture address');
  const base = `http://127.0.0.1:${address.port}`;
  const long = createInferenceTransport(1000, 1000);
  const short = createInferenceTransport(50, 50);
  try {
    expect(await (await long.fetch(base + '/headers')).text()).toBe('headers allowed');
    expect(await (await long.fetch(base + '/body')).text()).toBe('first second');
    await expect(short.fetch(base + '/slow-headers')).rejects.toThrow();
    const expiredBody = await short.fetch(base + '/slow-body');
    await expect(expiredBody.text()).rejects.toThrow();
    const controller = new AbortController();
    const waiting = await long.fetch(base + '/hang', { signal: controller.signal });
    const body = waiting.text();
    controller.abort();
    await expect(body).rejects.toThrow();
  } finally {
    for (const timer of timers) clearTimeout(timer);
    await Promise.all([long.close(), short.close()]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
