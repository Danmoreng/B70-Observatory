import type { HealthPayload } from '@observatory/contracts';
import { describe, expect, it } from 'vitest';
import { encodeHealthEvent, HealthEventHub } from '../src/health-events.js';

function payload(status: HealthPayload['status'], timestamp: string): HealthPayload {
  return {
    service: 'local-ai-b70-observatory',
    status,
    version: 'test',
    startedAt: '2025-01-01T00:00:00.000Z',
    timestamp,
    uptimeSeconds: 1,
    checks: [{ name: 'server', status }],
  };
}

describe('HealthEventHub', () => {
  it('emits an initial snapshot and thereafter only semantic status changes', () => {
    let current = payload('ok', '2025-01-01T00:00:01.000Z');
    const received: HealthPayload[] = [];
    const hub = new HealthEventHub(() => current, 60_000);
    const unsubscribe = hub.subscribe((value) => received.push(value));
    expect(received).toEqual([current]);

    current = payload('ok', '2025-01-01T00:00:02.000Z');
    hub.checkNow();
    expect(received).toHaveLength(1); // timestamp/uptime alone are not changes

    current = payload('degraded', '2025-01-01T00:00:03.000Z');
    hub.checkNow();
    expect(received).toEqual([expect.objectContaining({ status: 'ok' }), current]);
    hub.checkNow();
    expect(received).toHaveLength(2);
    unsubscribe();

    current = payload('degraded', '2025-01-01T00:01:00.000Z');
    const resumed: HealthPayload[] = [];
    const unsubscribeResumed = hub.subscribe((value) => resumed.push(value));
    expect(resumed[0]?.timestamp).toBe('2025-01-01T00:01:00.000Z');
    unsubscribeResumed();
    hub.close();
  });

  it('encodes one named SSE event without exposing a polling protocol', () => {
    const value = payload('ok', '2025-01-01T00:00:01.000Z');
    expect(encodeHealthEvent(value)).toBe(`event: health\ndata: ${JSON.stringify(value)}\n\n`);
  });
});
