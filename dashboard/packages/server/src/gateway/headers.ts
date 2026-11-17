import type { IncomingHttpHeaders } from 'node:http';
import { RequestOriginSchema, type RequestOrigin } from '../db/contracts.js';

/**
 * Request headers that the gateway forwards to the upstream, verbatim.
 *
 * This is a deliberately tight allowlist (project brief: "Header dürfen nur
 * über eine enge Allowlist behandelt werden"):
 *
 * - `authorization`: the client's credential for the upstream. It is
 *   forwarded (vLLM deployments may require one) but is **never** logged,
 *   never placed into URLs and never persisted.
 * - `content-type`: required so the upstream parses the forwarded body
 *   correctly; the body itself is forwarded byte-for-byte.
 * - `accept`: harmless client preference; forwarded for transparency.
 * - `x-observatory-origin`: telemetry-only label of the calling context
 *   (`web` | `pi` | `script` | `cli ...); not forwarded as-is elsewhere.
 *
 * - `x-api-key`, `anthropic-version`, `anthropic-beta`, `openai-beta`:
 *   native Messages/Responses protocol headers. Credentials are never logged.
 *
 * Everything else (cookies, hop-by-hop headers, other custom client headers,
 * `user-agent`, …) is dropped before the request leaves this process.
 */
const REQUEST_HEADER_ALLOWLIST: ReadonlyArray<string> = [
  'accept',
  'authorization',
  'content-type',
  'x-api-key',
  'anthropic-version',
  'anthropic-beta',
  'openai-beta',
];

export const ORIGIN_HEADER = 'x-observatory-origin';

/** Response header used to make the request id visible to clients. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Build the header set that goes to the upstream. Names are normalized to
 * lowercase; values that are `undefined` or empty are skipped. The input is
 * treated as untrusted and only the allowlisted names survive.
 */
export function pickForwardedHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of REQUEST_HEADER_ALLOWLIST) {
    const value = headers[name];
    if (value === undefined || value === '') continue;
    picked[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return picked;
}

/**
 * Resolve the telemetry origin for a request from the allowlisted
 * `x-observatory-origin` header. Anything missing or not matching the
 * database enum falls back to `unknown` (silently – it is a label, not an
 * authentication channel).
 */
export function requestOrigin(headers: IncomingHttpHeaders): RequestOrigin {
  const raw = headers[ORIGIN_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return 'unknown';
  const parsed = RequestOriginSchema.safeParse(String(value).trim().toLowerCase());
  return parsed.success ? parsed.data : 'unknown';
}

/**
 * Whether a client-supplied `x-request-id` is acceptable. Only canonical
 * UUIDs are honored so the id can be stored (the `requests` table requires
 * UUID primary keys) and so the client cannot smuggle unbounded or unsafe
 * strings into logs, error bodies or the database. Anything else gets a
 * freshly generated id instead.
 */
export function resolveRequestId(incoming: string | string[] | undefined): {
  id: string;
  /** True if the value came from the client (not generated here). */
  supplied: boolean;
} {
  if (incoming === undefined) {
    return { id: randomUuid(), supplied: false };
  }
  const candidate = Array.isArray(incoming) ? (incoming[0] ?? '') : incoming;
  const trimmed = candidate.trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return { id: trimmed.toLowerCase(), supplied: true };
  }
  return { id: randomUuid(), supplied: false };
}

export function randomUuid(): string {
  // crypto.randomUUID: version 4, stable format, no deprecation risk.
  return globalThis.crypto.randomUUID();
}
