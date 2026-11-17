import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { readSingleRunUsage } from '../../src/durable/saved-usage.js';

it('recovers stored counts without writing or inventing phase clocks and rejects ambiguous ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'b70-saved-usage-'));
  const path = join(root, 'conversation.sqlite');
  const turnId = randomUUID();
  const harness = await Harness.open(
    await openNodeSqliteStorage(path),
    { models: createModels(), registry: createRegistry() },
    context
  );
  const conversation = await harness.root(context);
  const answer = fauxAssistantMessage('Stored response');
  answer.usage = {
    ...answer.usage,
    input: 75,
    output: 20,
    cacheRead: 25,
    cacheWrite: 0,
    reasoning: 5,
    totalTokens: 120,
  };
  await conversation.commit(async (tx) => {
    await tx.appendEntry(conversation.id, {
      kind: 'b70.input',
      data: { id: turnId, kind: 'task' },
    });
    await tx.appendEntry(conversation.id, { kind: 'pi.assistant', model: [answer] });
  }, context);
  await harness.close(context);
  try {
    const before = await readFile(path);
    expect(await readSingleRunUsage(path, turnId)).toMatchObject({
      completedRequests: 1,
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 25 },
      prefill: null,
      decode: null,
      usageSource: 'durable-history',
    });
    expect(await readFile(path)).toEqual(before);
    expect(await readSingleRunUsage(path, randomUUID())).toBeUndefined();
    const more = await Harness.open(
      await openNodeSqliteStorage(path),
      { models: createModels(), registry: createRegistry() },
      context
    );
    const existing = await more.root(context);
    await existing.commit(async (tx) => {
      await tx.appendEntry(existing.id, {
        kind: 'b70.input',
        data: { id: randomUUID(), kind: 'task' },
      });
    }, context);
    await more.close(context);
    expect(await readSingleRunUsage(path, turnId)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
