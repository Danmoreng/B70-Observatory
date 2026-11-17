import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createNpmRegistry,
  isRegistryReadPath,
  type NpmRegistryAccess,
} from '../../src/runner/npm-registry.js';
const roots: string[] = [];
const relays: NpmRegistryAccess[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const call = (socketPath: string, path: string, token: string, method = 'GET') =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method,
        headers: { authorization: `Bearer ${token}`, cookie: 'must-not-leak=secret' },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
describe('npm registry capability', () => {
  it.each([
    '/vue',
    '/@fastify%2fsse',
    '/@fastify/sse/-/sse-0.5.0.tgz',
    '/three/-/three-0.181.0.tgz',
    '/typescript/latest',
  ])('allows package read %s', (path) => expect(isRegistryReadPath(path)).toBe(true));
  it.each([
    '//evil.example/pkg',
    '/../secret',
    '/%2e%2e/secret',
    '/-/npm/v1/security/audits',
    '/vue?url=http://127.0.0.1',
    '/http://127.0.0.1:8081',
    '/@scope/../../secret',
    '/vue/%2f%2fevil',
  ])('rejects non-package path %s', (path) => expect(isRegistryReadPath(path)).toBe(false));
  it('requires a run capability, strips credentials, rejects writes/redirects and revokes access', async () => {
    const upstream = createServer((req, res) => {
      expect(req.headers.authorization).toBeUndefined();
      expect(req.headers.cookie).toBeUndefined();
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://127.0.0.1:8081/' });
        res.end();
      } else {
        res.setHeader('content-type', 'application/json');
        res.end('{"name":"vue"}');
      }
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const root = await mkdtemp(join(tmpdir(), 'bnr-'));
    roots.push(root);
    const socketPath = join(root, 'npm.sock');
    const relay = createNpmRegistry({
      socketPath,
      upstream: new URL(`http://127.0.0.1:${address.port}`),
    });
    await relay.start();
    relays.push(relay);
    const token = 'a'.repeat(64);
    relay.register(token);
    expect((await call(socketPath, '/vue', 'b'.repeat(64))).status).toBe(401);
    expect((await call(socketPath, '/vue', token, 'PUT')).status).toBe(403);
    expect((await call(socketPath, '//evil.example/pkg', token)).status).toBe(403);
    expect((await call(socketPath, '/redirect', token)).status).toBe(502);
    expect(await call(socketPath, '/vue', token)).toEqual({ status: 200, body: '{"name":"vue"}' });
    relay.revoke(token);
    expect((await call(socketPath, '/vue', token)).status).toBe(401);
  });
});
