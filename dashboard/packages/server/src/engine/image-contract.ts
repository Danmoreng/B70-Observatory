import { z } from 'zod';
import { createHash } from 'node:crypto';

export const IMAGE_SIZES = {
  'landscape-quick': { width: 1536, height: 1024, ratio: '3:2', preset: '1.5 MP' },
  'landscape-4': { width: 2496, height: 1664, ratio: '3:2', preset: '4 MP (fast)' },
  'landscape-8': { width: 3552, height: 2368, ratio: '3:2', preset: '8 MP' },
  'portrait-quick': { width: 1024, height: 1536, ratio: '2:3', preset: '1.5 MP' },
  'portrait-4': { width: 1664, height: 2496, ratio: '2:3', preset: '4 MP (fast)' },
  'portrait-8': { width: 2368, height: 3552, ratio: '2:3', preset: '8 MP' },
  'square-4': { width: 2048, height: 2048, ratio: '1:1', preset: '4 MP (fast)' },
} as const;
export const ImageInputSchema = z
  .object({
    key: z.string().regex(/^[a-f0-9]{64}$/),
    prompt: z.string().trim().min(1).max(12000),
    sizeId: z
      .enum([
        'landscape-quick',
        'landscape-4',
        'landscape-8',
        'portrait-quick',
        'portrait-4',
        'portrait-8',
        'square-4',
      ])
      .default('landscape-4'),
    seed: z.number().int().min(-1).max(4294967295).default(-1),
  })
  .strict();
export type ImageInput = z.infer<typeof ImageInputSchema>;
export const ImageBatchSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    images: z.array(ImageInputSchema).min(2).max(16),
  })
  .strict()
  .refine(
    (batch) => new Set(batch.images.map((image) => image.key)).size === batch.images.length,
    'Image keys must be unique.'
  );
export const imageBatchFingerprint = (batch: z.infer<typeof ImageBatchSchema>) =>
  createHash('sha256').update(JSON.stringify(batch)).digest('hex');
export const ImageStatusSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/),
  status: z.enum(['queued', 'running', 'generated', 'completed', 'failed', 'cancelled']),
  phase: z.string().max(256),
  step: z.number().int().nonnegative().optional(),
  steps: z.number().int().nonnegative().optional(),
  seed: z.number().int().nonnegative(),
  sizeId: ImageInputSchema.shape.sizeId,
  error: z.string().max(1000).optional(),
});
export type ImageStatus = z.infer<typeof ImageStatusSchema>;
