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
  getCurrentTools,
  type FauxResponseFactory,
} from '@earendil-works/pi-ai';
import { obj, str } from '@earendil-works/pi-schema';
import { awaitWithContext } from '@earendil-works/chord/context';
import { defineTool } from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { DurableAgentManager } from '../../src/durable/manager.js';

// Exercise the real harness/storage with scripted model responses, no network or host tools.
afterEach(() => vi.restoreAllMocks());

async function fixture(block = false) {
  const root = await mkdtemp(join(tmpdir(), 'b70-child-test-'));
  const faux = fauxProvider({ tokensPerSecond: Infinity });
  const models = createModels();
  models.setProvider(faux.provider);
  const env = {
    cwd: '/workspace',
    exec: vi.fn(async () => ({ ok: false, error: 'Fixture has no AGENTS.md' })),
  } as unknown as ExecutionEnv;
  let active = 0,
    peak = 0;
  const calls: string[] = [];
  const proof = defineTool({
    name: 'proof',
    parameters: obj({ name: str() }),
    description: 'Fixture effect',
    async execute(args, _api, context) {
      calls.push(args.name);
      peak = Math.max(peak, ++active);
      if (block) await awaitWithContext(new Promise<void>(() => {}), context);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active--;
      return { output: [{ type: 'text', text: args.name + ' checked' }] };
    },
  });
  const response: FauxResponseFactory = (context) => {
    const user = context.messages.filter((m) => m.role === 'user').at(-1);
    const text = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content);
    const result = context.messages.filter((m) => m.role === 'toolResult').at(-1);
    if (text?.includes('ROOT')) {
      if (!result)
        return fauxAssistantMessage(
          fauxToolCall('delegate_tasks', {
            tasks: [
              { name: 'Alpha', task: 'alpha' },
              { name: 'Beta', task: 'beta' },
            ],
          }),
          { stopReason: 'toolUse' }
        );
      expect(JSON.stringify(result.content)).toContain('alpha checked');
      expect(JSON.stringify(result.content)).toContain('beta checked');
      return fauxAssistantMessage('Integrated both reports.');
    }
    const offered = getCurrentTools(context.messages).map((tool) => tool.name);
    expect(offered).toContain('proof');
    expect(offered).not.toContain('delegate_tasks');
    expect(offered).not.toContain('ask_user');
    const name = text?.includes('alpha') ? 'alpha' : 'beta';
    if (!result)
      return fauxAssistantMessage(fauxToolCall('proof', { name }), { stopReason: 'toolUse' });
    return fauxAssistantMessage(name + ' checked');
  };
  faux.setResponses(Array.from({ length: 30 }, () => response));
  const options = {
    runId: randomUUID(),
    requestId: randomUUID(),
    provider: faux.provider.id,
    model: faux.getModel().id,
    thinkingLevel: 'off' as const,
    models,
    storagePath: join(root, 'conversation.sqlite'),
    instructions: 'Fixture',
    env,
    browser: false,
    closeEnvironment: async () => {},
    extraTools: [proof],
  };
  return { root, options, calls, env, peak: () => peak };
}
async function settled(manager: DurableAgentManager) {
  await vi.waitFor(() => expect(['settled', 'failed']).toContain(manager.snapshot().status), {
    timeout: 10_000,
  });
  expect(manager.snapshot().status, manager.snapshot().reason).toBe('settled');
}

it('runs two owned children concurrently and projects separate full conversations', async () => {
  const f = await fixture();
  const manager = new DurableAgentManager(f.options);
  try {
    await manager.start({ task: 'ROOT' });
    await settled(manager);
    expect(f.calls.sort()).toEqual(['alpha', 'beta']);
    expect(f.peak()).toBe(2);
    const snapshot = manager.snapshot();
    expect(snapshot.subagents?.map((child) => child.status)).toEqual(['completed', 'completed']);
    expect(
      new Set(snapshot.timeline.filter((item) => item.agent).map((item) => item.agent!.id)).size
    ).toBe(2);
    for (const name of ['Alpha', 'Beta']) {
      const trace = snapshot.timeline.filter((item) => item.agent?.name === name);
      expect(trace.some((item) => item.kind === 'task')).toBe(true);
      expect(
        trace.some((item) => item.toolName === 'proof' && item.argumentsText && item.outputText)
      ).toBe(true);
      expect(trace.some((item) => item.kind === 'assistant')).toBe(true);
    }
    expect(
      snapshot.timeline.filter((item) => !item.agent && item.kind === 'assistant').at(-1)?.text
    ).toContain('Integrated');
  } finally {
    await manager.close();
    await rm(f.root, { recursive: true, force: true });
  }
}, 15_000);

it('restores child traces without resubmitting completed work after reopen', async () => {
  const f = await fixture();
  let manager = new DurableAgentManager(f.options);
  try {
    await manager.start({ task: 'ROOT' });
    await settled(manager);
    const children = manager.snapshot().subagents;
    await manager.close();
    manager = new DurableAgentManager(f.options);
    await manager.start({ task: 'ROOT' });
    await settled(manager);
    expect(f.calls.sort()).toEqual(['alpha', 'beta']);
    expect(manager.snapshot().subagents).toEqual(children);
    expect(
      manager
        .snapshot()
        .timeline.some(
          (item) => item.agent?.name === 'Alpha' && item.outputText?.includes('alpha checked')
        )
    ).toBe(true);
  } finally {
    await manager.close();
    await rm(f.root, { recursive: true, force: true });
  }
}, 15_000);

it('resumes interrupted owned children without duplicating unsafe effects', async () => {
  const f = await fixture(true);
  let manager = new DurableAgentManager(f.options);
  try {
    await manager.start({ task: 'ROOT' });
    await vi.waitFor(() => expect(f.calls).toHaveLength(2), { timeout: 5_000 });
    const identities = manager
      .snapshot()
      .subagents?.map((child) => child.id)
      .sort();
    await manager.close();
    manager = new DurableAgentManager(f.options);
    await manager.start({ task: 'ROOT' });
    await settled(manager);
    expect(f.calls.sort()).toEqual(['alpha', 'beta']);
    expect(
      manager
        .snapshot()
        .subagents?.map((child) => child.id)
        .sort()
    ).toEqual(identities);
    expect(
      manager
        .snapshot()
        .timeline.filter((item) => item.agent && item.toolName === 'proof')
        .every((item) => item.state === 'error')
    ).toBe(true);
  } finally {
    await manager.close();
    await rm(f.root, { recursive: true, force: true });
  }
}, 15_000);

it('cancels owned children when the main run is stopped', async () => {
  const f = await fixture(true);
  const manager = new DurableAgentManager(f.options);
  try {
    await manager.start({ task: 'ROOT' });
    await vi.waitFor(() => expect(f.calls).toHaveLength(2), { timeout: 5_000 });
    await manager.cancel({
      runId: f.options.runId,
      idempotencyKey: randomUUID(),
      expectedTaskVersion: 1,
      expectedRunVersion: 1,
    });
    expect(manager.snapshot().status).toBe('cancelled');
    expect(manager.snapshot().subagents?.map((child) => child.status)).toEqual([
      'stopped',
      'stopped',
    ]);
    expect(f.calls).toHaveLength(2);
  } finally {
    await manager.close();
    await rm(f.root, { recursive: true, force: true });
  }
}, 15_000);
