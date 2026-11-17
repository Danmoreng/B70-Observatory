import { describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  HealthCheckSchema,
  HealthPayloadSchema,
  SERVICE_NAME,
  SystemSnapshotSchema,
  UtcTimestampSchema,
  VllmTelemetryPayloadSchema,
  parseApiError,
  parseAuthSession,
  LoginRequestSchema,
  parseHealthPayload,
  parseSystemSnapshot,
  parseVllmTelemetryPayload,
} from '../src/index.js';

const validPayload = {
  service: SERVICE_NAME,
  status: 'ok',
  version: '0.1.0',
  startedAt: '2025-01-01T10:00:00.000Z',
  timestamp: '2025-01-01T10:00:30.000Z',
  uptimeSeconds: 30,
  checks: [{ name: 'server', status: 'ok' }],
};

describe('UtcTimestampSchema', () => {
  it('accepts the exact canonical Date.toISOString() form', () => {
    for (const value of [
      '2025-01-01T10:00:00.000Z',
      '2025-01-01T10:00:00.123Z',
      '2025-01-01T10:00:00.500Z',
      '2031-12-31T23:59:59.999Z',
    ]) {
      expect(UtcTimestampSchema.parse(value)).toBe(value);
    }
  });

  it('round-trips every toISOString() output (self-consistency)', () => {
    const date = new Date(Date.parse('2024-02-29T06:30:07.500Z'));
    expect(UtcTimestampSchema.parse(date.toISOString())).toBe(date.toISOString());
  });

  it('rejects different precisions (no fractional part, 1–2 or 5–6 digits)', () => {
    for (const value of [
      '2025-01-01T10:00:00Z',
      '2025-01-01T10:00:00.5Z',
      '2025-01-01T10:00:00.50Z',
      '2025-01-01T10:00:00.5000Z',
      '2025-01-01T10:00:00.500000Z',
    ]) {
      expect(() => UtcTimestampSchema.parse(value)).toThrow();
    }
  });

  it('rejects calendar-invalid dates the engine would silently normalize', () => {
    for (const value of [
      '2025-02-29T00:00:00.000Z', // 2025 is not a leap year
      '2025-04-31T00:00:00.000Z', // April has 30 days
      '2025-01-01T24:00:00.000Z', // no 24 o'clock
      '2025-00-10T00:00:00.000Z', // no month 0
      '2025-13-01T00:00:00.000Z', // no month 13
    ]) {
      expect(() => UtcTimestampSchema.parse(value)).toThrow();
    }
  });

  it('rejects offsets and other non-canonical shapes', () => {
    for (const value of [
      '2025-01-01T12:00:00.000+02:00',
      '2025-01-01T10:00:00.000z', // lowercase z
      '2025-01-01 10:00:00.000Z', // space separator
      'yesterday',
    ]) {
      expect(() => UtcTimestampSchema.parse(value)).toThrow();
    }
  });
});

describe('browser authentication contracts', () => {
  it('accepts password-only login and authenticated/anonymous session states', () => {
    expect(LoginRequestSchema.parse({ password: 'correct horse battery staple' })).toEqual({
      password: 'correct horse battery staple',
    });
    expect(parseAuthSession({ authenticated: false })).toEqual({ authenticated: false });
    expect(
      parseAuthSession({ authenticated: true, expiresAt: '2025-02-01T10:00:00.000Z' })
    ).toMatchObject({ authenticated: true });
    // Operator opt-out flag; an absent flag (older servers) must stay valid.
    expect(
      parseAuthSession({
        authenticated: true,
        expiresAt: '2025-02-01T10:00:00.000Z',
        loginRequired: false,
      })
    ).toMatchObject({ authenticated: true, loginRequired: false });
  });

  it('rejects usernames, empty passwords and inconsistent expiry state', () => {
    expect(() => LoginRequestSchema.parse({ username: 'admin', password: 'secret' })).toThrow();
    expect(() => LoginRequestSchema.parse({ password: '' })).toThrow();
    expect(() => parseAuthSession({ authenticated: true })).toThrow();
    expect(() =>
      parseAuthSession({ authenticated: false, expiresAt: '2025-02-01T10:00:00.000Z' })
    ).toThrow();
  });
});

