import { afterEach, describe, expect, it, vi } from 'vitest';
import { FirefoxProtocol } from '../src/firefox.js';
function fixture() {
  const socket = new EventTarget() as EventTarget & {
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  socket.close = vi.fn();
  socket.send = vi.fn((raw: string) => {
    const { id, method } = JSON.parse(raw);
    queueMicrotask(() =>
      socket.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'success',
            id,
            result: method === 'Runtime.evaluate' ? {} : {},
          }),
        })
      )
    );
  });
  const protocol = new FirefoxProtocol(socket as unknown as WebSocket, 50);
  const event = (method: string, params: Record<string, unknown>) =>
    socket.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify({ type: 'event', method, params }) })
    );
  return {
    socket,
    protocol,
    event,
    commands: () =>
      socket.send.mock.calls.map(
        (call) => JSON.parse(call[0]) as { method: string; params: Record<string, unknown> }
      ),
  };
}
afterEach(() => vi.useRealTimers());
describe('Firefox BiDi boundary', () => {
  it('uses a real BiDi session, intercepts all request contexts and denies downloads', async () => {
    const { protocol, commands, event } = fixture();
    try {
      await protocol.initialize();
      await protocol.send('Fetch.enable');
      await protocol.send('Browser.setDownloadBehavior');
      const paused = vi.fn();
      protocol.onEvent('Fetch.requestPaused', paused);
      event('network.beforeRequestSent', {
        isBlocked: true,
        request: { request: 'request-1', url: 'http://127.0.0.1:8081/' },
      });
      expect(paused).toHaveBeenCalledWith({
        requestId: 'request-1',
        request: { url: 'http://127.0.0.1:8081/' },
      });
      await protocol.send('Fetch.failRequest', { requestId: 'request-1' });
      expect(commands().map((c) => c.method)).toEqual([
        'session.new',
        'session.subscribe',
        'network.addIntercept',
        'browser.setDownloadBehavior',
        'network.failRequest',
      ]);
      expect(commands().find((c) => c.method === 'network.addIntercept')?.params).toEqual({
        phases: ['beforeRequestSent'],
      });
      expect(commands().find((c) => c.method === 'browser.setDownloadBehavior')?.params).toEqual({
        downloadBehavior: { type: 'denied' },
      });
    } finally {
      protocol.close();
    }
  });
  it('rejects unknown operations and pending requests on close instead of reporting success', async () => {
    const { socket, protocol } = fixture();
    await expect(protocol.send('Unknown.command')).rejects.toThrow('Unsupported Firefox');
    socket.send.mockImplementation(() => {});
    const eventPending = protocol.waitEvent('Page.loadEventFired', 60000);
    const eventRejected = expect(eventPending).rejects.toThrow('closed');
    const pending = protocol.send('Fetch.enable');
    const rejected = expect(pending).rejects.toThrow('closed');
    protocol.close();
    await rejected;
    await eventRejected;
    await expect(protocol.waitEvent('Page.loadEventFired', 50)).rejects.toThrow('closed');
  });
});
