import { describe, expect, it } from 'vitest';
import { normalizeReasoningEffort } from '../../src/gateway/reasoning.js';

describe('Qwen effort normalization', () => {
  it.each(['low', 'medium', 'xhigh', 'none', 'invalid'])(
    'preserves %s and the exact request bytes',
    (effort) => {
      const raw = Buffer.from(
        `{ "reasoning_effort": "${effort}", "messages": [{"content":"high"}] }`
      );
      expect(normalizeReasoningEffort(JSON.parse(raw.toString()), raw)).toBe(raw);
    }
  );
  it('changes only the effort fields, leaving prompt and tool strings alone', () => {
    const body = {
      reasoning_effort: 'high',
      reasoning: { effort: 'high' },
      output_config: { effort: 'high' },
      chat_template_kwargs: { reasoning_effort: 'high', preserve_thinking: true },
      messages: [{ content: 'high' }],
      tools: [{ name: 'high' }],
      metadata: { effort: 'high' },
    };
    expect(
      JSON.parse(normalizeReasoningEffort(body, Buffer.from(JSON.stringify(body))).toString())
    ).toEqual({
      ...body,
      reasoning_effort: 'xhigh',
      reasoning: { effort: 'xhigh' },
      output_config: { effort: 'xhigh' },
      chat_template_kwargs: { reasoning_effort: 'xhigh', preserve_thinking: true },
    });
  });
  it('leaves malformed containers to upstream validation', () => {
    const raw = Buffer.from('{"reasoning":null,"output_config":[],"chat_template_kwargs":"high"}');
    expect(normalizeReasoningEffort(JSON.parse(raw.toString()), raw)).toBe(raw);
  });
});
