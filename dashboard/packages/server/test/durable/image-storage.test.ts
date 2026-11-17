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
import { TaskStoreError } from '../../src/runner/task-store.js';

it.each(['persistence', 'storage_budget'] as const)(
  'reports image %s failures honestly and stops on exhausted storage',
  async (code) => {
    const root = await mkdtemp(join(tmpdir(), 'b70-durable-image-storage-'));
    const storagePath = join(root, 'conversation.sqlite');
    const faux = fauxProvider({ tokensPerSecond: Infinity });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('Continued.')]);
    const seed = await Harness.open(
      await openNodeSqliteStorage(storagePath),
      { models, registry: createRegistry() },
      context
    );
    const conversation = await seed.root(context, {
      agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
    });
    await conversation.commit(async (tx) => {
      await tx.appendEntry(conversation.id, {
        kind: 'pi.tool-result',
        model: [
          {
            role: 'toolResult',
            toolCallId: 'saved-shot',
            toolName: 'browser_screenshot',
            timestamp: 1,
            isError: false,
            content: [{ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }],
          },
        ],
      });
    }, context);
    await seed.close(context);
    const reason =
      code === 'storage_budget'
        ? 'Speicherbudget des Laufs erreicht: 2048 MiB Budget.'
        : 'Image rejected: invalid PNG header';
    const closeEnvironment = vi.fn(async () => {});
    const manager = new DurableAgentManager({
      runId: randomUUID(),
      requestId: randomUUID(),
      provider: faux.provider.id,
      model: faux.getModel().id,
      thinkingLevel: 'off',
      models,
      storagePath,
      instructions: 'Image storage fixture',
      env: {
        cwd: '/workspace',
        exec: async () => ({ ok: false, error: 'No instructions' }),
      } as unknown as ExecutionEnv,
      browser: false,
      closeEnvironment,
      onImage: () => {
        throw new TaskStoreError(code, reason);
      },
    });
    try {
      if (code === 'storage_budget') {
        await expect(manager.start({ task: 'Continue' })).rejects.toThrow(reason);
        expect(manager.snapshot().status).toBe('failed');
        expect(manager.snapshot().reason).toBe(reason);
        await vi.waitFor(() => expect(closeEnvironment).toHaveBeenCalled());
      } else {
        await manager.start({ task: 'Continue' });
        await vi.waitFor(() => expect(manager.snapshot().status).toBe('settled'));
      }
      expect(
        manager.snapshot().timeline.find((item) => item.title === 'Bild nicht gespeichert')?.text
      ).toBe(reason);
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  }
);
