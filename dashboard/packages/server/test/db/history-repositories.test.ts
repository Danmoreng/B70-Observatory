import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { newTempDb, daysAgoIso } from '../helpers.js';
import { MetricRepository } from '../../src/db/metrics.js';
import { RequestRepository } from '../../src/db/requests.js';
import { CursorError, decodeCursor, encodeCursor } from '../../src/history/cursor.js';

let temp: { db: DatabaseSync; close: () => void };
let requests: RequestRepository;
let metrics: MetricRepository;

const NOW = Date.parse('2025-06-15T12:00:00.000Z');

/** Deterministic, lexicographically ordered UUIDs (all valid UUIDs). */
function uuidAt(index: number): string {
  return `f0000000-0000-4000-8000-${(10000000 + index).toString(16).padStart(12, '0')}`;
}

function seedRequest(
  index: number,
  atUtc: string,
  status: 'in_progress' | 'completed' | 'error' = 'completed',
  model: string | null = 'Qwen3.8-27B'
): string {
  const id = uuidAt(index);
  requests.create({
    id,
    endpoint: '/v1/chat/completions',
    startedAtUtc: atUtc,
    model: model ?? undefined,
  });
  if (status !== 'in_progress') {
    requests.finish({
      requestId: id,
      status,
      completedAtUtc: atUtc,
      durationMs: 10,
      responseBytes: 1,
    });
  }
  return id;
}

beforeEach(() => {
  temp = newTempDb();
  requests = new RequestRepository(temp.db);
  metrics = new MetricRepository(temp.db);
});

afterEach(() => {
  temp.close();
});

