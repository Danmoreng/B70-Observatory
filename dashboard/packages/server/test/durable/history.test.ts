import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { DurableAgentManager } from '../../src/durable/manager.js';

it('retains history beyond the Pi 1.5 live window and a context reset after reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'b70-durable-history-'));
  const storagePath = join(root, 'conversation.sqlite');
  const faux = fauxProvider({ tokensPerSecond: Infinity });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('Continued from saved history.')]);
  const seed = await Harness.open(
    await openNodeSqliteStorage(storagePath),
    { models, registry: createRegistry() },
    context
  );
  const conversation = await seed.root(context, {
    agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
  });
  await conversation.commit(async (tx) => {
    for (let index = 0; index < 130; index++) {
      await tx.appendEntry(conversation.id, {
        kind: index === 90 ? 'pi.reset' : 'b70.input',
        ...(index === 90 ? { head: 'self' as const } : {}),
        model: [{ role: 'user', content: `History ${index}`, timestamp: index + 1 }],
      });
    }
  }, context);
  await seed.close(context);
  const manager = new DurableAgentManager({
    runId: randomUUID(),
    requestId: randomUUID(),
    provider: faux.provider.id,
    model: faux.getModel().id,
    thinkingLevel: 'off',
    models,
    storagePath,
    instructions: 'History fixture',
    env: {
      cwd: '/workspace',
      exec: async () => ({ ok: false, error: 'No project instructions in fixture' }),
    } as unknown as ExecutionEnv,
    browser: false,
    closeEnvironment: async () => {},
  });
  try {
    await manager.start({ task: 'Continue the saved conversation.' });
    await vi.waitFor(() => expect(['settled', 'failed']).toContain(manager.snapshot().status));
    expect(manager.snapshot().status, manager.snapshot().reason).toBe('settled');
    const trace = manager.snapshot().timeline;
    for (let index = 0; index < 130; index++) {
      expect(
        trace.some((item) => item.text === `History ${index}`),
        `History ${index}`
      ).toBe(true);
    }
    expect(trace.at(-1)?.text).toBe('Continued from saved history.');
  } finally {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});
