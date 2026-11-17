import { expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/memory/store.js';
import { fileURLToPath } from 'node:url';
const a = '11111111-1111-4111-8111-111111111111',
  b = '22222222-2222-4222-8222-222222222222';
it('preserves originals across correction and excludes foreign/unconfirmed visual candidates before ranking', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-07T12:00:00Z'));
  const vector = Array(768).fill(0) as number[];
  vector[0] = 1;
  const embedder = {
    ready: () => true,
    visionReady: () => true,
    encode: async () => vector,
    encodeImage: async () => vector,
    close: async () => {},
  };
  const memory = new MemoryStore(
    ':memory:',
    embedder,
    fileURLToPath(new URL('../../../../build/memory-runtime/vec0.so', import.meta.url))
  );
  try {
    const make = (projectId: string, status: 'confirmed' | 'proposed') =>
      memory.write(
        {
          title: 'Visual fixture',
          content: 'No matching lexical terms.',
          scope: 'project',
          kind: 'fact',
          projectId,
          status,
          visibility: 'local',
          sources: [{ kind: 'user', ref: 'explicit fixture' }],
        },
        { owner: true }
      );
    const first = make(a, 'confirmed'),
      foreign = make(b, 'confirmed'),
      proposal = make(a, 'proposed');
    for (const item of [first, foreign, proposal])
      memory.attachImage(item.id, {
        data: Buffer.from('original image bytes'),
        mimeType: 'image/png',
        width: 1,
        height: 1,
        purpose: 'reference',
        runId: a,
        sourceImageId: b,
        capturedAt: '2026-11-07T12:00:00Z',
        revision: 'a'.repeat(40),
      });
    await memory.indexPending();
    expect(
      (await memory.search('unrelated query', { owner: false, projectId: a })).items.map(
        (i) => i.id
      )
    ).toEqual([first.id]);
    expect(memory.get(first.id, { owner: true }).image?.embedded).toBe(true);
    expect(() => memory.image(first.id, { owner: false, projectId: b })).toThrow();
    expect(() =>
      memory.image(first.id, { owner: false, projectId: a, sharedOnly: true })
    ).toThrow();
    const updated = memory.write(
      {
        title: 'Corrected caption',
        content: 'Corrected text.',
        scope: 'project',
        kind: 'fact',
        projectId: a,
        status: 'confirmed',
        visibility: 'local',
        sources: [{ kind: 'user', ref: 'correction' }],
      },
      { owner: true },
      { id: first.id, version: 1 }
    );
    expect(Buffer.from(memory.image(first.id, { owner: true }).data, 'base64').toString()).toBe(
      'original image bytes'
    );
    expect(updated.image?.id).toBe(
      first.image?.id ?? memory.get(first.id, { owner: true }).image?.id
    );
    memory.remove(first.id, updated.version);
    expect(() => memory.image(first.id, { owner: true })).toThrow();
    expect(
      (
        memory.database.prepare('SELECT count(*) n FROM memory_image_vectors').get() as {
          n: number;
        }
      ).n
    ).toBe(2);
  } finally {
    await memory.close();
    vi.useRealTimers();
  }
});
