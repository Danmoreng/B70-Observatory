/**
 * Gateway failure model.
 *
 * Every gateway failure has exactly one machine-readable `code`. Codes are
 * the same vocabulary that is persisted into `requests.errorCode`
 * (`[a-z0-9_.-]+`, max 64 chars – see the M2 write contracts), so no
 * translation is needed between the client-facing error body and the
 * database row. Codes carry no raw content: no upstream URLs, no request
 * bodies, no credentials.
 */
export type GatewayErrorCode =
  | 'invalid_request_body'
  | 'invalid_content_type'
  | 'request_too_large'
  | 'upstream_unreachable'
  | 'upstream_timeout'
  | 'upstream_stream_idle'
  | 'upstream_stream_interrupted'
  | 'upstream_rejected'
  | 'upstream_rate_limited'
  | 'upstream_error'
  | 'upstream_response_too_large'
  | 'internal_error';

/** What caused an in-flight upstream request to be aborted. */
export type AbortCause = 'client' | 'upstream_timeout' | 'upstream_stream_idle' | 'upstream';

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly httpStatus: number;
  /** Short, sanitized message that is safe to show to the client. */
  readonly clientMessage: string;

  constructor(code: GatewayErrorCode, httpStatus: number, clientMessage: string) {
    super(`${code}: ${clientMessage}`);
    this.name = 'GatewayError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.clientMessage = clientMessage;
  }
}

/** OpenAI-compatible error envelope for gateway-originated failures. */
export interface OpenAiErrorBody {
  error: {
    message: string;
    /** OpenAI-style error classification (invalid_request_error/server_error). */
    type: string;
    /** Observability-specific machine code (see `GatewayErrorCode`). */
    code: string;
    /** Stable request id so the client can correlate with the dashboard. */
    request_id: string;
  };
}

export function buildErrorBody(
  code: GatewayErrorCode,
  message: string,
  requestId: string
): OpenAiErrorBody {
  return {
    error: {
      message: message.slice(0, 512),
      type: errorTypeFor(code),
      code,
      request_id: requestId,
    },
  };
}

function errorTypeFor(code: GatewayErrorCode): string {
  switch (code) {
    case 'invalid_request_body':
    case 'invalid_content_type':
    case 'request_too_large':
      return 'invalid_request_error';
    case 'upstream_rejected':
      return 'invalid_request_error';
    case 'upstream_rate_limited':
      return 'rate_limit_error';
    default:
      return 'server_error';
  }
}

export const UPSTREAM_MESSAGES: Record<GatewayErrorCode, string> = {
  invalid_request_body: 'Request body is not valid JSON for this endpoint.',
  invalid_content_type: 'Content-Type must be application/json (or a JSON media type).',
  request_too_large: 'Request body exceeds the configured size limit.',
  upstream_unreachable: 'The upstream model service is not reachable.',
  upstream_timeout: 'The upstream model service did not respond in time.',
  upstream_stream_idle: 'The upstream stream stopped producing data and was aborted.',
  upstream_stream_interrupted: 'The upstream connection was interrupted mid-response.',
  upstream_rejected: 'The upstream model service rejected the request.',
  upstream_rate_limited: 'The upstream model service is rate limiting requests.',
  upstream_error: 'The upstream model service returned an error.',
  upstream_response_too_large: 'The upstream response exceeds the configured size limit.',
  internal_error: 'Internal gateway error.',
};

/**
 * Map a transport-level failure of the upstream `fetch` to a `GatewayError`.
 * `abortCause` disambiguates aborts: a client-initiated abort must NOT be
 * reported as an upstream failure.
 */
export function errorFromFetchFailure(
  abortCause: AbortCause | undefined,
  error: unknown
): GatewayError {
  if (abortCause === 'upstream_timeout') {
    return new GatewayError('upstream_timeout', 504, UPSTREAM_MESSAGES.upstream_timeout);
  }
  if (abortCause === 'upstream_stream_idle') {
    return new GatewayError('upstream_stream_idle', 502, UPSTREAM_MESSAGES.upstream_stream_idle);
  }
  // Anything else (ECONNREFUSED, EAI_AGAIN, socket reset, unknown
  // abort) is reported as "upstream unavailable" – the detail never
  // leaks (no hostnames, no OS error text) beyond this fixed message.
  const detail = error instanceof Error ? error.name : 'error';
  return new GatewayError(
    'upstream_unreachable',
    502,
    `${UPSTREAM_MESSAGES.upstream_unreachable} (${detail})`
  );
}

/** Map an upstream *status* (non-2xx response) to a persisted error code. */
export function errorCodeForHttpStatus(status: number): GatewayErrorCode {
  if (status === 429) return 'upstream_rate_limited';
  if (status >= 500) return 'upstream_error';
  return 'upstream_rejected';
}
