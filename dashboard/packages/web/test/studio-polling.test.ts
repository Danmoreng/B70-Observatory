import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  api,
  refresh,
  error,
  pollError,
  connected,
  expansionId,
  startPolling,
  stopPolling,
} from '../src/studio/desk.js';
const bodies: Record<string, unknown> = {
  '/api/studio/api/config': {
    sizes: [{ id: 'landscape-quick', label: 'Quick', ratio: '3:2', width: 1536, height: 1024 }],
    acceptingJobs: true,
    freeGiB: 70,
    promptExpansion: { available: true, maxReferences: 4, model: 'Qwen 27B' },
  },
  '/api/studio/api/jobs': { jobs: [], engine: { online: true, busy: false }, acceptingJobs: true },
  '/api/studio/api/images': { images: [] },
  '/api/studio/api/references': { references: [] },
};
beforeEach(() => {
  vi.useFakeTimers();
  pollError.value = '';
  error.value = '';
  expansionId.value = '';
});
afterEach(() => {
  stopPolling();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('clears a transient poll error after reconnection without erasing action errors', async () => {
  let online = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (!online) throw new TypeError('NetworkError when attempting to fetch resource.');
      return Response.json(bodies[url]);
    })
  );
  const failed = refresh();
  await vi.advanceTimersByTimeAsync(350);
  await failed;
  expect(connected.value).toBe(false);
  expect(pollError.value).toContain('Connection');
  error.value = 'A separate upload failed';
  online = true;
  await refresh();
  expect(connected.value).toBe(true);
  expect(pollError.value).toBe('');
  expect(error.value).toBe('A separate upload failed');
});
it('retries reads once but never retries a mutation with a lost response', async () => {
  const fetcher = vi.fn(async () => {
    throw new TypeError('NetworkError');
  });
  vi.stubGlobal('fetch', fetcher);
  const read = api('/api/images').catch((e) => e);
  await vi.advanceTimersByTimeAsync(350);
  await read;
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockClear();
  await expect(api('/api/jobs', 'POST', {})).rejects.toThrow('Connection');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('cancels polling on navigation without reporting a network failure', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          )
        )
    )
  );
  startPolling();
  stopPolling();
  await vi.advanceTimersByTimeAsync(1000);
  expect(pollError.value).toBe('');
});
