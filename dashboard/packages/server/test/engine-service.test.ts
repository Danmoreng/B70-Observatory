import { describe, expect, it } from 'vitest';
import { createEngineServiceController, EngineServiceBusyError } from '../src/engine/service.js';

const active = 'LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n';

describe('vLLM user service controller', () => {
  it('reads the fixed unit and uses only fixed systemctl arguments', async () => {
    const calls: string[][] = [];
    const controller = createEngineServiceController(async (args) => {
      calls.push(args);
      return active;
    });
    expect(await controller.status()).toEqual({ activeState: 'active', autostart: true });
    await controller.action('restart');
    await controller.action('disable');
    expect(calls).toEqual([
      ['show', 'b70-qwen38-vllm.service', '--no-pager', '--property=LoadState,ActiveState,UnitFileState'],
      ['show', 'b70-qwen38-vllm.service', '--no-pager', '--property=LoadState,ActiveState,UnitFileState'],
      ['restart', '--no-block', 'b70-qwen38-vllm.service'],
      ['show', 'b70-qwen38-vllm.service', '--no-pager', '--property=LoadState,ActiveState,UnitFileState'],
      ['show', 'b70-qwen38-vllm.service', '--no-pager', '--property=LoadState,ActiveState,UnitFileState'],
      ['disable', 'b70-qwen38-vllm.service'],
      ['show', 'b70-qwen38-vllm.service', '--no-pager', '--property=LoadState,ActiveState,UnitFileState'],
    ]);
  });

  it.each(['start', 'stop', 'restart', 'enable', 'disable'] as const)(
    'targets the current engine for %s',
    async (action) => {
      const calls: string[][] = [];
      const controller = createEngineServiceController(async (args) => {
        calls.push(args);
        return active;
      });
      await controller.action(action);
      expect(calls[1]).toEqual(
        action === 'enable' || action === 'disable'
          ? [action, 'b70-qwen38-vllm.service']
          : [action, '--no-block', 'b70-qwen38-vllm.service']
      );
    }
  );

  it('refuses actions when the unit is not loaded', async () => {
    const calls: string[][] = [];
    const controller = createEngineServiceController(async (args) => {
      calls.push(args);
      return 'LoadState=not-found\nActiveState=inactive\nUnitFileState=disabled\n';
    });
    await expect(controller.action('start')).rejects.toThrow('not loaded');
    expect(calls).toHaveLength(1);
  });

  it('serializes concurrent actions', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = createEngineServiceController(async (args) => {
      if (args[0] === 'stop') await gate;
      return active;
    });
    const first = controller.action('stop');
    await expect(controller.action('restart')).rejects.toBeInstanceOf(EngineServiceBusyError);
    release?.();
    await first;
  });
});
