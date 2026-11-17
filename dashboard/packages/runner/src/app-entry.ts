/** Trusted reverse bridge: no host sockets or host network are available to app code. */
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';

const entry = realpathSync('/workspace/server.mjs');
if (!entry.startsWith('/workspace/')) throw new Error('App entry must stay inside the repository');
const sockets = new Set<Socket>();
let closing = false;
const child = spawn('/usr/bin/node', [entry], {
  cwd: '/workspace',
  env: {
    PATH: '/usr/bin:/bin',
    HOME: '/tmp',
    LANG: 'C.UTF-8',
    PORT: '3000',
    B70_APP_DATA: '/app-data',
    NODE_ENV: 'production',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
function connect(): void {
  if (closing) return;
  // Both destinations are fixed: the one read-only-mounted host relay and this namespace's app.
  const relay = createConnection('/app-socket/relay.sock');
  let app: Socket | undefined;
  sockets.add(relay);
  relay.once('connect', () => {
    app = createConnection({ host: '127.0.0.1', port: 3000 });
    sockets.add(app);
    app.once('error', () => relay.destroy());
    app.once('close', () => {
      sockets.delete(app!);
      relay.destroy();
    });
    relay.pipe(app);
    app.pipe(relay);
  });
  relay.once('error', () => relay.destroy());
  relay.once('close', () => {
    sockets.delete(relay);
    app?.destroy();
    if (!closing) setTimeout(connect, 100);
  });
}
for (let i = 0; i < 8; i++) connect();
child.once('error', (error) => {
  process.stderr.write(String(error));
  process.exit(1);
});
child.once('exit', (code) => process.exit(code ?? 1));
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    closing = true;
    for (const socket of sockets) socket.destroy();
    child.kill(signal);
  });
