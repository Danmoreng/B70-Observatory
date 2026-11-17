import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { newTempDb, newRequestId, daysAgoIso } from '../helpers.js';
import { DatabaseError, DbContractError } from '../../src/db/errors.js';
import { MetricRepository } from '../../src/db/metrics.js';
import { RequestRepository, type StoredRequest } from '../../src/db/requests.js';
import { ServiceEventRepository } from '../../src/db/service-events.js';

let temp: { db: DatabaseSync; close: () => void };
let requests: RequestRepository;
let metrics: MetricRepository;
let serviceEvents: ServiceEventRepository;

const NOW = Date.parse('2025-06-15T12:00:00.000Z');

beforeEach(() => {
  temp = newTempDb();
  requests = new RequestRepository(temp.db);
  metrics = new MetricRepository(temp.db);
  serviceEvents = new ServiceEventRepository(temp.db);
});

afterEach(() => {
  temp.close();
});

describe('RequestRepository', () => {
  it('creates a request in in_progress state with responseBytes still 0', () => {
    const id = newRequestId();
    requests.create({
      id,
      origin: 'web',
      model: 'Qwen3.8-27B',
      endpoint: '/v1/chat/completions',
      method: 'POST',
      startedAtUtc: daysAgoIso(NOW, 0),
      promptBytes: 1234,
    });

    const stored = requests.get(id);
    expect(stored).toMatchObject({
      id,
      origin: 'web',
      model: 'Qwen3.8-27B',
      endpoint: '/v1/chat/completions',
      method: 'POST',
      status: 'in_progress',
      promptBytes: 1234,
      // Streaming: the response size is not known yet → stays at 0.
      responseBytes: 0,
      httpStatus: null,
      durationMs: null,
    });
  });

  it('rejects responseBytes on create (only known at finish)', () => {
    expect(() =>
      requests.create({
        id: newRequestId(),
        endpoint: '/v1/chat/completions',
        startedAtUtc: daysAgoIso(NOW, 0),
        responseBytes: 5678, // unknown at creation time → contract violation
      })
    ).toThrowError(DbContractError);
    expect(requests.count()).toBe(0);
  });

  it('rejects contract violations before anything reaches SQLite', () => {
    const bad: Array<Record<string, unknown>> = [
      {
        // unknown top-level field (raw content smuggled in)
        id: newRequestId(),
        prompt: 'must never be stored',
        endpoint: '/v1/chat/completions',
        startedAtUtc: daysAgoIso(NOW, 0),
      },
      {
        // query strings may carry secrets and are forbidden in stored paths
        id: newRequestId(),
        endpoint: '/v1/chat/completions?api_key=sk-SECRET',
        startedAtUtc: daysAgoIso(NOW, 0),
      },
      {
        id: newRequestId(),
        endpoint: '/v1/chat/completions',
        startedAtUtc: '2025-06-15T14:00:00.000+02:00', // offset, not UTC
      },
      {
        id: newRequestId(),
        endpoint: '/v1/chat/completions',
        startedAtUtc: daysAgoIso(NOW, 0),
        promptBytes: -1,
      },
      {
        id: 'not-a-uuid',
        endpoint: '/v1/chat/completions',
        startedAtUtc: daysAgoIso(NOW, 0),
      },
    ];
    for (const input of bad) {
      expect(() => requests.create(input)).toThrowError(DbContractError);
    }
    expect(requests.count()).toBe(0);
  });

  it('tracks responseBytes streaming-style: 0 at create, actual size at finish', () => {
    const id = newRequestId();
    requests.create({ id, endpoint: '/v1/chat/completions', startedAtUtc: daysAgoIso(NOW, 0) });
    expect(requests.get(id)?.responseBytes).toBe(0);

    requests.finish({
      requestId: id,
      status: 'completed',
      completedAtUtc: daysAgoIso(NOW, 0),
      durationMs: 4321,
      responseBytes: 5678,
    });
    expect(requests.get(id)?.responseBytes).toBe(5678);

    // Negative size is a contract violation…
    const other = newRequestId();
    requests.create({ id: other, endpoint: '/x', startedAtUtc: daysAgoIso(NOW, 0) });
    expect(() =>
      requests.finish({
        requestId: other,
        status: 'completed',
        completedAtUtc: daysAgoIso(NOW, 0),
        durationMs: 10,
        responseBytes: -1,
      })
    ).toThrowError(DbContractError);
    // …and the field is now mandatory at finish.
    expect(() =>
      requests.finish({
        requestId: other,
        status: 'completed',
        completedAtUtc: daysAgoIso(NOW, 0),
        durationMs: 10,
      })
    ).toThrowError(DbContractError);
    expect(requests.get(other)?.status).toBe('in_progress');
  });

  it('assigns monotonically increasing event sequences', () => {
    const id = newRequestId();
    requests.create({
      id,
      endpoint: '/v1/chat/completions',
      startedAtUtc: daysAgoIso(NOW, 0),
    });
    const first = requests.appendEvent({
      requestId: id,
      eventType: 'start',
      atUtc: daysAgoIso(NOW, 0),
    });
    const second = requests.appendEvent({
      requestId: id,
      eventType: 'first_token',
      atUtc: daysAgoIso(NOW, 0),
    });

    expect(first).toBe(1);
    expect(second).toBe(2);
    const events = requests.listEvents(id);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events.map((event) => event.eventType)).toEqual(['start', 'first_token']);
  });

  it('rejects events for unknown requests', () => {
    expect(() =>
      requests.appendEvent({
        requestId: newRequestId(),
        eventType: 'start',
        atUtc: daysAgoIso(NOW, 0),
      })
    ).toThrowError(DatabaseError);
    try {
      requests.appendEvent({
        requestId: newRequestId(),
        eventType: 'start',
        atUtc: daysAgoIso(NOW, 0),
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as DatabaseError).code).toBe('unknown_request');
    }
  });

  it('rejects event input that violates the contract (bad type, bad timestamp)', () => {
    const id = newRequestId();
    requests.create({ id, endpoint: '/x', startedAtUtc: daysAgoIso(NOW, 0) });
    expect(() =>
      requests.appendEvent({ requestId: id, eventType: 'prompt_leak', atUtc: daysAgoIso(NOW, 0) })
    ).toThrowError(DbContractError);
    expect(() =>
      requests.appendEvent({
        requestId: id,
        eventType: 'start',
        atUtc: '2025-06-15T14:00:00.000+02:00',
      })
    ).toThrowError(DbContractError);
  });

  it('finishes a request with full and partial results', () => {
    const fullId = newRequestId();
    const partialId = newRequestId();
    requests.create({
      id: fullId,
      endpoint: '/v1/chat/completions',
      startedAtUtc: daysAgoIso(NOW, 0),
    });
    requests.create({
      id: partialId,
      endpoint: '/v1/chat/completions',
      startedAtUtc: daysAgoIso(NOW, 0),
    });

    requests.finish({
      requestId: fullId,
      status: 'completed',
      completedAtUtc: daysAgoIso(NOW, 0),
      durationMs: 4321,
      responseBytes: 5678,
      ttftMs: 320,
      httpStatus: 200,
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      prefixCacheQueries: 10,
      prefixCacheHits: 6,
      mtpDraftTokens: 40,
      mtpAcceptedTokens: 25,
    });
    requests.finish({
      requestId: partialId,
      status: 'error',
      completedAtUtc: daysAgoIso(NOW, 0),
      durationMs: 1000,
      responseBytes: 128,
      httpStatus: 502,
      // errorCode is the machine-readable part; free-text messages are
      // deliberately not writable anymore (review finding 4).
      errorCode: 'upstream_error',
    });

    const full = requests.get(fullId) as StoredRequest;
    expect(full.status).toBe('completed');
    expect(full.totalTokens).toBe(150);
    expect(full.prefixCacheHits).toBe(6);
    expect(full.mtpAcceptedTokens).toBe(25);
    expect(full.responseBytes).toBe(5678);

    const partial = requests.get(partialId) as StoredRequest;
    expect(partial.status).toBe('error');
    expect(partial.errorCode).toBe('upstream_error');
    // Free-text error descriptions are not part of the write contract
    // (review finding 4); the column stays NULL.
    expect(partial.errorMessage).toBeNull();
    expect(partial.responseBytes).toBe(128);
    expect(partial.promptTokens).toBeNull();
    expect(partial.ttftMs).toBeNull();
  });

  it('never persists raw-content or free-text fields smuggled into any write path', () => {
    // Review finding 4: prompt/response/messages/authorization/token and
    // any free-text `detail`/`errorMessage` must be structurally rejected
    // on every public write contract – not merely discouraged.
    const id = newRequestId();
    const smuggled = [
      'prompt',
      'response',
      'messages',
      'authorization',
      'token',
      'content',
      'detail',
      'errorMessage',
    ];
    const base = {
      id,
      endpoint: '/v1/chat/completions',
      startedAtUtc: daysAgoIso(NOW, 0),
    };
    for (const field of smuggled) {
      expect(() => requests.create({ ...base, [field]: 'SK-SMOKING-GUN-SECRET' })).toThrowError(
        DbContractError
      );
    }

    requests.create(base);
    const finishBase = {
      requestId: id,
      status: 'error',
      completedAtUtc: daysAgoIso(NOW, 0),
      durationMs: 10,
      responseBytes: 0,
    };
    for (const field of smuggled) {
      expect(() =>
        requests.finish({ ...finishBase, [field]: 'SK-SMOKING-GUN-SECRET' })
      ).toThrowError(DbContractError);
    }
    expect(() =>
      requests.appendEvent({
        requestId: id,
        eventType: 'error',
        atUtc: daysAgoIso(NOW, 0),
        detail: 'SK-SMOKING-GUN-SECRET',
      })
    ).toThrowError(DbContractError);
    expect(() =>
      metrics.insert({
        source: 'gpu',
        name: 'gpu.utilization',
        value: 1,
        unit: 'percent',
        atUtc: daysAgoIso(NOW, 0),
        prompt: 'SK-SMOKING-GUN-SECRET',
      })
    ).toThrowError(DbContractError);
    expect(() =>
      serviceEvents.insert({
        service: 'api',
        severity: 'error',
        type: 'crash',
        atUtc: daysAgoIso(NOW, 0),
        detail: 'SK-SMOKING-GUN-SECRET',
      })
    ).toThrowError(DbContractError);

    // Nothing reached SQLite; the stored rows contain none of it.
    expect(requests.count()).toBe(1);
    expect(requests.countEvents()).toBe(0);
    expect(metrics.count()).toBe(0);
    expect(serviceEvents.count()).toBe(0);
    const raw = JSON.stringify(temp.db.prepare('SELECT * FROM requests').all());
    expect(raw).not.toContain('SK-SMOKING-GUN-SECRET');
  });

  it('rejects finish for unknown requests and invalid results', () => {
    expect(() =>
      requests.finish({
        requestId: newRequestId(),
        status: 'completed',
        completedAtUtc: daysAgoIso(NOW, 0),
        durationMs: 10,
        responseBytes: 1,
      })
    ).toThrowError(DatabaseError);
    const id = newRequestId();
    requests.create({ id, endpoint: '/x', startedAtUtc: daysAgoIso(NOW, 0) });
    expect(() =>
      requests.finish({
        requestId: id,
        status: 'exploded',
        completedAtUtc: daysAgoIso(NOW, 0),
        durationMs: 10,
        responseBytes: 1,
      })
    ).toThrowError(DbContractError);
  });

  it('deletes a request and cascades to its events', () => {
    const id = newRequestId();
    requests.create({ id, endpoint: '/x', startedAtUtc: daysAgoIso(NOW, 0) });
    requests.appendEvent({ requestId: id, eventType: 'start', atUtc: daysAgoIso(NOW, 0) });
    requests.appendEvent({ requestId: id, eventType: 'complete', atUtc: daysAgoIso(NOW, 0) });
    expect(requests.countEvents()).toBe(2);

    requests.delete(id);
    expect(requests.get(id)).toBeUndefined();
    expect(requests.countEvents()).toBe(0);
  });

  it('enforces the foreign key at the SQLite level as well', () => {
    // Bypass the repository on purpose: the FK itself must hold.
    expect(() =>
      temp.db
        .prepare(
          'INSERT INTO request_events (requestId, sequence, eventType, atUtc) VALUES (?, 1, ?, ?)'
        )
        .run('does-not-exist', 'start', daysAgoIso(NOW, 0))
    ).toThrowError(/FOREIGN KEY/i);
  });

  it('filters by status, model and time range', () => {
    const ids = [newRequestId(), newRequestId(), newRequestId()];
    requests.create({
      id: ids[0]!,
      model: 'Qwen3.8-27B',
      endpoint: '/a',
      startedAtUtc: daysAgoIso(NOW, 40),
    });
    requests.create({
      id: ids[1]!,
      model: 'Qwen3.8-27B',
      endpoint: '/b',
      startedAtUtc: daysAgoIso(NOW, 5),
    });
    requests.create({
      id: ids[2]!,
      model: 'other-model',
      endpoint: '/c',
      startedAtUtc: daysAgoIso(NOW, 5),
    });
    requests.finish({
      requestId: ids[1]!,
      status: 'completed',
      completedAtUtc: daysAgoIso(NOW, 5),
      durationMs: 100,
      responseBytes: 0,
    });

    const recent = requests.list({ sinceUtc: daysAgoIso(NOW, 7) });
    expect(recent.map((request) => request.id).sort()).toEqual([ids[1]!, ids[2]!].sort());

    const completed = requests.list({ status: 'completed' });
    expect(completed.map((request) => request.id)).toEqual([ids[1]!]);

    const byModel = requests.list({ model: 'Qwen3.8-27B' });
    expect(byModel.length).toBe(2);

    const limited = requests.list({ limit: 1 });
    expect(limited.length).toBe(1);
  });
});

