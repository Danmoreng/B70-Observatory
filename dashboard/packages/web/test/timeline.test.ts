import { describe, expect, it } from 'vitest';
import { isTimelineNearEnd, newTimelineItemCount } from '../src/lib/timeline.js';

describe('agent timeline viewport', () => {
  it('follows only at the end or inside the small end threshold', () => {
    expect(isTimelineNearEnd({ scrollTop: 500, clientHeight: 500, scrollHeight: 1000 })).toBe(true);
    expect(isTimelineNearEnd({ scrollTop: 470, clientHeight: 500, scrollHeight: 1000 })).toBe(true);
    expect(isTimelineNearEnd({ scrollTop: 300, clientHeight: 500, scrollHeight: 1000 })).toBe(
      false
    );
  });

  it('counts newly appended records without treating token updates as records', () => {
    expect(newTimelineItemCount(4, 7)).toBe(3);
    expect(newTimelineItemCount(7, 7)).toBe(0);
    expect(newTimelineItemCount(7, 2)).toBe(0);
  });
});
