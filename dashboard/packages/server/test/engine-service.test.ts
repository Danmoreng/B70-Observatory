import { describe, expect, it } from 'vitest';
import { createEngineServiceController, EngineServiceBusyError } from '../src/engine/service.js';

const active = 'LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n';

describe('vLLM user service controller', () => {
  it('times each running unit independently of scheduler mode and ignores old or missing starts', async () => {
    const nowMicros = () => process.hrtime.bigint() / 1000n;
    const before = nowMicros();
    const startMicros = before / 2n;
    const text =
      'Id=b70-qwen38-vllm.service\nLoadState=loaded\nActiveState=inactive\nActiveEnterTimestampMonotonic=12345';
    const image = `Id=diffusion-desk-comfyui.service\nLoadState=loaded\nActiveState=active\nActiveEnterTimestampMonotonic=${startMicros}`;
    const controller = createEngineServiceController(async () => `${image}\n\n${text}\n`);
    const result = await controller.runtimes();
    expect(result.text).toEqual({ state: 'inactive' });
    expect(result.image.state).toBe('active');
    expect(result.image.uptimeSeconds).toBeGreaterThanOrEqual(Number((before - startMicros) / 1_000_000n));
    expect(result.image.uptimeSeconds).toBeLessThanOrEqual(Number((nowMicros() - startMicros) / 1_000_000n));
    const partial = createEngineServiceController(async () =>
      image.replace(String(startMicros), '0')
    );
    expect(await partial.runtimes()).toEqual({
      text: { state: 'unknown' },
      image: { state: 'active' },
    });
  });

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