describe('MetricRepository', () => {
  it('inserts normalized samples and queries them back', () => {
    const id = metrics.insert({
      source: 'gpu',
      name: 'gpu.utilization',
      value: 42.5,
      unit: 'percent',
      atUtc: daysAgoIso(NOW, 0),
      labels: { device: 'intel-arc-pro-b70' },
    });
    expect(id).toBeGreaterThan(0);

    const samples = metrics.query({ source: 'gpu', name: 'gpu.utilization' });
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      source: 'gpu',
      name: 'gpu.utilization',
      value: 42.5,
      unit: 'percent',
      labels: { device: 'intel-arc-pro-b70' },
    });
  });

  it('rejects invalid samples (unit missing, NaN value, offset timestamp, extra fields)', () => {
    const bad: Array<Record<string, unknown>> = [
      { source: 'gpu', name: 'gpu.vram', value: 1, atUtc: daysAgoIso(NOW, 0) },
      {
        source: 'gpu',
        name: 'gpu.utilization',
        value: Number.NaN,
        unit: 'percent',
        atUtc: daysAgoIso(NOW, 0),
      },
      {
        source: 'gpu',
        name: 'gpu.utilization',
        value: 1,
        unit: 'percent',
        atUtc: '2025-06-15T14:00:00+02:00',
      },
      { source: 'unknown-source', name: 'x', value: 1, unit: 'count', atUtc: daysAgoIso(NOW, 0) },
      {
        source: 'gpu',
        name: 'gpu.utilization',
        value: 1,
        unit: 'percent',
        atUtc: daysAgoIso(NOW, 0),
        prompt: 'raw content must never reach the db',
      },
      {
        source: 'gpu',
        name: 'gpu.utilization',
        value: 1,
        unit: 'percent',
        atUtc: daysAgoIso(NOW, 0),
        labels: { device: '' }, // empty label values carry no information
      },
    ];
    for (const input of bad) {
      expect(() => metrics.insert(input)).toThrowError(DbContractError);
    }
    expect(metrics.count()).toBe(0);
  });

  it('keeps the exact same series unique at the same instant, also across label key orders', () => {
    metrics.insert({
      source: 'gpu',
      name: 'gpu.utilization',
      value: 1,
      unit: 'percent',
      atUtc: daysAgoIso(NOW, 0),
      labels: { device: 'a' },
    });
    // Exactly the same series (same labels) at the same instant: unique.
    expect(() =>
      metrics.insert({
        source: 'gpu',
        name: 'gpu.utilization',
        value: 2,
        unit: 'percent',
        atUtc: daysAgoIso(NOW, 0),
        labels: { device: 'a' },
      })
    ).toThrowError(/UNIQUE constraint/i);
    // Same labels in a different key order are the same series, because
    // labels are serialized canonically (review finding 2).
    expect(() =>
      metrics.insert({
        source: 'gpu',
        name: 'gpu.utilization',
        value: 2,
        unit: 'percent',
        atUtc: daysAgoIso(NOW, 0),
        labels: { device: 'a', zone: 'x' },
      })
    ).not.toThrow();
    // The canonical re-ordering of that series must now collide.
    expect(() =>
      metrics.insert({
        source: 'gpu',
        name: 'gpu.utilization',
        value: 3,
        unit: 'percent',
        atUtc: daysAgoIso(NOW, 0),
        labels: { zone: 'x', device: 'a' },
      })
    ).toThrowError(/UNIQUE constraint/i);
    // Duplicates must also fail inside atomic batches.
    expect(() =>
      metrics.insertMany([
        {
          source: 'gpu',
          name: 'gpu.utilization',
          value: 2,
          unit: 'percent',
          atUtc: daysAgoIso(NOW, 0),
          labels: { device: 'a' },
        },
      ])
    ).toThrowError();
    expect(metrics.count()).toBe(2);
  });

  it('allows different label sets for the same (source, name, atUtc): labels are part of the series identity', () => {
    metrics.insert({
      source: 'gpu',
      name: 'gpu.utilization',
      value: 10,
      unit: 'percent',
      atUtc: daysAgoIso(NOW, 0),
      labels: { device: 'a' },
    });
    metrics.insert({
      source: 'gpu',
      name: 'gpu.utilization',
      value: 20,
      unit: 'percent',
      atUtc: daysAgoIso(NOW, 0),
      labels: { device: 'b' },
    });
    // No labels at all: a third, distinct series.
    metrics.insert({
      source: 'gpu',
      name: 'gpu.utilization',
      value: 30,
      unit: 'percent',
      atUtc: daysAgoIso(NOW, 0),
    });
    expect(metrics.count()).toBe(3);

    // Label-less duplicates still collide (NULL is normalized to a stable
    // key in the v2 unique index).
    expect(() =>
      metrics.insert({
        source: 'gpu',
        name: 'gpu.utilization',
        value: 40,
        unit: 'percent',
        atUtc: daysAgoIso(NOW, 0),
      })
    ).toThrowError(/UNIQUE constraint/i);
    expect(metrics.count()).toBe(3);
  });

  it('canonicalizes label key order on write and read-back', () => {
    metrics.insert({
      source: 'gpu',
      name: 'gpu.vram',
      value: 1,
      unit: 'bytes',
      atUtc: daysAgoIso(NOW, 0),
      labels: { zeta: '1', alpha: '2' },
    });
    const raw = temp.db
      .prepare('SELECT labels FROM metric_samples WHERE name = ?')
      .get('gpu.vram') as { labels: string };
    expect(raw.labels).toBe(JSON.stringify({ alpha: '2', zeta: '1' }));

    // The permuted key order refers to the same series → duplicate.
    expect(() =>
      metrics.insert({
        source: 'gpu',
        name: 'gpu.vram',
        value: 2,
        unit: 'bytes',
        atUtc: daysAgoIso(NOW, 0),
        labels: { alpha: '2', zeta: '1' },
      })
    ).toThrowError(/UNIQUE constraint/i);

    const samples = metrics.query({ name: 'gpu.vram' });
    expect(samples[0]?.labels).toEqual({ zeta: '1', alpha: '2' });
  });

  it('insertMany is atomic: one invalid sample aborts the whole batch', () => {
    expect(() =>
      metrics.insertMany([
        {
          source: 'gpu',
          name: 'gpu.utilization',
          value: 1,
          unit: 'percent',
          atUtc: daysAgoIso(NOW, 3),
        },
        {
          source: 'gpu',
          name: 'gpu.utilization',
          value: 2,
          unit: 'percent',
          atUtc: daysAgoIso(NOW, 2),
        },
        {
          source: 'gpu',
          name: 'gpu.utilization',
          value: Number.NaN,
          unit: 'percent',
          atUtc: daysAgoIso(NOW, 1),
        },
      ])
    ).toThrowError(DbContractError);
    expect(metrics.count()).toBe(0);

    const inserted = metrics.insertMany([
      {
        source: 'gpu',
        name: 'gpu.utilization',
        value: 1,
        unit: 'percent',
        atUtc: daysAgoIso(NOW, 3),
      },
      {
        source: 'gpu',
        name: 'gpu.utilization',
        value: 2,
        unit: 'percent',
        atUtc: daysAgoIso(NOW, 2),
      },
    ]);
    expect(inserted).toBe(2);
    expect(metrics.count()).toBe(2);
  });

  it('honours time-range and limit filters', () => {
    metrics.insertMany([
      {
        source: 'vllm',
        name: 'vllm.running_requests',
        value: 3,
        unit: 'count',
        atUtc: daysAgoIso(NOW, 10),
      },
      {
        source: 'vllm',
        name: 'vllm.running_requests',
        value: 5,
        unit: 'count',
        atUtc: daysAgoIso(NOW, 2),
      },
      {
        source: 'vllm',
        name: 'vllm.waiting_requests',
        value: 1,
        unit: 'count',
        atUtc: daysAgoIso(NOW, 1),
      },
    ]);
    const recent = metrics.query({ source: 'vllm', fromUtc: daysAgoIso(NOW, 7) });
    expect(recent).toHaveLength(2);
    const limited = metrics.query({ source: 'vllm', limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0]?.name).toBe('vllm.running_requests'); // oldest first
  });
});