describe('RequestRepository.listPage (M5A keyset pagination)', () => {
  it('orders newest first, tie-breaking equal timestamps by id DESC', () => {
    // All three share the same millisecond; order must come from the id.
    const low = seedRequest(1, '2025-06-15T12:00:00.000Z');
    const high = seedRequest(5, '2025-06-15T12:00:00.000Z');
    const mid = seedRequest(3, '2025-06-15T12:00:00.000Z');
    const older = seedRequest(9, daysAgoIso(NOW, 1));

    const page = requests.listPage({ limit: 10 });
    expect(page.items.map((row) => row.id)).toEqual([high, mid, low, older]);
    expect(page.hasMore).toBe(false);
  });

  it('reports hasMore only when a (limit+1)-th row exists', () => {
    for (let index = 0; index < 5; index += 1) {
      seedRequest(index, new Date(NOW - (5 - index) * 100000).toISOString());
    }
    expect(requests.listPage({ limit: 5 }).hasMore).toBe(false);
    expect(requests.listPage({ limit: 4 }).hasMore).toBe(true);
    expect(requests.listPage({ limit: 4 }).items).toHaveLength(4);
  });

  it('walks pages without duplicates or gaps across equal timestamps', () => {
    const all = new Array(10);
    for (let index = 0; index < all.length; index += 1) {
      all[index] = seedRequest(index, '2025-06-15T12:00:00.000Z');
    }
    // Expected order: newest ts (all equal) then id DESC.
    const expected = [...all].sort((a, b) => (a < b ? 1 : -1));

    const page1 = requests.listPage({ limit: 4 });
    expect(page1.items.map((row) => row.id)).toEqual(expected.slice(0, 4));
    expect(page1.hasMore).toBe(true);
    const last1 = page1.items[page1.items.length - 1];
    if (last1 === undefined) throw new Error('page1 empty');

    const page2 = requests.listPage({
      limit: 4,
      cursor: { startedAtUtc: last1.startedAtUtc, requestId: last1.id },
    });
    expect(page2.items.map((row) => row.id)).toEqual(expected.slice(4, 8));
    expect(page2.hasMore).toBe(true);
    const last2 = page2.items[page2.items.length - 1];
    if (last2 === undefined) throw new Error('page2 empty');

    const page3 = requests.listPage({
      limit: 4,
      cursor: { startedAtUtc: last2.startedAtUtc, requestId: last2.id },
    });
    expect(page3.items.map((row) => row.id)).toEqual(expected.slice(8, 10));
    expect(page3.hasMore).toBe(false);

    const seen = [...page1.items, ...page2.items, ...page3.items].map((row) => row.id);
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
    expect(seen).toEqual(expected); // no gaps, stable order
  });

  it('reflects requests inserted between pages (after the cursor, no re-delivery before it)', () => {
    const sameTs = '2025-06-01T08:00:00.000Z';
    const base = new Array(4);
    for (let index = 0; index < base.length; index += 1) {
      base[index] = seedRequest(index, sameTs);
    }
    const page1 = requests.listPage({ limit: 2 });
    const last1 = page1.items[page1.items.length - 1];
    if (last1 === undefined) throw new Error('page1 empty');

    // Inserted while paging: one sorts AFTER the cursor (id below it)…
    const afterCursor = seedRequest(-100, sameTs);
    // …and one sorts BEFORE the cursor (id above it, i.e. inside page 1).
    const beforeCursor = seedRequest(100, sameTs);

    const page2 = requests.listPage({
      limit: 3,
      cursor: { startedAtUtc: last1.startedAtUtc, requestId: last1.id },
    });
    const page2Ids = page2.items.map((row) => row.id);
    expect(page2Ids).toContain(afterCursor);
    // Keyset semantics: a row that "should have been" in page 1 is not
    // re-delivered (no duplicates); that trade-off is documented in M5A.
    expect(page2Ids).not.toContain(beforeCursor);
    const union = [...page1.items, ...page2.items].map((row) => row.id);
    expect(new Set(union).size).toBe(union.length);
  });

  it('applies id/status/model/time filters to the page, inclusive at both bounds', () => {
    const before = seedRequest(0, '2025-06-01T00:00:00.000Z', 'completed');
    const atFrom = seedRequest(1, '2025-06-01T01:00:00.000Z', 'completed');
    const inside = seedRequest(2, '2025-06-01T12:00:00.000Z', 'error');
    const atTo = seedRequest(3, '2025-06-01T23:00:00.000Z', 'completed');
    const after = seedRequest(4, '2025-06-02T00:00:00.000Z', 'completed', 'other-model');

    const window = requests.listPage({
      limit: 10,
      fromUtc: '2025-06-01T01:00:00.000Z',
      toUtc: '2025-06-01T23:00:00.000Z',
    });
    expect(window.items.map((row) => row.id)).toContain(atFrom);
    expect(window.items.map((row) => row.id)).toContain(atTo);
    expect(window.items.map((row) => row.id)).not.toContain(before);
    expect(window.items.map((row) => row.id)).not.toContain(after);

    const completed = requests.listPage({ limit: 10, status: 'completed' });
    expect(completed.items.every((row) => row.status === 'completed')).toBe(true);
    expect(completed.items.map((row) => row.id)).not.toContain(inside);

    const byModel = requests.listPage({ limit: 10, model: 'other-model' });
    expect(byModel.items.map((row) => row.id)).toEqual([after]);

    const byId = requests.listPage({ limit: 10, id: inside });
    expect(byId.items.map((row) => row.id)).toEqual([inside]);
    expect(byId.hasMore).toBe(false);
  });

  it('rejects a cursor minted for a different filter set (binding is checked at decode)', () => {
    seedRequest(1, '2025-06-01T10:00:00.000Z', 'completed');
    const errorId = seedRequest(2, '2025-06-01T10:00:00.000Z', 'error');
    const foreignCursor = encodeCursor(
      { startedAtUtc: '2025-06-01T10:00:00.000Z', requestId: errorId },
      { status: 'error' }
    );
    // The cursor was minted for `status=error`; using it for a different
    // filter set must fail instead of mixing two result sets.
    expect(() => decodeCursor(foreignCursor, { status: 'completed' })).toThrowError(CursorError);
    // …against its own filter set the same cursor decodes cleanly.
    expect(decodeCursor(foreignCursor, { status: 'error' }).requestId).toBe(errorId);

    // A cursor minted for the filtered page round-trips with that filter.
    const page = requests.listPage({ status: 'completed', limit: 2 });
    const first = page.items[0];
    if (first === undefined) throw new Error('empty page');
    const ownCursor = encodeCursor(
      { startedAtUtc: first.startedAtUtc, requestId: first.id },
      { status: 'completed' }
    );
    const decoded = decodeCursor(ownCursor, { status: 'completed' });
    expect(decoded.requestId).toBe(first.id);
  });
});

