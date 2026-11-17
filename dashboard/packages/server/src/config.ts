import { z } from 'zod';

/**
 * Runtime validation of process environment variables.
 *
 * Development services bind to loopback only. Non-loopback binding is accepted
 * exclusively in explicit LAN mode, which requires browser credentials unless
 * the operator explicitly selects `OBSERVATORY_BROWSER_AUTH_MODE=none`.
 * Inference authentication is separately configurable (token by default).
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

const DEFAULTS = {
  mode: 'development',
  host: '127.0.0.1',
  port: 8090,
  maxRequestBytes: 1024 * 1024, // 1 MiB
  dbPath: 'data/observatory.db',
  dbBusyTimeoutMs: 5000,
  retentionDays: 30,
  upstreamUrl: 'http://127.0.0.1:8081',
  upstreamTimeoutMs: 15_000,
  upstreamStreamIdleTimeoutMs: 120_000,
  upstreamMaxResponseBytes: 16 * 1024 * 1024, // 16 MiB
  webRoot: 'packages/web/dist',
  sessionDays: 30,
  cookieSecure: false,
  metricsIntervalMs: 5_000,
  metricsTimeoutMs: 3_000,
  telemetryPersistMinIntervalMs: 60_000,
  systemIntervalMs: 5_000,
  systemTimeoutMs: 2_000,
  systemPersistMinIntervalMs: 60_000,
  eventBufferSize: 512,
  diskPath: '/',
  gpuHelperSocket: '/run/local-ai-b70-observatory/gpu.sock',
  agentExecutionMode: 'disabled',
  agentRunnerSocket: '/run/local-ai-b70-runner/control.sock',
} as const;

const PASSWORD_HASH_PATTERN = /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/;
const TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Absolute http(s) URL without credentials, query string or fragment.
 * Shared by the gateway upstream URL and the telemetry metrics URL because
 * both are logged at startup and must therefore stay clean.
 */
function isCleanHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function defaultMetricsUrl(upstreamUrl: string): string {
  try {
    return new URL('/metrics', upstreamUrl).toString();
  } catch {
    // Preserve ConfigError's aggregated schema diagnostics for an invalid
    // upstream URL instead of throwing a raw URL parser exception here.
    return `${upstreamUrl.replace(/\/+$/, '')}/metrics`;
  }
}

