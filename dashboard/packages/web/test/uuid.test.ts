import { describe, expect, it } from 'vitest';
import { createUuid } from '../src/lib/uuid.js';

describe('createUuid', () => {
  it('works when randomUUID is unavailable on a plain-HTTP origin', () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, index) => index);
    const cryptoApi = {
      getRandomValues<T extends ArrayBufferView | null>(target: T): T {
        if (target instanceof Uint8Array) target.set(bytes);
        return target;
      },
    };

    expect(createUuid(cryptoApi)).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
  });
});
