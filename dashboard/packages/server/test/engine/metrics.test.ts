import { expect, it, vi } from 'vitest';
import { createEngineMetrics } from '../../src/engine/metrics.js';
import { EngineModes } from '../../src/engine/mode-controller.js';
import { GpuScheduler } from '../../src/engine/gpu-scheduler.js';

it('reports the responding engine, validated Comfy memory, queue and active jobs without inference calls', async () => {
  const gpu = new GpuScheduler({ image: async () => {}, text: async () => {} });
  gpu.setStudio(true);
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/health') throw Error('Text intentionally stopped');
    if (path === '/queue')
      return Response.json({ queue_running: [[1, 'prompt']], queue_pending: [[]] });
    if (path === '/system_stats')
      return Response.json({
        system: { ram_free: 100, ram_total: 1000 },
        devices: [{ name: 'Intel Arc', vram_free: 50, vram_total: 320 }],
      });
    throw Error('Unexpected engine operation');
  });
  const metrics = createEngineMetrics({
    textUrl: 'http://127.0.0.1:8081',
    comfyUrl: 'http://127.0.0.1:8188',
    modes: new EngineModes(undefined, gpu),
    fetcher,
    jobs: () => [
      { id: 'a', source: 'agent', status: 'running', phase: 'Generating image', step: 3, steps: 6 },
    ],
  });
  const [a, b] = await Promise.all([metrics(), metrics()]);
  expect(a).toEqual(b);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(a).toMatchObject({
    textReady: false,
    imageReady: true,
    phase: 'image',
    imageQueue: { running: 1, pending: 1 },
    imageMemory: { devices: [{ name: 'Intel Arc', vramFree: 50, vramTotal: 320 }] },
    jobs: [{ step: 3, steps: 6 }],
  });
  await metrics();
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('treats intentionally stopped engines and invalid statistics as unavailable rather than zero usage', async () => {
  const metrics = createEngineMetrics({
    textUrl: 'http://127.0.0.1:8081',
    comfyUrl: 'http://127.0.0.1:8188',
    modes: new EngineModes(
      undefined,
      new GpuScheduler({ image: async () => {}, text: async () => {} })
    ),
    jobs: () => [],
    fetcher: async () => Response.json({ system: { ram_free: -1 }, queue_running: 'invalid' }),
  });
  expect(await metrics()).toMatchObject({
    textReady: true,
    imageReady: false,
    imageMemory: null,
    imageQueue: null,
  });
});
