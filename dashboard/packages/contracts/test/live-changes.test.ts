import { describe, expect, it } from 'vitest';
import { AgentLiveChangesSchema } from '../src/live-changes.js';
const sample = {
  taskId: '10000000-0000-4000-8000-000000000001',
  runId: '20000000-0000-4000-8000-000000000001',
  capturedAt: '2026-10-29T18:00:00.000Z',
  status: 'live',
  stale: false,
  truncated: false,
  files: [{ path: 'a.ts', status: 'modified' }],
  diff: '+a',
};
describe('live changes boundary', () => {
  it('accepts only bounded display snapshots, never approvable result fields', () => {
    expect(AgentLiveChangesSchema.parse(sample)).toEqual(sample);
    expect(
      AgentLiveChangesSchema.safeParse({ ...sample, resultRevision: 'a'.repeat(40) }).success
    ).toBe(false);
    expect(AgentLiveChangesSchema.safeParse({ ...sample, diff: 'ä'.repeat(140_000) }).success).toBe(
      false
    );
    expect(
      AgentLiveChangesSchema.safeParse({
        ...sample,
        files: Array.from({ length: 501 }, () => sample.files[0]),
      }).success
    ).toBe(false);
  });
  it('rejects unsafe file paths and non-canonical/invalid timestamps', () => {
    for (const path of ['/etc/passwd', '../outside', 'a/../outside', 'a\0b'])
      expect(
        AgentLiveChangesSchema.safeParse({ ...sample, files: [{ path, status: 'modified' }] })
          .success
      ).toBe(false);
    for (const capturedAt of [
      '2026-02-30T18:00:00.000Z',
      '2026-10-29T18:00:00Z',
      '2026-10-29T18:00:00.000+00:00',
    ])
      expect(AgentLiveChangesSchema.safeParse({ ...sample, capturedAt }).success).toBe(false);
  });
});
