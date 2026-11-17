import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createAppRelay } from '../../src/runner/app-preview.js';

const roots: string[] = [];
const relays: Awaited<ReturnType<typeof createAppRelay>>[] = [];
const clients: Socket[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const relay of relays.splice(0)) relay.close();
  for (const client of clients.splice(0)) client.destroy();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'brelay-'));
  roots.push(root);
  const path = join(root, 'relay.sock');
  const relay = await createAppRelay(path);
  relays.push(relay);
  const connect = async () => {
    const client = createConnection(path);
    clients.push(client);
    await once(client, 'connect');
    return client;
  };
  return { relay, connect };
}

it('queues requests in order until reverse connections arrive', async () => {
  const { relay, connect } = await fixture();
  const first = relay.acquire(new AbortController().signal);
  const second = relay.acquire(new AbortController().signal);
  const client1 = await connect();
  const socket1 = await first;
  const received1 = once(client1, 'data');
  socket1!.write('first');
  expect(String((await received1)[0])).toBe('first');
  const client2 = await connect();
  const socket2 = await second;
  const received2 = once(client2, 'data');
  socket2!.write('second');
  expect(String((await received2)[0])).toBe('second');
});

it('removes cancelled waits without consuming the next connection', async () => {
  const { relay, connect } = await fixture();
  const cancelled = new AbortController();
  const first = relay.acquire(cancelled.signal);
  cancelled.abort();
  expect(await first).toBeUndefined();
  expect(await relay.acquire(cancelled.signal)).toBeUndefined();
  const second = relay.acquire(new AbortController().signal);
  await connect();
  expect((await second)?.destroyed).toBe(false);
});

it('bounds pending requests and releases every wait during shutdown', async () => {
  const { relay } = await fixture();
  const pending = Array.from({ length: 32 }, () => relay.acquire(new AbortController().signal));
  expect(await relay.acquire(new AbortController().signal)).toBeUndefined();
  relay.close();
  relays.splice(relays.indexOf(relay), 1);
  expect(await Promise.all(pending)).toEqual(Array(32).fill(undefined));
  expect(await relay.acquire(new AbortController().signal)).toBeUndefined();
});

it('times out unavailable connections after five seconds', async () => {
  const { relay } = await fixture();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const pending = relay.acquire(new AbortController().signal);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await pending).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});
