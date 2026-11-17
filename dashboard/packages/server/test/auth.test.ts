import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createPasswordHash, hashOpaqueToken } from '../src/auth/crypto.js';
import { loadServerConfig } from '../src/config.js';
import { AuthSessionRepository } from '../src/db/auth-sessions.js';
import { newTempDb } from './helpers.js';
import type { EngineServiceController } from '../src/engine/service.js';

const PASSWORD = 'a very local password';
const GATEWAY_TOKEN = 'gateway-token-for-tests';
const ORIGIN = 'http://localhost';
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function setup(releaseHealthToken?: string, engineService?: EngineServiceController) {
  const temp = newTempDb();
  const webRoot = mkdtempSync(join(tmpdir(), 'observatory-web-'));
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Observatory test</title>');
  const passwordHash = await createPasswordHash(PASSWORD);
  const gatewayTokenHash = hashOpaqueToken(GATEWAY_TOKEN);
  const config = loadServerConfig({
    OBSERVATORY_MODE: 'lan',
    OBSERVATORY_HOST: '0.0.0.0',
    OBSERVATORY_PASSWORD_HASH: passwordHash,
    OBSERVATORY_GATEWAY_TOKEN_HASH: gatewayTokenHash,
  });
  const sessions = new AuthSessionRepository(temp.db);
  const app = buildApp({
    version: 'test',
    config,
    loggerLevel: 'silent',
    database: temp.db,
    auth: {
      mode: 'lan',
      passwordHash,
      gatewayTokenHash,
      sessions,
      sessionDays: 30,
      cookieSecure: false,
      releaseHealthToken,
    },
    webRoot,
    engineService,
  });
  cleanups.push(() => rmSync(webRoot, { recursive: true, force: true }));
  cleanups.push(() => temp.close());
  cleanups.push(() => void app.close());
  return { app, db: temp.db, webRoot };
}

function sessionCookie(response: {
  headers: Record<string, string | string[] | number | undefined>;
}): string {
  const header = response.headers['set-cookie'];
  return String(Array.isArray(header) ? header[0] : header).split(';')[0] ?? '';
}