describe('HealthPayloadSchema', () => {
  it('accepts a valid payload', () => {
    expect(parseHealthPayload(validPayload)).toEqual(validPayload);
  });

  it('rejects an unknown service name', () => {
    expect(() => HealthPayloadSchema.parse({ ...validPayload, service: 'other' })).toThrow();
  });

  it('rejects unknown top-level fields', () => {
    expect(() =>
      HealthPayloadSchema.parse({ ...validPayload, prompt: 'secret content' })
    ).toThrow();
  });

  it('rejects invalid status values', () => {
    expect(() => HealthPayloadSchema.parse({ ...validPayload, status: 'bogus' })).toThrow();
  });

  it('rejects non-UTC or non-date timestamp strings', () => {
    expect(() => HealthPayloadSchema.parse({ ...validPayload, timestamp: 'yesterday' })).toThrow();
    expect(() =>
      HealthPayloadSchema.parse({ ...validPayload, timestamp: '2025-13-40T99:00:00Z' })
    ).toThrow();
  });

  it('rejects offset-bearing timestamps even when valid RFC 3339 dates (R2 regression)', () => {
    // The contract promises UTC, so `+02:00` / `-05:30` variants must fail,
    // not merely be tolerated.
    expect(() =>
      HealthPayloadSchema.parse({ ...validPayload, timestamp: '2025-01-01T12:00:00.000+02:00' })
    ).toThrow();
    expect(() =>
      HealthPayloadSchema.parse({ ...validPayload, startedAt: '2025-01-01T04:30:00-05:30' })
    ).toThrow();
    expect(() =>
      HealthPayloadSchema.parse({ ...validPayload, timestamp: '2025-01-01T10:00:00+00:00' })
    ).toThrow();
  });

  it('accepts millisecond-precision UTC timestamps from Date.toISOString()', () => {
    const timestamp = new Date('2025-01-01T10:00:00.123Z').toISOString();
    expect(HealthPayloadSchema.parse({ ...validPayload, timestamp })).toMatchObject({ timestamp });
  });

  it('rejects negative or fractional uptime', () => {
    expect(() => HealthPayloadSchema.parse({ ...validPayload, uptimeSeconds: -1 })).toThrow();
    expect(() => HealthPayloadSchema.parse({ ...validPayload, uptimeSeconds: 1.5 })).toThrow();
  });

  it('rejects an empty check list and malformed checks', () => {
    expect(() => HealthPayloadSchema.parse({ ...validPayload, checks: [] })).toThrow();
    expect(() =>
      HealthPayloadSchema.parse({ ...validPayload, checks: [{ name: 'gpu', status: 'broken' }] })
    ).toThrow();
  });

  it('accepts optional check messages', () => {
    expect(
      HealthCheckSchema.parse({ name: 'gpu', status: 'degraded', message: 'driver offline' })
    ).toMatchObject({ name: 'gpu', status: 'degraded' });
  });
});

describe('ApiErrorSchema', () => {
  it('accepts a valid error body', () => {
    expect(parseApiError({ error: { code: 'not_found', message: 'Route not found.' } })).toEqual({
      error: { code: 'not_found', message: 'Route not found.' },
    });
  });

  it('accepts an optional UUID request id', () => {
    const body = {
      error: {
        code: 'internal_error',
        message: 'Boom',
        requestId: '8b5f2c3a-1111-4222-9333-abcdef012345',
      },
    };
    expect(parseApiError(body)).toEqual(body);
  });

  it('rejects unknown codes, missing message and extra fields', () => {
    expect(() => ApiErrorSchema.parse({ error: { code: 'nope', message: 'x' } })).toThrow();
    expect(() => ApiErrorSchema.parse({ error: { code: 'bad_request' } })).toThrow();
    expect(() =>
      ApiErrorSchema.parse({ error: { code: 'bad_request', message: 'x', extra: 1 } })
    ).toThrow();
    expect(() => ApiErrorSchema.parse({ message: 'top-level only' })).toThrow();
  });
});

