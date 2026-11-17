import { afterEach, describe, expect, it, vi } from 'vitest';
import browserExtension from '../src/browser-extension.js';
import { BrowserInputError, BrowserSession, sanitizeSelector } from '../src/browser.js';

type Tool = { execute(id: string, params: Record<string, unknown>): Promise<unknown> };
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('browser extension session recovery', () => {
  it('selects Chromium by default, keeps two independent sessions, and reuses the selected instance', async () => {
    vi.spyOn(BrowserSession.prototype, 'isRunning', 'get').mockReturnValue(true);
    const navigate = vi
      .spyOn(BrowserSession.prototype, 'navigate')
      .mockResolvedValue({ url: 'http://127.0.0.1:3000', title: 'RPS' });
    const resize = vi
      .spyOn(BrowserSession.prototype, 'resize')
      .mockResolvedValue({ width: 1800, height: 1000 });
    const inspect = vi
      .spyOn(BrowserSession.prototype, 'inspect')
      .mockResolvedValue('existing page');
    vi.spyOn(BrowserSession.prototype, 'screenshot').mockRejectedValue(
      new Error('fixture without pixels')
    );
    const factory = vi.fn(() => new BrowserSession());
    const tools = new Map<string, Tool>();
    browserExtension(
      { registerTool: (raw) => tools.set(String(raw.name), raw as unknown as Tool) },
      true,
      factory
    );
    const open = tools.get('browser_open')!;
    await open.execute('1', { url: 'http://127.0.0.1:3000' });
    await open.execute('2', { url: 'http://127.0.0.1:3000', browser: 'firefox' });
    await tools.get('browser_inspect')!.execute('3', {});
    await tools.get('browser_resize')!.execute('resize', { width: 1800, height: 1000 });
    expect(resize.mock.contexts[0]).toBe(navigate.mock.contexts[1]);
    expect(navigate.mock.calls[0]?.[1]).toEqual({ width: 1440, height: 900 });
    expect(inspect.mock.contexts.at(-1)).toBe(navigate.mock.contexts[1]);
    await open.execute('4', { url: 'http://127.0.0.1:3000' });
    expect(navigate.mock.contexts[2]).toBe(navigate.mock.contexts[0]);
    expect(factory.mock.calls).toEqual([['chromium'], ['firefox']]);
  });
  it('never labels a legacy headless Chromium as Firefox', async () => {
    const navigate = vi.spyOn(BrowserSession.prototype, 'navigate');
    const tools = new Map<string, Tool>();
    browserExtension(
      { registerTool: (raw) => tools.set(String(raw.name), raw as unknown as Tool) },
      true
    );
    expect(
      await tools
        .get('browser_open')!
        .execute('1', { url: 'http://127.0.0.1:3000', browser: 'firefox' })
    ).toMatchObject({ isError: true });
    expect(navigate).not.toHaveBeenCalled();
  });
  it('keeps a preview after input/element errors and closes it after runtime failures', async () => {
    vi.stubEnv('B70_BROWSER_ROOT', '/browser');
    vi.spyOn(BrowserSession.prototype, 'isRunning', 'get').mockReturnValue(true);
    vi.spyOn(BrowserSession.prototype, 'navigate').mockResolvedValue({
      url: 'http://127.0.0.1:5173/',
      title: 'Preview',
    });
    const close = vi.spyOn(BrowserSession.prototype, 'close').mockResolvedValue();
    const inspect = vi
      .spyOn(BrowserSession.prototype, 'inspect')
      .mockImplementation(async (selector) => {
        if (selector !== undefined) sanitizeSelector(selector);
        return 'Preview remains open';
      });
    const action = vi
      .spyOn(BrowserSession.prototype, 'act')
      .mockRejectedValue(new BrowserInputError('Element nicht gefunden'));
    const tools = new Map<string, Tool>();
    browserExtension({
      registerTool: (tool) => tools.set(String(tool.name), tool as unknown as Tool),
    });
    const call = (name: string, params: Record<string, unknown> = {}) =>
      tools.get(name)!.execute('test', params);
    await call('browser_open', { url: 'http://127.0.0.1:5173/' });
    expect(await call('browser_inspect', { selector: 'button;alert(1)' })).toMatchObject({
      isError: true,
    });
    await call('browser_action', { action: 'click', selector: '#missing' });
    expect(close).not.toHaveBeenCalled();
    expect(await call('browser_inspect')).toMatchObject({
      content: [{ text: expect.stringContaining('Preview remains open') }],
    });
    expect(inspect.mock.contexts[0]).toBe(inspect.mock.contexts[1]);
    action.mockRejectedValueOnce(new Error('CDP connection lost'));
    expect(await call('browser_action', { action: 'reload' })).toMatchObject({ isError: true });
    expect(close).toHaveBeenCalledOnce();
    await call('browser_inspect');
    expect(inspect.mock.contexts.at(-1)).not.toBe(inspect.mock.contexts[0]);
  });

  it('returns the same screenshot bytes after opening, inspecting and acting', async () => {
    vi.stubEnv('B70_BROWSER_ROOT', '/browser');
    vi.spyOn(BrowserSession.prototype, 'isRunning', 'get').mockReturnValue(true);
    vi.spyOn(BrowserSession.prototype, 'navigate').mockResolvedValue({
      url: 'http://127.0.0.1:5173/',
      title: 'Preview',
    });
    vi.spyOn(BrowserSession.prototype, 'inspect').mockResolvedValue('English active');
    const act = vi.spyOn(BrowserSession.prototype, 'act').mockResolvedValue('Klick ausgeführt.');
    const png = Buffer.from('screenshot fixture');
    const screenshot = vi.spyOn(BrowserSession.prototype, 'screenshot').mockResolvedValue({
      png,
      mimeType: 'image/png',
      width: 820,
      height: 1180,
      byteLength: png.length,
      clipped: false,
    });
    const tools = new Map<string, Tool>();
    browserExtension({
      registerTool: (tool) => tools.set(String(tool.name), tool as unknown as Tool),
    });
    const call = (name: string, params: Record<string, unknown> = {}) =>
      tools.get(name)!.execute('test', params);
    for (const [name, params] of [
      ['browser_open', { url: 'http://127.0.0.1:5173/' }],
      ['browser_inspect', {}],
      ['browser_action', { action: 'click', selector: '.lang-en' }],
    ] as const) {
      const result = await call(name, params);
      expect(result).toMatchObject({
        content: [
          ...(name === 'browser_action' ? [] : [{ type: 'text', text: expect.any(String) }]),
          { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
        ],
      });
      expect(JSON.stringify(result)).not.toMatch(
        /Aktueller Screenshot|Dasselbe Bild|Klick ausgeführt/
      );
    }
    expect(screenshot).toHaveBeenCalledTimes(3);
    screenshot.mockRejectedValueOnce(new Error('capture too large'));
    const result = await call('browser_action', { action: 'click', selector: '#submit' });
    expect(result).toMatchObject({
      content: [
        {
          text: expect.stringContaining(
            'Operation completed. Automatic screenshot failed: capture too large'
          ),
        },
      ],
      details: { screenshotError: 'capture too large' },
    });
    expect(result).not.toHaveProperty('isError', true);
    expect(JSON.stringify(result)).toContain('Do not repeat the operation');
    expect(act).toHaveBeenCalledTimes(2);
    act.mockRejectedValueOnce(new BrowserInputError('Element fehlt'));
    expect(await call('browser_action', { action: 'click', selector: '#missing' })).toMatchObject({
      isError: true,
    });
    expect(screenshot).toHaveBeenCalledTimes(4);
  });
});