describe('ServiceEventRepository', () => {
  it('records lifecycle events and filters by service/time', () => {
    serviceEvents.insert({
      service: 'api',
      severity: 'info',
      type: 'started',
      atUtc: daysAgoIso(NOW, 10),
    });
    serviceEvents.insert({
      service: 'api',
      severity: 'error',
      type: 'crash',
      atUtc: daysAgoIso(NOW, 1),
    });
    serviceEvents.insert({
      service: 'vllm',
      severity: 'warn',
      type: 'restart',
      atUtc: daysAgoIso(NOW, 1),
    });

    expect(serviceEvents.list({ sinceUtc: daysAgoIso(NOW, 2) })).toHaveLength(2);
    expect(serviceEvents.list({ service: 'api' }).map((event) => event.type)).toEqual([
      'started',
      'crash',
    ]);
  });

  it('rejects unknown services, severities and oversized types', () => {
    for (const input of [
      { service: 'nginx', severity: 'info', type: 'started', atUtc: daysAgoIso(NOW, 0) },
      { service: 'api', severity: 'panic', type: 'started', atUtc: daysAgoIso(NOW, 0) },
      {
        service: 'gpu',
        severity: 'warn',
        type: 'x'.repeat(65), // machine-readable type is bounded
      },
    ]) {
      expect(() => serviceEvents.insert(input)).toThrowError(DbContractError);
    }
    expect(serviceEvents.count()).toBe(0);
  });

  it('rejects free-text detail on service events (no raw content in the table)', () => {
    expect(() =>
      serviceEvents.insert({
        service: 'api',
        severity: 'error',
        type: 'crash',
        atUtc: daysAgoIso(NOW, 0),
        detail: 'OOM killed, dmesg: sk-SECRET stack trace',
      })
    ).toThrowError(DbContractError);
    expect(serviceEvents.count()).toBe(0);
  });
});
