import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { DesktopSession } from '../../../src/desktop.js';
import { BrowserSession } from '../../../src/browser.js';
import browserExtension from '../../../src/browser-extension.js';

const desktop = new DesktopSession();
const sessions: BrowserSession[] = [];
const tools = new Map<
  string,
  {
    execute: (
      id: string,
      args: Record<string, unknown>
    ) => Promise<{
      content: Array<{ type: string; text?: string; data?: string }>;
      isError?: boolean;
    }>;
  }
>();
browserExtension(
  {
    registerTool(tool) {
      tools.set(String(tool.name), tool as unknown as NonNullable<ReturnType<typeof tools.get>>);
    },
  },
  true,
  (engine) => {
    const session = new BrowserSession({ desktop, engine });
    sessions.push(session);
    return session;
  }
);
let forbiddenRequests = 0;
const forbiddenServer = createServer((_req, res) => {
  forbiddenRequests++;
  res.end('forbidden');
});
await new Promise<void>((resolve) => forbiddenServer.listen(8081, '127.0.0.1', resolve));
const html = `<!doctype html><html><title>Visible browser acceptance</title><style>body{font:24px sans-serif;padding:30px;background:#dde8ee}button,input{font:24px sans-serif;padding:12px}canvas{display:block;margin-top:20px}</style><h1>Shared visible browser</h1><button id="count" onclick="document.querySelector('#result').textContent='Count '+(++window.count)">Increment</button><p id="result">Count 0</p><form onsubmit="event.preventDefault();document.querySelector('#message').textContent='Submitted '+document.querySelector('input').value"><input id="name"><button>Submit</button></form><p id="message"></p><canvas width="300" height="180"></canvas><p id="webgl"></p><p id="gate"></p><script>window.count=0;const gl=document.querySelector('canvas').getContext('webgl2');document.querySelector('#webgl').textContent=gl?'WEBGL OK':'WEBGL FAILED';if(gl){gl.clearColor(.1,.7,.25,1);gl.clear(gl.COLOR_BUFFER_BIT)}fetch('http://127.0.0.1:8081/forbidden').then(()=>document.querySelector('#gate').textContent='NETWORK FAILED',()=>document.querySelector('#gate').textContent='NETWORK BLOCKED');</script></html>`;
const server = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html');
  response.end(html);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address !== 'string');
const output = '/workspace/evidence';
mkdirSync(output, { recursive: true });
const checks: string[] = [];
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await tools.get(name)!.execute('probe', args);
  const text = result.content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
  assert(!result.isError, text);
  return { result, text };
}
try {
  for (const browser of ['chromium', 'firefox']) {
    await call('browser_open', {
      url: `http://localhost:${address.port}`,
      browser,
      width: 1000,
      height: 680,
    });
    let inspected = (await call('browser_inspect')).text;
    assert(inspected.includes('WEBGL OK'), inspected);
    assert(inspected.includes('NETWORK BLOCKED'), inspected);
    assert.equal(forbiddenRequests, 0, 'Browser request gate allowed the forbidden relay port');
    await call('browser_action', { action: 'click', selector: '#count' });
    await call('browser_action', { action: 'type', selector: '#name', text: 'Grüße 27B' });
    await call('browser_action', { action: 'press', key: 'Enter' });
    inspected = (await call('browser_inspect')).text;
    assert(inspected.includes('Count 1') && inspected.includes('Submitted Grüße 27B'), inspected);
    await call('browser_resize', { width: 640, height: 480 });
    await call('browser_resize', { width: 1800, height: 1000 });
    inspected = (await call('browser_inspect')).text;
    assert(
      inspected.includes('Count 1') && inspected.includes('Submitted Grüße 27B'),
      'Resize lost the existing page state: ' + inspected
    );
    const shot = (await call('browser_screenshot')).result.content.find((p) => p.type === 'image');
    assert(shot?.data);
    writeFileSync(`${output}/${browser}-page.png`, Buffer.from(shot.data, 'base64'));
    const frame = await desktop.viewerFrame();
    const image = frame.content.find((p) => p.type === 'image');
    assert(image?.type === 'image');
    writeFileSync(`${output}/${browser}-desktop.png`, Buffer.from(image.data, 'base64'));
    checks.push(browser + ' visible browser, WebGL, input, state-preserving resize and screenshot');
    console.log('PASS ' + checks.at(-1));
  }
  assert.equal(sessions.length, 2);
  await call('browser_open', { url: `http://127.0.0.1:${address.port}`, browser: 'chromium' });
  assert.equal(sessions.length, 2, 'Browser switch created a duplicate session');
  const observation = await desktop.call('observe', {});
  writeFileSync(
    `${output}/desktop-observation.json`,
    JSON.stringify(observation.content.filter((p) => p.type === 'text'))
  );
  await desktop.call('stop', {});
  await call('browser_open', { url: `http://127.0.0.1:${address.port}`, browser: 'firefox' });
  assert.equal(sessions.length, 3, 'Desktop restart reused a dead browser');
  checks.push('two browser sessions shared one desktop; restart creates fresh browser');
  writeFileSync(`${output}/report.json`, JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  await Promise.allSettled(sessions.map((session) => session.close()));
  await desktop.close();
  forbiddenServer.closeAllConnections();
  await new Promise<void>((resolve) => forbiddenServer.close(() => resolve()));
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
