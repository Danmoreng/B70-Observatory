import { z } from 'zod';
const count = z.number().int().nonnegative();
const bytes = z.number().finite().nonnegative();
export const ImageJobMetricSchema = z.object({
  id: z.string().max(64),
  source: z.enum(['agent', 'studio', 'enhance']),
  status: z.string().max(32),
  phase: z.string().max(256),
  createdAt: z.string().datetime().optional(),
  step: count.optional(),
  steps: count.optional(),
  elapsedSeconds: bytes.optional(),
  renderSeconds: bytes.optional(),
  width: count.optional(),
  height: count.optional(),
  seed: count.optional(),
});
export type ImageJobMetric = z.infer<typeof ImageJobMetricSchema>;
export const EngineMetricsSchema = z.object({
  sampledAt: z.string().datetime(),
  textReady: z.boolean(),
  imageReady: z.boolean(),
  phase: z.enum(['text', 'draining', 'loading-image', 'image', 'loading-text', 'failed', 'closed']),
  activeText: count,
  waitingText: count,
  waitingImages: count,
  imageQueue: z.object({ running: count, pending: count }).nullable(),
  imageMemory: z
    .object({
      ramFree: bytes,
      ramTotal: bytes,
      devices: z
        .array(z.object({ name: z.string().max(256), vramFree: bytes, vramTotal: bytes }))
        .max(8),
    })
    .nullable(),
  jobs: z.array(ImageJobMetricSchema).max(20),
});
export type EngineMetrics = z.infer<typeof EngineMetricsSchema>;
