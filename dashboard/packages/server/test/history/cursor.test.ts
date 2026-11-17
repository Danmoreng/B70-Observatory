import { describe, expect, it } from 'vitest';
import {
  CursorError,
  decodeCursor,
  encodeCursor,
  type CursorFilterSet,
} from '../../src/history/cursor.js';

const POSITION = {
  startedAtUtc: '2025-06-01T10:00:00.250Z',
  requestId: '0e19369e-8060-4a9b-9a4d-1c2b3e4f5a6b',
};
const FILTERS: CursorFilterSet = {
  status: 'completed',
  model: 'Qwen3.8-27B',
  from: '2025-06-01T00:00:00.000Z',
};

function expectCursorError(fn: () => void, messagePart?: string): void {
  try {
    fn();
    expect.unreachable('expected CursorError');
  } catch (error) {
    expect(error).toBeInstanceOf(CursorError);
    if (messagePart !== undefined) expect((error as Error).message).toContain(messagePart);
  }
}

describe('pagination cursor codec (M5A)', () => {
  it('round-trips a position encoded for a given filter set', () => {
    const encoded = encodeCursor(POSITION, FILTERS);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = decodeCursor(encoded, FILTERS);
    expect(decoded).toEqual(POSITION);
  });

  it('rejects cursors that do not match the current filter set', () => {
    const encoded = encodeCursor(POSITION, FILTERS);
    // Same position, different filter → the digest no longer matches.
    expectCursorError(
      () => decodeCursor(encoded, { ...FILTERS, status: 'error' }),
      'does not match'
    );
    expectCursorError(() => decodeCursor(encoded, {}), 'does not match');
    expectCursorError(
      () => decodeCursor(encoded, { ...FILTERS, model: 'other-model' }),
      'does not match'
    );
  });

  it('rejects a cursor whose position fields were tampered with', () => {
    const encoded = encodeCursor(POSITION, FILTERS);
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    // Swap the keyset anchor but keep the original filter digest.
    const tampered = Buffer.from(
      JSON.stringify({ ...payload, s: '2025-06-02T00:00:00.000Z' }),
      'utf8'
    ).toString('base64url');
    expectCursorError(() => decodeCursor(tampered, FILTERS));
  });

  it('rejects malformed, truncated or oversized cursors', () => {
    expectCursorError(() => decodeCursor('', FILTERS), 'size bound');
    expectCursorError(() => decodeCursor('has spaces and ?!', FILTERS), 'alphabet');
    expectCursorError(
      () => decodeCursor(Buffer.from('not json at all!!').toString('base64url'), FILTERS),
      'JSON'
    );
    expectCursorError(
      () => decodeCursor(Buffer.from('{"v":1}').toString('base64url'), FILTERS),
      'contract'
    );
    // Valid base64url JSON that violates the shape contract.
    const wrongShape = Buffer.from(
      JSON.stringify({ v: 2, s: POSITION.startedAtUtc, i: POSITION.requestId, f: 'x'.repeat(64) })
    ).toString('base64url');
    expectCursorError(() => decodeCursor(wrongShape, FILTERS), 'contract');
    // Size bound beyond 512 characters.
    const oversized = 'A'.repeat(513);
    expectCursorError(() => decodeCursor(oversized, FILTERS), 'size bound');
  });

  it('rejects cursors carrying a non-canonical or invalid timestamp', () => {
    const encoded = encodeCursor(POSITION, FILTERS);
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const badOffset = Buffer.from(
      JSON.stringify({ ...payload, s: '2025-06-01T12:00:00.000+02:00' })
    ).toString('base64url');
    expectCursorError(() => decodeCursor(badOffset, FILTERS), 'canonical');
    // Normalized-away calendar date: 2025-02-29 does not exist.
    const badCalendar = Buffer.from(
      JSON.stringify({ ...payload, s: '2025-02-29T10:00:00.000Z' })
    ).toString('base64url');
    expectCursorError(() => decodeCursor(badCalendar, FILTERS), 'canonical');
    // Digest mismatch is detected too (the payload changed).
    expect(() => decodeCursor(badOffset, { ...FILTERS })).toThrow(CursorError);
  });
});
