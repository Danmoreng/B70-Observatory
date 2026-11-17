import { describe, expect, it, vi } from 'vitest';
import { HistoryChangeSchema } from '@observatory/contracts';
import { buildApp } from '../../src/app.js';
import { loadServerConfig } from '../../src/config.js';
import { MetricRepository } from '../../src/db/metrics.js';
import { RequestRepository } from '../../src/db/requests.js';
import { newTempDb, newRequestId } from '../helpers.js';

describe('history invalidation', () => {
  it('notifies only after successful commits and isolates failed observers', () => {
    const temp = newTempDb();
    try {
      const metrics = new MetricRepository(temp.db);
      const observe = vi.fn();
      metrics.changes.subscribe(() => {
        throw new Error('broken observer');
      });
      const stop = metrics.changes.subscribe(observe);
      const sample = {
        source: 'gpu',
        name: 'temperature',
        value: 50,
        unit: 'celsius',
        atUtc: new Date().toISOString(),
      };
      metrics.insertMany([sample]);
      expect(observe).toHaveBeenCalledTimes(1);
      expect(() => metrics.insertMany([{ ...sample, name: 'new' }, sample])).toThrow();
      expect(metrics.query()).toHaveLength(1);
      expect(observe).toHaveBeenCalledTimes(1);
      stop();
      metrics.insert({ ...sample, name: 'new' });
      expect(observe).toHaveBeenCalledTimes(1);
    } finally {
      temp.close();
    }
  });

  it('coalesces repository writes into a validated SSE frame without request contents', async () => {
    const temp = newTempDb();
    const requests = new RequestRepository(temp.db);
    const metrics = new MetricRepository(temp.db);
    const app = buildApp({
      version: 'test',
      config: loadServerConfig({}),
      loggerLevel: 'silent',
      database: temp.db,
      history: { requests, metrics },
    });
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 3000);
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const response = await fetch(address + '/api/events', { signal: abort.signal });
      const reader = response.body!.getReader();
      await reader.read(); // Initial health frame means subscriptions are installed.
      const atUtc = new Date().toISOString();
      const id = newRequestId();
      requests.create({
        id,
        endpoint: '/v1/chat/completions',
        startedAtUtc: atUtc,
        promptBytes: 0,
      });
      requests.appendEvent({ requestId: id, eventType: 'start', atUtc });
      metrics.insert({ source: 'gpu', name: 'temperature', value: 50, unit: 'celsius', atUtc });
      let frame = '';
      const decoder = new TextDecoder();
      while (!frame.includes('event: history') || !frame.endsWith('\n\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('Stream ended before invalidation');
        frame += decoder.decode(chunk.value, { stream: true });
      }
      const data = frame.slice(frame.indexOf('event: history')).split('\n')[1]!.slice(6);
      const payload = HistoryChangeSchema.parse(JSON.parse(data));
      expect(payload.resources.sort()).toEqual(['metrics', 'requests']);
      expect(frame).not.toContain(id);
      await reader.cancel();
    } finally {
      clearTimeout(timeout);
      abort.abort();
      await app.close();
      temp.close();
    }
  });
});
