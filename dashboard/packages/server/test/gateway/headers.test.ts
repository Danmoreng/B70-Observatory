import { describe, expect, it } from 'vitest';
import type { IncomingHttpHeaders } from 'node:http';
import {
  ORIGIN_HEADER,
  REQUEST_ID_HEADER,
  pickForwardedHeaders,
  requestOrigin,
  resolveRequestId,
} from '../../src/gateway/headers.js';

describe('pickForwardedHeaders', () => {
  it('keeps only the allowlist (accept, authorization, content-type)', () => {
    const headers: IncomingHttpHeaders = {
      accept: '*/*',
      authorization: 'Bearer fictional-token',
      'content-type': 'application/json',
      cookie: 'session=abc',
      'x-custom-evil': 'nope',
      'user-agent': 'test-agent',
      host: '127.0.0.1:9999',
      connection: 'keep-alive',
    };
    const picked = pickForwardedHeaders(headers);
    expect(picked).toEqual({
      accept: '*/*',
      authorization: 'Bearer fictional-token',
      'content-type': 'application/json',
    });
  });

  it('joins multi-value headers and drops empty ones', () => {
    const raw = {
      accept: ['text/plain', 'application/json'],
      authorization: '',
      'content-type': 'application/json',
    };
    const picked = pickForwardedHeaders(raw as unknown as IncomingHttpHeaders);
    expect(picked.accept).toBe('text/plain, application/json');
    expect(picked.authorization).toBeUndefined();
  });

  it('never includes cookies', () => {
    const picked = pickForwardedHeaders({ cookie: 'a=1', 'content-type': 'application/json' });
    expect(picked.cookie).toBeUndefined();
  });
});

describe('requestOrigin', () => {
  it.each([
    ['web', 'web'],
    ['PI', 'pi'],
    ['  script  ', 'script'],
    ['cli', 'cli'],
    ['unknown', 'unknown'],
  ] as const)('maps %s to %s', (input, expected) => {
    const headers: IncomingHttpHeaders = { [ORIGIN_HEADER]: input };
    expect(requestOrigin(headers)).toBe(expected);
  });

  it("falls back to 'unknown' for missing or invalid values", () => {
    expect(requestOrigin({})).toBe('unknown');
    expect(requestOrigin({ [ORIGIN_HEADER]: 'totally-bogus' })).toBe('unknown');
    expect(requestOrigin({ [ORIGIN_HEADER]: ['web'] })).toBe('web');
  });
});

describe('resolveRequestId', () => {
  const UUID = 'c8f1a3d2-9b6e-4c1a-8d5f-0a1b2c3d4e5f';

  it('accepts a valid UUID from the client (case-insensitive)', () => {
    const upper = UUID.toUpperCase();
    const resolved = resolveRequestId(upper);
    expect(resolved).toEqual({ id: UUID, supplied: true });
  });

  it('generates a fresh UUID for missing or malformed values', () => {
    for (const value of [undefined, '', 'not-a-uuid', 'x'.repeat(36), UUID.slice(0, 10)]) {
      const resolved = resolveRequestId(value);
      expect(resolved.supplied).toBe(false);
      expect(resolved.id).not.toBe(value);
      expect(resolved.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it('takes the first value of a multi-value header', () => {
    const resolved = resolveRequestId([UUID, 'junk']);
    expect(resolved).toEqual({ id: UUID, supplied: true });
  });

  it('exposes the stable response header name', () => {
    expect(REQUEST_ID_HEADER).toBe('x-request-id');
  });
});
