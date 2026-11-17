import type { DatabaseSync } from 'node:sqlite';
import type { ZodType } from 'zod';
import { ChangeSignal } from './change-signal.js';
import { DatabaseError, DbContractError } from './errors.js';
import {
  NewRequestSchema,
  RequestEventSchema,
  RequestResultSchema,
  RequestStatusSchema,
  type NewRequest,
  type RequestEvent,
  type RequestResult,
  type RequestStatus,
} from './contracts.js';

function parseOrThrow<T>(schema: ZodType<T>, what: string, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new DbContractError(what, result.error.issues);
  }
  return result.data;
}

export interface StoredRequestEvent {
  id: number;
  requestId: string;
  sequence: number;
  eventType: string;
  atUtc: string;
  detail: string | null;
}

export interface StoredRequest {
  id: string;
  origin: string;
  model: string | null;
  endpoint: string;
  method: string;
  status: string;
  httpStatus: number | null;
  startedAtUtc: string;
  completedAtUtc: string | null;
  durationMs: number | null;
  ttftMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  promptBytes: number;
  responseBytes: number;
  prefixCacheQueries: number | null;
  prefixCacheHits: number | null;
  mtpDraftTokens: number | null;
  mtpAcceptedTokens: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface RequestFilter {
  status?: RequestStatus;
  model?: string;
  /** Include requests started at or after this instant. */
  sinceUtc?: string;
  /** Include requests started strictly before this instant. */
  untilUtc?: string;
  limit?: number;
}

/**
 * Filter set for keyset (cursor) pagination of the request list (M5A).
 * Ordering is always newest first: `(startedAtUtc DESC, id DESC)`. The
 * keyset cursor is a stable pair `(startedAtUtc, id)`; equal timestamps are
 * tie-broken by the (unique) request id, so pages are deterministic even
 * when many requests share one millisecond.
 */
export interface RequestPageQuery {
  /** Exact request-ID filter. */
  id?: string;
  status?: RequestStatus;
  /** Exact model-name filter. */
  model?: string;
  /** Include requests started at or after this instant (canonical UTC). */
  fromUtc?: string;
  /** Include requests started at or before this instant (canonical UTC). */
  toUtc?: string;
  /** Page size (1–200); the repository requests one extra row internally. */
  limit: number;
  /**
   * Keyset position to start *after* (DESC order). The caller must have
   * decoded and re-validated the cursor; these are plain trusted values.
   */
  cursor?: { startedAtUtc: string; requestId: string };
}

/** One page of the request list plus a stable "another page exists" flag. */
export interface RequestPage {
  items: StoredRequest[];
  /**
   * Whether at least one more row follows in the same filter set. Derived
   * by requesting `limit + 1` rows: `nextCursor` is only handed to clients
   * when this is true, so a cursor never points into an empty page.
   */
  hasMore: boolean;
}

/**
 * Repository for the `requests` table and its `request_events` child rows.
 * All inputs are parsed against the Zod contracts before reaching SQLite;
 * all statements are parameterized (no string interpolation of user data).
 */
export class RequestRepository {
  readonly changes = new ChangeSignal();
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Insert a new request in `in_progress` state. Returns the request id.
   * `responseBytes` is intentionally not accepted here – the response
   * size is only known when the request finishes (M2 review finding 3);
   * the column keeps its `0` default until `finish()` updates it.
   */
  create(input: unknown): string {
    const request = parseOrThrow(NewRequestSchema, 'new request', input) as NewRequest;
    this.db
      .prepare(
        'INSERT INTO requests (id, origin, model, endpoint, method, status, startedAtUtc, promptBytes) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        request.id,
        request.origin,
        request.model ?? null,
        request.endpoint,
        request.method,
        'in_progress',
        request.startedAtUtc,
        request.promptBytes
      );
    this.changes.notify();
    return request.id;
  }

  /**
   * Whether a request row with this id already exists. Used by the gateway
   * to resolve client-supplied `x-request-id` values deterministically:
   * a valid UUID that names an existing request must never be reused.
   */
  exists(requestId: string): boolean {
    const row = this.db.prepare('SELECT 1 AS found FROM requests WHERE id = ?').get(requestId);
    return row !== undefined;
  }

  /**
   * Append a lifecycle event. `sequence` is assigned automatically
   * (last + 1). Fails with `unknown_request` if the request row does not
   * exist; the foreign key is a second, independent guard.
   *
   * @returns the new event id.
   */
  appendEvent(input: unknown): number {
    const event = parseOrThrow(RequestEventSchema, 'request event', input) as RequestEvent;
    this.ensureRequestExists(event.requestId);
    const row = this.db
      .prepare('SELECT COALESCE(MAX(sequence), 0) AS last FROM request_events WHERE requestId = ?')
      .get(event.requestId) as { last: number } | undefined;
    const sequence = (row?.last ?? 0) + 1;
    const result = this.db
      .prepare(
        'INSERT INTO request_events (requestId, sequence, eventType, atUtc, detail) ' +
          'VALUES (?, ?, ?, ?, ?)'
      )
      .run(event.requestId, sequence, event.eventType, event.atUtc, null);
    this.changes.notify();
    return Number(result.lastInsertRowid);
  }

