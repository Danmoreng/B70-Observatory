import { createServer, createConnection, type Socket } from 'node:net';
import { writeFile } from 'node:fs/promises';

/** Fixed registry transport in a private network namespace, no forward proxy or host network. */
export async function startNpmBridge(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid npm capability');
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    if (sockets.size >= 64) {
      client.destroy();
      return;
    }
    const upstream = createConnection('/inference/npm.sock');
    sockets.add(client);
    sockets.add(upstream);
    client.once('error', () => upstream.destroy());
    upstream.once('error', () => client.destroy());
    client.once('close', () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.once('close', () => {
      sockets.delete(upstream);
      client.destroy();
    });
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(4873, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  await writeFile(
    '/tmp/b70-npmrc',
    `registry=http://127.0.0.1:4873/\n//127.0.0.1:4873/:_authToken=${token}\naudit=false\nfund=false\nupdate-notifier=false\n`,
    { mode: 0o600 }
  );
  return {
    env: {
      NPM_CONFIG_REGISTRY: 'http://127.0.0.1:4873/',
      NPM_CONFIG_USERCONFIG: '/tmp/b70-npmrc',
      NPM_CONFIG_CACHE: '/tmp/b70-npm-cache',
      NPM_CONFIG_AUDIT: 'false',
      NPM_CONFIG_FUND: 'false',
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
      NPM_CONFIG_DANGEROUSLY_ALLOW_ALL_SCRIPTS: 'true',
      // Prefer the package's portable prebuilt binary over this Arch host's libvips.
      SHARP_IGNORE_GLOBAL_LIBVIPS: '1',
    },
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}
