import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { useRequests } from '../src/composables/useRequests.js';
import { fetchMetricHistory, fetchRequestDetail } from '../src/lib/api.js';
import type { RequestSummary } from '@observatory/contracts';

const firstId = 'a0000000-0000-4000-8000-000000000001';
const secondId = 'a0000000-0000-4000-8000-000000000002';
const item = (id = firstId): RequestSummary => ({
  id,
  origin: 'script',
  model: 'Qwen3.8-27B',
  endpoint: '/v1/chat/completions',
  method: 'POST',
  status: 'completed',
  startedAtUtc: new Date().toISOString(),
  promptBytes: 0,
  responseBytes: 0,
});
const response = (data: unknown) => new Response(JSON.stringify(data));
const mounted: Array<() => void> = [];
afterEach(() => {
  mounted.splice(0).forEach((stop) => stop());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup() {
  const revision = ref(0);
  const minutes = ref(15);
  const enabled = ref(true);
  const onError = vi.fn();
  let state!: ReturnType<typeof useRequests>;
  const wrapper = mount(
    defineComponent({
      setup() {
        state = useRequests(enabled, minutes, revision, onError);
        return () => null;
      },
    })
  );
  mounted.push(() => wrapper.unmount());
  return { state, revision, minutes, enabled, onError };
}

describe('request browsing', () => {
  it('freezes pagination bounds and offers refresh instead of replacing loaded pages', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ items: [item()], nextCursor: 'cursor-1' }))
      .mockResolvedValueOnce(response({ items: [item(secondId)], nextCursor: null }));
    const { state, revision } = setup();
    await flushPromises();
    await state.load(true);
    const first = new URL(String(fetch.mock.calls[0]![0]), 'http://localhost');
    const second = new URL(String(fetch.mock.calls[1]![0]), 'http://localhost');
    expect(second.searchParams.get('from')).toBe(first.searchParams.get('from'));
    expect(second.searchParams.get('to')).toBe(first.searchParams.get('to'));
    expect(second.searchParams.get('cursor')).toBe('cursor-1');
    revision.value++;
    await flushPromises();
    expect(state.changed.value).toBe(true);
    expect(state.items.value.map((item) => item.id)).toEqual([firstId, secondId]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not reset page two when invalidation arrives during pagination', async () => {
    let resolvePage!: (response: Response) => void;
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ items: [item()], nextCursor: 'cursor-1' }))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePage = resolve;
          })
      );
    const { state, revision } = setup();
    await flushPromises();
    const paging = state.load(true);
    revision.value++;
    await flushPromises();
    resolvePage(response({ items: [item(secondId)], nextCursor: null }));
    await paging;
    await flushPromises();
    expect(state.changed.value).toBe(true);
    expect(state.items.value).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects a late response after the filter selection changed', async () => {
    let resolveOld!: (response: Response) => void;
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          })
      )
      .mockResolvedValueOnce(response({ items: [item(secondId)], nextCursor: null }));
    const { state } = setup();
    state.filters.value.model = 'Qwen3.8-27B';
    await state.load();
    expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    resolveOld(response({ items: [item()], nextCursor: null }));
    await flushPromises();
    expect(state.items.value.map((item) => item.id)).toEqual([secondId]);
  });

  it('refreshes first-page data on events, with no interval polling', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => response({ items: [], nextCursor: null }));
    const { revision } = setup();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    revision.value++;
    await flushPromises();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reports expired sessions and keeps detail errors separate from list data', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ items: [item()], nextCursor: null }))
      .mockResolvedValueOnce(new Response('', { status: 401 }));
    const { state, onError } = setup();
    await flushPromises();
    await state.select(firstId);
    expect(state.items.value).toHaveLength(1);
    expect(state.detail.value).toBeNull();
    expect(state.detailError.value).toContain('session');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
  });

  it('validates response identity, schema, and history selection at the API boundary', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ ...item(secondId), events: [] }));
    await expect(fetchRequestDetail(firstId)).rejects.toMatchObject({ code: 'invalid_payload' });
    const query = {
      series: 'gpu.utilization-percent',
      from: '2025-01-01T00:00:00.000Z',
      to: '2025-01-01T01:00:00.000Z',
      bucketSeconds: 60,
    };
    fetch.mockResolvedValueOnce(
      response({
        series: 'system.cpu-utilization-percent',
        unit: 'percent',
        bucketSeconds: 60,
        buckets: [],
      })
    );
    await expect(fetchMetricHistory(query)).rejects.toMatchObject({ code: 'invalid_payload' });
    fetch.mockResolvedValueOnce(new Response('invalid json'));
    await expect(fetchMetricHistory(query)).rejects.toMatchObject({ code: 'invalid_payload' });
  });
});