export const ServerConfigSchema = z
  .object({
    studioComfyRoot: z
      .string()
      .startsWith('/')
      .max(1024)
      .refine((v) => !v.includes('\0'))
      .optional(),
    studioRuntimeRoot: z
      .string()
      .startsWith('/')
      .max(1024)
      .refine((v) => !v.includes('\0'))
      .optional(),
    studioStateRoot: z
      .string()
      .startsWith('/')
      .max(1024)
      .refine((v) => !v.includes('\0'))
      .optional(),
    imageJobsRoot: z
      .string()
      .startsWith('/')
      .max(1024)
      .refine((v) => !v.includes('\0'))
      .optional(),
    comfyUrl: z
      .string()
      .url()
      .refine((v) => {
        try {
          const u = new URL(v);
          return (
            u.protocol === 'http:' &&
            ['127.0.0.1', 'localhost'].includes(u.hostname) &&
            !u.username &&
            !u.password &&
            !u.search &&
            !u.hash &&
            u.pathname === '/'
          );
        } catch {
          return false;
        }
      })
      .default('http://127.0.0.1:8188'),
    mode: z.enum(['development', 'lan']),
    /** Only inference routes may explicitly opt out of bearer authentication. */
    gatewayAuthMode: z.enum(['token', 'none']).default('token'),
    /**
     * Browser/API authentication for the dashboard. `password` (default)
     * keeps the full session-cookie login flow; `none` skips browser
     * authentication in LAN mode without weakening the same-origin rule
     * for state-changing requests. Independent of `gatewayAuthMode`.
     */
    browserAuthMode: z.enum(['password', 'none']).default('password'),
    speechExecutable: z
      .string()
      .startsWith('/')
      .max(1024)
      .refine((v) => !v.includes('\0'))
      .optional(),
    speechModel: z
      .string()
      .startsWith('/')
      .max(1024)
      .refine((v) => !v.includes('\0'))
      .optional(),
    host: z.string().min(1).max(255),
    port: z.coerce.number().int().min(1).max(65535),
    maxRequestBytes: z.coerce
      .number()
      .int()
      .min(1)
      .max(100 * 1024 * 1024),
    /**
     * Location of the SQLite file. Relative paths are resolved against the
     * current working directory at startup. NUL bytes are rejected because
     * they terminate C paths inside SQLite's C library.
     */
    dbPath: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => !value.includes('\0'), { message: 'dbPath must not contain NUL bytes' }),
    /** How long a second connection may wait for a write lock (ms). */
    dbBusyTimeoutMs: z.coerce.number().int().min(1).max(120000),
    /**
     * Retention horizon in whole days, applied uniformly to requests,
     * request events, metric samples and service events (see README).
     */
    retentionDays: z.coerce.number().int().min(1).max(3650),
    /**
     * Base URL of the upstream vLLM service. Must be an absolute http(s)
     * URL; the gateway appends the OpenAI endpoint paths to it. HTTP is
     * allowed on purpose – the local vLLM service is plain HTTP on
     * loopback.
     *
     * The URL is logged verbatim at startup, so it must stay clean:
     * embedded credentials (user/password), query strings and fragments are
     * all rejected. Credentials belong in request headers only.
     */
    upstreamUrl: z.string().min(1).max(1024).refine(isCleanHttpUrl, {
      message:
        'upstreamUrl must be an absolute http:// or https:// URL without credentials, query string or fragment',
    }),
    /**
     * Total upstream budget: connection + response headers (streaming) or
     * connection + full response body (non-streaming), in ms.
     */
    upstreamTimeoutMs: z.coerce.number().int().min(1).max(3_600_000),
    /**
     * Idle timeout for SSE streams: if no upstream byte arrives for this
     * long, the upstream request is aborted. In ms.
     */
    upstreamStreamIdleTimeoutMs: z.coerce.number().int().min(1).max(3_600_000),
    /** Maximum buffered upstream response for non-streaming requests (bytes). */
    upstreamMaxResponseBytes: z.coerce
      .number()
      .int()
      .min(1)
      .max(512 * 1024 * 1024),
    webRoot: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => !value.includes('\0'), {
        message: 'webRoot must not contain NUL bytes',
      }),
    sessionDays: z.coerce.number().int().min(1).max(365),
    cookieSecure: z.enum(['true', 'false']).transform((value) => value === 'true'),
    /**
     * URL of the vLLM Prometheus metrics endpoint. Defaults to
     * `<upstreamUrl>/metrics`. Same cleanliness rules as `upstreamUrl`.
     */
    metricsUrl: z.string().min(1).max(1024).refine(isCleanHttpUrl, {
      message:
        'metricsUrl must be an absolute http:// or https:// URL without credentials, query string or fragment',
    }),
    /** Server-side scrape interval for the metrics endpoint (ms). */
    metricsIntervalMs: z.coerce.number().int().min(1000).max(3_600_000),
    /** Per-scrape budget: connect + full body (ms). */
    metricsTimeoutMs: z.coerce.number().int().min(500).max(300_000),
    /**
     * Minimum distance between two persisted telemetry sample batches (ms).
     * Bounded-growth rule: only semantically changed snapshots are
     * persisted, and at most one batch per this interval (M4A).
     */
    telemetryPersistMinIntervalMs: z.coerce.number().int().min(1000).max(86_400_000),
    /**
     * Server-side collection interval for the local system sources
     * (`/proc`, statfs, GPU sysfs) in ms. The browser never polls; this
     * loop is the documented server-side exception (M4B).
     */
    systemIntervalMs: z.coerce.number().int().min(1000).max(3_600_000),
    /** Per-collection budget applied to every local read (ms). */
    systemTimeoutMs: z.coerce.number().int().min(100).max(300_000),
    /**
     * Minimum distance between two persisted system sample batches (ms).
     */
    systemPersistMinIntervalMs: z.coerce.number().int().min(1000).max(86_400_000),
    /**
     * Size of the in-memory SSE replay window (entries). The journal is
     * fixed for the process lifetime: clients whose `Last-Event-ID` fell
     * out of this window receive fresh snapshots (re-synchronisation)
     * instead of a silent data gap. Clamped to 8…4096.
     */
    eventBufferSize: z.coerce.number().int().min(8).max(4096),
    /**
     * Filesystem path the disk-usage figures refer to (`node:fs statfs`).
     * Relative paths are resolved against the process working directory.
     */
    diskPath: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => !value.includes('\0'), {
        message: 'diskPath must not contain NUL bytes',
      }),
    gpuHelperSocket: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => value.startsWith('/'), {
        message: 'gpuHelperSocket must be an absolute path',
      }),
    /** `isolated` permits only IPC to the separately installed runner. */
    agentExecutionMode: z.enum(['disabled', 'isolated']),
    agentRunnerSocket: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => value.startsWith('/') && !value.includes('\0'), {
        message: 'agentRunnerSocket must be an absolute path',
      }),
    agentRunnerToken: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    releaseHealthToken: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    passwordHash: z
      .string()
      .regex(PASSWORD_HASH_PATTERN, 'invalid scrypt password hash')
      .optional(),
    gatewayTokenHash: z
      .string()
      .regex(TOKEN_HASH_PATTERN, 'must be a lowercase SHA-256 hex digest')
      .optional(),
  })
  .superRefine((value, context) => {
    if ((value.speechExecutable === undefined) !== (value.speechModel === undefined))
      context.addIssue({
        code: 'custom',
        path: ['speechModel'],
        message: 'Speech executable and model must be configured together.',
      });
    if (value.mode === 'development' && !LOOPBACK_HOSTS.has(value.host)) {
      context.addIssue({
        code: 'custom',
        path: ['host'],
        message: `development host must be loopback (one of: ${[...LOOPBACK_HOSTS].join(', ')})`,
      });
    }
    if (value.mode === 'lan') {
      if (value.browserAuthMode === 'password' && value.passwordHash === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['passwordHash'],
          message: 'required in LAN mode with browserAuthMode "password"',
        });
      }
      if (value.gatewayAuthMode === 'token' && value.gatewayTokenHash === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['gatewayTokenHash'],
          message: 'required in LAN mode',
        });
      }
    }
    if (value.agentExecutionMode === 'isolated' && value.agentRunnerToken === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['agentRunnerToken'],
        message: 'a 64-character runner control token is required in isolated mode',
      });
    }
  });

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export interface ServerEnv {
  OBSERVATORY_MODE?: string;
  OBSERVATORY_HOST?: string;
  OBSERVATORY_PORT?: string;
  OBSERVATORY_MAX_REQUEST_BYTES?: string;
  OBSERVATORY_DB_PATH?: string;
  OBSERVATORY_DB_BUSY_TIMEOUT_MS?: string;
  OBSERVATORY_RETENTION_DAYS?: string;
  OBSERVATORY_UPSTREAM_URL?: string;
  OBSERVATORY_UPSTREAM_TIMEOUT_MS?: string;
  OBSERVATORY_UPSTREAM_STREAM_IDLE_TIMEOUT_MS?: string;
  OBSERVATORY_UPSTREAM_MAX_RESPONSE_BYTES?: string;
  OBSERVATORY_WEB_ROOT?: string;
  OBSERVATORY_SESSION_DAYS?: string;
  OBSERVATORY_COOKIE_SECURE?: string;
  OBSERVATORY_METRICS_URL?: string;
  OBSERVATORY_METRICS_INTERVAL_MS?: string;
  OBSERVATORY_METRICS_TIMEOUT_MS?: string;
  OBSERVATORY_TELEMETRY_PERSIST_MIN_INTERVAL_MS?: string;
  OBSERVATORY_SYSTEM_INTERVAL_MS?: string;
  OBSERVATORY_SYSTEM_TIMEOUT_MS?: string;
  OBSERVATORY_SYSTEM_PERSIST_MIN_INTERVAL_MS?: string;
  OBSERVATORY_DISK_PATH?: string;
  OBSERVATORY_GPU_HELPER_SOCKET?: string;
  OBSERVATORY_AGENT_EXECUTION_MODE?: string;
  OBSERVATORY_AGENT_RUNNER_SOCKET?: string;
  OBSERVATORY_AGENT_RUNNER_TOKEN?: string;
  OBSERVATORY_RELEASE_HEALTH_TOKEN?: string;
  OBSERVATORY_PASSWORD_HASH?: string;
  OBSERVATORY_GATEWAY_TOKEN_HASH?: string;
  OBSERVATORY_GATEWAY_AUTH_MODE?: string;
  OBSERVATORY_BROWSER_AUTH_MODE?: string;
  [key: string]: string | undefined;
}

