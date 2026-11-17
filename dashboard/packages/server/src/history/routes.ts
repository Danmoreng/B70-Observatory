import { z, type ZodType } from 'zod';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  DEFAULT_REQUEST_PAGE_SIZE,
  MAX_METRIC_HISTORY_BUCKETS,
  MetricsHistoryQuerySchema,
  MetricsHistoryResponseSchema,
  RequestDetailSchema,
  RequestListQuerySchema,
  RequestListResponseSchema,
  type RequestSummary,
} from '@observatory/contracts';
import type { MetricRepository } from '../db/metrics.js';
import type { RequestRepository, StoredRequest } from '../db/requests.js';
import { CursorError, decodeCursor, encodeCursor, type CursorFilterSet } from './cursor.js';
import { findMetricSeries } from './series.js';

/**
 * Read-only historical API (M5A).
 *
 * - `GET /api/requests` – newest first, filterable (id/status/model/from/to),
 *   stable keyset pagination; `nextCursor` is only set when a further page
 *   provably exists (limit+1 probe).
 * - `GET /api/requests/:id` – full persisted metadata plus the lifecycle
 *   events in sequence order; 404 for unknown UUIDs.
 * - `GET /api/metrics/history` – one allowlisted series per call,
 *   epoch-aligned buckets aggregated inside SQLite.
 *
 * Every response body is runtime-validated against the shared, strictly
 * closed Zod contracts before it is sent: the contracts contain no
 * content- or secret-bearing fields, so nothing raw can leave the process.
 * In LAN mode all three endpoints sit behind the browser-session
 * authentication (see `auth/routes.ts`); in development mode they follow
 * the same open-loopback rule as the rest of the API.
 */
export interface HistoryOptions {
  requests: RequestRepository;
  metrics: MetricRepository;
}

const UUID_SCHEMA = z.string().uuid();

/**
 * Maximum window of the metric history endpoint. Larger spans cannot
 * satisfy the 1000-bucket cap at any legal bucket size and are rejected
 * up front; the actual bucket count is checked separately.
 */
export const MAX_METRIC_HISTORY_WINDOW_DAYS = 366;

function badRequest(reply: FastifyReply, message: string): void {
  reply.status(400).send({ error: { code: 'bad_request', message } });
}

/**
 * Parse untrusted query input; returns a client-safe message naming only
 * our own parameter paths (never raw input values) or `''` on success.
 */
function queryProblem(schema: ZodType, data: unknown): string {
  const result = schema.safeParse(data);
  if (result.success) return '';
  const paths = result.error.issues
    .map((issue) => (issue.path.length > 0 ? issue.path.join('.') : '(query)'))
    .slice(0, 8);
  return `Invalid query parameter(s): ${paths.join(', ')}.`;
}

/** Project a stored request row onto the public summary contract. */
function toSummary(row: StoredRequest): RequestSummary {
  const summary: Record<string, unknown> = {
    id: row.id,
    origin: row.origin,
    endpoint: row.endpoint,
    method: row.method,
    status: row.status,
    startedAtUtc: row.startedAtUtc,
    promptBytes: row.promptBytes,
    responseBytes: row.responseBytes,
  };
  // NULL database values are omitted so the UI can tell "not reported"
  // from a legitimate zero; free-text columns (errorMessage) have no
  // contract field and are never copied.
  const optionals: Array<[string, unknown]> = [
    ['model', row.model],
    ['httpStatus', row.httpStatus],
    ['completedAtUtc', row.completedAtUtc],
    ['durationMs', row.durationMs],
    ['ttftMs', row.ttftMs],
    ['promptTokens', row.promptTokens],
    ['completionTokens', row.completionTokens],
    ['totalTokens', row.totalTokens],
    ['prefixCacheQueries', row.prefixCacheQueries],
    ['prefixCacheHits', row.prefixCacheHits],
    ['mtpDraftTokens', row.mtpDraftTokens],
    ['mtpAcceptedTokens', row.mtpAcceptedTokens],
    ['errorCode', row.errorCode],
  ];
  for (const [key, value] of optionals) {
    if (value !== null && value !== undefined) summary[key] = value;
  }
  return summary as RequestSummary;
}

