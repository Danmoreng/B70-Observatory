import { z } from 'zod';
import {
  EngineMetricsSchema,
  type EngineMetrics,
  type ImageJobMetric,
} from '@observatory/contracts';
import type { EngineModes } from './mode-controller.js';
const bytes = z.number().finite().nonnegative();
const statsSchema = z.object({
  system: z.object({ ram_free: bytes, ram_total: bytes }),
  devices: z
    .array(z.object({ name: z.string().max(256), vram_free: bytes, vram_total: bytes }))
    .max(8),
});
const queueSchema = z.object({
  queue_running: z.array(z.unknown()).max(10000),
  queue_pending: z.array(z.unknown()).max(10000),
});
export function createEngineMetrics(options: {
  textUrl: string;
  comfyUrl: string;
  modes: EngineModes;
  jobs: () => ImageJobMetric[];
  fetcher?: typeof fetch;
}) {
  let pending: Promise<EngineMetrics> | undefined,
    cached: EngineMetrics | undefined,
    at = 0;
  const fetcher = options.fetcher ?? fetch;
  async function get(origin: string, path: string) {
    try {
      const response = await fetcher(new URL(path, origin), {
        redirect: 'error',
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return undefined;
      }
      if (path === '/health') {
        await response.body?.cancel();
        return true;
      }
      const body = await response.text();
      if (body.length > 2 * 1024 * 1024) return undefined;
      return JSON.parse(body) as unknown;
    } catch {
      return undefined;
    }
  }
  return async () => {
    if (cached && Date.now() - at < 1000) return cached;
    if (pending) return pending;
    pending = (async () => {
      const [text, queue, stats] = await Promise.all([
        get(options.textUrl, '/health'),
        get(options.comfyUrl, '/queue'),
        get(options.comfyUrl, '/system_stats'),
      ]);
      const q = queueSchema.safeParse(queue),
        s = statsSchema.safeParse(stats);
      const active = new Set(['queued', 'running', 'cancelling', 'generated']);
      const jobs = options
        .jobs()
        .sort(
          (a, b) =>
            Number(active.has(b.status)) - Number(active.has(a.status)) ||
            Date.parse(b.createdAt ?? '1970-01-01') - Date.parse(a.createdAt ?? '1970-01-01')
        )
        .slice(0, 20);
      cached = EngineMetricsSchema.parse({
        sampledAt: new Date().toISOString(),
        textReady: text === true,
        imageReady: q.success,
        ...options.modes.status().gpu,
        imageQueue: q.success
          ? { running: q.data.queue_running.length, pending: q.data.queue_pending.length }
          : null,
        imageMemory: s.success
          ? {
              ramFree: s.data.system.ram_free,
              ramTotal: s.data.system.ram_total,
              devices: s.data.devices.map((d) => ({
                name: d.name,
                vramFree: d.vram_free,
                vramTotal: d.vram_total,
              })),
            }
          : null,
        jobs,
      });
      at = Date.now();
      return cached;
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