/** Raised when the environment is invalid; the process must not start. */
export class ConfigError extends Error {
  readonly code = 'invalid_config';

  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Parse and validate configuration from the given environment snapshot. */
export function loadServerConfig(env: ServerEnv = {}): ServerConfig {
  const raw = {
    studioComfyRoot: env.OBSERVATORY_STUDIO_COMFY_ROOT,
    studioRuntimeRoot: env.OBSERVATORY_STUDIO_RUNTIME_ROOT,
    studioStateRoot: env.OBSERVATORY_STUDIO_STATE_ROOT,
    imageJobsRoot: env.OBSERVATORY_IMAGE_JOBS_ROOT,
    comfyUrl: env.OBSERVATORY_COMFY_URL,
    mode: env.OBSERVATORY_MODE ?? DEFAULTS.mode,
    speechExecutable: env.OBSERVATORY_SPEECH_EXECUTABLE,
    speechModel: env.OBSERVATORY_SPEECH_MODEL,
    host: env.OBSERVATORY_HOST ?? DEFAULTS.host,
    port: env.OBSERVATORY_PORT ?? String(DEFAULTS.port),
    maxRequestBytes: env.OBSERVATORY_MAX_REQUEST_BYTES ?? String(DEFAULTS.maxRequestBytes),
    dbPath: env.OBSERVATORY_DB_PATH ?? DEFAULTS.dbPath,
    dbBusyTimeoutMs: env.OBSERVATORY_DB_BUSY_TIMEOUT_MS ?? String(DEFAULTS.dbBusyTimeoutMs),
    retentionDays: env.OBSERVATORY_RETENTION_DAYS ?? String(DEFAULTS.retentionDays),
    upstreamUrl: env.OBSERVATORY_UPSTREAM_URL ?? DEFAULTS.upstreamUrl,
    upstreamTimeoutMs: env.OBSERVATORY_UPSTREAM_TIMEOUT_MS ?? String(DEFAULTS.upstreamTimeoutMs),
    upstreamStreamIdleTimeoutMs:
      env.OBSERVATORY_UPSTREAM_STREAM_IDLE_TIMEOUT_MS ??
      String(DEFAULTS.upstreamStreamIdleTimeoutMs),
    upstreamMaxResponseBytes:
      env.OBSERVATORY_UPSTREAM_MAX_RESPONSE_BYTES ?? String(DEFAULTS.upstreamMaxResponseBytes),
    webRoot: env.OBSERVATORY_WEB_ROOT ?? DEFAULTS.webRoot,
    sessionDays: env.OBSERVATORY_SESSION_DAYS ?? String(DEFAULTS.sessionDays),
    cookieSecure: env.OBSERVATORY_COOKIE_SECURE ?? String(DEFAULTS.cookieSecure),
    metricsUrl:
      env.OBSERVATORY_METRICS_URL ??
      defaultMetricsUrl(env.OBSERVATORY_UPSTREAM_URL ?? DEFAULTS.upstreamUrl),
    metricsIntervalMs: env.OBSERVATORY_METRICS_INTERVAL_MS ?? String(DEFAULTS.metricsIntervalMs),
    metricsTimeoutMs: env.OBSERVATORY_METRICS_TIMEOUT_MS ?? String(DEFAULTS.metricsTimeoutMs),
    telemetryPersistMinIntervalMs:
      env.OBSERVATORY_TELEMETRY_PERSIST_MIN_INTERVAL_MS ??
      String(DEFAULTS.telemetryPersistMinIntervalMs),
    systemIntervalMs: env.OBSERVATORY_SYSTEM_INTERVAL_MS ?? String(DEFAULTS.systemIntervalMs),
    systemTimeoutMs: env.OBSERVATORY_SYSTEM_TIMEOUT_MS ?? String(DEFAULTS.systemTimeoutMs),
    systemPersistMinIntervalMs:
      env.OBSERVATORY_SYSTEM_PERSIST_MIN_INTERVAL_MS ?? String(DEFAULTS.systemPersistMinIntervalMs),
    eventBufferSize: env.OBSERVATORY_EVENT_BUFFER_SIZE ?? String(DEFAULTS.eventBufferSize),
    diskPath: env.OBSERVATORY_DISK_PATH ?? DEFAULTS.diskPath,
    gpuHelperSocket: env.OBSERVATORY_GPU_HELPER_SOCKET ?? DEFAULTS.gpuHelperSocket,
    agentExecutionMode: env.OBSERVATORY_AGENT_EXECUTION_MODE ?? DEFAULTS.agentExecutionMode,
    agentRunnerSocket: env.OBSERVATORY_AGENT_RUNNER_SOCKET ?? DEFAULTS.agentRunnerSocket,
    agentRunnerToken: env.OBSERVATORY_AGENT_RUNNER_TOKEN,
    releaseHealthToken: env.OBSERVATORY_RELEASE_HEALTH_TOKEN,
    passwordHash: env.OBSERVATORY_PASSWORD_HASH,
    gatewayTokenHash: env.OBSERVATORY_GATEWAY_TOKEN_HASH,
    gatewayAuthMode: env.OBSERVATORY_GATEWAY_AUTH_MODE ?? 'token',
    browserAuthMode: env.OBSERVATORY_BROWSER_AUTH_MODE ?? 'password',
  };
  const result = ServerConfigSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid server configuration: ${details}`);
  }
  if (
    result.data.imageJobsRoot &&
    (result.data.mode !== 'lan' ||
      result.data.gatewayAuthMode !== 'token' ||
      !result.data.gatewayTokenHash)
  )
    throw new ConfigError(
      'Image orchestration requires LAN mode with authenticated gateway bearer access.'
    );
  if (
    (result.data.studioComfyRoot || result.data.studioRuntimeRoot || result.data.studioStateRoot) &&
    !result.data.imageJobsRoot
  )
    throw new ConfigError('Studio integration requires OBSERVATORY_IMAGE_JOBS_ROOT.');
  return result.data;
}