describe('VllmTelemetryPayloadSchema (M4A)', () => {
  const fullPayload = {
    service: SERVICE_NAME,
    sourceStatus: 'ok',
    timestamp: '2025-01-01T10:00:30.000Z',
    model: 'Qwen3.8-27B',
    requests: { running: 3, waiting: 1 },
    kvCacheUsagePercent: 42.5,
    tokens: {
      promptTokens: 100000,
      generationTokens: 5000,
      promptTokensPerSecond: 12.5,
      generationTokensPerSecond: 2.5,
    },
    prefixCache: {
      queriedTokens: 80000,
      hitTokens: 48000,
      hitRate: 0.6,
    },
    mtp: { draftTokens: 900, acceptedTokens: 720, acceptanceRate: 0.8 },
    requestsFinished: { total: 15, byReason: { stop: 15, error: 0 } },
    latency: { e2eAvgMs: 7358.2, ttftAvgMs: 5290.7, interTokenAvgMs: 47.1 },
    gpu: { available: false, reason: 'sysfs liefert nur Temperaturen; fehlen: Auslastung, VRAM' },
  };

  it('accepts a fully populated payload', () => {
    expect(parseVllmTelemetryPayload(fullPayload)).toEqual(fullPayload);
  });

  it('accepts a minimal payload (error state, no data, unavailable gpu)', () => {
    expect(
      parseVllmTelemetryPayload({
        service: SERVICE_NAME,
        sourceStatus: 'error',
        sourceMessage: `Metrikquelle nicht erreichbar: timeout nach 3000 ms`,
        timestamp: '2025-01-01T10:00:30.000Z',
        gpu: { available: true },
      })
    ).toMatchObject({ sourceStatus: 'error' });
  });

  it('rejects removed per-second prefix-cache rate fields (strict contract)', () => {
    // The admission-batch-credited prefix-cache counters have no stable
    // time axis; per-second rates derived from them were aggregation
    // artifacts and were removed from the contract.
    const base = {
      service: SERVICE_NAME,
      sourceStatus: 'ok',
      timestamp: '2025-01-01T10:00:30.000Z',
      gpu: { available: true },
    };
    expect(() =>
      VllmTelemetryPayloadSchema.parse({
        ...base,
        prefixCache: {
          queriedTokens: 1000,
          hitTokens: 500,
          queriedTokensPerSecond: 12,
          hitTokensPerSecond: 6,
        },
      })
    ).toThrow();
  });

  it('rejects unknown top-level fields (strict contract)', () => {
    expect(() =>
      VllmTelemetryPayloadSchema.parse({
        service: SERVICE_NAME,
        sourceStatus: 'ok',
        timestamp: '2025-01-01T10:00:30.000Z',
        gpu: { available: true },
        prompt: 'raw user content',
      })
    ).toThrow();
  });

  it('rejects out-of-range or non-finite values', () => {
    const base = {
      service: SERVICE_NAME,
      sourceStatus: 'ok',
      timestamp: '2025-01-01T10:00:30.000Z',
      gpu: { available: true },
    };
    expect(() => VllmTelemetryPayloadSchema.parse({ ...base, kvCacheUsagePercent: 101 })).toThrow();
    expect(() =>
      VllmTelemetryPayloadSchema.parse({ ...base, kvCacheUsagePercent: -0.1 })
    ).toThrow();
    expect(() =>
      VllmTelemetryPayloadSchema.parse({
        ...base,
        prefixCache: { queriedTokens: 1, hitTokens: 1, hitRate: 1.5 },
      })
    ).toThrow();
    expect(() =>
      VllmTelemetryPayloadSchema.parse({
        ...base,
        tokens: { promptTokens: 1, generationTokens: 1, promptTokensPerSecond: Number.NaN },
      })
    ).toThrow();
    expect(() =>
      VllmTelemetryPayloadSchema.parse({ ...base, requests: { running: -1, waiting: 0 } })
    ).toThrow();
  });

  it('requires canonical UTC timestamps and a bounded source message', () => {
    const base = {
      sourceStatus: 'ok',
      timestamp: '2025-01-01T10:00:30Z',
      gpu: { available: true },
    };
    expect(() => VllmTelemetryPayloadSchema.parse({ service: SERVICE_NAME, ...base })).toThrow();
    expect(() =>
      VllmTelemetryPayloadSchema.parse({
        service: SERVICE_NAME,
        sourceStatus: 'error',
        sourceMessage: 'x'.repeat(257),
        timestamp: '2025-01-01T10:00:30.000Z',
        gpu: { available: true },
      })
    ).toThrow();
  });

  it('rejects gpu entries with extra fields', () => {
    expect(() =>
      VllmTelemetryPayloadSchema.parse({
        service: SERVICE_NAME,
        sourceStatus: 'ok',
        timestamp: '2025-01-01T10:00:30.000Z',
        gpu: { available: false, reason: 'x', powerWatts: 55 },
      })
    ).toThrow();
  });
});

