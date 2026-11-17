import cookie from '@fastify/cookie';
import { LoginRequestSchema, type AuthSession } from '@observatory/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthSessionRepository } from '../db/auth-sessions.js';
import { createOpaqueToken, hashOpaqueToken, verifyOpaqueToken, verifyPassword } from './crypto.js';

const COOKIE_NAME = 'observatory_session';
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const SESSION_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface LoginAttempt {
  failures: number;
  windowStartedMs: number;
  blockedUntilMs?: number;
}

export interface AuthOptions {
  mode: 'development' | 'lan';
  gatewayAuthMode?: 'token' | 'none';
  /**
   * Browser authentication mode (independent of `gatewayAuthMode`).
   * `none` (explicit operator choice) skips the session check for `/api`
   * while the same-origin rule for state-changing requests stays active.
   * Defaults to `password` for backwards compatibility.
   */
  browserAuthMode?: 'password' | 'none';
  passwordHash?: string;
  gatewayTokenHash?: string;
  internalGatewayToken?: string;
  sessions: AuthSessionRepository;
  sessionDays: number;
  cookieSecure: boolean;
  releaseHealthToken?: string;
  now?: () => Date;
}

function apiError(reply: FastifyReply, status: number, code: string, message: string): void {
  reply.status(status).send({ error: { code, message } });
}

function isStateChanging(request: FastifyRequest): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
}

function isPathUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function hasSameOrigin(request: FastifyRequest): boolean {
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite !== undefined) return fetchSite === 'same-origin';
  const origin = request.headers.origin;
  if (origin === undefined) return false;
  return origin === `${request.protocol}://${request.headers.host ?? ''}`;
}

function bearerToken(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization === undefined) return undefined;
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization);
  return match?.[1];
}

