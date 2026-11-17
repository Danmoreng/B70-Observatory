import { describe, expect, it } from 'vitest';
import {
  assertMayStartWork,
  berlinMinutes,
  remainingWorkSeconds,
} from '../../src/durable/working-hours.js';

describe('PC-wide agent working hours', () => {
  it.each(['2026-10-22T20:44:00Z', '2026-12-22T21:44:00Z'])(
    'observes Berlin time in summer and winter: %s',
    (time) => {
      const before = new Date(time);
      expect(berlinMinutes(before)).toBe(22 * 60 + 44);
      expect(() => assertMayStartWork(before)).not.toThrow();
      expect(() => assertMayStartWork(new Date(before.getTime() + 60_000))).toThrow(/22:45/);
    }
  );
  it('stops tools by 22:55 and keeps the shorter ordinary run budget', () => {
    expect(remainingWorkSeconds(new Date('2026-10-22T20:40:30Z'))).toBe(870);
    expect(remainingWorkSeconds(new Date('2026-10-22T08:00:00Z'))).toBe(4200);
    expect(remainingWorkSeconds(new Date('2026-10-22T20:56:00Z'))).toBe(1);
  });
});
