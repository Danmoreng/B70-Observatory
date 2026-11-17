/** Local TLS frontend. The HTTP listener serves only public certificate setup files. */
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const host = process.env.B70_TLS_HOST ?? '127.0.0.1';
const port = Number(process.env.B70_TLS_PORT ?? '8443');
const setupPort = Number(process.env.B70_TLS_SETUP_PORT ?? '8091');
const root = process.env.B70_TLS_ROOT;
if (!root?.startsWith('/')) throw new Error('B70_TLS_ROOT must be an absolute directory');
for (const value of [port, setupPort])
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error('Invalid port');
const upstream = new URL(process.env.B70_TLS_UPSTREAM ?? `http://${host}:8090`);
if (
  upstream.protocol !== 'http:' ||
  upstream.username ||
  upstream.password ||
  upstream.search ||
  upstream.hash ||
  upstream.pathname !== '/'
)
  throw new Error('Invalid local upstream');
const origin = `https://${host}:${port}`;
const profile = readFileSync(join(root, 'local-ai-b70.mobileconfig'));
const certificate = readFileSync(join(root, 'ca.cer'));
const instructions = readFileSync(join(root, 'setup.html'));
function serveSetup(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end();
    return;
  }
  const path = request.url?.split('?')[0];
  const entry =
    path === '/local-ai-b70.mobileconfig'
      ? [profile, 'application/x-apple-aspen-config', 'local-ai-b70.mobileconfig']
      : path === '/ca.cer'
        ? [certificate, 'application/x-x509-ca-cert', 'local-ai-b70-ca.cer']
        : path === '/'
          ? [instructions, 'text/html; charset=utf-8']
          : undefined;
  if (!entry) {
    response.writeHead(404).end();
    return;
  }
  const [content, contentType, filename] = entry;
  response.writeHead(200, {
    'content-type': contentType,
    'content-length': content.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(filename ? { 'content-disposition': `attachment; filename="${filename}"` } : {}),
  });
  response.end(request.method === 'HEAD' ? undefined : content);
}
const https = createHttpsServer(
  {
    key: readFileSync(join(root, 'server.key')),
    cert: readFileSync(join(root, 'server.pem')),
    minVersion: 'TLSv1.2',
  },
  (request, response) => {
    if (
      request.headers.host !== new URL(origin).host ||
      !request.url?.startsWith('/') ||
      request.url.startsWith('//')
    ) {
      response.writeHead(400).end();
      return;
    }
    const headers = { ...request.headers, host: upstream.host };
    // A verified frontend origin maps to the backend's own origin. Other origins
    // retain their value and are rejected by the backend's existing CSRF check.
    if (headers.origin === origin) headers.origin = upstream.origin;
    for (const name of [
      'connection',
      'upgrade',
      'proxy-authorization',
      'forwarded',
      'x-forwarded-for',
      'x-forwarded-host',
      'x-forwarded-proto',
    ])
      delete headers[name];
    const outgoing = httpRequest(
      {
        hostname: upstream.hostname,
        port: upstream.port || 80,
        path: request.url,
        method: request.method,
        headers,
      },
      (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.pipe(response);
      }
    );
    outgoing.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.on('aborted', () => outgoing.destroy());
    response.on('close', () => outgoing.destroy());
    request.pipe(outgoing);
  }
);
https.requestTimeout = 150_000;
https.headersTimeout = 15_000;
https.listen(port, host, () => console.log(`Local AI HTTPS: ${origin}`));
const setup = createHttpServer(serveSetup);
setup.listen(setupPort, host, () =>
  console.log(`iPad certificate setup: http://${host}:${setupPort}`)
);
function shutdown() {
  setup.close();
  https.close();
  setTimeout(() => {
    https.closeAllConnections();
    setup.closeAllConnections();
  }, 2000).unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
