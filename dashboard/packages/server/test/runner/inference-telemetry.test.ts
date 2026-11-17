import { describe, expect, it } from 'vitest';
import {
  createInferenceTelemetryObserver,
  readEngineWait,
} from '../../src/runner/inference-telemetry.js';

const timings = { prompt_n: 100, prompt_ms: 50, predicted_n: 20, predicted_ms: 400 };
const usage = {
  prompt_tokens: 300,
  completion_tokens: 20,
  prompt_tokens_details: { cached_tokens: 200 },
};
const final = { choices: [{ finish_reason: 'stop' }], usage, timings };

describe('request-scoped inference observation', () => {
  it('accepts only bounded numeric gateway wait headers', () => {
    expect(readEngineWait('0.000')).toBe(0);
    expect(readEngineWait('125.500')).toBe(125.5);
    for (const value of [null, undefined, '', 'NaN', '-1', '2700001', '1e3', '2;evil'])
      expect(readEngineWait(value)).toBeUndefined();
  });
  it('uses vLLM server intervals, excludes cache and the first decoded token, and ignores overall throughput', () => {
    const observer = createInferenceTelemetryObserver('text/event-stream');
    observer.push(
      Buffer.from(
        `data: ${JSON.stringify({
          choices: [],
          usage,
          metrics: {
            time_to_first_token_ms: 50,
            generation_time_ms: 380,
            queue_time_ms: 9000,
            tokens_per_second: 999,
          },
        })}\n\ndata: [DONE]\n\n`
      )
    );
    expect(observer.finish()).toMatchObject({
      complete: true,
      usage: { inputTokens: 300, outputTokens: 20, cachedInputTokens: 200 },
      prefill: { tokens: 100, durationMs: 50 },
      decode: { tokens: 19, durationMs: 380 },
    });
  });

  it('leaves vLLM prefill unknown without cache counts and decode unknown for a single token', () => {
    const observer = createInferenceTelemetryObserver('application/json');
    observer.push(
      Buffer.from(
        JSON.stringify({
          usage: { prompt_tokens: 30, completion_tokens: 1 },
          metrics: { time_to_first_token_ms: 50, generation_time_ms: 1 },
        })
      )
    );
    expect(observer.finish()).toMatchObject({ prefill: null, decode: null });
  });
  it('reads real backend phase clocks and excludes cached prompt tokens', () => {
    const observer = createInferenceTelemetryObserver('application/json');
    observer.push(Buffer.from(JSON.stringify(final)));
    expect(observer.finish()).toEqual({
      complete: true,
      failed: false,
      usage: { inputTokens: 300, outputTokens: 20, cachedInputTokens: 200 },
      prefill: { tokens: 100, durationMs: 50 },
      decode: { tokens: 20, durationMs: 400 },
    });
  });

  it('handles UTF-8/chunk boundaries, CRLF, comments and multiline SSE without adding cumulative chunks', () => {
    const observer = createInferenceTelemetryObserver('text/event-stream; charset=utf-8');
    const body = Buffer.from(
      ': heartbeat\r\n\r\ndata: {"choices":[{"delta":{"content":"Grüße 🌱"}}],\r\ndata: "usage":{"completion_tokens":3}}\r\n\r\n' +
        `data: ${JSON.stringify(final)}\r\n\r\ndata: [DONE]\r\n\r\n`
    );
    for (let i = 0; i < body.length; i++) observer.push(body.subarray(i, i + 1));
    const result = observer.finish();
    expect(result.complete).toBe(true);
    expect(result.usage?.outputTokens).toBe(20);
    expect(result.decode).toEqual({ tokens: 20, durationMs: 400 });
  });

  it('accepts a final finish_reason without requiring the optional usage-only event', () => {
    const observer = createInferenceTelemetryObserver('text/event-stream');
    observer.push(Buffer.from(`data: ${JSON.stringify(final)}\n\n`));
    expect(observer.finish().prefill).toEqual({ tokens: 100, durationMs: 50 });
  });

  it('does not interpret usage, first-token time or precomputed rates as phase timing', () => {
    const observer = createInferenceTelemetryObserver('application/json');
    observer.push(
      Buffer.from(
        JSON.stringify({
          usage,
          timings: { prompt_per_second: 99, predicted_per_second: 11 },
          ttft_ms: 25,
        })
      )
    );
    expect(observer.finish()).toMatchObject({ complete: true, prefill: null, decode: null });
  });

  it.each([
    { prompt_n: -1, prompt_ms: 20, predicted_n: 5, predicted_ms: 0 },
    { prompt_n: '100', prompt_ms: 20, predicted_n: 5.5, predicted_ms: 10 },
    { prompt_n: 100, prompt_ms: null, predicted_n: 5, predicted_ms: -10 },
    { prompt_n: Number.MAX_SAFE_INTEGER + 1, prompt_ms: 20, predicted_n: 3, predicted_ms: '50' },
  ])('rejects invalid backend timing pairs independently: %j', (invalid) => {
    const observer = createInferenceTelemetryObserver('application/json');
    observer.push(Buffer.from(JSON.stringify({ timings: invalid })));
    expect(observer.finish()).toMatchObject({ prefill: null, decode: null });
  });

  it('drops timings from incomplete or errored streams', () => {
    const incomplete = createInferenceTelemetryObserver('text/event-stream');
    incomplete.push(Buffer.from(`data: ${JSON.stringify({ timings, usage })}\n\n`));
    expect(incomplete.finish()).toMatchObject({
      complete: false,
      prefill: null,
      decode: null,
      usage: null,
    });
    const error = createInferenceTelemetryObserver('text/event-stream');
    error.push(
      Buffer.from(
        `data: ${JSON.stringify(final)}\n\ndata: {"error":{"message":"failed"}}\n\ndata: [DONE]\n\n`
      )
    );
    expect(error.finish()).toMatchObject({
      complete: false,
      failed: true,
      prefill: null,
      decode: null,
      usage: null,
    });
  });

  it('skips oversized SSE events but resumes at the next event without losing final measurements', () => {
    const observer = createInferenceTelemetryObserver('text/event-stream');
    observer.push(Buffer.from('data: {"content":"'));
    for (let i = 0; i < 20; i++) observer.push(Buffer.from('x'.repeat(30_000)));
    observer.push(Buffer.from(`"}\n\ndata: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`));
    expect(observer.finish()).toMatchObject({
      complete: true,
      decode: { tokens: 20, durationMs: 400 },
    });
  });

  it('bounds non-streaming observation and returns unavailable for an oversized JSON body', () => {
    const observer = createInferenceTelemetryObserver('application/json');
    observer.push(Buffer.from(JSON.stringify({ content: 'x'.repeat(1_100_000), ...final })));
    expect(observer.finish()).toMatchObject({
      complete: true,
      prefill: null,
      decode: null,
      usage: null,
    });
  });
});
