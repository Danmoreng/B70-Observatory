import { StringDecoder } from 'node:string_decoder';
import type { InferencePhaseTiming, InferenceUsage } from '@observatory/contracts';
export function readEngineWait(value: string | null | undefined): number | undefined {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return undefined;
  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) && milliseconds >= 0 && milliseconds <= 45 * 60_000
    ? milliseconds
    : undefined;
}

// Observation is deliberately smaller than the relay's forwarding budget. An
// oversized event is skipped, then parsing resumes at the next SSE boundary.
const MAX_EVENT_CHARS = 256 * 1024;
const MAX_JSON_CHARS = 1024 * 1024;

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;
}
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function phase(tokens: unknown, durationMs: unknown): InferencePhaseTiming | null {
  const n = count(tokens);
  return n !== null &&
    typeof durationMs === 'number' &&
    Number.isFinite(durationMs) &&
    durationMs > 0 &&
    durationMs <= Number.MAX_SAFE_INTEGER &&
    Number.isFinite((n / durationMs) * 1000)
    ? { tokens: n, durationMs }
    : null;
}

export interface ObservedInferenceTelemetry {
  complete: boolean;
  failed: boolean;
  usage: InferenceUsage | null;
  prefill: InferencePhaseTiming | null;
  decode: InferencePhaseTiming | null;
}

/** Read-only side channel for chat-completion JSON and SSE. Never edits bytes. */
export function createInferenceTelemetryObserver(contentType: string) {
  const stream = contentType.toLowerCase().includes('text/event-stream');
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let eventData = '';
  let skipLine = false;
  let skipEvent = false;
  let jsonOversized = false;
  let terminated = false;
  let validJson = false;
  let finalChoice = false;
  const observed: ObservedInferenceTelemetry = {
    complete: false,
    failed: false,
    usage: null,
    prefill: null,
    decode: null,
  };

  function readPayload(text: string): void {
    if (text.trim() === '[DONE]') {
      terminated = true;
      return;
    }
    let payload: ObjectValue | undefined;
    try {
      payload = object(JSON.parse(text));
    } catch {
      return;
    }
    if (!payload) return;
    validJson = true;
    if (payload.error !== undefined && payload.error !== null) observed.failed = true;
    if (Array.isArray(payload.choices)) {
      for (const choice of payload.choices) {
        const reason = object(choice)?.finish_reason;
        if (typeof reason === 'string' && reason.length > 0) {
          finalChoice = true;
          if (['error', 'cancel', 'cancelled'].includes(reason)) observed.failed = true;
        }
      }
    }
    const usage = object(payload.usage);
    if (usage) {
      const details = object(usage.prompt_tokens_details);
      const next: InferenceUsage = {
        inputTokens: count(usage.prompt_tokens),
        outputTokens: count(usage.completion_tokens),
        cachedInputTokens: count(details?.cached_tokens),
      };
      if (Object.values(next).some((value) => value !== null)) observed.usage = next;
    }
    const timings = object(payload.timings);
    if (timings) {
      // llama.cpp / Strata chat completions report these pairs per request.
      // prompt_n excludes cache_n; usage.prompt_tokens does not. Do not replace
      // missing phase clocks with total duration, TTFT or global /metrics data.
      observed.prefill = phase(timings.prompt_n, timings.prompt_ms);
      observed.decode = phase(timings.predicted_n, timings.predicted_ms);
    }
    const metrics = object(payload.metrics);
    if (metrics) {
      // vLLM's server clock starts at scheduling, excluding its queue. Its
      // first-token interval includes prompt/cache processing and the first
      // output step; it is not a client TTFT or a GPU-kernel benchmark.
      const input = observed.usage?.inputTokens;
      const cached = observed.usage?.cachedInputTokens;
      if (input != null && cached != null && cached <= input)
        observed.prefill ??= phase(input - cached, metrics.time_to_first_token_ms);
      // generation_time_ms spans FIRST to LAST token: the first token is
      // already included in the prefill interval, so count only N-1 here.
      const output = observed.usage?.outputTokens;
      if (output != null && output > 1)
        observed.decode ??= phase(output - 1, metrics.generation_time_ms);
    }
  }

  function flushEvent(): void {
    if (!skipEvent && eventData) readPayload(eventData);
    eventData = '';
    skipEvent = false;
  }
  function line(text: string): void {
    if (text.endsWith('\r')) text = text.slice(0, -1);
    if (text === '') {
      flushEvent();
      return;
    }
    if (skipEvent || !text.startsWith('data:')) return;
    const value = text.slice(5).replace(/^ /, '');
    if (eventData.length + value.length + 1 > MAX_EVENT_CHARS) {
      skipEvent = true;
      eventData = '';
      return;
    }
    eventData += `${eventData ? '\n' : ''}${value}`;
  }
  function append(text: string): void {
    if (!stream) {
      if (!jsonOversized && buffer.length + text.length <= MAX_JSON_CHARS) buffer += text;
      else {
        jsonOversized = true;
        buffer = '';
      }
      return;
    }
    // Split the incoming chunk without ever accumulating an unbounded line.
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf('\n', start);
      const end = newline === -1 ? text.length : newline;
      const part = text.slice(start, end);
      if (!skipLine && buffer.length + part.length <= MAX_EVENT_CHARS) buffer += part;
      else {
        skipLine = true;
        skipEvent = true;
        buffer = '';
        eventData = '';
      }
      if (newline === -1) break;
      if (!skipLine) line(buffer);
      buffer = '';
      skipLine = false;
      start = newline + 1;
    }
  }
  return {
    push(chunk: Buffer): void {
      append(decoder.write(chunk));
    },
    finish(): ObservedInferenceTelemetry {
      append(decoder.end());
      if (stream) {
        if (buffer && !skipLine) line(buffer);
        flushEvent();
      } else if (!jsonOversized && buffer) readPayload(buffer);
      observed.complete =
        !observed.failed && (stream ? terminated || finalChoice : validJson || jsonOversized);
      if (!observed.complete) return { ...observed, usage: null, prefill: null, decode: null };
      return observed;
    },
  };
}
