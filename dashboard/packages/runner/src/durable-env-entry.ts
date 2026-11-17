/** Runs inside bwrap: no durable DB, runner socket, host HOME or credentials. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import browserExtension from './browser-extension.js';
import desktopExtension from './desktop-extension.js';
import { BrowserSession } from './browser.js';
import { DesktopSession } from './desktop.js';
import { startNpmBridge } from './npm-bridge.js';

type BrowserTool = {
  name: string;
  execute: (id: string, args: Record<string, unknown>) => Promise<unknown>;
};
const tools = new Map<string, BrowserTool>();
const cleanup: Array<() => void | Promise<void>> = [];
const register = {
  registerTool(tool: Record<string, unknown>) {
    tools.set(String(tool.name), tool as unknown as BrowserTool);
  },
  on(_event: string, handler: (event: Record<string, unknown>) => void | Promise<void>) {
    cleanup.push(() => handler({}));
  },
};
const desktop = new DesktopSession();
const desktopEnabled = process.env.B70_DESKTOP_ROOT === '/runtime/desktop';
desktopExtension(register, desktopEnabled, desktop);
browserExtension(register, undefined, (engine) => {
  if (!desktopEnabled && engine === 'firefox')
    throw new Error('Firefox requires the isolated desktop.');
  return new BrowserSession({ engine, ...(desktopEnabled ? { desktop } : {}) });
});
// Internal viewer command; deliberately absent from model tool registrations.
if (desktopEnabled)
  tools.set('desktop_viewer_frame', {
    name: 'desktop_viewer_frame',
    execute: () => desktop.viewerFrame(),
  });
const browser = createServer((socket) => {
  let body = '';
  socket.setTimeout(120_000, () => socket.destroy());
  socket.on('data', (chunk: Buffer) => {
    body += chunk.toString('utf8');
    if (body.length > 1024 * 1024) {
      socket.destroy();
      return;
    }
    if (!body.endsWith('\n')) return;
    socket.removeAllListeners('data');
    void (async () => {
      try {
        const request = JSON.parse(body) as { name: string; args: Record<string, unknown> };
        const tool = tools.get(request.name);
        if (!tool) throw new Error('Sandbox tool unavailable');
        socket.end(JSON.stringify(await tool.execute('durable-browser', request.args)));
      } catch (error) {
        const reason =
          error instanceof Error ? error.message.slice(0, 300) : 'Browser operation failed.';
        socket.end(
          JSON.stringify({
            isError: true,
            content: [{ type: 'text', text: reason }],
          })
        );
      }
    })();
  });
});
await new Promise<void>((resolve, reject) => {
  browser.once('error', reject);
  browser.listen('/tmp/b70-durable-browser.sock', resolve);
});
const npm = process.env.B70_NPM_TOKEN ? await startNpmBridge(process.env.B70_NPM_TOKEN) : undefined;
const child = spawn('/runtime/pi-env', process.argv.slice(2), {
  // Keep the daemon's descriptors separate from Node-owned streams and forward
  // image payloads with normal stream backpressure in both directions.
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ...npm?.env },
});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdin.on('error', () => undefined);
child.once('close', (code) => {
  process.stdin.unpipe(child.stdin);
  process.stdin.pause();
  browser.close();
  npm?.close();
  void (async () => {
    const deadline = setTimeout(() => process.exit(code ?? 1), 6000);
    await Promise.allSettled(cleanup.map(async (fn) => fn()));
    clearTimeout(deadline);
    process.exitCode = code ?? 1;
    process.stdout.end(() => process.exit(code ?? 1));
  })();
});
child.once('error', () => process.exit(70));
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => child.kill(signal));
