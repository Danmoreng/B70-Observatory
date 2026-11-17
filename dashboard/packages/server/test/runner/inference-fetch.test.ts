import { expect, it, vi } from 'vitest';
import { createInferenceFetch } from '../../src/runner/inference-fetch.js';

const payload =
  'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":30,"completion_tokens":5}}\n\ndata: [DONE]\n\n';
it('preserves response bytes and auth, passes a gateway correlation ID and records completion once', async () => {
  const report = vi.fn();
  const upstream = vi.fn<typeof fetch>(
    async () => new Response(payload, { headers: { 'content-type': 'text/event-stream' } })
  );
  const response = await createInferenceFetch(report, upstream)(
    'http://gateway/v1/chat/completions',
    {
      headers: { authorization: 'Bearer private-gateway-credential' },
    }
  );
  expect(await response.text()).toBe(payload);
  const headers = new Headers(upstream.mock.calls[0]![1]!.headers);
  expect(headers.get('authorization')).toBe('Bearer private-gateway-credential');
  expect(report).toHaveBeenCalledTimes(1);
  expect(report.mock.calls[0]![0]).toMatchObject({
    requestId: headers.get('x-request-id'),
    outcome: 'completed',
    usage: { inputTokens: 30, outputTokens: 5 },
    prefill: null,
    decode: null,
  });
  expect(JSON.stringify(report.mock.calls)).not.toContain('credential');
});

it('recognizes a finished SSE response when the SDK cancels at DONE instead of reading EOF', async () => {
  const report = vi.fn();
  const upstream = vi.fn<typeof fetch>(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(payload));
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      )
  );
  const response = await createInferenceFetch(
    report,
    upstream
  )('http://gateway/v1/chat/completions');
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  expect(report.mock.calls[0]![0].outcome).toBe('completed');
  expect(report).toHaveBeenCalledTimes(1);
});

it('records interrupted, HTTP-error and rejected fetch attempts without successful token counts', async () => {
  for (const mode of ['cancel', 'http', 'reject']) {
    const report = vi.fn();
    const upstream = vi.fn<typeof fetch>(async () => {
      if (mode === 'reject') throw new Error('offline');
      return mode === 'http'
        ? new Response(payload, { status: 503 })
        : new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode('data: {"delta":"partial"}\n\n'));
              },
            })
          );
    });
    try {
      const response = await createInferenceFetch(
        report,
        upstream
      )('http://gateway/v1/chat/completions');
      if (mode === 'cancel') await response.body!.cancel();
      else await response.text();
    } catch {
      /* Network rejection is intentionally preserved. */
    }
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]![0]).toMatchObject({
      outcome: 'failed',
      usage: null,
      prefill: null,
      decode: null,
    });
  }
});

it('does not break inference when metric persistence throws', async () => {
  const response = await createInferenceFetch(
    () => {
      throw new Error('disk');
    },
    async () => new Response(payload, { headers: { 'content-type': 'text/event-stream' } })
  )('http://gateway/v1/chat/completions');
  expect(await response.text()).toBe(payload);
});
