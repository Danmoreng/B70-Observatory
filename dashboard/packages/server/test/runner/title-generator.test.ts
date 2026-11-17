import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateTaskTitle } from '../../src/runner/title-generator.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  while (cleanups.length > 0) await cleanups.pop()!();
});

interface MockUpstream {
  baseUrl: string;
  /** Content returned in the next completion; defaults to a fixed title. */
  nextContent: string | undefined;
  status: number;
  requests(): Array<{ path: string; body: Record<string, unknown> }>;
}

function startUpstream(): Promise<MockUpstream> {
  const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
  const state = { nextContent: undefined as string | undefined, status: 200 };
  const server: Server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.once('end', () => {
      seen.push({
        path: incoming.url ?? '',
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      });
      outgoing.writeHead(state.status, { 'content-type': 'application/json' });
      outgoing.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: state.nextContent ?? 'Refactor telemetry collector',
              },
              finish_reason: 'stop',
            },
          ],
        })
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('missing test port');
      const port = (address as AddressInfo).port;
      cleanups.push(() => new Promise<void>((close) => server.close(() => close())));
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        get nextContent() {
          return state.nextContent;
        },
        set nextContent(value: string | undefined) {
          state.nextContent = value;
        },
        get status() {
          return state.status;
        },
        set status(value: number) {
          state.status = value;
        },
        requests: () => seen,
      });
    });
  });
}

describe('generateTaskTitle', () => {
  it('asks the loaded model for a title based on the task text', async () => {
    const upstream = await startUpstream();
    const config = { gatewayUrl: upstream.baseUrl, model: 'Qwen3.8-27B' };
    const title = await generateTaskTitle(
      config,
      'Please fix the off-by-one error in the chart axis'
    );
    expect(title).toBe('Refactor telemetry collector');
    const request = upstream.requests().at(-1)!;
    expect(request.path).toBe('/v1/chat/completions');
    expect(request.body.model).toBe('Qwen3.8-27B');
    expect(request.body.stream).toBe(false);
    expect(request.body.reasoning_effort).toBe('none');
    expect(request.body.chat_template_kwargs).toEqual({ enable_thinking: false });
    const messages = request.body.messages as Array<{ role: string; content: string }>;
    expect(messages.at(-1)!.content).toContain('off-by-one error in the chart axis');
    expect(messages.at(-1)!.content).toContain('Titel');
  });

  it('cleans quotes, extra lines and trailing punctuation from the model answer', async () => {
    const upstream = await startUpstream();
    const config = { gatewayUrl: upstream.baseUrl, model: 'Qwen3.8-27B' };
    upstream.nextContent = `  "Fix login redirect."  \nsecond line\n`;
    expect(await generateTaskTitle(config, 'Fix login redirect')).toBe('Fix login redirect');
  });

  it('truncates overly long answers to the short title limit', async () => {
    const upstream = await startUpstream();
    const config = { gatewayUrl: upstream.baseUrl, model: 'Qwen3.8-27B' };
    upstream.nextContent = `x`.repeat(400);
    const title = await generateTaskTitle(config, 'Do something');
    expect(title!.length).toBeLessThanOrEqual(60);
    expect(title!.endsWith('…')).toBe(true);
  });

  it('truncates long task descriptions before sending them to the model', async () => {
    const upstream = await startUpstream();
    const config = { gatewayUrl: upstream.baseUrl, model: 'Qwen3.8-27B' };
    await generateTaskTitle(config, `a`.repeat(10_000));
    const messages = upstream.requests().at(-1)!.body.messages as Array<{ content: string }>;
    expect(messages.at(-1)!.content.length).toBeLessThan(3_000);
  });

  it('resolves to undefined on HTTP errors so the fallback title applies', async () => {
    const upstream = await startUpstream();
    const config = { gatewayUrl: upstream.baseUrl, model: 'Qwen3.8-27B' };
    upstream.status = 500;
    expect(await generateTaskTitle(config, 'Any task')).toBeUndefined();
  });

  it('settles when an upstream response exceeds the size limit', async () => {
    const upstream = await startUpstream();
    upstream.nextContent = 'x'.repeat(256 * 1024);
    expect(
      await generateTaskTitle({ gatewayUrl: upstream.baseUrl, model: 'm' }, 'Task')
    ).toBeUndefined();
  });

  it('bounds an unfinished response with an absolute deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let received!: () => void;
    const incoming = new Promise<void>((resolve) => {
      received = resolve;
    });
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{');
      received();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    );
    const port = (server.address() as AddressInfo).port;
    const title = generateTaskTitle({ gatewayUrl: `http://127.0.0.1:${port}`, model: 'm' }, 'Task');
    await incoming;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await title).toBeUndefined();
  });

  it('resolves to undefined when the model endpoint is unreachable', async () => {
    const server = createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(
      await generateTaskTitle({ gatewayUrl: `http://127.0.0.1:${port}`, model: 'm' }, 'Task')
    ).toBeUndefined();
  });

  it('resolves to undefined for empty or unparsable model answers', async () => {
    const upstream = await startUpstream();
    const config = { gatewayUrl: upstream.baseUrl, model: 'Qwen3.8-27B' };
    upstream.nextContent = '   \n\t  ';
    expect(await generateTaskTitle(config, 'Task')).toBeUndefined();
    upstream.nextContent = '"""';
    expect(await generateTaskTitle(config, 'Task')).toBeUndefined();
  });
});