describe('LAN browser authentication', () => {
  it('guards engine status and actions with the browser session and same-origin rule', async () => {
    const engineService: EngineServiceController = {
      status: async () => ({ activeState: 'active', autostart: true }),
      action: async () => ({ activeState: 'inactive', autostart: true }),
    };
    const { app } = await setup(undefined, engineService);
    expect((await app.inject({ method: 'GET', url: '/api/engine/service' })).statusCode).toBe(401);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ORIGIN, host: 'localhost', 'content-type': 'application/json' },
      payload: { password: PASSWORD },
    });
    const cookie = sessionCookie(login);
    const read = await app.inject({
      method: 'GET',
      url: '/api/engine/service',
      headers: { cookie },
    });
    expect(read.json()).toEqual({ activeState: 'active', autostart: true });
    const crossOrigin = await app.inject({
      method: 'POST',
      url: '/api/engine/service',
      headers: { cookie, origin: 'http://attacker.invalid', host: 'localhost' },
      payload: { action: 'stop' },
    });
    expect(crossOrigin.statusCode).toBe(403);
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/engine/service',
      headers: { cookie, origin: ORIGIN, host: 'localhost' },
      payload: { action: 'stop', unit: 'another.service' },
    });
    expect(invalid.statusCode).toBe(400);
    const action = await app.inject({
      method: 'POST',
      url: '/api/engine/service',
      headers: { cookie, origin: ORIGIN, host: 'localhost' },
      payload: { action: 'stop' },
    });
    expect(action.statusCode).toBe(200);
    expect(action.json()).toEqual({ activeState: 'inactive', autostart: true });
  });
  it('permits only the dedicated release helper token to probe health', async () => {
    const token = 'a'.repeat(64);
    const { app } = await setup(token);
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const wrong = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { authorization: `Bearer ${'b'.repeat(64)}` },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('serves the login shell but protects API data until login', async () => {
    const { app } = await setup();
    const page = await app.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Observatory test');
    expect(page.headers['content-security-policy']).toContain("default-src 'self'");
    expect(page.headers['x-frame-options']).toBe('DENY');
    const spaRoute = await app.inject({
      method: 'GET',
      url: '/requests/example',
      headers: { accept: 'text/html' },
    });
    expect(spaRoute.statusCode).toBe(200);
    expect(spaRoute.body).toContain('Observatory test');

    const anonymous = await app.inject({ method: 'GET', url: '/api/auth/session' });
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.json()).toEqual({ authenticated: false });
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(401);
    expect(health.json()).toMatchObject({ error: { code: 'unauthorized' } });
    const events = await app.inject({ method: 'GET', url: '/api/events' });
    expect(events.statusCode).toBe(401);
  });

  it('serves newly hashed frontend assets without restarting the server', async () => {
    const { app, webRoot } = await setup();
    await app.ready();
    mkdirSync(join(webRoot, 'assets'));
    writeFileSync(join(webRoot, 'assets', 'index-new-hash.js'), 'export const ready = true;');
    writeFileSync(join(webRoot, 'assets', 'index-new-hash.css'), 'body { color: white; }');

    const script = await app.inject({ method: 'GET', url: '/assets/index-new-hash.js' });
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toContain('javascript');
    expect(script.body).toContain('ready = true');

    const style = await app.inject({ method: 'GET', url: '/assets/index-new-hash.css' });
    expect(style.statusCode).toBe(200);
    expect(style.headers['content-type']).toContain('text/css');
    expect(style.body).toContain('color: white');
  });

  it('creates a persistent HttpOnly session without storing its cleartext token', async () => {
    const { app, db } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ORIGIN, host: 'localhost', 'content-type': 'application/json' },
      payload: { password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ authenticated: true });
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Max-Age=2592000');

    const cookie = sessionCookie(response);
    const clearToken = cookie.split('=')[1] ?? '';
    const row = db.prepare('SELECT tokenHash FROM auth_sessions').get() as { tokenHash: string };
    expect(row.tokenHash).toHaveLength(64);
    expect(row.tokenHash).not.toContain(clearToken);
    expect(JSON.stringify(row)).not.toContain(PASSWORD);

    const health = await app.inject({ method: 'GET', url: '/api/health', headers: { cookie } });
    expect(health.statusCode).toBe(200);
    const session = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie },
    });
    expect(session.json()).toMatchObject({ authenticated: true });
  });

  it('rejects wrong passwords, cross-origin writes and repeated guessing', async () => {
    const { app } = await setup();
    const crossOrigin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'http://attacker.invalid', host: 'localhost' },
      payload: { password: PASSWORD },
    });
    expect(crossOrigin.statusCode).toBe(403);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: ORIGIN, host: 'localhost' },
        payload: { password: 'wrong' },
      });
      expect(wrong.statusCode).toBe(401);
    }
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ORIGIN, host: 'localhost' },
      payload: { password: PASSWORD },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('revokes the session on logout', async () => {
    const { app } = await setup();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ORIGIN, host: 'localhost' },
      payload: { password: PASSWORD },
    });
    const cookie = sessionCookie(login);
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { origin: ORIGIN, host: 'localhost', cookie },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ authenticated: false });
    expect(String(logout.headers['set-cookie'])).not.toContain('Max-Age=2592000');
    const health = await app.inject({ method: 'GET', url: '/api/health', headers: { cookie } });
    expect(health.statusCode).toBe(401);
  });
});

