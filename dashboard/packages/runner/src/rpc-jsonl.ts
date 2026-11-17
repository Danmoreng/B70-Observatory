import { StringDecoder } from 'node:string_decoder';

const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_AGGREGATE_BYTES = 128 * 1024 * 1024;
// Pi JSON.stringify emits this fixed event shape. All individual message events
// have already crossed the channel; agent_end repeats the turn's entire history.
const AGGREGATE_PREFIX = '{"type":"agent_end","messages":[';

/** LF framing (U+2028/U+2029 are legal JSON string content), bounded in memory.
 * Oversized agent_end history arrays alone are streamed away; retry metadata
 * after the array and all original message events are retained. Other oversized
 * records still fail closed, as do unclosed/over-budget aggregate arrays.
 */
export class RpcJsonlDecoder {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private skipping = false;
  private projected = false;
  private depth = 0;
  private quoted = false;
  private escaped = false;
  private aggregateBytes = 0;

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer | string): void {
    this.consumeLines(typeof chunk === 'string' ? chunk : this.decoder.write(chunk));
  }

  end(): void {
    this.consumeLines(this.decoder.end());
    if (this.skipping) throw new Error('Pi sent an incomplete aggregate RPC record.');
    if (this.buffer.length > 0) this.finishLine();
  }

  private consumeLines(text: string): void {
    let start = 0;
    for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', start)) {
      this.consume(text.slice(start, end), true);
      this.finishLine();
      start = end + 1;
    }
    this.consume(text.slice(start));
  }

  private consume(text: string, complete = false): void {
    if (this.skipping) {
      this.skipArray(text, complete);
      return;
    }
    this.buffer += text;
    if (
      Buffer.byteLength(this.buffer) <=
      MAX_RECORD_BYTES + (complete && this.buffer.endsWith('\r') ? 1 : 0)
    )
      return;
    if (!this.projected && this.buffer.startsWith(AGGREGATE_PREFIX)) {
      const array = this.buffer.slice(AGGREGATE_PREFIX.length);
      this.buffer = '{"type":"agent_end","messages":[]';
      this.projected = true;
      this.skipping = true;
      this.depth = 1;
      this.skipArray(array, complete);
      return;
    }
    throw new Error('Pi sent an oversized RPC record.');
  }

  private skipArray(text: string, complete: boolean): void {
    this.aggregateBytes += Buffer.byteLength(text);
    if (this.aggregateBytes > MAX_AGGREGATE_BYTES)
      throw new Error('Pi sent an oversized aggregate RPC record.');
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (this.quoted) {
        if (this.escaped) this.escaped = false;
        else if (char === '\\') this.escaped = true;
        else if (char === '"') this.quoted = false;
      } else if (char === '"') this.quoted = true;
      else if (char === '[') this.depth += 1;
      else if (char === ']' && --this.depth === 0) {
        this.skipping = false;
        this.consume(text.slice(i + 1), complete);
        return;
      }
    }
  }

  private finishLine(): void {
    if (this.skipping) throw new Error('Pi sent an incomplete aggregate RPC record.');
    const line = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer;
    this.buffer = '';
    this.projected = false;
    this.aggregateBytes = 0;
    this.depth = 0;
    this.quoted = false;
    this.escaped = false;
    if (line.length > 0) this.onLine(line);
  }
}
