/**
 * Measurement side of the SSE pass-through.
 *
 * The gateway must forward the upstream byte stream *unmodified*, so this
 * module only *observes* chunks: it counts bytes, detects the first
 * `data:` field (TTFT) and extracts the `usage` object vLLM/OpenAI may
 * include in a final SSE event. No content is stored – only non-negative
 * integer counters (M3 data-privacy constraint: no raw LLM content
 * anywhere).
 *
 * The meter is the **single source of truth** for the first-token
 * timestamp: the `first_token` event and the persisted `ttftMs` must both
 * be derived from `firstDataAt`, so they can never disagree.
 *
 * Detection semantics (review follow-up, M3 finding 4):
 * - Only an SSE field that actually starts a line with `data:` counts.
 *   SSE comments (`: …`, e.g. the OpenAI byte-patch annotation),
 *   heartbeats and blank lines and empty streams never trigger it.
 * - A `data:` marker split across chunk boundaries (e.g. a chunk ending in
 *   `dat`) is recognized once the `:` arrives; the timestamp is the chunk
 *   in which the full `data:` marker became visible.
 * - A `TextDecoder` in streaming mode keeps partial multi-byte UTF-8
 *   sequences across chunks, so a character split in the middle never
 *   corrupts line or field detection.
 */

/** Token counters extracted from the upstream `usage` object. */
export interface UpstreamUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

/** Maximum size of one in-flight SSE event kept for usage extraction. */
const MAX_PENDING_EVENT = 64 * 1024;

const DONE_SENTINEL = '[DONE]';

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Extract token counters from a (parsed) upstream JSON payload that
 * contains a `usage` object, or `null` if there is no usable `usage`.
 * Works both for non-streaming chat completion bodies and for the final
 * SSE event of a stream (sent when `stream_options.include_usage` is set).
 */
export function extractUsage(payload: unknown): UpstreamUsage | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const object = payload as Record<string, unknown>;
  // Responses completion events and Anthropic message_start nest their usage.
  const nested = object.response ?? object.message;
  const container =
    typeof nested === 'object' && nested !== null ? (nested as Record<string, unknown>) : object;
  const usage = container.usage;
  if (typeof usage !== 'object' || usage === null) return null;
  const fields = usage as Record<string, unknown>;
  const prompt = fields.prompt_tokens ?? fields.input_tokens;
  const completion = fields.completion_tokens ?? fields.output_tokens;
  const total = fields.total_tokens;
  if (!isNonNegativeInt(prompt) && !isNonNegativeInt(completion) && !isNonNegativeInt(total)) {
    return null;
  }
  return {
    promptTokens: isNonNegativeInt(prompt) ? prompt : null,
    completionTokens: isNonNegativeInt(completion) ? completion : null,
    totalTokens: isNonNegativeInt(total)
      ? total
      : isNonNegativeInt(prompt) && isNonNegativeInt(completion)
        ? prompt + completion
        : null,
  };
}

/**
 * Feed upstream response chunks into this meter. It is cheap enough to run
 * on every chunk of a live SSE stream: byte counting plus an incremental
 * line scan for `data:` fields and completed events.
 *
 * Chunks must be fed in order. `atMs` is the wall-clock time at which this
 * chunk was received; it is the only timestamp the meter produces.
 */
export class SseMeter {
  /** Bytes received so far (uncompressed upstream payload). */
  bytes = 0;
  /**
   * `Date.now()` of the chunk in which the first `data:` field became
   * visible (the full `data:` marker at the start of an SSE line). As
   * soon as a line starts with `data:`, the field is unambiguous – the
   * line cannot still turn into something else – so the timestamp is set
   * immediately, independent of when the line (or stream) completes.
   * `null` until such a chunk has been seen; comments, heartbeats and
   * blank lines never set it.
   */
  firstDataAt: number | null = null;
  /** Last usable `usage` counters seen so far (may be null). */
  usage: UpstreamUsage | null = null;

  /** Streaming decoder: holds partial UTF-8 sequences across chunks. */
  private readonly decoder = new TextDecoder('utf-8');
  /** The current, not-yet-terminated line (without its line break). */
  private lineBuffer = '';
  /** Lines of the event currently being assembled (terminated by a blank line). */
  private eventLines: string[] = [];
  /** Total characters queued in `eventLines` (for the size bound). */
  private eventLength = 0;
  /** Process one raw upstream chunk. Must be called in order. */
  onChunk(chunk: Uint8Array, atMs: number): void {
    this.bytes += chunk.byteLength;
    if (chunk.byteLength === 0) return;

    // Streaming decode: a multi-byte character split across this chunk
    // boundary is held back by the decoder until the rest arrives.
    this.lineBuffer += this.decoder.decode(chunk, { stream: true });

    // The moment the in-flight line starts with the full `data:` marker,
    // the first-token time is fixed – even if the line itself continues
    // across further chunks.
    if (this.firstDataAt === null && this.lineBuffer.startsWith('data:')) {
      this.firstDataAt = atMs;
    }

    let newline: number;
    while ((newline = this.lineBuffer.indexOf('\n')) !== -1) {
      let line = this.lineBuffer.slice(0, newline);
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      // A chunk may contain comments and the first data field together.
      // Checking each completed line is therefore required in addition
      // to checking the still-incomplete line buffer above.
      if (this.firstDataAt === null && line.startsWith('data:')) {
        this.firstDataAt = atMs;
      }
      if (line === '') {
        // A blank line terminates the current event.
        if (this.eventLines.length > 0) {
          this.observeEvent(this.eventLines.join('\n'));
          this.eventLines = [];
          this.eventLength = 0;
        }
        continue;
      }

      if (this.eventLength < MAX_PENDING_EVENT) {
        this.eventLines.push(line);
        this.eventLength += line.length + 1;
      }
    }

    // Keep the line buffer bounded: a "line" larger than the event limit
    // cannot plausibly hold a small `usage` field (the bytes still count).
    if (this.lineBuffer.length > MAX_PENDING_EVENT) {
      this.lineBuffer = '';
    }
  }

  private observeEvent(event: string): void {
    // SSE event: lines, at least one starting with `data:`.
    if (!event.includes('data:')) return;
    const data = event
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n');
    if (data.length === 0 || data === DONE_SENTINEL) return;
    if (!data.includes('usage')) return;
    try {
      const extracted = extractUsage(JSON.parse(data));
      if (extracted !== null) {
        // Anthropic sends input usage at message_start, output at message_delta.
        const promptTokens = extracted.promptTokens ?? this.usage?.promptTokens ?? null;
        const completionTokens = extracted.completionTokens ?? this.usage?.completionTokens ?? null;
        this.usage = {
          promptTokens,
          completionTokens,
          totalTokens:
            extracted.totalTokens ??
            (promptTokens !== null && completionTokens !== null
              ? promptTokens + completionTokens
              : null),
        };
      }
    } catch {
      // Not JSON (or partial) – ignore; usage simply stays null.
    }
  }
}
