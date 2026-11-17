import { describe, expect, it } from 'vitest';
import { InferenceRequestTelemetrySchema } from '../src/task-telemetry.js';

const sample = {
  requestId: '11111111-1111-4111-8111-111111111111',
  startedAt: '2026-10-29T12:00:00.000Z',
  finishedAt: '2026-10-29T12:00:01.000Z',
  durationMs: 1000,
  outcome: 'completed',
  usage: null,
  prefill: null,
  decode: null,
};
describe('task telemetry boundaries', () => {
  it('requires canonical real UTC timestamps', () => {
    expect(InferenceRequestTelemetrySchema.safeParse(sample).success).toBe(true);
    for (const startedAt of [
      '2026-02-30T12:00:00.000Z',
      '2026-10-29T12:00:00Z',
      '2026-10-29T12:00:00.000+00:00',
    ]) {
      expect(InferenceRequestTelemetrySchema.safeParse({ ...sample, startedAt }).success).toBe(
        false
      );
    }
  });
  it('accepts no capability or content fields and no fabricated failed-phase timing', () => {
    expect(InferenceRequestTelemetrySchema.safeParse({ ...sample, token: 'secret' }).success).toBe(
      false
    );
    expect(
      InferenceRequestTelemetrySchema.safeParse({
        ...sample,
        outcome: 'failed',
        decode: { tokens: 5, durationMs: 5 },
      }).success
    ).toBe(false);
  });
});
