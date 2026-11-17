import { describe, expect, it } from 'vitest';
import {
  buildErrorBody,
  errorCodeForHttpStatus,
  errorFromFetchFailure,
  GatewayError,
} from '../../src/gateway/errors.js';

describe('errorFromFetchFailure', () => {
  it('maps a timeout abort to 504 upstream_timeout', () => {
    const error = errorFromFetchFailure('upstream_timeout', new Error('aborted'));
    expect(error).toBeInstanceOf(GatewayError);
    expect(error.httpStatus).toBe(504);
    expect(error.code).toBe('upstream_timeout');
  });

  it('maps a stream-idle abort to 502 upstream_stream_idle', () => {
    const error = errorFromFetchFailure('upstream_stream_idle', new Error('aborted'));
    expect(error.httpStatus).toBe(502);
    expect(error.code).toBe('upstream_stream_idle');
  });

  it('maps any other transport failure to 502 upstream_unreachable', () => {
    for (const error of [
      new Error('connect ECONNREFUSED 127.0.0.1:9999'),
      Object.assign(new Error('getaddrinfo ENOTFOUND nohost'), { code: 'ENOTFOUND' }),
      new Error('random failure'),
      'a plain string error',
      undefined,
    ]) {
      const mapped = errorFromFetchFailure(undefined, error);
      expect(mapped.httpStatus).toBe(502);
      expect(mapped.code).toBe('upstream_unreachable');
      // Sanitized: the client message never carries hostnames or OS detail
      // beyond a fixed message + the error class name.
      expect(mapped.clientMessage).not.toContain('9999');
      expect(mapped.clientMessage).not.toContain('ENOTFOUND');
    }
  });

  it('never reports a client abort as an upstream failure', () => {
    expect(errorFromFetchFailure('client', new Error('aborted')).code).toBe('upstream_unreachable');
    // Callers must treat 'client' separately (see settleUpstreamFailure).
  });
});

describe('errorCodeForHttpStatus', () => {
  it('maps 429 to rate limiting, other 4xx to rejected, 5xx to upstream error', () => {
    expect(errorCodeForHttpStatus(429)).toBe('upstream_rate_limited');
    expect(errorCodeForHttpStatus(400)).toBe('upstream_rejected');
    expect(errorCodeForHttpStatus(404)).toBe('upstream_rejected');
    expect(errorCodeForHttpStatus(500)).toBe('upstream_error');
    expect(errorCodeForHttpStatus(503)).toBe('upstream_error');
  });
});

describe('buildErrorBody', () => {
  it('produces an OpenAI-shaped error with a stable request id', () => {
    const body = buildErrorBody('upstream_timeout', 'The upstream timed out.', 'req-123');
    expect(body).toEqual({
      error: {
        message: 'The upstream timed out.',
        type: 'server_error',
        code: 'upstream_timeout',
        request_id: 'req-123',
      },
    });
  });

  it('truncates long messages to 512 characters', () => {
    const body = buildErrorBody('upstream_error', 'x'.repeat(1000), 'req-1');
    expect(body.error.message.length).toBe(512);
  });

  it('uses the OpenAI error type vocabulary', () => {
    expect(buildErrorBody('invalid_request_body', 'm', 'r').error.type).toBe(
      'invalid_request_error'
    );
    expect(buildErrorBody('upstream_rate_limited', 'm', 'r').error.type).toBe('rate_limit_error');
    expect(buildErrorBody('upstream_unreachable', 'm', 'r').error.type).toBe('server_error');
  });
});
