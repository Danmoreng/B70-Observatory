import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { desktopEnvironment, DesktopSession, type DesktopResult } from '../src/desktop.js';
import registerDesktopTools from '../src/desktop-extension.js';

const png = readFileSync(new URL('./fixtures/desktop/blank.png', import.meta.url));
const text = (result: DesktopResult) =>
  result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
const snapshot = (result: DesktopResult) =>
  JSON.parse(text(result).split('\n')[1]!).snapshot as string;
function fixture() {
  const backend = vi.fn(async (args: string[]): Promise<Record<string, unknown>> => {
    if (args[0] === 'start')
      return {
        status: {
          width: Number(args[args.indexOf('--width') + 1]),
          height: Number(args[args.indexOf('--height') + 1]),
        },
      };
    if (args[0] === 'env')
      return {
        environment: {
          variables: [
            { name: 'DISPLAY', value: ':90' },
            { name: 'XAUTHORITY', value: '/tmp/b70-desktop/run/b70/Xauthority' },
            { name: 'B70_NPM_TOKEN', value: 'never-inherit' },
          ],
        },
      };
    if (args[0] === 'observe')
      return {
        screenshot: { path: '/tmp/b70-desktop/frame.png' },
        windows: [{ id: '12', title: 'Canvas' }],
      };
    return { ok: true, message: 'Input completed.' };
  });
  const read = vi.fn(async () => png);
  const session = new DesktopSession(backend, read);
  return {
    session,
    backend,
    read,
    start: () => session.call('start', { width: 640, height: 480 }),
  };
}

