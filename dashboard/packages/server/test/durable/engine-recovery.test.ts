import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { obj } from '@earendil-works/pi-schema';
import { defineTool } from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { DurableAgentManager } from '../../src/durable/manager.js';
import { createEngineRecovery } from '../../src/durable/model-recovery.js';

afterEach(() => vi.useRealTimers());
async function fixture(failures: number) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-12T18:00:00Z'));
  const root = await mkdtemp(join(tmpdir(), 'b70-engine-recovery-'));
  const faux = fauxProvider({ tokensPerSecond: Infinity });
  const models = createModels();
  const recovery = createEngineRecovery(faux.getModel());
  models.setProvider({
    ...faux.provider,
    streamSimple: (model, context, options) =>
      recovery((attempt) => faux.provider.streamSimple(model, context, attempt), options ?? {}),
  });
  const effect = vi.fn(async () => ({
    output: [{ type: 'text' as const, text: 'Effect completed once.' }],
  }));
  const proof = defineTool({
    name: 'proof',
    description: 'One effect',
    parameters: obj({}),
    execute: effect,
  });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('proof', {}), { stopReason: 'toolUse' }),
    ...Array.from({ length: failures }, () =>
      fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: 'Connection refused',
      })
    ),
    (context) => {
      expect(context.messages.filter((message) => message.role === 'toolResult')).toHaveLength(1);
      return fauxAssistantMessage('Resumed from the completed tool result.');
    },
  ]);
  const options = {
    runId: randomUUID(),
    requestId: randomUUID(),
    provider: faux.provider.id,
    model: faux.getModel().id,
    thinkingLevel: 'off' as const,
    models,
    storagePath: join(root, 'conversation.sqlite'),
    instructions: 'Recovery fixture',
    env: {
      cwd: '/workspace',
      exec: async () => ({ ok: false, error: 'No project instructions' }),
    } as unknown as ExecutionEnv,
    browser: false,
    closeEnvironment: async () => {},
    extraTools: [proof],
  };
  return { root, options, faux, effect };
}

it('automatically resumes after a ten-minute outage without replaying a completed tool', async () => {
  const f = await fixture(20);
  const manager = new DurableAgentManager(f.options);
  try {
    await manager.start({ task: 'Do the effect, then finish.' });
    await vi.waitFor(() => expect(f.faux.state.callCount).toBe(2));
    for (let attempt = 0; attempt < 20; attempt++) {
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(f.faux.state.callCount).toBe(attempt + 3));
    }
    await vi.waitFor(() => expect(manager.snapshot().status).toBe('settled'));
    expect(f.effect).toHaveBeenCalledOnce();
    expect(manager.snapshot().timeline.filter((item) => item.kind === 'task')).toHaveLength(1);
    expect(manager.snapshot().timeline.filter((item) => item.kind === 'retry')).toHaveLength(20);
  } finally {
    await manager.close();
    vi.useRealTimers();
    await rm(f.root, { recursive: true, force: true });
  }
}, 20_000);

it('persists a pending retry across manager reopen and still respects Stop', async () => {
  const f = await fixture(20);
  let manager = new DurableAgentManager(f.options);
  try {
    await manager.start({ task: 'Do the effect, then finish.' });
    await vi.waitFor(() => expect(f.faux.state.callCount).toBe(2));
    await vi.waitFor(() =>
      expect(manager.snapshot().timeline.some((item) => item.kind === 'retry')).toBe(true)
    );
    await manager.close();
    manager = new DurableAgentManager(f.options);
    await manager.start({ task: 'Do the effect, then finish.' });
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(f.faux.state.callCount).toBeGreaterThanOrEqual(3));
    const callsBeforeStop = f.faux.state.callCount;
    await manager.cancel({
      runId: f.options.runId,
      idempotencyKey: randomUUID(),
      expectedTaskVersion: 1,
      expectedRunVersion: 1,
    });
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    expect(manager.snapshot().status).toBe('cancelled');
    expect(f.faux.state.callCount).toBe(callsBeforeStop);
    expect(f.effect).toHaveBeenCalledOnce();
  } finally {
    await manager.close();
    vi.useRealTimers();
    await rm(f.root, { recursive: true, force: true });
  }
}, 20_000);
