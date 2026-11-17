import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppPreviewManager, createAppBridge } from '../../src/runner/app-preview.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('app browser bridge', () => {
  it('retains early preparation failures in app status and clears them when stopped', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bab-'));
    roots.push(root);
    const manager = new AppPreviewManager(join(root, 'apps'), root, '127.0.0.1');
    try {
      await expect(
        manager.start('project', join(root, 'missing-repository'), 'bad-revision')
      ).rejects.toThrow();
      expect(manager.status('project')).toMatchObject({
        status: 'failed',
        revision: 'bad-revision',
      });
      expect(manager.status('project').logs.length).toBeGreaterThan(0);
      expect(await manager.stop('project')).toMatchObject({ status: 'stopped' });
    } finally {
      await manager.close();
    }
  });
  it('uses a dedicated origin with capability authentication and removes dashboard credentials and app cookies', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bab-'));
    roots.push(root);
    const socket = join(root, 'app.sock');
    let received: Record<string, unknown> | undefined;
    const app = createServer((request, response) => {
      received = request.headers;
      response.setHeader('content-type', 'application/json');
      response.setHeader('set-cookie', 'dashboard=attacker');
      response.setHeader('access-control-allow-origin', '*');
      response.end(JSON.stringify({ url: request.url }));
    });
    servers.push(app);
    app.listen(socket);
    await once(app, 'listening');
    const token = 'a'.repeat(64);
    const bridge = await createAppBridge(socket, '127.0.0.1', token);
    servers.push(bridge);
    const address = bridge.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const url = `http://127.0.0.1:${address.port}`;
    expect((await fetch(url)).status).toBe(403);
    expect((await fetch(url + '/_b70/open/' + 'b'.repeat(64))).status).toBe(403);
    const entry = await fetch(url + '/_b70/open/' + token, { redirect: 'manual' });
    expect(entry.status).toBe(303);
    const cookie = entry.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly; SameSite=Strict');
    const cookieHeader = cookie.split(';')[0] + '; dashboard=secret';
    const result = await fetch(url + '/api/data?x=1', {
      headers: { cookie: cookieHeader, authorization: 'Bearer secret' },
    });
    expect(await result.json()).toEqual({ url: '/api/data?x=1' });
    expect(received?.cookie).toBeUndefined();
    expect(received?.authorization).toBeUndefined();
    expect(result.headers.get('set-cookie')).toContain(
      'b70_user_aaaaaaaaaaaaaaaa_dashboard=attacker'
    );
    const appCookie = result.headers.get('set-cookie')!.split(';')[0]!;
    await fetch(url + '/api/data', { headers: { cookie: `${cookieHeader}; ${appCookie}` } });
    expect(received?.cookie).toBe('dashboard=attacker');
    expect(result.headers.get('access-control-allow-origin')).toBeNull();
    expect(result.headers.get('content-security-policy')).toContain("form-action 'self'");
    expect(
      (
        await fetch(url + '/api/data', {
          method: 'POST',
          headers: { cookie: cookieHeader, origin: 'http://other-app:9000' },
        })
      ).status
    ).toBe(403);
    expect(
      (
        await fetch(url + '/api/data', {
          method: 'POST',
          headers: { cookie: cookieHeader, origin: url },
        })
      ).status
    ).toBe(200);
  });
});
