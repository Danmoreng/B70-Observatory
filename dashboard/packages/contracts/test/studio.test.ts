import { expect, it } from 'vitest';
import { parseStudioResponse, StudioDraftSchema, StudioReferenceSchema } from '../src/studio.js';
it('validates restored drafts and keeps reference identifiers local rather than accepting URLs or paths', () => {
  expect(StudioDraftSchema.parse({})).toMatchObject({
    mode: 'generate',
    count: 1,
    referenceIds: [],
    sampler: 'euler',
    scheduler: 'simple',
    noiseStart: 1.1,
    noiseEnd: 0.9,
  });
  expect(() => StudioDraftSchema.parse({ count: 1000 })).toThrow();
  expect(
    StudioDraftSchema.parse({ sampler: 'lcm', scheduler: 'beta', noiseStart: 0, noiseEnd: 1.23 })
  ).toMatchObject({ sampler: 'lcm', scheduler: 'beta', noiseStart: 0, noiseEnd: 1.23 });
  for (const value of [-1, 65, NaN, Infinity, '1.1', null])
    expect(() => StudioDraftSchema.parse({ noiseStart: value })).toThrow();
  expect(() =>
    StudioReferenceSchema.parse({ id: 'http://outside.invalid/image', name: 'bad' })
  ).toThrow();
  expect(() => parseStudioResponse('/api/jobs', 'POST', { ids: ['/etc/passwd'] })).toThrow();
  expect(parseStudioResponse('/api/jobs', 'POST', { ids: ['a'.repeat(32)] })).toEqual({
    ids: ['a'.repeat(32)],
  });
});