describe('SystemSnapshotSchema (M4B)', () => {
  const base = {
    service: SERVICE_NAME,
    sourceStatus: 'ok',
    timestamp: '2025-01-01T10:00:30.000Z',
    gpu: { available: false as const, reason: 'Kein Intel-GPU gefunden' },
  };

  it('accepts a full snapshot with all sections', () => {
    const payload = parseSystemSnapshot({
      ...base,
      cpu: {
        coreCount: 12,
        utilizationPercent: 12.5,
        load1: 0.9,
        load5: 0.45,
        load15: 0.22,
      },
      memory: {
        totalBytes: 33_000_000_000,
        usedBytes: 9_000_000_000,
        availableBytes: 24_000_000_000,
        usagePercent: 27.3,
      },
      disk: {
        path: '/',
        totalBytes: 2_000_000_000_000,
        usedBytes: 1_200_000_000_000,
        freeBytes: 800_000_000_000,
        usagePercent: 60,
      },
      process: {
        count: 1138,
        running: 2,
        observatoryRssBytes: 120_000_000,
        uptimeSeconds: 3_600,
      },
      gpu: {
        available: true,
        card: 'card0',
        values: { temperatureC: 69.4, powerWatts: 42.1 },
        missing: ['utilization', 'vram', 'clock'],
      },
    });
    expect(payload.cpu?.utilizationPercent).toBe(12.5);
    expect(payload.gpu).toMatchObject({ available: true });
  });

  it('accepts first-measurement snapshots (no utilization) and stale/error states', () => {
    const first = parseSystemSnapshot({
      ...base,
      cpu: { coreCount: 12, load1: 0.5 },
      memory: { totalBytes: 1024 },
      gpu: {
        available: true,
        card: 'card0',
        values: { temperatureC: 55 },
        missing: ['utilization', 'vram', 'power', 'clock'],
      },
    });
    expect(first.cpu?.utilizationPercent).toBeUndefined();
    expect(
      parseSystemSnapshot({ ...base, sourceStatus: 'stale', sourceMessage: 'zeitüberschreitung' })
    ).toMatchObject({ sourceStatus: 'stale' });
    expect(
      parseSystemSnapshot({ ...base, sourceStatus: 'error', sourceMessage: 'nicht lesbar' })
    ).toMatchObject({ sourceStatus: 'error' });
  });

  it('rejects out-of-range and non-finite values', () => {
    for (const mutation of [
      { cpu: { coreCount: 12, utilizationPercent: 100.5 } },
      { cpu: { coreCount: 12, utilizationPercent: Number.NaN } },
      { cpu: { coreCount: 0 } },
      { memory: { totalBytes: -1 } },
      { memory: { totalBytes: 10, usagePercent: 101 } },
      { disk: { path: '', totalBytes: 10 } },
      { process: { observatoryRssBytes: -1, uptimeSeconds: 0 } },
      {
        gpu: {
          available: true,
          values: { utilizationPercent: 200, temperatureC: Number.POSITIVE_INFINITY },
          missing: [],
        },
      },
    ]) {
      expect(() => SystemSnapshotSchema.parse({ ...base, ...mutation })).toThrow();
    }
  });

  it('rejects unknown fields (strict) and unknown gpu missing entries', () => {
    expect(() => SystemSnapshotSchema.parse({ ...base, prompt: 'raw content' })).toThrow();
    expect(() =>
      SystemSnapshotSchema.parse({
        ...base,
        gpu: {
          available: true,
          values: { temperatureC: 55 },
          missing: ['temperature', 'vram', 'vram', 'bogus'],
        },
      })
    ).toThrow();
  });

  it('keeps the unavailable-gpu form strict (no values allowed)', () => {
    expect(() =>
      SystemSnapshotSchema.parse({
        ...base,
        gpu: { available: false, reason: 'x', values: { temperatureC: 55 } },
      })
    ).toThrow();
  });

  it('requires canonical UTC timestamps and a bounded source message', () => {
    expect(() =>
      SystemSnapshotSchema.parse({ ...base, timestamp: '2025-01-01T10:00:30Z' })
    ).toThrow();
    expect(() => SystemSnapshotSchema.parse({ ...base, sourceMessage: 'x'.repeat(257) })).toThrow();
  });
});
