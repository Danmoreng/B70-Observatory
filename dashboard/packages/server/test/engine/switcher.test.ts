import { afterEach, expect, it, vi } from 'vitest';
import { createGpuSwitch } from '../../src/engine/switcher.js';

afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-15T11:00:00+01:00'));
  const commands: string[][] = [],
    state = {
      image: false,
      legacy: false,
      textRequests: 0,
      imageRequests: 0,
      freeGpu: 32 * 1024 ** 3,
      now: 0,
    };
  const engines = createGpuSwitch('http://127.0.0.1:1', 'http://127.0.0.1:2', {
    run: async (args) => {
      commands.push(args);
      if (args[0] === 'show') return state.legacy ? 'active' : 'inactive';
      if (args[1] === 'diffusion-desk-comfyui.service') state.image = args[0] === 'start';
      return '';
    },
    now: () => state.now,
    wait: async () => {
      state.now += 31000;
    },
    fetch: async (url) => {
      const target = new URL(String(url));
      if (target.pathname === '/metrics')
        return new Response(
          `vllm:num_requests_running{model="fixture"} ${state.textRequests}\nvllm:num_requests_waiting{model="fixture"} 0\n`
        );
      if (target.pathname === '/health') return new Response('ok');
      if (!state.image) throw new Error('Image engine offline.');
      if (target.pathname === '/queue')
        return Response.json({
          queue_running: Array(state.imageRequests).fill([]),
          queue_pending: [],
        });
      return Response.json({
        devices: [{ vram_free: state.freeGpu }],
        system: { ram_free: 24 * 1024 ** 3 },
      });
    },
  });
  return { engines, state, commands };
}
it('uses only the fixed user services, starts images after stopping text, and restores text after image shutdown', async () => {
  const f = fixture();
  await f.engines.image();
  await f.engines.text();
  expect(f.commands.filter((c) => c[0] !== 'show')).toEqual([
    ['stop', 'b70-qwen38-vllm.service'],
    ['start', 'diffusion-desk-comfyui.service'],
    ['stop', 'diffusion-desk-comfyui.service'],
    ['start', 'b70-qwen38-vllm.service'],
  ]);
});
it('refuses a second independent image-engine owner before changing either service', async () => {
  const f = fixture();
  f.state.legacy = true;
  await expect(f.engines.image()).rejects.toThrow('exclusive image-engine ownership');
  expect(f.commands.every((c) => c[0] === 'show')).toBe(true);
});
it('does not stop text requests that bypass the shared admission queue', async () => {
  const f = fixture();
  f.state.textRequests = 1;
  await expect(f.engines.image()).rejects.toThrow('running or untracked');
  expect(f.commands.every((c) => c[0] === 'show')).toBe(true);
});
it('refuses to stop a busy image engine during restoration', async () => {
  const f = fixture();
  f.state.image = true;
  f.state.imageRequests = 1;
  await expect(f.engines.text()).rejects.toThrow('still has work');
  expect(f.commands.filter((c) => c[0] !== 'show')).toEqual([]);
});
it('stops a freshly started image engine if VRAM did not become available', async () => {
  const f = fixture();
  f.state.freeGpu = 3 * 1024 ** 3;
  await expect(f.engines.image()).rejects.toThrow('not released sufficiently');
  expect(f.state.image).toBe(false);
});

it('rolls back a text recipe if the new service exposes the wrong model', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-23T10:00:00Z'));
  const actions: string[][] = [];
  const commit = vi.fn();
  const engines = createGpuSwitch('http://text', 'http://image', {
    run: async (args) => {
      if (args[0] === 'show') {
        if (args.includes('--property=LoadState')) return 'loaded';
        return args[1] === 'b70-qwen38-vllm.service' ? 'active' : 'inactive';
      }
      actions.push(args);
      return '';
    },
    fetch: async (url) =>
      new URL(String(url)).pathname === '/metrics'
        ? new Response('vllm:num_requests_running 0\nvllm:num_requests_waiting 0\n')
        : Response.json({ data: [{ id: 'Qwen3.8-27B' }] }),
  });
  await expect(engines.selectText('Qwen3.8-27B', 'inkling2-mini-exl3-b70', commit)).rejects.toThrow(
    'different model'
  );
  expect(commit).not.toHaveBeenCalled();
  expect(actions).toEqual([
    ['stop', 'b70-qwen38-vllm.service'],
    ['start', 'b70-inkling2-vllm.service'],
    ['stop', 'b70-inkling2-vllm.service'],
    ['start', 'b70-qwen38-vllm.service'],
  ]);
});
