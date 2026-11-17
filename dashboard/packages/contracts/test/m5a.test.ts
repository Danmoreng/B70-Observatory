import { describe, expect, it } from 'vitest';
import {
  MAX_METRIC_HISTORY_BUCKETS,
  MAX_REQUEST_PAGE_SIZE,
  MetricsHistoryQuerySchema,
  MetricsHistoryResponseSchema,
  MetricBucketSchema,
  RequestListQuerySchema,
  RequestListResponseSchema,
  RequestSummarySchema,
  parseMetricsHistoryResponse,
  parseRequestDetail,
  parseRequestListResponse,
  type MetricBucket,
} from '../src/index.js';

const VALID_SUMMARY = {
  id: '0e19369e-8060-4a9b-9a4d-1c2b3e4f5a6b',
  origin: 'web',
  model: 'Qwen3.8-27B',
  endpoint: '/v1/chat/completions',
  method: 'POST',
  status: 'completed',
  httpStatus: 200,
  startedAtUtc: '2025-06-01T10:00:00.000Z',
  completedAtUtc: '2025-06-01T10:00:04.250Z',
  durationMs: 4250,
  ttftMs: 320,
  promptTokens: 100,
  completionTokens: 50,
  totalTokens: 150,
  promptBytes: 2048,
  responseBytes: 4096,
  prefixCacheQueries: 10,
  prefixCacheHits: 6,
  mtpDraftTokens: 40,
  mtpAcceptedTokens: 25,
};

/** Minimal summary (all optional metadata absent, as for an in-progress row). */
const MINIMAL_SUMMARY = {
  id: '0e19369e-8060-4a9b-9a4d-1c2b3e4f5a6b',
  origin: 'unknown',
  endpoint: '/v1/chat/completions',
  method: 'POST',
  status: 'in_progress',
  startedAtUtc: '2025-06-01T10:00:00.000Z',
  promptBytes: 0,
  responseBytes: 0,
};

describe('M5A request contracts', () => {
  it('accepts full and minimal request summaries and rejects content/smuggle fields', () => {
    expect(RequestSummarySchema.parse(VALID_SUMMARY)).toEqual(VALID_SUMMARY);
    expect(RequestSummarySchema.parse(MINIMAL_SUMMARY)).toEqual(MINIMAL_SUMMARY);
    // Raw content, secrets and free text must have no field at all.
    for (const field of [
      'prompt',
      'response',
      'responses',
      'messages',
      'tools',
      'toolCalls',
      'content',
      'detail',
      'errorMessage',
      'authorization',
      'cookie',
      'token',
      'headers',
    ]) {
      expect(() =>
        RequestSummarySchema.parse({ ...MINIMAL_SUMMARY, [field]: 'sk-SECRET' })
      ).toThrow();
    }
  });

  it('rejects unknown fields and bad values on summaries (strict)', () => {
    const bad: Array<Record<string, unknown>> = [
      { ...MINIMAL_SUMMARY, unknownField: 'strict objects reject this' },
      { ...MINIMAL_SUMMARY, id: 'no-uuid' },
      { ...MINIMAL_SUMMARY, status: 'done' },
      { ...MINIMAL_SUMMARY, method: 'TRACE' },
      { ...MINIMAL_SUMMARY, startedAtUtc: '2025-06-01T12:00:00.000+02:00' },
      { ...MINIMAL_SUMMARY, promptBytes: -1 },
      { ...VALID_SUMMARY, httpStatus: 999 },
      { ...VALID_SUMMARY, durationMs: -5 },
    ];
    for (const input of bad) {
      expect(() => RequestSummarySchema.parse(input)).toThrow();
    }
  });

  it('validates detail payloads with ordered lifecycle events', () => {
    const detail = {
      ...VALID_SUMMARY,
      events: [
        { sequence: 1, eventType: 'start', atUtc: '2025-06-01T10:00:00.000Z' },
        { sequence: 2, eventType: 'first_token', atUtc: '2025-06-01T10:00:00.320Z' },
        { sequence: 3, eventType: 'complete', atUtc: '2025-06-01T10:00:04.250Z' },
      ],
    };
    expect(parseRequestDetail(detail)).toEqual(detail);
    // Events are data-only: no free-text detail field can ride along.
    expect(() =>
      parseRequestDetail({
        ...detail,
        events: [{ sequence: 1, eventType: 'start', atUtc: detail.startedAtUtc, detail: 'leak' }],
      })
    ).toThrow();
    expect(() =>
      parseRequestDetail({ ...detail, events: [{ sequence: 0, eventType: 'start' }] })
    ).toThrow();
    expect(() => parseRequestDetail({ ...MINIMAL_SUMMARY })).toThrow();
  });
});