describe('isolated desktop tools', () => {
  it('is opt-in and never inherits a host session or credentials', () => {
    const registerTool = vi.fn();
    registerDesktopTools({ registerTool }, false);
    expect(registerTool).not.toHaveBeenCalled();
    const env = desktopEnvironment();
    for (const name of [
      'DISPLAY',
      'WAYLAND_DISPLAY',
      'DBUS_SESSION_BUS_ADDRESS',
      'SSH_AUTH_SOCK',
      'B70_NPM_TOKEN',
      'B70_RUNNER_GATEWAY_TOKEN',
    ])
      expect(env[name]).toBeUndefined();
    expect(env.HOME).toBe('/tmp/b70-desktop/home');
    expect(env.LIBGL_ALWAYS_SOFTWARE).toBe('1');
  });
  it('captures observer frames without renewing or invalidating the agent input snapshot', async () => {
    const { session, start } = fixture();
    expect((await session.viewerFrame()).content).toEqual([]);
    const token = snapshot(await start());
    const frame = await session.viewerFrame();
    expect(frame.content[0]?.type).toBe('image');
    expect(
      (await session.call('action', { action: 'click', snapshot: token, x: 10, y: 20 })).isError
    ).toBeUndefined();
  });
  it('skips observer work while model input is queued and never dispatches it concurrently', async () => {
    const { session, backend, start } = fixture();
    const token = snapshot(await start());
    let finish!: (value: Record<string, unknown>) => void;
    backend.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const action = session.call('action', { action: 'click', snapshot: token, x: 10, y: 20 });
    await Promise.resolve();
    expect((await session.viewerFrame()).content).toEqual([]);
    finish({ ok: true });
    await action;
  });
  it('automatically prepares only its private browser display and preserves a running desktop generation', async () => {
    const { session, backend } = fixture();
    const display = await session.prepareBrowser();
    expect(display.env.DISPLAY).toBe(':90');
    expect(display.env.XAUTHORITY).toMatch(/^\/tmp\/b70-desktop\//);
    expect(display.env.B70_NPM_TOKEN).toBeUndefined();
    expect(display.width).toBe(1920);
    expect(display.height).toBe(1200);
    const epoch = session.generation;
    await session.call('start', { width: 1920, height: 1200 });
    expect(session.generation).toBe(epoch);
    backend.mockResolvedValueOnce({
      environment: {
        variables: [
          { name: 'DISPLAY', value: ':0' },
          { name: 'XAUTHORITY', value: '/home/operator/.Xauthority' },
        ],
      },
    });
    await expect(session.prepareBrowser()).rejects.toThrow('Invalid private desktop');
  });
  it('returns the actual image and a full-desktop observation', async () => {
    const { start } = fixture();
    const result = await start();
    expect(result.isError).toBeUndefined();
    expect(result.content[1]).toEqual({
      type: 'image',
      mimeType: 'image/png',
      data: png.toString('base64'),
    });
    expect(snapshot(result)).toMatch(/^[a-f0-9-]{36}$/);
  });
  it('refuses stale snapshots, out-of-bounds points and unobserved window IDs without sending input', async () => {
    const { session, backend, start } = fixture();
    const token = snapshot(await start());
    for (const args of [
      { action: 'click', snapshot: 'stale', x: 1, y: 1 },
      { action: 'click', snapshot: token, x: 640, y: 1 },
      { action: 'focus', snapshot: token, windowId: '999' },
      { action: 'press', snapshot: token, key: 'Return; whoami' },
    ])
      expect((await session.call('action', args)).isError).toBe(true);
    expect(backend.mock.calls.map((call) => call[0][0])).toEqual(['start', 'observe']);
    const result = await session.call('action', { action: 'click', snapshot: token, x: 12, y: 20 });
    expect(backend).toHaveBeenCalledWith(
      ['click', '--button', '1', '--count', '1', '12', '20'],
      undefined
    );
    expect(snapshot(result)).not.toBe(token);
  });
  it('serializes competing calls and consumes each observed snapshot once', async () => {
    const { session, backend, start } = fixture();
    const token = snapshot(await start());
    const args = { action: 'type', snapshot: token, text: 'Grüße aus Köln' };
    const results = await Promise.all([session.call('action', args), session.call('action', args)]);
    expect(results[0]!.isError).toBeUndefined();
    expect(results[1]!.isError).toBe(true);
    expect(backend.mock.calls.filter((call) => call[0][0] === 'type')).toHaveLength(1);
  });
  it('does not retry a timed-out action and requires a fresh observation', async () => {
    const { session, backend, start } = fixture();
    const token = snapshot(await start());
    backend.mockRejectedValueOnce(new Error('Timed out after dispatch.'));
    const result = await session.call('action', {
      action: 'press',
      key: 'ctrl+s',
      snapshot: token,
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('outcome may be unknown');
    expect(
      (await session.call('action', { action: 'press', key: 'ctrl+s', snapshot: token })).isError
    ).toBe(true);
    expect(backend.mock.calls.filter((call) => call[0][0] === 'key')).toHaveLength(1);
    expect(snapshot(await session.call('observe', {}))).not.toBe(token);
  });
  it('reports a completed action honestly when its screenshot fails', async () => {
    const { session, read, start } = fixture();
    const token = snapshot(await start());
    read.mockRejectedValueOnce(new Error('Capture failed.'));
    const result = await session.call('action', { action: 'click', snapshot: token, x: 1, y: 1 });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('Input completed.');
    expect(text(result)).toContain('Do not repeat a completed action');
    expect(
      (await session.call('action', { action: 'click', snapshot: token, x: 1, y: 1 })).isError
    ).toBe(true);
  });
  it('refuses malformed images and never labels them as screenshots', async () => {
    const { read, start } = fixture();
    read.mockResolvedValue(Buffer.from('not a PNG'));
    const result = await start();
    expect(result.content.every((part) => part.type === 'text')).toBe(true);
    expect(text(result)).toContain('Observation failed');
  });
  it('honors cancellation before any dispatch and rejects unknown arguments', async () => {
    const { session, backend } = fixture();
    const signal = AbortSignal.abort();
    expect((await session.call('start', {}, signal)).isError).toBe(true);
    expect((await session.call('start', { display: ':0' })).isError).toBe(true);
    expect(backend).not.toHaveBeenCalled();
  });
  it('rejects launch directories outside the project before dispatch', async () => {
    const { session, backend, start } = fixture();
    await start();
    const result = await session.call('launch', {
      command: ['/usr/bin/echo', 'test'],
      cwd: '/tmp',
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('inside /workspace');
    expect(backend.mock.calls.filter((call) => call[0][0] === 'launch')).toHaveLength(0);
  });
});
