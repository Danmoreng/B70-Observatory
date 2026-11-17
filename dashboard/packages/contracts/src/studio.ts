import { z } from 'zod';
const text = z.string().max(16000);
const id = z.string().regex(/^[a-f0-9]{32}$/);
const finite = z.number().finite();
const sampling = {
  sampler: z.string().min(1).max(64).default('euler'),
  scheduler: z.string().min(1).max(64).default('simple'),
  noiseStart: finite.min(0).max(64).default(1.1),
  noiseEnd: finite.min(0).max(64).default(0.9),
};
export const StudioReferenceSchema = z.object({
  id,
  name: text,
  width: finite.positive(),
  height: finite.positive(),
  bytes: finite.nonnegative(),
  created: finite,
  uses: finite.nonnegative(),
});
export const StudioDraftSchema = z.object({
  ...sampling,
  prompt: z.string().max(12000).default(''),
  sizeId: z.string().max(64).default('landscape-8'),
  seed: z.string().max(16).default('-1'),
  count: z.number().int().min(1).max(8).default(1),
  mode: z.enum(['generate', 'edit']).default('generate'),
  referenceIds: z.array(id).max(16).default([]),
});
const request = z.object({
  ...sampling,
  prompt: text,
  sizeId: z.string().max(64),
  seed: finite,
  mode: z.enum(['generate', 'edit']).optional(),
  referenceIds: z.array(id).max(16).optional(),
});
const job = z.object({
  id,
  created: finite,
  status: z.enum([
    'queued',
    'running',
    'cancelling',
    'generated',
    'completed',
    'failed',
    'cancelled',
  ]),
  elapsed: finite.nonnegative(),
  error: text.nullable(),
  request,
  progress: z.object({ phase: text.optional(), step: finite.optional(), steps: finite.optional() }),
  result: z
    .object({
      prompt: text.optional(),
      ratio: text.optional(),
      report: text.optional(),
      model: text.optional(),
    })
    .optional(),
});
const image = z.object({
  id: z.string().regex(/^[a-f0-9]{20}$/),
  title: text,
  category: text,
  comparisonKey: text,
  created: finite,
  width: finite.positive(),
  height: finite.positive(),
  bytes: finite.nonnegative(),
  prompt: text,
  seed: finite.nullable(),
  steps: finite.nullable(),
  cfg: finite.nullable(),
  sampler: text,
  scheduler: text,
  noiseStart: finite.min(0).max(64).nullable().default(null),
  noiseEnd: finite.min(0).max(64).nullable().default(null),
  model: text,
  quantization: text,
  favorite: z.boolean(),
  pinned: z.boolean(),
  rating: z.number().int().min(0).max(5),
  keywords: z.array(z.string().max(40)).max(20),
  generationTime: finite.nullable(),
  jobId: id.nullable(),
  hasWorkflow: z.boolean(),
  hasPreview: z.boolean(),
  mode: z.enum(['generate', 'edit']),
  references: z.array(StudioReferenceSchema).max(16),
});
const config = z.object({
  sampling: z
    .object({
      samplers: z.array(z.string().min(1).max(64)).min(1).max(128),
      schedulers: z.array(z.string().min(1).max(64)).min(1).max(32),
    })
    .default({ samplers: ['euler', 'lcm'], schedulers: ['simple'] }),
  sizes: z
    .array(
      z.object({
        id: z.string().max(64),
        label: text,
        ratio: z.string().max(16),
        width: finite.positive(),
        height: finite.positive(),
      })
    )
    .max(32),
  acceptingJobs: z.boolean(),
  freeGiB: finite,
  promptExpansion: z.object({
    available: z.boolean(),
    maxReferences: finite.int().min(0).max(4),
    model: text,
  }),
});
/** Every imported Studio response crosses the same runtime validation boundary. */
export function parseStudioResponse(path: string, method: string, value: unknown): unknown {
  if (path === '/api/config') return config.parse(value);
  if (path === '/api/images') return z.object({ images: z.array(image).max(50000) }).parse(value);
  if (path === '/api/jobs' && method === 'GET')
    return z
      .object({
        jobs: z.array(job).max(200),
        engine: z.object({ online: z.boolean(), busy: z.boolean() }),
        acceptingJobs: z.boolean(),
      })
      .parse(value);
  if (path === '/api/jobs' && method === 'POST')
    return z.object({ ids: z.array(id).min(1).max(8) }).parse(value);
  if (path === '/api/references' && method === 'GET')
    return z.object({ references: z.array(StudioReferenceSchema).max(10000) }).parse(value);
  if (path === '/api/references' && method === 'POST')
    return z.object({ reference: StudioReferenceSchema }).parse(value);
  if (path === '/api/expansions' && method === 'POST') return z.object({ id }).parse(value);
  if (/^\/api\/expansions\/[a-f0-9]{32}$/.test(path) && method === 'GET')
    return z
      .object({
        job: job.extend({
          result: z.object({
            prompt: text.optional(),
            ratio: text.optional(),
            report: text.optional(),
            model: text.optional(),
          }),
        }),
      })
      .parse(value);
  if (/^\/api\/images\/[a-f0-9]{20}$/.test(path) && method === 'DELETE')
    return z.object({ deleted: z.literal(true), jobIds: z.array(id).max(2000) }).parse(value);
  return z.record(z.string(), z.unknown()).parse(value);
}