export function registerHistory(app: FastifyInstance, options: HistoryOptions): void {
  app.get('/api/requests', async (request, reply) => {
    const problem = queryProblem(RequestListQuerySchema, request.query);
    if (problem !== '') return badRequest(reply, problem);
    const query = RequestListQuerySchema.parse(request.query);

    if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
      return badRequest(reply, '`to` must not be earlier than `from`.');
    }

    const filters: CursorFilterSet = {
      id: query.id,
      status: query.status,
      model: query.model,
      from: query.from,
      to: query.to,
    };
    let cursor: { startedAtUtc: string; requestId: string } | undefined;
    if (query.cursor !== undefined) {
      try {
        cursor = decodeCursor(query.cursor, filters);
      } catch (error) {
        if (error instanceof CursorError) {
          return badRequest(reply, 'Invalid pagination cursor.');
        }
        throw error;
      }
    }

    const limit = query.limit ?? DEFAULT_REQUEST_PAGE_SIZE;
    const page = options.requests.listPage({
      id: query.id,
      status: query.status,
      model: query.model,
      fromUtc: query.from,
      toUtc: query.to,
      limit,
      cursor,
    });

    const last = page.items[page.items.length - 1];
    const payload = {
      items: page.items.map(toSummary),
      nextCursor:
        page.hasMore && last !== undefined
          ? encodeCursor({ startedAtUtc: last.startedAtUtc, requestId: last.id }, filters)
          : null,
    };
    // Runtime validation against the shared contract before the body leaves.
    return RequestListResponseSchema.parse(payload);
  });

  app.get('/api/requests/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!UUID_SCHEMA.safeParse(id).success) {
      return badRequest(reply, '`id` must be a valid request UUID.');
    }
    const row = options.requests.get(id);
    if (row === undefined) {
      reply.status(404).send({ error: { code: 'not_found', message: 'Request not found.' } });
      return;
    }
    const events = options.requests.listEvents(id).map((event) => ({
      sequence: event.sequence,
      eventType: event.eventType,
      atUtc: event.atUtc,
    }));
    const payload = { ...toSummary(row), events };
    return RequestDetailSchema.parse(payload);
  });

  app.get('/api/metrics/history', async (request, reply) => {
    const problem = queryProblem(MetricsHistoryQuerySchema, request.query);
    if (problem !== '') return badRequest(reply, problem);
    const query = MetricsHistoryQuerySchema.parse(request.query);

    const series = findMetricSeries(query.series);
    if (series === undefined) {
      return badRequest(reply, 'Unknown metric series.');
    }
    if (query.from > query.to) {
      return badRequest(reply, '`to` must not be earlier than `from`.');
    }
    const fromMs = Date.parse(query.from);
    const toMs = Date.parse(query.to);
    const spanMs = toMs - fromMs;
    if (spanMs > MAX_METRIC_HISTORY_WINDOW_DAYS * 86_400_000) {
      return badRequest(reply, 'Time window is too large for this endpoint.');
    }
    // Buckets are aligned to the Unix epoch in SQLite. Counting only the
    // elapsed intervals is off by one when a non-aligned window crosses a
    // bucket boundary near either end (and could let 1001 rows reach the
    // response schema as a 500). Count the actual aligned bucket indices.
    const bucketWidthMs = query.bucketSeconds * 1000;
    const bucketCount = Math.floor(toMs / bucketWidthMs) - Math.floor(fromMs / bucketWidthMs) + 1;
    if (bucketCount > MAX_METRIC_HISTORY_BUCKETS) {
      return badRequest(
        reply,
        `Series would contain ${bucketCount} buckets (maximum ${MAX_METRIC_HISTORY_BUCKETS}); ` +
          'increase bucketSeconds or narrow the window.'
      );
    }

    const buckets = options.metrics.aggregateHistory({
      source: series.source,
      name: series.name,
      ...(series.labelKey !== undefined ? { labelKey: series.labelKey } : {}),
      fromUtc: query.from,
      toUtc: query.to,
      bucketSeconds: query.bucketSeconds,
    });
    const payload = {
      series: query.series,
      unit: series.unit,
      bucketSeconds: query.bucketSeconds,
      buckets,
    };
    return MetricsHistoryResponseSchema.parse(payload);
  });
}
