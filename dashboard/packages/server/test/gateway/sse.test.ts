import { describe, expect, it } from 'vitest';
import { SseMeter, extractUsage } from '../../src/gateway/sse.js';

describe('extractUsage', () => {
  it('extracts all counters from a full usage object', () => {
    expect(
      extractUsage({ usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })
    ).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
  });

  it('keeps missing counters as null', () => {
    expect(extractUsage({ usage: { prompt_tokens: 5 } })).toEqual({
      promptTokens: 5,
      completionTokens: null,
      totalTokens: null,
    });
  });

  it('returns null for missing, non-object or non-numeric usage', () => {
    expect(extractUsage({})).toBeNull();
    expect(extractUsage(null)).toBeNull();
    expect(extractUsage('usage')).toBeNull();
    expect(extractUsage({ usage: 'nope' })).toBeNull();
    expect(extractUsage({ usage: { prompt_tokens: 'ten' } })).toBeNull();
    expect(extractUsage({ usage: { prompt_tokens: -1 } })).toBeNull();
    expect(extractUsage({ usage: { prompt_tokens: 1.5 } })).toBeNull();
    expect(extractUsage({ usage: { prompt_tokens: NaN } })).toBeNull();
  });
});

describe('SseMeter', () => {
  const push = (meter: SseMeter, data: string | Uint8Array, atMs = 1000): void => {
    meter.onChunk(typeof data === 'string' ? new TextEncoder().encode(data) : data, atMs);
  };

  it('counts bytes across chunks', () => {
    const meter = new SseMeter();
    push(meter, 'data: x\n\n');
    push(meter, 'data: y\n\n');
    expect(meter.bytes).toBe(Buffer.byteLength('data: x\n\ndata: y\n\n'));
  });

  it('stamps firstDataAt only on data: lines (not on SSE comments or CRLF)', () => {
    const commentOnly = new SseMeter();
    push(commentOnly, ': OPENAI-BYTE-PATCH-ANNOTATION\n\n');
    expect(commentOnly.firstDataAt).toBeNull();
    push(commentOnly, '\r\n', 1100);
    expect(commentOnly.firstDataAt).toBeNull();

    const data = new SseMeter();
    push(data, ': comment\n\n', 100);
    push(data, 'data: {"role":"assistant"}\n\n', 200);
    expect(data.firstDataAt).toBe(200);

    // A data line at the very start of the stream counts too.
    const first = new SseMeter();
    push(first, 'data: x\n\n', 42);
    expect(first.firstDataAt).toBe(42);
  });

  it('extracts usage from a final SSE event but not from [DONE]', () => {
    const meter = new SseMeter();
    push(meter, 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
    expect(meter.usage).toBeNull();
    push(
      meter,
      'data: {"choices":[{"delta":{"content":" hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n'
    );
    expect(meter.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
    push(meter, 'data: [DONE]\n\n');
    expect(meter.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  });

  it('handles events split across chunk boundaries', () => {
    const event = 'data: {"usage":{"prompt_tokens":9,"completion_tokens":1,"total_tokens":10}}\n\n';
    const meter = new SseMeter();
    const encoded = new TextEncoder().encode(event);
    const half = Math.floor(encoded.length / 2);
    push(meter, encoded.subarray(0, half), 1);
    push(meter, encoded.subarray(half), 2);
    expect(meter.usage).toEqual({ promptTokens: 9, completionTokens: 1, totalTokens: 10 });
  });

  it('ignores non-JSON data payloads without throwing', () => {
    const meter = new SseMeter();
    push(meter, 'data: {broken json with usage\n\n');
    expect(meter.usage).toBeNull();
    expect(meter.bytes).toBeGreaterThan(0);
  });

  it('bounds the pending buffer: a huge event cannot grow memory unboundedly', () => {
    const meter = new SseMeter();
    // No event terminator at all – a single "in-flight event".
    push(meter, 'x'.repeat(512 * 1024), 1);
    push(meter, 'x'.repeat(512 * 1024), 2);
    expect(meter.bytes).toBe(1024 * 1024);
    expect(meter.usage).toBeNull();
  });

  it('supports CRLF event terminators', () => {
    const meter = new SseMeter();
    push(
      meter,
      'data: {"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\r\n\r\n'
    );
    expect(meter.usage).toEqual({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
  });

  it('stamps firstDataAt at the moment a `data:` marker completes, even if it is split across chunks', () => {
    // The `data:` marker itself is split: `dat` in one chunk, `a: …` in
    // the next. The marker only becomes visible in the second chunk, so
    // that chunk's timestamp is the first-token time – even though the
    // line (and the stream) continues past it.
    const meter = new SseMeter();
    push(meter, 'dat', 100);
    expect(meter.firstDataAt).toBeNull();
    push(meter, 'a: {"x":1} partial', 250);
    expect(meter.firstDataAt).toBe(250);
    push(meter, ',"y":2}\n\n', 400);
    expect(meter.firstDataAt).toBe(250);
  });

  it('ignores `data:` text that is not at the start of a line (no false positives mid-payload)', () => {
    const meter = new SseMeter();
    push(meter, 'data: {"choices":[{"delta":{"content":"note: data: fake"}}]}\n\n', 100);
    // The outer line *is* a data line, so it stamps – but at the right
    // (outer) line's start time, not some later chunk.
    expect(meter.firstDataAt).toBe(100);

    const meter2 = new SseMeter();
    push(meter2, ': a comment that mentions data: inline\n\n', 10);
    expect(meter2.firstDataAt).toBeNull();
  });

  it('does not stamp firstDataAt on heartbeats or blank lines before the first data field', () => {
    const meter = new SseMeter();
    push(meter, ': keepalive\n\n', 10);
    expect(meter.firstDataAt).toBeNull();
    push(meter, '\n\n', 20);
    expect(meter.firstDataAt).toBeNull();
    push(meter, ': heartbeat again\n\n', 30);
    expect(meter.firstDataAt).toBeNull();
    push(meter, 'data: {"x":1}\n\n', 40);
    expect(meter.firstDataAt).toBe(40);
  });

  it('finds the first data field when comments and data share one chunk', () => {
    const meter = new SseMeter();
    push(meter, ': keepalive\n\n: second comment\n\ndata: {"x":1}\n\n', 75);
    expect(meter.firstDataAt).toBe(75);
  });

  it('handles a UTF-8 multi-byte character split across chunk boundaries', () => {
    // `€` is 3 bytes (E2 82 AC). Split it in the middle of the data line
    // so the decoder must carry the partial sequence across the boundary.
    const event =
      'data: {"t":"€","usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n';
    const encoded = new TextEncoder().encode(event);
    // The euro sign occupies byte offsets 12..14; split right after its
    // first byte so the decoder must carry 0x82 0xAC across the boundary.
    const splitAt = 13;
    expect(encoded[splitAt - 1]).toBe(0xe2);
    expect(encoded[splitAt]).toBe(0x82);
    const meter = new SseMeter();
    push(meter, encoded.subarray(0, splitAt), 100);
    // The marker is visible (and the first-token time fixed) although the
    // line itself is not complete yet…
    expect(meter.firstDataAt).toBe(100);
    push(meter, encoded.subarray(splitAt), 150);
    // …and the rest of the line arriving later does not move it.
    expect(meter.firstDataAt).toBe(100);
    // The partial character must not corrupt usage extraction.
    expect(meter.usage).toEqual({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
  });

  it('stamps firstDataAt for a data line that completes in a later chunk', () => {
    const meter = new SseMeter();
    push(meter, ': comment\n\n', 10);
    expect(meter.firstDataAt).toBeNull();
    push(meter, 'data: {"x":1}\n', 50);
    expect(meter.firstDataAt).toBe(50);
    push(meter, '\n', 900);
    expect(meter.firstDataAt).toBe(50);
  });
});

describe('Responses and Anthropic usage', () => {
  it('extracts nested Responses usage', () => {
    expect(
      extractUsage({ response: { usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } })
    ).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  });
  it('combines input and output counters from separate Anthropic events', () => {
    const meter = new SseMeter();
    meter.onChunk(
      Buffer.from('data: {"message":{"usage":{"input_tokens":7,"output_tokens":0}}}\n\n'),
      1
    );
    meter.onChunk(Buffer.from('data: {"usage":{"output_tokens":4}}\n\n'), 2);
    expect(meter.usage).toEqual({ promptTokens: 7, completionTokens: 4, totalTokens: 11 });
  });
});
