import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { newTempDb, newRequestId, daysAgoIso } from '../helpers.js';
import { DbContractError } from '../../src/db/errors.js';
import { pruneOlderThan, retentionCutoffUtc } from '../../src/db/retention.js';
import { RequestRepository } from '../../src/db/requests.js';
import { MetricRepository } from '../../src/db/metrics.js';
import { ServiceEventRepository } from '../../src/db/service-events.js';

const NOW = Date.parse('2025-06-15T12:00:00.000Z');

let temp: { db: DatabaseSync; close: () => void };
let requests: RequestRepository;
let metrics: MetricRepository;
let serviceEvents: ServiceEventRepository;

beforeEach(() => {
  temp = newTempDb();
  requests = new RequestRepository(temp.db);
  metrics = new MetricRepository(temp.db);
  serviceEvents = new ServiceEventRepository(temp.db);
});

afterEach(() => {
  temp.close();
});

describe('retentionCutoffUtc', () => {
  it('subtracts whole days from the given instant', () => {
    expect(retentionCutoffUtc(30, new Date(NOW))).toBe(daysAgoIso(NOW, 30));
    expect(retentionCutoffUtc(1, new Date(NOW))).toBe(daysAgoIso(NOW, 1));
  });

  it('rejects fractional or non-positive horizons', () => {
    expect(() => retentionCutoffUtc(0, new Date(NOW))).toThrowError(DbContractError);
    expect(() => retentionCutoffUtc(-3, new Date(NOW))).toThrowError(DbContractError);
    expect(() => retentionCutoffUtc(1.5, new Date(NOW))).toThrowError(DbContractError);
  });
});

describe('pruneOlderThan', () => {
  const seed = () => {
    const oldRequest = newRequestId();
    const boundaryRequest = newRequestId();
    const recentRequest = newRequestId();

    requests.create({ id: oldRequest, endpoint: '/a', startedAtUtc: daysAgoIso(NOW, 40) });
    requests.appendEvent({
      requestId: oldRequest,
      eventType: 'start',
      atUtc: daysAgoIso(NOW, 40),
    });
    requests.create({ id: boundaryRequest, endpoint: '/b', startedAtUtc: daysAgoIso(NOW, 30) });
    // A surviving request may still carry an event older than the cutoff.
    requests.appendEvent({
      requestId: boundaryRequest,
      eventType: 'start',
      atUtc: daysAgoIso(NOW, 45),
    });
    requests.create({ id: recentRequest, endpoint: '/c', startedAtUtc: daysAgoIso(NOW, 1) });
    requests.appendEvent({
      requestId: recentRequest,
      eventType: 'start',
      atUtc: daysAgoIso(NOW, 1),
    });

    metrics.insert({
      source: 'gpu',
      name: 'gpu.utilization',
      value: 10,
      unit: 'percent',
      atUtc: daysAgoIso(NOW, 40),
    });
    metrics.insert({
      source: 'gpu',
      name: 'gpu.utilization',
      value: 90,
      unit: 'percent',
      atUtc: daysAgoIso(NOW, 1),
    });

    serviceEvents.insert({
      service: 'api',
      severity: 'error',
      type: 'crash',
      atUtc: daysAgoIso(NOW, 40),
    });
    serviceEvents.insert({
      service: 'api',
      severity: 'info',
      type: 'started',
      atUtc: daysAgoIso(NOW, 1),
    });

    return { oldRequest, boundaryRequest, recentRequest };
  };

  it('prunes strictly older rows, keeps the boundary, and reports exact counts', () => {
    const { oldRequest, boundaryRequest, recentRequest } = seed();
    const cutoff = daysAgoIso(NOW, 30);

    const counts = pruneOlderThan(temp.db, cutoff);

    expect(counts).toEqual({
      requests: 1,
      requestEvents: 2, // old event with old parent + old event on surviving parent
      metricSamples: 1,
      serviceEvents: 1,
    });
    expect(requests.get(oldRequest)).toBeUndefined();
    // Exactly at the cutoff: kept.
    expect(requests.get(boundaryRequest)?.status).toBeDefined();
    expect(requests.get(recentRequest)?.status).toBeDefined();
    // The old event on the surviving request is gone, its recent one stays.
    expect(requests.listEvents(boundaryRequest)).toHaveLength(0);
    expect(requests.listEvents(recentRequest)).toHaveLength(1);
    expect(metrics.count()).toBe(1);
    expect(serviceEvents.count()).toBe(1);
  });

  it('removes everything when the cutoff is far in the future', () => {
    seed();
    const counts = pruneOlderThan(temp.db, new Date(NOW).toISOString());
    expect(counts.requests).toBe(3);
    expect(counts.requestEvents).toBe(3);
    expect(counts.metricSamples).toBe(2);
    expect(counts.serviceEvents).toBe(2);
    expect(requests.count()).toBe(0);
    expect(requests.countEvents()).toBe(0);
  });

  it('rejects non-UTC cutoffs and invalid dates', () => {
    seed();
    expect(() => pruneOlderThan(temp.db, '2025-05-16T14:00:00+02:00')).toThrowError(
      DbContractError
    );
    expect(() => pruneOlderThan(temp.db, 'yesterday')).toThrowError(DbContractError);
    // Nothing was deleted.
    expect(requests.count()).toBe(3);
  });

  it('prunes at millisecond granularity: a .000Z row is older than a .500Z cutoff', () => {
    // Review finding 1: canonical `.sssZ` timestamps must compare
    // lexicographically at sub-second precision. A row exactly at 30 days
    // (`...T12:00:00.000Z`) is strictly older than the cutoff 500 ms later
    // (`...T12:00:00.500Z`) and must be pruned.
    const id = newRequestId();
    const boundary = daysAgoIso(NOW, 30); // ends in .000Z
    const cutoff = new Date(NOW - 30 * 86_400_000 + 500).toISOString(); // .500Z
    expect(cutoff.endsWith('.500Z')).toBe(true);
    requests.create({ id, endpoint: '/ms', startedAtUtc: boundary });

    const counts = pruneOlderThan(temp.db, cutoff);
    expect(counts.requests).toBe(1);
    expect(requests.get(id)).toBeUndefined();
  });

  it('rejects non-canonical cutoffs (other precision, normalized invalid dates)', () => {
    seed();
    // Different precision than the exact toISOString() form: rejected.
    expect(() => pruneOlderThan(temp.db, '2025-05-16T12:00:00Z')).toThrowError(DbContractError);
    expect(() => pruneOlderThan(temp.db, '2025-05-16T12:00:00.5Z')).toThrowError(DbContractError);
    // Calendar-invalid dates that the engine would normalize: rejected.
    expect(() => pruneOlderThan(temp.db, '2025-02-29T12:00:00.000Z')).toThrowError(DbContractError);
    expect(() => pruneOlderThan(temp.db, '2025-04-31T12:00:00.000Z')).toThrowError(DbContractError);
    expect(() => pruneOlderThan(temp.db, '2025-05-01T24:00:00.000Z')).toThrowError(DbContractError);
    // Nothing was deleted by any rejected cutoff.
    expect(requests.count()).toBe(3);
  });
});
