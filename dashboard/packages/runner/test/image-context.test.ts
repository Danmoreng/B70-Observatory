import { describe, expect, it } from 'vitest';
import { trimImageContext } from '../src/cockpit-extension.js';

describe('reference images in model context', () => {
  const image = (data: string) => ({ type: 'image', mimeType: 'image/png', data });
  it('preserves all four user references while bounding tool screenshots independently', () => {
    const messages = [
      { role: 'user', content: [image('old-reference')] },
      { role: 'user', content: [image('ref1'), image('ref2'), image('ref3'), image('ref4')] },
      ...['shot1', 'shot2', 'shot3'].map((value) => ({
        role: 'toolResult',
        content: [image(value)],
      })),
    ];
    const before = JSON.stringify(messages);
    const trimmed = trimImageContext({ messages });
    expect(JSON.stringify(trimmed)).toContain('ref1');
    expect(JSON.stringify(trimmed)).toContain('ref4');
    expect(JSON.stringify(trimmed)).toContain('shot2');
    expect(JSON.stringify(trimmed)).toContain('shot3');
    expect(JSON.stringify(trimmed)).not.toContain('shot1');
    expect(JSON.stringify(trimmed)).not.toContain('old-reference');
    expect(JSON.stringify(messages)).toBe(before);
  });
  it('leaves four references and two screenshots untouched', () => {
    expect(
      trimImageContext({
        messages: [
          { role: 'user', content: Array.from({ length: 4 }, (_, i) => image(`ref${i}`)) },
          { role: 'toolResult', content: [image('before'), image('after')] },
        ],
      })
    ).toBeUndefined();
  });
});
