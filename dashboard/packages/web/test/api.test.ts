import { describe, expect, it, vi } from 'vitest';
import { fetchAuthSession, fetchHealth, HealthFetchError, login, logout } from '../src/lib/api.js';

const VALID_PAYLOAD = {
  service: 'local-ai-b70-observatory',
  status: 'ok',
  version: '0.1.0',
  startedAt: '2025-01-01T10:00:00.000Z',
  timestamp: '2025-01-01T10:00:30.000Z',
  uptimeSeconds: 30,
  checks: [{ name: 'server', status: 'ok' }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchHealth', () => {
  it('returns a validated payload for a valid health response', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse(VALID_PAYLOAD);
    const payload = await fetchHealth({ fetchImpl });
    expect(payload).toEqual(VALID_PAYLOAD);
  });

  it('sends an Accept header for JSON', async () => {
    let seenHeaders: Headers | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      seenHeaders = new Headers(init?.headers);
      return jsonResponse(VALID_PAYLOAD);
    };
    await fetchHealth({ fetchImpl });
    expect(seenHeaders?.get('accept')).toBe('application/json');
  });

  it('maps a network failure to code "network"', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError('fetch failed');
    };
    const promise = fetchHealth({ fetchImpl });
    await expect(promise).rejects.toMatchObject({ code: 'network' });
    await expect(promise).rejects.toBeInstanceOf(HealthFetchError);
  });

  it('maps HTTP error responses to code "http" including the status code', async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ error: { code: 'internal_error', message: 'boom' } }, 500);
    const promise = fetchHealth({ fetchImpl });
    await expect(promise).rejects.toMatchObject({ code: 'http' });
    await expect(promise).rejects.toThrow(/500/);
  });

  it('maps non-JSON responses to code "invalid_payload"', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('<html>gateway timeout</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    const promise = fetchHealth({ fetchImpl });
    await expect(promise).rejects.toMatchObject({ code: 'invalid_payload' });
  });

  it('rejects JSON that violates the shared contract', async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ ...VALID_PAYLOAD, prompt: 'raw content leak' });
    const promise = fetchHealth({ fetchImpl });
    await expect(promise).rejects.toMatchObject({ code: 'invalid_payload' });
  });

  it('rejects a contract-valid payload for the wrong service', async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ ...VALID_PAYLOAD, service: 'something-else' });
    const promise = fetchHealth({ fetchImpl });
    await expect(promise).rejects.toMatchObject({ code: 'invalid_payload' });
  });

  it('uses the global fetch and the same-origin /api/health path by default', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jsonResponse(VALID_PAYLOAD));
    const payload = await fetchHealth();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe('/api/health');
    expect(payload.status).toBe('ok');
  });
});

describe('browser authentication API', () => {
  it('uses same-origin cookie requests and puts the password only in the JSON body', async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ input: String(input), init });
      return jsonResponse({ authenticated: true, expiresAt: '2025-02-01T10:00:00.000Z' });
    };
    await login('top secret', fetchImpl);
    expect(calls[0]?.input).toBe('/api/auth/login');
    expect(calls[0]?.input).not.toContain('secret');
    expect(calls[0]?.init?.credentials).toBe('same-origin');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ password: 'top secret' }));
  });

  it('parses anonymous status and logout responses', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ authenticated: false });
    await expect(fetchAuthSession(fetchImpl)).resolves.toEqual({ authenticated: false });
    await expect(logout(fetchImpl)).resolves.toEqual({ authenticated: false });
  });
});