describe('M5A request list query/response contracts', () => {
  it('accepts a fully populated (string-encoded) query', () => {
    const query = RequestListQuerySchema.parse({
      id: '0e19369e-8060-4a9b-9a4d-1c2b3e4f5a6b',
      status: 'completed',
      model: 'Qwen3.8-27B',
      from: '2025-06-01T00:00:00.000Z',
      to: '2025-06-02T00:00:00.000Z',
      limit: '200',
      cursor: 'YWJjXzEyMw',
    });
    expect(query.limit).toBe(200);
  });

  it('rejects malformed parameters (uuid, status, UTC form, limits, cursor, extras)', () => {
    const bad: Array<Record<string, unknown>> = [
      { id: 'not-a-uuid' },
      { status: 'done' },
      { model: 'x'.repeat(129) },
      { from: '2025-06-01T00:00:00Z' }, // no millisecond fraction
      { to: '2025-06-01T02:00:00.000+02:00' },
      { from: '2025-02-29T00:00:00.000Z' }, // calendar-invalid
      { limit: '0' },
      { limit: String(MAX_REQUEST_PAGE_SIZE + 1) },
      { limit: 'abc' },
      { limit: '-1' },
      { cursor: 'has space' },
      { cursor: 'a'.repeat(513) },
      { cursor: '' },
      { foo: 'bar' }, // unknown parameter
      { status: ['a', 'b'] }, // repeated parameter
    ];
    for (const input of bad) {
      expect(() => RequestListQuerySchema.parse(input), JSON.stringify(input)).toThrow();
    }
  });

  it('accepts an empty query (all parameters optional)', () => {
    expect(RequestListQuerySchema.parse({})).toEqual({});
  });

  it('validates list responses: bounded items, nullable base64url cursor, strict shape', () => {
    const response = parseRequestListResponse({
      items: [VALID_SUMMARY],
      nextCursor: 'YWJjXzEyMw',
    });
    expect(response.items).toHaveLength(1);
    expect(() => RequestListResponseSchema.parse({ items: [], nextCursor: null })).not.toThrow();
    expect(() =>
      RequestListResponseSchema.parse({ items: [], nextCursor: 'bad cursor' })
    ).toThrow();
    expect(() =>
      RequestListResponseSchema.parse({ items: [], nextCursor: 'x'.repeat(513) })
    ).toThrow();
    expect(() =>
      RequestListResponseSchema.parse({ items: [VALID_SUMMARY], prompt: 'nope' })
    ).toThrow();
    expect(() =>
      RequestListResponseSchema.parse({
        items: [MINIMAL_SUMMARY, MINIMAL_SUMMARY, { ...MINIMAL_SUMMARY, prompt: 'x' }],
        nextCursor: null,
      })
    ).toThrow();
  });

  it('caps the list page at the shared constant', () => {
    const items = Array.from({ length: MAX_REQUEST_PAGE_SIZE + 1 }, (_, index) => ({
      ...MINIMAL_SUMMARY,
      id: `11111111-2222-4333-8444-5555${(1000 + index).toString(16).padStart(8, '0')}`,
    }));
    expect(() => RequestListResponseSchema.parse({ items, nextCursor: null })).toThrow();
    expect(() =>
      RequestListResponseSchema.parse({
        items: items.slice(0, MAX_REQUEST_PAGE_SIZE),
        nextCursor: 'YWJj',
      })
    ).not.toThrow();
  });
});

describe('M5A metric history contracts', () => {
  const BUCKET: MetricBucket = {
    atUtc: '2025-06-01T10:00:00.000Z',
    min: 1,
    max: 9,
    avg: 5,
    count: 3,
  };

  it('requires series, both canonical bounds and a bounded bucket size', () => {
    const valid = {
      series: 'vllm.requests-running',
      from: '2025-06-01T00:00:00.000Z',
      to: '2025-06-02T00:00:00.000Z',
      bucketSeconds: '60',
    };
    expect(MetricsHistoryQuerySchema.parse(valid)).toEqual({ ...valid, bucketSeconds: 60 });
    const bad: Array<Record<string, unknown>> = [
      { ...valid, series: '' },
      { ...valid, series: 'x'.repeat(65) },
      { ...valid, from: '2025-06-01T00:00:00Z' },
      { ...valid, to: '2025-06-02T00:00:00.000+00:00' },
      { series: 'vllm.x', to: valid.to, bucketSeconds: 60 }, // missing from
      { ...valid, bucketSeconds: '0' },
      { ...valid, bucketSeconds: 'abc' },
      { ...valid, bucketSeconds: 86_401 },
      { ...valid, foo: 1 },
    ];
    for (const input of bad) {
      expect(() => MetricsHistoryQuerySchema.parse(input), JSON.stringify(input)).toThrow();
    }
  });

  it('validates bucket payloads strictly (finite numbers, canonical UTC, positive count)', () => {
    expect(MetricBucketSchema.parse(BUCKET)).toEqual(BUCKET);
    for (const patch of [
      { atUtc: '2025-06-01T10:00:00Z' },
      { min: Number.NaN },
      { max: Number.POSITIVE_INFINITY },
      { count: 0 },
      { count: 1.5 },
      { prompt: 'content must never be a field' },
    ]) {
      expect(
        () => MetricBucketSchema.parse({ ...BUCKET, ...patch }),
        JSON.stringify(patch)
      ).toThrow();
    }
  });

  it('caps responses at 1000 buckets and keeps the shape strict', () => {
    const buckets = Array.from({ length: MAX_METRIC_HISTORY_BUCKETS }, (_, index) => ({
      ...BUCKET,
      atUtc: new Date(Date.parse('2025-01-01T00:00:00.000Z') + index * 60_000).toISOString(),
    }));
    const payload = parseMetricsHistoryResponse({
      series: 'vllm.requests-running',
      unit: 'count',
      bucketSeconds: 60,
      buckets,
    });
    expect(payload.buckets).toHaveLength(MAX_METRIC_HISTORY_BUCKETS);
    expect(() =>
      MetricsHistoryResponseSchema.parse({
        series: 'vllm.requests-running',
        unit: 'count',
        bucketSeconds: 60,
        buckets: [...buckets, BUCKET],
      })
    ).toThrow();
    expect(() =>
      MetricsHistoryResponseSchema.parse({
        series: 'vllm.requests-running',
        unit: 'count',
        bucketSeconds: 60,
        buckets: [],
        prompt: 'nope',
      })
    ).toThrow();
  });
});
