import { describe, expect, it, vi } from 'vitest';
import type { AgentLiveChanges } from '@observatory/contracts';
import { LiveChangesCache } from '../../src/runner/live-changes-cache.js';

const taskId = '10000000-0000-4000-8000-000000000001';
const runId = '20000000-0000-4000-8000-000000000001';
const sample: AgentLiveChanges = {
  taskId,
  runId,
  capturedAt: '2026-10-29T18:00:00.000Z',
  status: 'live',
  stale: false,
  truncated: false,
  files: [{ path: 'app.ts', status: 'modified' }],
  diff: '+change',
};

describe('on-demand live changes cache', () => {
  it('bypasses cached values on explicit refresh but still shares an inflight capture', async () => {
    const cache = new LiveChangesCache(() => 100);
    await cache.get(taskId, runId, async () => sample);
    let finish!: (value: AgentLiveChanges) => void;
    const capture = vi.fn(
      () =>
        new Promise<AgentLiveChanges>((resolve) => {
          finish = resolve;
        })
    );
    const first = cache.get(taskId, runId, capture, '', true);
    const second = cache.get(taskId, runId, capture, '', true);
    await Promise.resolve();
    expect(capture).toHaveBeenCalledTimes(1);
    finish({ ...sample, diff: '+manual' });
    expect((await first).diff).toBe('+manual');
    expect((await second).diff).toBe('+manual');
  });
  it('shares inflight work and caches success for three seconds', async () => {
    let now = 0;
    const cache = new LiveChangesCache(() => now);
    let finish!: (value: AgentLiveChanges) => void;
    const capture = vi.fn(
      () =>
        new Promise<AgentLiveChanges>((resolve) => {
          finish = resolve;
        })
    );
    const first = cache.get(taskId, runId, capture);
    const second = cache.get(taskId, runId, capture);
    await Promise.resolve();
    expect(capture).toHaveBeenCalledTimes(1);
    finish(sample);
    expect(await first).toEqual(sample);
    expect(await second).toEqual(sample);
    now = 2999;
    expect(await cache.get(taskId, runId, capture)).toEqual(sample);
    expect(capture).toHaveBeenCalledTimes(1);
    now = 3000;
    const fresh = vi.fn(async () => ({ ...sample, diff: '+fresh' }));
    expect((await cache.get(taskId, runId, fresh)).diff).toBe('+fresh');
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it('preserves last capture and timestamp on failure and limits retries', async () => {
    let now = 0;
    const cache = new LiveChangesCache(() => now);
    await cache.get(taskId, runId, async () => sample);
    now = 3000;
    const capture = vi.fn(async (): Promise<AgentLiveChanges> => {
      throw new Error('SECRET PATH');
    });
    const result = await cache.get(taskId, runId, capture);
    expect(result).toMatchObject({ diff: '+change', capturedAt: sample.capturedAt, stale: true });
    expect(JSON.stringify(result)).not.toContain('SECRET PATH');
    await cache.get(taskId, runId, capture);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('limits concurrent captures across different runs without mixing data', async () => {
    const cache = new LiveChangesCache();
    let finish!: (value: AgentLiveChanges) => void;
    const pending = cache.get(
      taskId,
      runId,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await Promise.resolve();
    const other = await cache.get(taskId, '20000000-0000-4000-8000-000000000002', async () => {
      throw new Error('must not start');
    });
    expect(other).toMatchObject({ status: 'unavailable', stale: true, files: [], diff: '' });
    expect(other.runId).not.toBe(runId);
    finish(sample);
    await pending;
  });
});
