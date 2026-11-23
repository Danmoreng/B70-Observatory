import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RunnerEngineMode, policy } from '../../src/engine/mode.js';
import { EngineModes } from '../../src/engine/mode-controller.js';
import { GpuScheduler } from '../../src/engine/gpu-scheduler.js';
import type { AgentController } from '../../src/agent/manager.js';

it('waits for the runner socket at boot and fails closed for policy errors', async () => {
  let calls = 0;
  const gpu = new GpuScheduler({ image: async () => {}, text: async () => {} });
  const agent = {
    engineMode: async () => {
      if (++calls < 3) throw Object.assign(new Error('Socket starting'), { code: 'ENOENT' });
      return policy('studio');
    },
  } as AgentController;
  const modes = new EngineModes(agent, gpu);
  await modes.load();
  expect(modes.status().mode).toBe('studio');
  expect(modes.status().gpu.phase).toBe('image');
  agent.engineMode = async () => {
    throw new Error('Invalid policy');
  };
  await expect(modes.load()).rejects.toThrow('Invalid policy');
});

it('persists policy, freezes agent admission in studio, and removes image capabilities in text', () => {
  const root = mkdtempSync(join(tmpdir(), 'b70-mode-')),
    file = join(root, 'mode.json');
  try {
    const modes = new RunnerEngineMode(file, true);
    expect(modes.status()).toEqual(policy('text'));
    expect(() => modes.set('studio', true)).toThrow('Pause or finish');
    expect(modes.status().mode).toBe('text');
    modes.set('hybrid', false);
    expect(modes.status()).toEqual({ mode: 'hybrid', imageTools: true, agentsAllowed: true });
    modes.set('studio', false);
    expect(() => modes.assertAgents()).toThrow('disabled');
    const resumed = new RunnerEngineMode(file, true);
    expect(resumed.status().mode).toBe('studio');
    resumed.set('text', false);
    expect(resumed.status().imageTools).toBe(false);
    expect(() => new RunnerEngineMode(file, false).set('hybrid', false)).toThrow('disabled');
    writeFileSync(file, '{"mode":"invalid"}');
    expect(() => new RunnerEngineMode(file, true)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('changes runner admission before swapping, rejects concurrent GPU work, and leaves active turns intact', async () => {
  const events: string[] = [];
  let mode = policy('text'),
    occupied = false;
  const engines = {
    image: async () => {
      events.push('image');
    },
    text: async () => {
      events.push('text');
    },
  };
  const gpu = new GpuScheduler(engines);
  const agent = {
    engineMode: async (next?: 'text' | 'hybrid' | 'studio') => {
      if (next && occupied) throw new Error('Pause agents first');
      if (next) {
        events.push('policy:' + next);
        mode = policy(next);
      }
      return mode;
    },
  } as AgentController;
  const modes = new EngineModes(agent, gpu);
  await modes.load();
  occupied = true;
  await expect(modes.set('studio')).rejects.toThrow('Pause agents');
  expect(events).toEqual([]);
  occupied = false;
  await modes.set('studio');
  expect(events).toEqual(['policy:studio', 'image']);
  expect(modes.allowsText()).toBe(false);
  expect(modes.status().imageTools).toBe(false);
  const release = await gpu.acquireText();
  await expect(modes.set('text')).rejects.toThrow('busy');
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await modes.set('hybrid');
  expect(modes.status().imageTools).toBe(true);
  expect(modes.status().agentsAllowed).toBe(true);
  expect(events.slice(-2)).toEqual(['policy:hybrid', 'text']);
  await gpu.close();
});

it('keeps the last verified recipe across a runner restart during a model switch', () => {
  const root = mkdtempSync(join(tmpdir(), 'b70-recipe-'));
  const file = join(root, 'mode.json');
  try {
    writeFileSync(file, '{"mode":"hybrid"}');
    const open = () => new RunnerEngineMode(file, true, 'inkling2-mini-exl3-b70');
    open().beginSwitch('Qwen3.8-27B', true);
    const interrupted = open();
    expect(interrupted.status()).toMatchObject({ mode: 'hybrid', model: 'inkling2-mini-exl3-b70' });
    expect(interrupted.pending).toEqual({ next: 'Qwen3.8-27B', wasActive: true });
    interrupted.selectModel('Qwen3.8-27B');
    expect(open().model).toBe('Qwen3.8-27B');
    expect(open().pending).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
