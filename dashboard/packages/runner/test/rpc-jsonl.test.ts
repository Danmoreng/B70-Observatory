import { describe, expect, it } from 'vitest';
import { RpcJsonlDecoder } from '../src/rpc-jsonl.js';

describe('large Pi turn-end aggregation', () => {
  it('streams repeated image history away, preserves retry metadata and resumes at the next line', () => {
    const output: string[] = [];
    const decoder = new RpcJsonlDecoder((line) => output.push(line));
    const aggregate =
      JSON.stringify({
        type: 'agent_end',
        messages: [
          { role: 'toolResult', content: [{ type: 'image', data: 'A'.repeat(9 * 1024 * 1024) }] },
          { role: 'assistant', content: [{ type: 'text', text: 'Escapes: \\" ] [ \\u2028' }] },
        ],
        willRetry: true,
      }) + '\r\n{"type":"agent_settled"}\n';
    for (let start = 0; start < aggregate.length; start += 65_537)
      decoder.push(Buffer.from(aggregate.slice(start, start + 65_537)));
    decoder.end();
    expect(output.map((line) => JSON.parse(line))).toEqual([
      { type: 'agent_end', messages: [], willRetry: true },
      { type: 'agent_settled' },
    ]);
  });
  it('rejects other oversized records and incomplete aggregates', () => {
    const decoder = new RpcJsonlDecoder(() => {
      throw new Error('Unexpected delivery');
    });
    expect(() =>
      decoder.push(
        JSON.stringify({ type: 'message_end', message: 'A'.repeat(9 * 1024 * 1024) }) + '\n'
      )
    ).toThrow('oversized RPC record');
    const incomplete = new RpcJsonlDecoder(() => {});
    incomplete.push('{"type":"agent_end","messages":["' + 'A'.repeat(9 * 1024 * 1024));
    expect(() => incomplete.end()).toThrow('incomplete aggregate');
  });
});
