import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createInputTokenCounter, readUniqueInputTokens } from '../../src/durable/input-tokens.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const input = (id: string, text: string) => ({
  kind: 'b70.input',
  data: { id, kind: 'task' },
  model: [{ role: 'user', content: [{ type: 'text', text }] }],
});
const tool = (id: string, text: string) => ({
  kind: 'pi.tool-result',
  model: [{ role: 'toolResult', toolCallId: id, content: [{ type: 'text', text }] }],
});
const answer = (prompt = 1000, cache = 0, stopReason = 'toolUse') => ({
  kind: 'pi.assistant',
  model: [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Own answer repeated later in context must NEVER count as input' },
      ],
      usage: { input: prompt - cache, cacheRead: cache, cacheWrite: 0 },
      stopReason,
    },
  ],
});
function fixture(records: unknown[], conversations = 1) {
  const root = mkdtempSync(join(tmpdir(), 'b70-unique-input-'));
  roots.push(root);
  const path = join(root, 'conversation.sqlite');
  const db = new DatabaseSync(path);
  db.exec(
    'CREATE TABLE conversations(id INTEGER);CREATE TABLE entries(id INTEGER PRIMARY KEY,record TEXT);'
  );
  for (let i = 0; i < conversations; i++) db.prepare('INSERT INTO conversations VALUES(?)').run(i);
  for (const record of records)
    db.prepare('INSERT INTO entries(record) VALUES(?)').run(JSON.stringify(record));
  db.close();
  return path;
}
const bindings = [
  { runId: 'run1', turnId: 'turn1' },
  { runId: 'run2', turnId: 'turn2' },
];

it('counts initial context and each consumed input once, regardless of prompt growth/cache boundaries/retries', async () => {
  const records = [
    input('turn1', 'Initial task'),
    answer(1000, 256),
    tool('a', 'ABC'),
    answer(1500, 0),
    answer(1500, 1408),
    tool('b', 'XY'),
    answer(2200, 2048, 'error'),
    answer(2200, 0),
    tool('pending', 'not yet consumed'),
  ];
  const count = vi.fn(async (unit: { text: string } | { data: string; mimeType: string }) =>
    'text' in unit ? unit.text.length : 20
  );
  const path = fixture(records);
  expect(await readUniqueInputTokens(path, bindings, count)).toEqual(new Map([['run1', 1005]]));
  expect(count.mock.calls.map(([u]) => u)).toEqual([{ text: 'ABC' }, { text: 'XY' }]);
  // Reopening/replaying saved history gives the same value, not another increment.
  expect(await readUniqueInputTokens(path, bindings, count)).toEqual(new Map([['run1', 1005]]));
});

it('survives compaction, deduplicates repeated logical input/tool entries and scopes continuations', async () => {
  const path = fixture([
    input('turn1', 'Start'),
    answer(1000),
    tool('a', 'old'),
    answer(1300),
    {
      kind: 'pi.compaction',
      head: 1,
      model: [
        { role: 'user', content: [{ type: 'text', text: 'Generated summary is own output' }] },
      ],
    },
    answer(300),
    input('turn1', 'Start'),
    tool('a', 'old'),
    answer(1300),
    input('turn2', 'new'),
    answer(500),
    tool('b', 'next'),
    answer(800),
  ]);
  const count = vi.fn(async (u: { text: string } | { data: string; mimeType: string }) =>
    'text' in u ? u.text.length : 20
  );
  expect(await readUniqueInputTokens(path, bindings, count)).toEqual(
    new Map([
      ['run1', 1003],
      ['run2', 7],
    ])
  );
  expect(count.mock.calls.map(([u]) => u)).toEqual([
    { text: 'old' },
    { text: 'new' },
    { text: 'next' },
  ]);
});

it('counts new images once and never replaces unavailable accounting with processed prompt totals', async () => {
  const path = fixture([
    input('turn1', 'Start'),
    answer(),
    {
      kind: 'pi.tool-result',
      model: [
        {
          role: 'toolResult',
          toolCallId: 'screenshot',
          content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }],
        },
      ],
    },
    answer(5000),
  ]);
  expect(await readUniqueInputTokens(path, bindings, async () => 42)).toEqual(
    new Map([['run1', 1042]])
  );
  expect(
    await readUniqueInputTokens(path, bindings, async () => {
      throw new Error('offline');
    })
  ).toBeUndefined();
  expect(
    await readUniqueInputTokens(path, [{ runId: 'unknown', turnId: 'other' }], async () => 0)
  ).toBeUndefined();
  expect(
    await readUniqueInputTokens(
      fixture([input('turn1', 'Start'), answer()], 2),
      bindings,
      async () => 0
    )
  ).toBeUndefined();
});

it('uses the gateway/model tokenizer, caches only content fingerprints and removes image framing', async () => {
  const upstream = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      prompt?: string;
      messages?: Array<{ content: unknown[] }>;
    };
    return Response.json({
      count: body.prompt?.length ?? (body.messages?.[0]?.content.length ? 112 : 12),
    });
  });
  const counter = createInputTokenCounter(
    { model: 'Qwen', gatewayUrl: 'http://gateway/', gatewayToken: 'secret' },
    upstream
  );
  expect(await counter({ text: 'ABCD' })).toBe(4);
  expect(await counter({ text: 'ABCD' })).toBe(4);
  expect(await counter({ data: 'AAAA', mimeType: 'image/png' })).toBe(100);
  expect(upstream).toHaveBeenCalledTimes(3);
  expect(String(upstream.mock.calls[0]![0])).toBe('http://gateway/v1/tokenize');
  expect(JSON.parse(String(upstream.mock.calls[0]![1]?.body))).toEqual({
    model: 'Qwen',
    prompt: 'ABCD',
  });
});

it('only counts images that survive the actual model image window', async () => {
  const image = (id: string) => ({
    kind: 'pi.tool-result',
    model: [
      {
        role: 'toolResult',
        toolCallId: id,
        content: [{ type: 'image', mimeType: 'image/png', data: id }],
      },
    ],
  });
  const path = fixture([
    input('turn1', 'Start'),
    answer(),
    image('old'),
    image('middle'),
    image('latest'),
    answer(),
  ]);
  const counter = vi.fn(async () => 10);
  expect(await readUniqueInputTokens(path, bindings, counter)).toEqual(new Map([['run1', 1020]]));
  expect(counter.mock.calls).toHaveLength(2);
});

it('attributes previously unconsumed tool input to the continuation that first sees it', async () => {
  const path = fixture([
    input('turn1', 'Start'),
    answer(1000),
    tool('pending', 'pending'),
    input('turn2', 'continue'),
    answer(2000),
  ]);
  expect(
    await readUniqueInputTokens(path, bindings, async (unit) =>
      'text' in unit ? unit.text.length : 0
    )
  ).toEqual(
    new Map([
      ['run1', 1000],
      ['run2', 15],
    ])
  );
});