  /** Transition a request to a terminal state (completed/error/aborted).
   * `responseBytes` is required: the full response size is only known at
   * this point (M2 review finding 3). Other optional fields are stored
   * as NULL when omitted. */
  finish(input: unknown): void {
    const result = parseOrThrow(RequestResultSchema, 'request result', input) as RequestResult;
    this.ensureRequestExists(result.requestId);
    const columns: Array<[string, string | number | null]> = [
      ['status', result.status],
      ['completedAtUtc', result.completedAtUtc],
      ['durationMs', result.durationMs],
      ['responseBytes', result.responseBytes],
      ['ttftMs', result.ttftMs ?? null],
      ['httpStatus', result.httpStatus ?? null],
      ['promptTokens', result.promptTokens ?? null],
      ['completionTokens', result.completionTokens ?? null],
      ['totalTokens', result.totalTokens ?? null],
      ['prefixCacheQueries', result.prefixCacheQueries ?? null],
      ['prefixCacheHits', result.prefixCacheHits ?? null],
      ['mtpDraftTokens', result.mtpDraftTokens ?? null],
      ['mtpAcceptedTokens', result.mtpAcceptedTokens ?? null],
      ['errorCode', result.errorCode ?? null],
    ];
    const setClause = columns.map((column) => `${column[0]} = ?`).join(', ');
    this.db
      .prepare(`UPDATE requests SET ${setClause} WHERE id = ?`)
      .run(...columns.map((column) => column[1]), result.requestId);
    this.changes.notify();
  }

  /** Update only `status` (e.g. marking a request aborted mid-stream). */
  setStatus(requestId: string, status: string): void {
    const parsed = RequestStatusSchema.safeParse(status);
    if (!parsed.success) {
      throw new DbContractError('request status', parsed.error.issues);
    }
    this.ensureRequestExists(requestId);
    this.db.prepare('UPDATE requests SET status = ? WHERE id = ?').run(parsed.data, requestId);
    this.changes.notify();
  }

  /** Delete a request; child events cascade (FK ON DELETE CASCADE). */
  delete(requestId: string): void {
    this.db.prepare('DELETE FROM requests WHERE id = ?').run(requestId);
    this.changes.notify();
  }

  get(requestId: string): StoredRequest | undefined {
    const row = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId);
    return row === undefined ? undefined : (row as unknown as StoredRequest);
  }

  list(filter: RequestFilter = {}): StoredRequest[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.status !== undefined) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter.model !== undefined) {
      clauses.push('model = ?');
      params.push(filter.model);
    }
    if (filter.sinceUtc !== undefined) {
      clauses.push('startedAtUtc >= ?');
      params.push(filter.sinceUtc);
    }
    if (filter.untilUtc !== undefined) {
      clauses.push('startedAtUtc < ?');
      params.push(filter.untilUtc);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(1, Math.trunc(filter.limit ?? 100)), 1000);
    const rows = this.db
      .prepare(`SELECT * FROM requests${where} ORDER BY startedAtUtc ASC LIMIT ?`)
      .all(...params, limit) as unknown as StoredRequest[];
    return rows;
  }

  /**
   * One page of the request list in newest-first keyset order (M5A).
   * No `OFFSET` is used: the cursor row is bound as
   * `(startedAtUtc, id) < (cursor.startedAtUtc, cursor.requestId)` in
   * descending order, which stays stable under concurrent inserts and
   * makes "no duplicate, no gap between pages" a property of the query.
   * One extra row beyond `limit` is fetched purely to decide `hasMore`.
   */
  listPage(query: RequestPageQuery): RequestPage {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query.id !== undefined) {
      clauses.push('id = ?');
      params.push(query.id);
    }
    if (query.status !== undefined) {
      clauses.push('status = ?');
      params.push(query.status);
    }
    if (query.model !== undefined) {
      clauses.push('model = ?');
      params.push(query.model);
    }
    if (query.fromUtc !== undefined) {
      clauses.push('startedAtUtc >= ?');
      params.push(query.fromUtc);
    }
    if (query.toUtc !== undefined) {
      clauses.push('startedAtUtc <= ?');
      params.push(query.toUtc);
    }
    if (query.cursor !== undefined) {
      clauses.push('(startedAtUtc < ? OR (startedAtUtc = ? AND id < ?))');
      params.push(query.cursor.startedAtUtc, query.cursor.startedAtUtc, query.cursor.requestId);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(1, Math.trunc(query.limit)), 200);
    const rows = this.db
      .prepare(`SELECT * FROM requests${where} ORDER BY startedAtUtc DESC, id DESC LIMIT ?`)
      .all(...params, limit + 1) as unknown as StoredRequest[];
    const hasMore = rows.length > limit;
    return { items: hasMore ? rows.slice(0, limit) : rows, hasMore };
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number };
    return row.n;
  }

  listEvents(requestId: string): StoredRequestEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM request_events WHERE requestId = ? ORDER BY sequence ASC')
      .all(requestId) as unknown as StoredRequestEvent[];
    return rows;
  }

  countEvents(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM request_events').get() as { n: number };
    return row.n;
  }

  private ensureRequestExists(requestId: string): void {
    const row = this.db.prepare('SELECT 1 AS found FROM requests WHERE id = ?').get(requestId);
    if (row === undefined) {
      throw new DatabaseError(`request ${requestId} does not exist`, 'unknown_request');
    }
  }
}
