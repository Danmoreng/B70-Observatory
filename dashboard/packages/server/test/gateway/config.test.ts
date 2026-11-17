import { describe, expect, it } from 'vitest';
import { ConfigError, loadServerConfig } from '../../src/config.js';

/** Unit tests for the M3 gateway/upstream configuration surface. */
describe('server config: upstream (M3)', () => {
  it('defaults to the production vLLM address with sane limits', () => {
    const config = loadServerConfig({});
    expect(config.upstreamUrl).toBe('http://127.0.0.1:8081');
    expect(config.upstreamTimeoutMs).toBe(15_000);
    expect(config.upstreamStreamIdleTimeoutMs).toBe(120_000);
    expect(config.upstreamMaxResponseBytes).toBe(16 * 1024 * 1024);
  });

  it('accepts explicit http(s) upstream URLs (LAN addresses allowed)', () => {
    expect(
      loadServerConfig({ OBSERVATORY_UPSTREAM_URL: 'http://192.168.1.50:8081' }).upstreamUrl
    ).toBe('http://192.168.1.50:8081');
    expect(loadServerConfig({ OBSERVATORY_UPSTREAM_URL: 'https://llm.local' }).upstreamUrl).toBe(
      'https://llm.local'
    );
  });

  it('accepts a path in the upstream URL but nothing else that can carry secrets', () => {
    // A base path is legitimate (reverse proxies); credentials, query
    // strings and fragments are not – the URL is logged at startup.
    expect(
      loadServerConfig({ OBSERVATORY_UPSTREAM_URL: 'http://127.0.0.1:8081/v1' }).upstreamUrl
    ).toBe('http://127.0.0.1:8081/v1');
  });

  it('rejects URLs with embedded credentials (user, password or both)', () => {
    // The URL is logged verbatim at startup; credentials must never ride
    // along in it – they belong in request headers only.
    for (const value of [
      'http://user@127.0.0.1:8081',
      'http://user:pass@127.0.0.1:8081',
      'https://user:pass@llm.local',
      'http://:pass@127.0.0.1:8081',
    ]) {
      expect(() => loadServerConfig({ OBSERVATORY_UPSTREAM_URL: value })).toThrowError(ConfigError);
    }
  });

  it('rejects URLs with query strings or fragments', () => {
    // Query strings and fragments are the classic carrier for secrets
    // (tokens, API keys) and would be leaked via the startup log line.
    for (const value of [
      'http://127.0.0.1:8081?token=abc',
      'http://127.0.0.1:8081/v1?key=value',
      'https://llm.local#fragment',
      'https://llm.local?x=1#y',
    ]) {
      expect(() => loadServerConfig({ OBSERVATORY_UPSTREAM_URL: value })).toThrowError(ConfigError);
    }
  });

  it('rejects non-http(s) schemes and unparsable URLs with ConfigError', () => {
    for (const value of ['ftp://127.0.0.1:8081', 'not a url', '127.0.0.1:8081', 'file:///x']) {
      expect(() => loadServerConfig({ OBSERVATORY_UPSTREAM_URL: value })).toThrowError(ConfigError);
    }
  });

  it('rejects timeouts outside the allowed ranges', () => {
    const invalid = [
      { OBSERVATORY_UPSTREAM_TIMEOUT_MS: '0' },
      { OBSERVATORY_UPSTREAM_TIMEOUT_MS: 'not-a-number' },
      { OBSERVATORY_UPSTREAM_STREAM_IDLE_TIMEOUT_MS: '-5' },
    ];
    for (const env of invalid) {
      expect(() => loadServerConfig(env)).toThrowError(ConfigError);
    }
  });

  it('accepts explicit numeric overrides', () => {
    const config = loadServerConfig({
      OBSERVATORY_UPSTREAM_TIMEOUT_MS: '300',
      OBSERVATORY_UPSTREAM_STREAM_IDLE_TIMEOUT_MS: '200',
      OBSERVATORY_UPSTREAM_MAX_RESPONSE_BYTES: '1024',
    });
    expect(config.upstreamTimeoutMs).toBe(300);
    expect(config.upstreamStreamIdleTimeoutMs).toBe(200);
    expect(config.upstreamMaxResponseBytes).toBe(1024);
  });

  it('rejects an oversized response limit', () => {
    expect(() =>
      loadServerConfig({ OBSERVATORY_UPSTREAM_MAX_RESPONSE_BYTES: String(1024 * 1024 * 1024) })
    ).toThrowError(ConfigError);
  });
});

describe('explicit inference authentication policy', () => {
  it('defaults to token authentication', () => {
    expect(loadServerConfig({}).gatewayAuthMode).toBe('token');
  });
  it('rejects unknown policies', () => {
    expect(() => loadServerConfig({ OBSERVATORY_GATEWAY_AUTH_MODE: 'public' })).toThrow(
      ConfigError
    );
  });
});