describe('LAN gateway authentication', () => {
  it('accepts only the configured Authorization bearer token', async () => {
    const { app } = await setup();
    app.get('/v1/auth-probe', async () => ({ ok: true }));
    const missing = await app.inject({ method: 'GET', url: '/v1/auth-probe' });
    expect(missing.statusCode).toBe(401);
    expect(missing.headers['www-authenticate']).toBe('Bearer');
    const wrong = await app.inject({
      method: 'GET',
      url: '/v1/auth-probe',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(wrong.statusCode).toBe(401);
    const valid = await app.inject({
      method: 'GET',
      url: '/v1/auth-probe',
      headers: { authorization: `Bearer ${GATEWAY_TOKEN}` },
    });
    expect(valid.statusCode).toBe(200);
  });
});

describe('LAN browser authentication, browserAuthMode none', () => {
  async function setupOpen() {
    const temp = newTempDb();
    const webRoot = mkdtempSync(join(tmpdir(), 'observatory-web-'));
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Observatory test</title>');
    const config = loadServerConfig({
      OBSERVATORY_MODE: 'lan',
      OBSERVATORY_HOST: '0.0.0.0',
      OBSERVATORY_BROWSER_AUTH_MODE: 'none',
      OBSERVATORY_GATEWAY_TOKEN_HASH: hashOpaqueToken(GATEWAY_TOKEN),
    });
    expect(config.passwordHash).toBeUndefined();
    const sessions = new AuthSessionRepository(temp.db);
    const app = buildApp({
      version: 'test',
      config,
      loggerLevel: 'silent',
      database: temp.db,
      auth: {
        mode: 'lan',
        browserAuthMode: 'none',
        gatewayTokenHash: hashOpaqueToken(GATEWAY_TOKEN),
        sessions,
        sessionDays: 30,
        cookieSecure: false,
      },
      webRoot,
    });
    cleanups.push(() => rmSync(webRoot, { recursive: true, force: true }));
    cleanups.push(() => temp.close());
    cleanups.push(() => void app.close());
    return { app };
  }

  it('reports authenticated without a cookie and announces loginRequired false', async () => {
    const { app } = await setupOpen();
    const session = await app.inject({ method: 'GET', url: '/api/auth/session' });
    expect(session.statusCode).toBe(200);
    const body = session.json();
    expect(body.authenticated).toBe(true);
    expect(body.loginRequired).toBe(false);
    expect(body.expiresAt).toBeDefined();
    expect(session.headers['set-cookie']).toBeUndefined();
  });

  it('serves dashboard and agent GET routes without any cookie', async () => {
    const { app } = await setupOpen();
    for (const url of ['/api/health', '/api/agent']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
    }
    // Task routes exist only with a configured controller; here they must be
    // rejected for that reason (503), never by authentication (401).
    for (const url of ['/api/agent/tasks', '/api/agent/projects']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(503);
    }
  });

  it('keeps the same-origin rule for state-changing requests', async () => {
    const { app } = await setupOpen();
    const crossOrigin = await app.inject({
      method: 'POST',
      url: '/api/agent/runs',
      headers: { origin: 'http://attacker.invalid', host: 'localhost' },
      payload: { task: 'x' },
    });
    expect(crossOrigin.statusCode).toBe(403);
    const noOrigin = await app.inject({
      method: 'POST',
      url: '/api/agent/runs',
      headers: { host: 'localhost' },
      payload: { task: 'x' },
    });
    expect(noOrigin.statusCode).toBe(403);
    const fetchSiteNone = await app.inject({
      method: 'POST',
      url: '/api/agent/runs',
      headers: { 'sec-fetch-site': 'none', host: 'localhost' },
      payload: { task: 'x' },
    });
    expect(fetchSiteNone.statusCode).toBe(403);
    const queryDoesNotBypass = await app.inject({
      method: 'POST',
      url: '/api/agent/runs?auth=none',
      headers: { origin: 'http://attacker.invalid', host: 'localhost' },
      payload: { task: 'x' },
    });
    expect(queryDoesNotBypass.statusCode).toBe(403);
    // A same-origin write passes the origin rule (still rejected for its own
    // reasons, but never with 401/403).
    const sameOrigin = await app.inject({
      method: 'POST',
      url: '/api/agent/runs',
      headers: { origin: ORIGIN, host: 'localhost' },
      payload: { task: 'x' },
    });
    expect(sameOrigin.statusCode).not.toBe(401);
    expect(sameOrigin.statusCode).not.toBe(403);
    // sec-fetch-site evidence alone is sufficient for same-origin clients.
    const fetchSiteSame = await app.inject({
      method: 'POST',
      url: '/api/agent/runs',
      headers: { 'sec-fetch-site': 'same-origin', host: 'localhost' },
      payload: { task: 'x' },
    });
    expect(fetchSiteSame.statusCode).not.toBe(403);
  });

  it('still requires the gateway bearer token on /v1', async () => {
    const { app } = await setupOpen();
    app.get('/v1/auth-probe', async () => ({ ok: true }));
    const missing = await app.inject({ method: 'GET', url: '/v1/auth-probe' });
    expect(missing.statusCode).toBe(401);
    const valid = await app.inject({
      method: 'GET',
      url: '/v1/auth-probe',
      headers: { authorization: `Bearer ${GATEWAY_TOKEN}` },
    });
    expect(valid.statusCode).toBe(200);
  });
});
