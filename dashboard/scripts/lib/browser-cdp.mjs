/** Small, dependency-free browser driver for local acceptance checks. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(check, message, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(100);
  }
  throw new Error(message);
}
export async function openBrowser() {
  const profile = mkdtempSync(join(tmpdir(), 'b70-map-browser-'));
  const chrome = spawn(
    '/usr/bin/google-chrome-stable',
    [
      '--headless=new',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-background-networking',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  let ws;
  const close = async () => {
    ws?.close();
    if (chrome.exitCode === null) {
      chrome.kill('SIGTERM');
      await Promise.race([once(chrome, 'exit'), pause(3000)]);
    }
    if (chrome.exitCode === null) chrome.kill('SIGKILL');
    rmSync(profile, { recursive: true, force: true });
  };
  try {
    let port;
    await until(() => {
      try {
        port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
        return port > 0;
      } catch {
        return false;
      }
    }, 'Chrome did not start');
    const target = await (
      await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
    ).json();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await once(ws, 'open');
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(String(data));
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const key = ++id;
        const timer = setTimeout(() => {
          pending.delete(key);
          reject(new Error(`CDP timeout: ${method}`));
        }, 15_000);
        pending.set(key, { resolve, reject, timer });
        ws.send(JSON.stringify({ id: key, method, params }));
      });
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    };
    return {
      send,
      evaluate,
      close,
      capture: async (path) => {
        const { data } = await send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(path, Buffer.from(data, 'base64'));
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
