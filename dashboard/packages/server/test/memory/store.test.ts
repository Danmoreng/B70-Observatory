import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { MemoryWrite } from '@observatory/contracts';
import { MemoryStore, redactMemory } from '../../src/memory/store.js';
import type { MemoryEmbedder } from '../../src/memory/embedding.js';
const projectA = '11111111-1111-4111-8111-111111111111';
const projectB = '22222222-2222-4222-8222-222222222222';
const owner = { owner: true };
const stores: MemoryStore[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function entry(content = 'Build with npm run check'): MemoryWrite {
  return {
    title: 'Build procedure',
    content,
    scope: 'project',
    projectId: projectA,
    kind: 'procedure',
    status: 'confirmed',
    visibility: 'local',
    sources: [{ kind: 'user', ref: 'Explicit owner note' }],
  };
}
function store() {
  const s = new MemoryStore(':memory:');
  stores.push(s);
  return s;
}
describe('personal memory canonical store', () => {
  it('binds agent reads to confirmed, current, allowed knowledge', async () => {
    const s = store();
    s.write(entry(), owner);
    s.write({ ...entry(), projectId: projectB }, owner);
    s.write({ ...entry(), status: 'proposed' }, owner);
    s.write({ ...entry(), status: 'superseded' }, owner);
    s.write({ ...entry(), validUntil: '2000-01-01T00:00:00.000Z' }, owner);
    s.write(
      {
        ...entry('Developer preference'),
        title: 'Developer preference',
        scope: 'developer',
        projectId: undefined,
        visibility: 'shared',
      },
      owner
    );
    expect(s.list({ owner: false, projectId: projectA })).toHaveLength(2);
    expect(s.list({ owner: false, projectId: projectA, sharedOnly: true })).toHaveLength(1);
    expect((await s.search('Build', { owner: false, projectId: projectA })).items).toHaveLength(1);
  });
  it('lets agents propose only for their own project without self-confirmation', () => {
    const s = store(),
      policy = { owner: false, projectId: projectA };
    const draft = s.write({ ...entry(), status: 'proposed' }, policy);
    expect(s.list(policy)).toHaveLength(0);
    expect(() => s.write(entry(), policy)).toThrow(/only propose/);
    expect(() => s.write({ ...entry(), status: 'proposed', projectId: projectB }, policy)).toThrow(
      /only propose/
    );
    expect(() => s.write({ ...entry(), status: 'proposed', visibility: 'shared' }, policy)).toThrow(
      /only propose/
    );
    expect(s.get(draft.id, owner).status).toBe('proposed');
  });
  it('versions corrections optimistically and removes old lexical content', async () => {
    const s = store();
    const a = s.write(entry('obsolete-command'), owner);
    const b = s.write(entry('replacement-command'), owner, { id: a.id, version: a.version });
    expect(b.version).toBe(2);
    expect(s.history(a.id)).toHaveLength(2);
    expect(() => s.write(entry(), owner, { id: a.id, version: 1 })).toThrow(/changed/);
    expect((await s.search('obsolete-command', owner)).items).toHaveLength(0);
    expect((await s.search('replacement-command', owner)).items[0]?.id).toBe(a.id);
  });
  it('deletes revisions and indexed content with the memory entry', async () => {
    const s = store(),
      a = s.write(entry(), owner);
    s.remove(a.id, a.version);
    expect(() => s.history(a.id)).toThrow(/not found/);
    expect((await s.search('Build', owner)).items).toHaveLength(0);
    expect(s.database.prepare('SELECT count(*) n FROM memory_revisions').get()).toMatchObject({
      n: 0,
    });
  });
  it('preserves source evidence, scope and versions across reopen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'b70-memory-'));
    roots.push(root);
    const a = new MemoryStore(join(root, 'memory.sqlite'));
    const item = a.write(entry(), owner);
    await a.close();
    const b = new MemoryStore(join(root, 'memory.sqlite'));
    stores.push(b);
    expect(b.get(item.id, owner)).toEqual(item);
  });
  it('indexes Unicode without cutting surrogate pairs and bounds injected context', async () => {
    const s = store();
    s.write(entry('🌱'.repeat(3000)), owner);
    const chunks = s.database.prepare('SELECT text FROM memory_chunks').all() as Array<{
      text: string;
    }>;
    expect(
      chunks.every((c) => !c.text.includes('\uFFFD') && Buffer.byteLength(c.text) <= 2400)
    ).toBe(true);
    const context = await s.context('Build', projectA);
    expect(context.text.length).toBeLessThanOrEqual(6000);
  });
  it('keeps raw episodes out of automatic context and imports idempotently', async () => {
    const s = store();
    expect(s.ingest('run:a', entry('Unverified assistant narrative'))).toBe(true);
    expect(s.ingest('run:a', entry())).toBe(false);
    expect((await s.context('narrative', projectA)).text).toBe('');
    expect(
      (
        await s.search(
          'narrative',
          { owner: false, projectId: projectA },
          { includeEpisodes: true }
        )
      ).items
    ).toHaveLength(1);
  });
  it('offers source-preserving duplicate/expiry maintenance', () => {
    const s = store();
    s.write(entry(), owner);
    s.write(entry(), owner);
    s.write({ ...entry('Old'), validUntil: '2000-01-01T00:00:00.000Z' }, owner);
    const result = s.maintenance();
    expect(result.duplicateGroups[0]).toHaveLength(2);
    expect(result.expired).toHaveLength(1);
    expect(s.list(owner)).toHaveLength(3);
  });
  it('redacts common credential formats before canonical storage', () => {
    expect(redactMemory('MY_API_KEY=topsecret Bearer abcdefghijklmnopqrstuvwxyz')).toBe(
      'MY_API_KEY=[REDACTED] Bearer [REDACTED]'
    );
  });
});
const extension = fileURLToPath(
  new URL('../../../../build/memory-runtime/vec0.so', import.meta.url)
);
describe.skipIf(!existsSync(extension))('real sqlite-vec hybrid retrieval', () => {
  it('retrieves semantically related passages while enforcing project and visibility before KNN ranking', async () => {
    const embedder: MemoryEmbedder = {
      ready: () => true,
      close: async () => {},
      encode: async (text) => {
        const v = Array(768).fill(0) as number[];
        v[/cat|feline/i.test(text) ? 0 : 1] = 1;
        return v;
      },
    };
    const s = new MemoryStore(':memory:', embedder, extension);
    stores.push(s);
    const a = s.write(entry('Our cat likes sunshine'), owner);
    s.write({ ...entry('Another feline'), projectId: projectB }, owner);
    s.write({ ...entry('A feline secret'), status: 'proposed' }, owner);
    await s.indexPending();
    expect(s.status().embedded).toBe(3);
    const result = await s.search('feline', { owner: false, projectId: projectA });
    expect(result.items.map((i) => i.id)).toEqual([a.id]);
    s.remove(a.id, a.version);
    expect((await s.search('feline', { owner: false, projectId: projectA })).items).toHaveLength(0);
    expect(s.database.prepare('SELECT count(*) n FROM memory_vectors').get()).toMatchObject({
      n: 2,
    });
  });
});
