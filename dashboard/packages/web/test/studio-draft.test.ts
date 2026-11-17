import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => localStorage.removeItem('diffusion-desk-h3-draft'));
it('recovers prompts and parameters saved by the old numeric seed input', async () => {
  localStorage.setItem(
    'diffusion-desk-h3-draft',
    JSON.stringify({
      prompt: 'A saved fashion portrait',
      sizeId: 'portrait-8',
      seed: 766167567,
      count: 2,
      mode: 'generate',
      referenceIds: [],
    })
  );
  vi.resetModules();
  const { draft, restoreSampling } = await import('../src/studio/desk.js');
  expect(draft.prompt).toBe('A saved fashion portrait');
  expect(draft.seed).toBe('766167567');
  expect(draft.sizeId).toBe('portrait-8');
  expect(draft.count).toBe(2);
  expect(draft.sampler).toBe('euler');
  expect(draft.scheduler).toBe('simple');
  restoreSampling({ sampler: 'lcm', scheduler: 'beta', noiseStart: null, noiseEnd: null });
  expect(draft.noiseStart).toBe(1);
  expect(draft.noiseEnd).toBe(1);
  expect(draft.prompt).toBe('A saved fashion portrait');
});

it('restores sampling choices and a zero noise multiplier without resetting the prompt', async () => {
  localStorage.setItem(
    'diffusion-desk-h3-draft',
    JSON.stringify({
      prompt: 'A quiet lake',
      sampler: 'lcm',
      scheduler: 'beta',
      noiseStart: 0,
      noiseEnd: 0.81,
    })
  );
  vi.resetModules();
  const { draft } = await import('../src/studio/desk.js');
  expect(draft).toMatchObject({
    prompt: 'A quiet lake',
    sampler: 'lcm',
    scheduler: 'beta',
    noiseStart: 0,
    noiseEnd: 0.81,
  });
});