export function registerAuth(app: FastifyInstance, options: AuthOptions): void {
  const now = options.now ?? (() => new Date());
  const sessionMs = options.sessionDays * 86_400_000;
  const credentialHash = hashOpaqueToken(options.passwordHash ?? 'development');
  const attempts = new Map<string, LoginAttempt>();
  /** LAN mode with explicit operator opt-out of browser authentication. */
  const browserOpen = options.mode === 'lan' && (options.browserAuthMode ?? 'password') === 'none';
  app.register(cookie);

  const cookieBaseOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: options.cookieSecure,
  };
  const cookieOptions = {
    ...cookieBaseOptions,
    maxAge: Math.floor(sessionMs / 1000),
  };

  const readSession = (request: FastifyRequest, reply: FastifyReply): string | undefined => {
    if (options.mode === 'development') return new Date(now().getTime() + sessionMs).toISOString();
    if (browserOpen) return new Date(now().getTime() + sessionMs).toISOString();
    const token = request.cookies[COOKIE_NAME];
    if (token === undefined) return undefined;
    const tokenHash = hashOpaqueToken(token);
    const record = options.sessions.find(tokenHash);
    const current = now();
    if (
      record === undefined ||
      record.credentialHash !== credentialHash ||
      record.expiresAtUtc <= current.toISOString()
    ) {
      if (record !== undefined) options.sessions.delete(tokenHash);
      reply.clearCookie(COOKIE_NAME, cookieBaseOptions);
      return undefined;
    }
    if (
      current.getTime() - new Date(record.lastSeenAtUtc).getTime() >=
      SESSION_REFRESH_INTERVAL_MS
    ) {
      const expiresAt = new Date(current.getTime() + sessionMs).toISOString();
      options.sessions.touch(tokenHash, current.toISOString(), expiresAt);
      reply.setCookie(COOKIE_NAME, token, cookieOptions);
      return expiresAt;
    }
    return record.expiresAtUtc;
  };

  app.addHook('preHandler', async (request, reply) => {
    if (options.mode !== 'lan') return;
    const path = request.url.split('?')[0] ?? request.url;
    if (
      path === '/api/health' &&
      request.method === 'GET' &&
      options.releaseHealthToken !== undefined &&
      verifyOpaqueToken(bearerToken(request) ?? '', hashOpaqueToken(options.releaseHealthToken))
    ) {
      return;
    }
    if (isPathUnder(path, '/api') && isStateChanging(request) && !hasSameOrigin(request)) {
      apiError(reply, 403, 'forbidden', 'Same-origin request required.');
      return reply;
    }
    if (isPathUnder(path, '/v1')) {
      if (options.gatewayAuthMode === 'none') return;
      const token = bearerToken(request);
      if (
        token &&
        options.internalGatewayToken &&
        verifyOpaqueToken(token, hashOpaqueToken(options.internalGatewayToken))
      )
        return;
      if (
        token === undefined ||
        options.gatewayTokenHash === undefined ||
        !verifyOpaqueToken(token, options.gatewayTokenHash)
      ) {
        reply.header('www-authenticate', 'Bearer');
        apiError(reply, 401, 'unauthorized', 'Valid gateway bearer token required.');
        return reply;
      }
      return;
    }
    if (
      isPathUnder(path, '/api') &&
      path !== '/api/auth/login' &&
      path !== '/api/auth/session' &&
      readSession(request, reply) === undefined
    ) {
      apiError(reply, 401, 'unauthorized', 'Authentication required.');
      return reply;
    }
  });

  app.get('/api/auth/session', async (request, reply) => {
    const expiresAt = readSession(request, reply);
    const payload: AuthSession =
      expiresAt === undefined ? { authenticated: false } : { authenticated: true, expiresAt };
    // Only the explicit opt-out is announced (`loginRequired: false`). Older
    // clients parse the contract strictly and never see this field on
    // password installations; newer clients treat an absent field as
    // "login required", so old server responses stay compatible.
    if (options.mode !== 'lan' || browserOpen) payload.loginRequired = false;
    return payload;
  });

  app.post('/api/auth/login', async (request, reply) => {
    if (options.mode === 'development') {
      return {
        authenticated: true,
        expiresAt: new Date(now().getTime() + sessionMs).toISOString(),
      };
    }
    const address = request.ip;
    const currentMs = now().getTime();
    const previous = attempts.get(address);
    if (previous?.blockedUntilMs !== undefined && previous.blockedUntilMs > currentMs) {
      reply.header('retry-after', String(Math.ceil((previous.blockedUntilMs - currentMs) / 1000)));
      apiError(reply, 429, 'too_many_requests', 'Too many failed login attempts. Try again later.');
      return;
    }
    const parsed = LoginRequestSchema.safeParse(request.body);
    const valid =
      parsed.success &&
      options.passwordHash !== undefined &&
      (await verifyPassword(parsed.data.password, options.passwordHash));
    if (!valid) {
      const active =
        previous !== undefined && currentMs - previous.windowStartedMs < LOGIN_WINDOW_MS
          ? previous
          : { failures: 0, windowStartedMs: currentMs };
      active.failures += 1;
      if (active.failures >= LOGIN_MAX_FAILURES)
        active.blockedUntilMs = currentMs + LOGIN_WINDOW_MS;
      attempts.set(address, active);
      apiError(reply, 401, 'unauthorized', 'Incorrect password.');
      return;
    }
    attempts.delete(address);
    options.sessions.deleteExpired(new Date(currentMs).toISOString());
    const token = createOpaqueToken();
    const timestamp = new Date(currentMs).toISOString();
    const expiresAt = new Date(currentMs + sessionMs).toISOString();
    options.sessions.create({
      tokenHash: hashOpaqueToken(token),
      credentialHash,
      createdAtUtc: timestamp,
      lastSeenAtUtc: timestamp,
      expiresAtUtc: expiresAt,
    });
    reply.setCookie(COOKIE_NAME, token, cookieOptions);
    return { authenticated: true, expiresAt };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[COOKIE_NAME];
    if (token !== undefined) options.sessions.delete(hashOpaqueToken(token));
    reply.clearCookie(COOKIE_NAME, cookieBaseOptions);
    return { authenticated: false };
  });
}
