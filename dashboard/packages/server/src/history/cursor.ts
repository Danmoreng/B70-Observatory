import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Opaque pagination cursors for the request list (M5A).
 *
 * A cursor is a base64url-encoded JSON object carrying:
 * - the keyset position (`startedAtUtc` + `id`) of the last row of the page
 *   the cursor was issued for, and
 * - a SHA-256 digest over the *entire* payload: the keyset position plus
 *   the filter set the page was computed with (`id`, `status`, `model`,
 *   `from`, `to`).
 *
 * On every request the digest is re-computed from the *current* query and
 * compared in constant time: a cursor that is malformed, truncated, casually
 * altered or simply belongs to a different filter set is rejected with 400
 * before anything touches SQLite. This is a consistency check, not a
 * cryptographic authenticity guarantee: the digest is intentionally unkeyed
 * because a cursor only narrows already-authorized read access. Clients still
 * treat the value as an opaque, URL-safe string.
 */

/** Filter set a cursor is bound to (canonical, query-string level names). */
export interface CursorFilterSet {
  id?: string;
  status?: string;
  model?: string;
  from?: string;
  to?: string;
}

/** Stable keyset position of one request row. */
export interface CursorPosition {
  startedAtUtc: string;
  requestId: string;
}

/** Raised for any cursor that is malformed, truncated or filter-mismatched. */
export class CursorError extends Error {
  readonly code = 'invalid_cursor';

  constructor(message: string) {
    super(message);
    this.name = 'CursorError';
  }
}

const CURSOR_MAX_LENGTH = 512;
const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;
const CANONICAL_UTC_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/;

const CursorPayloadSchema = z
  .object({
    v: z.literal(1),
    /** Keyset anchor: canonical UTC start instant of the page's last row. */
    s: z.string().min(1).max(64),
    /** Keyset anchor: request id of the page's last row. */
    i: z.string().uuid(),
    /** SHA-256 hex digest binding the cursor to its filter set. */
    f: z.string().regex(SHA256_HEX_REGEX),
  })
  .strict();

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Deterministic digest binding a cursor to its full payload (stable JSON
 * key order): keyset position *and* filter set. Tampering with a single
 * field without updating the digest, or reusing the cursor for a different
 * query, invalidates it. This is not an HMAC and is not an authorization
 * boundary.
 */
export function cursorPayloadKey(position: CursorPosition, filters: CursorFilterSet): string {
  return sha256Hex(
    JSON.stringify({
      s: position.startedAtUtc,
      i: position.requestId,
      id: filters.id ?? null,
      status: filters.status ?? null,
      model: filters.model ?? null,
      from: filters.from ?? null,
      to: filters.to ?? null,
    })
  );
}

/** Encode a keyset position bound to `filters` as an opaque URL-safe string. */
export function encodeCursor(position: CursorPosition, filters: CursorFilterSet): string {
  const payload = {
    v: 1,
    s: position.startedAtUtc,
    i: position.requestId,
    f: cursorPayloadKey(position, filters),
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decode and re-validate a cursor against the *current* filter set.
 * Throws {@link CursorError} (mapped to HTTP 400) when the cursor is
 * malformed, exceeds the size bound, fails the payload contract or does not
 * match the current filters.
 */
export function decodeCursor(cursor: string, filters: CursorFilterSet): CursorPosition {
  if (cursor.length === 0 || cursor.length > CURSOR_MAX_LENGTH) {
    throw new CursorError('cursor exceeds its size bound');
  }
  if (!BASE64URL_REGEX.test(cursor)) {
    throw new CursorError('cursor contains characters outside the URL-safe alphabet');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new CursorError('cursor is not valid encoded JSON');
  }
  const parsed = CursorPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CursorError('cursor payload fails the expected contract');
  }
  if (
    !CANONICAL_UTC_REGEX.test(parsed.data.s) ||
    new Date(parsed.data.s).toISOString() !== parsed.data.s
  ) {
    throw new CursorError('cursor carries a non-canonical timestamp');
  }
  const expected = Buffer.from(
    cursorPayloadKey({ startedAtUtc: parsed.data.s, requestId: parsed.data.i }, filters),
    'utf8'
  );
  const actual = Buffer.from(parsed.data.f, 'utf8');
  if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) {
    throw new CursorError('cursor does not match the current filter set');
  }
  return { startedAtUtc: parsed.data.s, requestId: parsed.data.i };
}
