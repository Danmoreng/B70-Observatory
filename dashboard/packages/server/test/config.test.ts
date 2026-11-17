import { describe, expect, it } from 'vitest';
import { ConfigError, loadServerConfig, type ServerEnv } from '../src/config.js';

describe('loadServerConfig', () => {
  it('keeps GPU orchestration opt-in and rejects unprotected or remote image engines', () => {
    expect(loadServerConfig().imageJobsRoot).toBeUndefined();
    expect(() => loadServerConfig({ OBSERVATORY_IMAGE_JOBS_ROOT: '/tmp/images' })).toThrow(
      'authenticated'
    );
    for (const url of [
      'http://example.com:8188',
      'file:///tmp/images',
      'http://127.0.0.1:8188/?secret=x',
    ])
      expect(() => loadServerConfig({ OBSERVATORY_COMFY_URL: url })).toThrow();
  });
  it('applies loopback-safe defaults when the environment is empty', () => {
    expect(loadServerConfig()).toEqual({
      comfyUrl: 'http://127.0.0.1:8188',
      mode: 'development',
      gatewayAuthMode: 'token',
      browserAuthMode: 'password',
      host: '127.0.0.1',
      port: 8090,
      maxRequestBytes: 1024 * 1024,
      dbPath: 'data/observatory.db',
      dbBusyTimeoutMs: 5000,
      retentionDays: 30,
      upstreamUrl: 'http://127.0.0.1:8081',
      upstreamTimeoutMs: 15000,
      upstreamStreamIdleTimeoutMs: 120000,
      upstreamMaxResponseBytes: 16 * 1024 * 1024,
      webRoot: 'packages/web/dist',
      sessionDays: 30,
      cookieSecure: false,
      metricsUrl: 'http://127.0.0.1:8081/metrics',
      metricsIntervalMs: 5000,
      metricsTimeoutMs: 3000,
      telemetryPersistMinIntervalMs: 60000,
      systemIntervalMs: 5000,
      systemTimeoutMs: 2000,
      systemPersistMinIntervalMs: 60000,
      eventBufferSize: 512,
      diskPath: '/',
      gpuHelperSocket: '/run/local-ai-b70-observatory/gpu.sock',
      agentExecutionMode: 'disabled',
      agentRunnerSocket: '/run/local-ai-b70-runner/control.sock',
      agentRunnerToken: undefined,
      releaseHealthToken: undefined,
      passwordHash: undefined,
      gatewayTokenHash: undefined,
    });
  });

  it('accepts explicit loopback hosts, ports, byte limits and database settings', () => {
    const env: ServerEnv = {
      OBSERVATORY_HOST: '::1',
      OBSERVATORY_PORT: '9001',
      OBSERVATORY_MAX_REQUEST_BYTES: '2097152',
      OBSERVATORY_DB_PATH: '/tmp/observatory/test.db',
      OBSERVATORY_DB_BUSY_TIMEOUT_MS: '1000',
      OBSERVATORY_RETENTION_DAYS: '14',
    };
    expect(loadServerConfig(env)).toEqual({
      comfyUrl: 'http://127.0.0.1:8188',
      mode: 'development',
      gatewayAuthMode: 'token',
      browserAuthMode: 'password',
      host: '::1',
      port: 9001,
      maxRequestBytes: 2097152,
      dbPath: '/tmp/observatory/test.db',
      dbBusyTimeoutMs: 1000,
      retentionDays: 14,
      upstreamUrl: 'http://127.0.0.1:8081',
      upstreamTimeoutMs: 15000,
      upstreamStreamIdleTimeoutMs: 120000,
      upstreamMaxResponseBytes: 16 * 1024 * 1024,
      webRoot: 'packages/web/dist',
      sessionDays: 30,
      cookieSecure: false,
      metricsUrl: 'http://127.0.0.1:8081/metrics',
      metricsIntervalMs: 5000,
      metricsTimeoutMs: 3000,
      telemetryPersistMinIntervalMs: 60000,
      systemIntervalMs: 5000,
      systemTimeoutMs: 2000,
      systemPersistMinIntervalMs: 60000,
      eventBufferSize: 512,
      diskPath: '/',
      gpuHelperSocket: '/run/local-ai-b70-observatory/gpu.sock',
      agentExecutionMode: 'disabled',
      agentRunnerSocket: '/run/local-ai-b70-runner/control.sock',
      agentRunnerToken: undefined,
      releaseHealthToken: undefined,
      passwordHash: undefined,
      gatewayTokenHash: undefined,
    });
  });

  it('coerces numeric environment values', () => {
    expect(loadServerConfig({ OBSERVATORY_PORT: '9001' }).port).toBe(9001);
  });

  it('accepts explicit telemetry metrics settings', () => {
    const config = loadServerConfig({
      OBSERVATORY_METRICS_URL: 'http://127.0.0.1:9090/metrics',
      OBSERVATORY_METRICS_INTERVAL_MS: '2500',
      OBSERVATORY_METRICS_TIMEOUT_MS: '1200',
      OBSERVATORY_TELEMETRY_PERSIST_MIN_INTERVAL_MS: '300000',
    });
    expect(config.metricsUrl).toBe('http://127.0.0.1:9090/metrics');
    expect(config.metricsIntervalMs).toBe(2500);
    expect(config.metricsTimeoutMs).toBe(1200);
    expect(config.telemetryPersistMinIntervalMs).toBe(300000);
  });

  it('accepts explicit system collection settings', () => {
    const config = loadServerConfig({
      OBSERVATORY_SYSTEM_INTERVAL_MS: '2500',
      OBSERVATORY_SYSTEM_TIMEOUT_MS: '1200',
      OBSERVATORY_SYSTEM_PERSIST_MIN_INTERVAL_MS: '300000',
      OBSERVATORY_DISK_PATH: '/srv',
      OBSERVATORY_GPU_HELPER_SOCKET: '/run/test/gpu.sock',
    });
    expect(config.systemIntervalMs).toBe(2500);
    expect(config.systemTimeoutMs).toBe(1200);
    expect(config.systemPersistMinIntervalMs).toBe(300000);
    expect(config.eventBufferSize).toBe(512);
    expect(config.diskPath).toBe('/srv');
    expect(config.gpuHelperSocket).toBe('/run/test/gpu.sock');
  });

  it('ignores legacy direct-launch settings and accepts only isolated runner IPC', () => {
    const config = loadServerConfig({
      OBSERVATORY_AGENT_EXECUTABLE: '/opt/pi/bin/pi',
      OBSERVATORY_AGENT_WORKSPACE: '/srv/repository',
      OBSERVATORY_AGENT_PROFILE_DIR: '/srv/pi-profile',
      OBSERVATORY_AGENT_PROVIDER: 'local-provider',
      OBSERVATORY_AGENT_MODEL: 'local-model',
      OBSERVATORY_AGENT_THINKING_LEVEL: 'high',
    });
    expect(config.agentExecutionMode).toBe('disabled');
    expect(config).not.toHaveProperty('agentExecutable');
    expect(config).not.toHaveProperty('agentWorkspace');
    const isolated = loadServerConfig({
      OBSERVATORY_AGENT_EXECUTION_MODE: 'isolated',
      OBSERVATORY_AGENT_RUNNER_SOCKET: '/run/test/runner.sock',
      OBSERVATORY_AGENT_RUNNER_TOKEN: 'c'.repeat(64),
    });
    expect(isolated.agentExecutionMode).toBe('isolated');
    expect(isolated.agentRunnerSocket).toBe('/run/test/runner.sock');
    expect(isolated.agentRunnerToken).toBe('c'.repeat(64));
    expect(() => loadServerConfig({ OBSERVATORY_AGENT_EXECUTION_MODE: 'isolated' })).toThrowError(
      /agentRunnerToken/
    );
    expect(() => loadServerConfig({ OBSERVATORY_AGENT_EXECUTION_MODE: 'direct' })).toThrowError(
      /agentExecutionMode/
    );
  });

  it('derives the default metrics URL from the upstream URL', () => {
    expect(
      loadServerConfig({ OBSERVATORY_UPSTREAM_URL: 'http://127.0.0.1:9999/' }).metricsUrl
    ).toBe('http://127.0.0.1:9999/metrics');
    expect(
      loadServerConfig({ OBSERVATORY_UPSTREAM_URL: 'http://127.0.0.1:9999/v1' }).metricsUrl
    ).toBe('http://127.0.0.1:9999/metrics');
  });

  it('rejects metrics URLs with credentials, query strings or fragments', () => {
    for (const bad of [
      'http://user:pass@127.0.0.1:8081/metrics',
      'http://127.0.0.1:8081/metrics?token=abc',
      'http://127.0.0.1:8081/metrics#frag',
      'ftp://127.0.0.1:8081/metrics',
    ]) {
      expect(() => loadServerConfig({ OBSERVATORY_METRICS_URL: bad })).toThrowError(ConfigError);
    }
  });

  it('rejects non-loopback hosts in development mode', () => {
    for (const host of ['0.0.0.0', '192.168.1.10', 'example.com']) {
      expect(() => loadServerConfig({ OBSERVATORY_HOST: host })).toThrowError(ConfigError);
    }
  });

  it('accepts an authenticated explicit LAN configuration', () => {
    const config = loadServerConfig({
      OBSERVATORY_MODE: 'lan',
      OBSERVATORY_HOST: '0.0.0.0',
      OBSERVATORY_PASSWORD_HASH: `scrypt$16384$8$1$${'A'.repeat(22)}$${'B'.repeat(86)}`,
      OBSERVATORY_GATEWAY_TOKEN_HASH: 'a'.repeat(64),
      OBSERVATORY_SESSION_DAYS: '90',
      OBSERVATORY_COOKIE_SECURE: 'true',
    });
    expect(config).toMatchObject({
      mode: 'lan',
      host: '0.0.0.0',
      sessionDays: 90,
      cookieSecure: true,
    });
  });

  it('refuses LAN mode unless both browser and gateway credentials are configured', () => {
    expect(() =>
      loadServerConfig({ OBSERVATORY_MODE: 'lan', OBSERVATORY_HOST: '0.0.0.0' })
    ).toThrowError(/passwordHash.*gatewayTokenHash/);
  });

  it('accepts LAN mode with browser auth "none" without a password hash', () => {
    const config = loadServerConfig({
      OBSERVATORY_MODE: 'lan',
      OBSERVATORY_HOST: '0.0.0.0',
      OBSERVATORY_BROWSER_AUTH_MODE: 'none',
      OBSERVATORY_GATEWAY_TOKEN_HASH: 'a'.repeat(64),
    });
    expect(config).toMatchObject({
      mode: 'lan',
      browserAuthMode: 'none',
      gatewayAuthMode: 'token',
      passwordHash: undefined,
    });
  });

  it('still rejects LAN mode with browser auth "password" without a password hash', () => {
    expect(() =>
      loadServerConfig({
        OBSERVATORY_MODE: 'lan',
        OBSERVATORY_HOST: '0.0.0.0',
        OBSERVATORY_BROWSER_AUTH_MODE: 'password',
        OBSERVATORY_GATEWAY_TOKEN_HASH: 'a'.repeat(64),
      })
    ).toThrowError(/passwordHash/);
  });

  it('keeps browser and gateway auth modes independent', () => {
    // Browser "none" does not remove the gateway token requirement.
    expect(() =>
      loadServerConfig({
        OBSERVATORY_MODE: 'lan',
        OBSERVATORY_HOST: '0.0.0.0',
        OBSERVATORY_BROWSER_AUTH_MODE: 'none',
      })
    ).toThrowError(/gatewayTokenHash/);
    // Gateway "none" does not remove the password requirement.
    expect(() =>
      loadServerConfig({
        OBSERVATORY_MODE: 'lan',
        OBSERVATORY_HOST: '0.0.0.0',
        OBSERVATORY_GATEWAY_AUTH_MODE: 'none',
      })
    ).toThrowError(/passwordHash/);
    // Both can be disabled together for a fully local, no-credential LAN setup.
    const bothOpen = loadServerConfig({
      OBSERVATORY_MODE: 'lan',
      OBSERVATORY_HOST: '0.0.0.0',
      OBSERVATORY_BROWSER_AUTH_MODE: 'none',
      OBSERVATORY_GATEWAY_AUTH_MODE: 'none',
    });
    expect(bothOpen).toMatchObject({ browserAuthMode: 'none', gatewayAuthMode: 'none' });
    expect(bothOpen.passwordHash).toBeUndefined();
    expect(bothOpen.gatewayTokenHash).toBeUndefined();
  });

  it('rejects invalid browser auth modes', () => {
    expect(() => loadServerConfig({ OBSERVATORY_BROWSER_AUTH_MODE: 'off' })).toThrowError(
      /browserAuthMode/
    );
  });

  it('rejects out-of-range or non-numeric ports', () => {
    for (const port of ['0', '-1', '65536', 'abc']) {
      expect(() => loadServerConfig({ OBSERVATORY_PORT: port })).toThrowError(ConfigError);
    }
  });

  it('rejects absurd request size limits', () => {
    expect(() => loadServerConfig({ OBSERVATORY_MAX_REQUEST_BYTES: '0' })).toThrowError(
      ConfigError
    );
    expect(() =>
      loadServerConfig({ OBSERVATORY_MAX_REQUEST_BYTES: String(101 * 1024 * 1024) })
    ).toThrowError(ConfigError);
  });

  it('rejects invalid database paths (empty, too long, NUL bytes)', () => {
    for (const value of ['', 'x'.repeat(513), 'data/ob\u0000servatory.db']) {
      expect(() => loadServerConfig({ OBSERVATORY_DB_PATH: value })).toThrowError(ConfigError);
    }
  });

  it('rejects out-of-range busy timeouts and retention horizons', () => {
    for (const value of ['0', '-1', '120001', 'abc']) {
      expect(() => loadServerConfig({ OBSERVATORY_DB_BUSY_TIMEOUT_MS: value })).toThrowError(
        ConfigError
      );
    }
    for (const value of ['0', '-5', '3651', 'soon']) {
      expect(() => loadServerConfig({ OBSERVATORY_RETENTION_DAYS: value })).toThrowError(
        ConfigError
      );
    }
  });

  it('ignores unknown environment keys (only the OBSERVATORY_ keys below are consumed)', () => {
    const env: ServerEnv = {
      OBSERVATORY_PORT: '9001',
      PATH: '/usr/bin',
      OBSERVATORY_OBSESSIVE_FLAG: 'x',
    };
    expect(loadServerConfig(env).port).toBe(9001);
  });

  it('reports the failing field in the error message', () => {
    try {
      loadServerConfig({ OBSERVATORY_HOST: '0.0.0.0' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toContain('host');
    }
  });
});