describe('MetricRepository.aggregateHistory (M5A)', () => {
  const t = (offsetSeconds: number, ms = 0): string =>
    new Date(1748740800000 + offsetSeconds * 1000 + ms).toISOString();

  function seedSeries(
    source: 'vllm' | 'gpu' | 'system',
    name: string,
    values: Array<[number, number]>,
    labels?: Record<string, string>
  ): void {
    metrics.insertMany(
      values.map(([offsetSeconds, value]) => ({
        source: source as 'vllm',
        name,
        value,
        unit: 'count',
        atUtc: t(offsetSeconds),
        ...(labels !== undefined ? { labels } : {}),
      }))
    );
  }

  it('computes min/max/avg/count per epoch-aligned bucket in chronological order', () => {
    // Bucket 1748740800 (BASE) gets 1/5/7, bucket +60 gets 100.
    seedSeries('vllm', 'vllm.requests_running', [
      [0, 5],
      [30, 7],
      [59_500 / 1000, 1],
      [60, 100],
    ]);
    const buckets = metrics.aggregateHistory({
      source: 'vllm',
      name: 'vllm.requests_running',
      fromUtc: t(0),
      toUtc: t(3_600),
      bucketSeconds: 60,
    });
    expect(buckets).toEqual([
      {
        atUtc: new Date(1748740800000).toISOString(),
        min: 1,
        max: 7,
        avg: 13 / 3,
        count: 3,
      },
      {
        atUtc: new Date(1748740860000).toISOString(),
        min: 100,
        max: 100,
        avg: 100,
        count: 1,
      },
    ]);
  });

  it('aligns buckets to the epoch and includes both window bounds', () => {
    // 12:00:59.0Z and 12:00:59.5Z both belong to the base bucket
    // (whole-second truncation), +60s to the next bucket.
    seedSeries('vllm', 'vllm.requests_running', [
      [59, 1],
      [59.5, 2],
      [60, 3],
    ]);
    // First sample sits exactly at `from`, the last exactly at `to`.
    const buckets = metrics.aggregateHistory({
      source: 'vllm',
      name: 'vllm.requests_running',
      fromUtc: t(59),
      toUtc: t(60),
      bucketSeconds: 60,
    });
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({ atUtc: t(0), count: 2, min: 1, max: 2 });
    expect(buckets[1]).toMatchObject({ atUtc: t(60), count: 1 });
  });

  it('aggregates only the requested label set when the series carries labels', () => {
    seedSeries('gpu', 'gpu.utilization_percent', [[0, 10]], { device: 'a' });
    seedSeries('gpu', 'gpu.utilization_percent', [[0, 90]], { device: 'b' });
    metrics.insertMany([
      { source: 'gpu', name: 'gpu.utilization_percent', value: 55, unit: 'percent', atUtc: t(0) },
    ]);
    const forDeviceA = metrics.aggregateHistory({
      source: 'gpu',
      name: 'gpu.utilization_percent',
      labelKey: JSON.stringify({ device: 'a' }),
      fromUtc: t(0),
      toUtc: t(600),
      bucketSeconds: 60,
    });
    expect(forDeviceA).toHaveLength(1);
    expect(forDeviceA[0]).toMatchObject({ min: 10, max: 10, count: 1 });
    const labelless = metrics.aggregateHistory({
      source: 'gpu',
      name: 'gpu.utilization_percent',
      labelKey: '',
      fromUtc: t(0),
      toUtc: t(600),
      bucketSeconds: 60,
    });
    expect(labelless[0]).toMatchObject({ min: 55, max: 55 });
  });

  it('returns an empty list for an empty window and rejects contract violations', () => {
    seedSeries('vllm', 'vllm.requests_running', [[0, 1]]);
    expect(
      metrics.aggregateHistory({
        source: 'vllm',
        name: 'vllm.requests_running',
        fromUtc: t(10_000),
        toUtc: t(20_000),
        bucketSeconds: 60,
      })
    ).toEqual([]);
    expect(() =>
      metrics.aggregateHistory({
        source: 'nginx' as never,
        name: 'vllm.requests_running',
        fromUtc: t(0),
        toUtc: t(60),
        bucketSeconds: 60,
      })
    ).toThrow();
    expect(() =>
      metrics.aggregateHistory({
        source: 'vllm',
        name: 'vllm.requests_running',
        fromUtc: '2025-06-01T12:00:00Z' as never, // non-canonical
        toUtc: t(60),
        bucketSeconds: 60,
      })
    ).toThrow();
    expect(() =>
      metrics.aggregateHistory({
        source: 'vllm',
        name: 'vllm.requests_running',
        fromUtc: t(0),
        toUtc: t(60),
        bucketSeconds: 0,
      })
    ).toThrow();
  });
});
