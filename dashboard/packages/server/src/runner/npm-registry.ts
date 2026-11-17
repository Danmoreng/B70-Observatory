import { chmod, mkdir, rm } from 'node:fs/promises';
import { createServer, request as httpRequest, type ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { dirname } from 'node:path';

export interface NpmRegistryAccess {
  socketRoot: string;
  start(): Promise<void>;
  close(): Promise<void>;
  register(token: string): void;
  revoke(token: string): void;
}

/** Package metadata and tarballs only, never npm writes, search, arbitrary URLs or redirects. */
export function isRegistryReadPath(raw: string): boolean {
  if (raw.length > 1024 || !raw.startsWith('/') || /[?#\\\0]/.test(raw)) return false;
  let parts: string[];
  try {
    parts = decodeURIComponent(raw).slice(1).split('/');
  } catch {
    return false;
  }
  const name = /^[A-Za-z0-9_][A-Za-z0-9._~-]{0,213}$/;
  if (parts[0]?.startsWith('@')) {
    if (!name.test(parts[0].slice(1))) return false;
    parts = parts.slice(1);
  }
  if (!name.test(parts[0] ?? '')) return false;
  if (parts.length === 1) return true;
  if (parts.length === 2) return /^[A-Za-z0-9][A-Za-z0-9+._~-]{0,128}$/.test(parts[1]!);
  return (
    parts.length === 3 && parts[1] === '-' && /^[A-Za-z0-9_][A-Za-z0-9._~-]*\.tgz$/.test(parts[2]!)
  );
}

export function createNpmRegistry(options: {
  socketPath: string;
  /** Test seam, never loaded from env/browser input. */ upstream?: URL;
}): NpmRegistryAccess {
  const capabilities = new Map<string, { bytes: number; active: Set<ClientRequest> }>();
  const origin = options.upstream ?? new URL('https://registry.npmjs.org');
  const server = createServer((incoming, outgoing) => {
    const token = incoming.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const grant = capabilities.get(token);
    if (grant === undefined) {
      outgoing.writeHead(401);
      outgoing.end('npm capability required');
      return;
    }
    if (
      !['GET', 'HEAD'].includes(incoming.method ?? '') ||
      !isRegistryReadPath(incoming.url ?? '')
    ) {
      outgoing.writeHead(403);
      outgoing.end('Only public npm package reads are permitted');
      return;
    }
    if (grant.active.size >= 24 || grant.bytes >= 2 * 1024 * 1024 * 1024) {
      outgoing.writeHead(429);
      outgoing.end('npm transfer limit reached');
      return;
    }
    const requestFunction = origin.protocol === 'https:' ? httpsRequest : httpRequest;
    // A fixed origin plus the validated path; Authorization/cookies never leave this relay.
    const upstream = requestFunction(
      new URL(incoming.url!, origin),
      {
        method: incoming.method,
        headers: {
          accept:
            typeof incoming.headers.accept === 'string'
              ? incoming.headers.accept
              : 'application/json',
          'user-agent': 'Local-AI-B70-npm-relay',
        },
        timeout: 30_000,
      },
      (response) => {
        if ((response.statusCode ?? 500) >= 300 && (response.statusCode ?? 500) < 400) {
          response.destroy();
          outgoing.writeHead(502);
          outgoing.end('Registry redirects are disabled');
          return;
        }
        const headers: Record<string, string> = { 'cache-control': 'no-store' };
        for (const name of ['content-type', 'content-length', 'content-encoding', 'etag']) {
          const value = response.headers[name];
          if (typeof value === 'string') headers[name] = value;
        }
        outgoing.writeHead(response.statusCode ?? 502, headers);
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          grant.bytes += chunk.length;
          if (bytes > 128 * 1024 * 1024 || grant.bytes > 2 * 1024 * 1024 * 1024)
            upstream.destroy(new Error('npm response exceeded transfer limit'));
        });
        response.once('error', () => outgoing.destroy());
        response.pipe(outgoing);
      }
    );
    grant.active.add(upstream);
    upstream.once('close', () => grant.active.delete(upstream));
    upstream.once('timeout', () => upstream.destroy(new Error('npm registry timed out')));
    upstream.once('error', () => {
      if (!outgoing.headersSent) {
        outgoing.writeHead(502);
        outgoing.end('npm registry unavailable');
      } else outgoing.destroy();
    });
    outgoing.once('close', () => upstream.destroy());
    upstream.end();
  });
  server.maxConnections = 96;
  server.headersTimeout = 10_000;
  server.on('connect', (_request, socket) => socket.destroy());
  return {
    socketRoot: dirname(options.socketPath),
    register(token) {
      if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('invalid npm capability');
      capabilities.set(token, { bytes: 0, active: new Set() });
    },
    revoke(token) {
      const grant = capabilities.get(token);
      capabilities.delete(token);
      for (const request of grant?.active ?? []) request.destroy();
    },
    async start() {
      await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });
      await rm(options.socketPath, { force: true });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.socketPath, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      await chmod(options.socketPath, 0o666);
    },
    async close() {
      for (const token of capabilities.keys()) this.revoke(token);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(options.socketPath, { force: true });
    },
  };
}
