import type { EngineModes } from './mode-controller.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ImageInputSchema, ImageBatchSchema } from './image-contract.js';
import type { ImageJobs } from './image-jobs.js';

/** Fixed trusted-runner surface. Never accept workflows, URLs or host paths. */
export function registerImageRoutes(app: FastifyInstance, jobs: ImageJobs, modes?: EngineModes) {
  app.get('/v1/image-jobs/gpu', async () => jobs.gpu.status());
  app.post('/v1/image-batches/cancel', { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    const parsed = ImageBatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid image batch.' });
    jobs.cancelBatch(parsed.data);
    return { accepted: true };
  });
  app.get('/v1/image-batches/:id', async (request, reply) => {
    const parsed = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid image batch ID.' });
    return jobs.batch(parsed.data.id);
  });
  app.post('/v1/image-batches', { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    if (modes && !modes.allowsAgentImages())
      return reply.code(409).send({ error: 'Agent image tools require Hybrid mode.' });
    const parsed = ImageBatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid image batch.' });
    return reply.code(202).send({ jobs: await jobs.submitBatch(parsed.data) });
  });
  app.post('/v1/image-jobs', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    if (modes && !modes.allowsAgentImages())
      return reply.code(409).send({ error: 'Agent image tools require Hybrid mode.' });
    const input = ImageInputSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Invalid image parameters.' });
    return reply.code(202).send(await jobs.submit(input.data));
  });
  const params = z.object({ id: z.string().regex(/^[a-f0-9]{32}$/) });
  app.get('/v1/image-jobs/:id', async (request, reply) => {
    const parsed = params.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid image job ID.' });
    return jobs.get(parsed.data.id);
  });
  app.delete('/v1/image-jobs/:id', async (request, reply) => {
    const parsed = params.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid image job ID.' });
    const key = request.headers['x-image-job-key'];
    if (key !== undefined && (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)))
      return reply.code(400).send({ error: 'Invalid cancellation key.' });
    jobs.cancel(parsed.data.id, key);
    return { accepted: true };
  });
  for (const preview of [false, true])
    app.get('/v1/image-jobs/:id/' + (preview ? 'preview' : 'original'), async (request, reply) => {
      const parsed = params.safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid image job ID.' });
      reply.header('cache-control', 'no-store').type(preview ? 'image/webp' : 'image/png');
      return jobs.artifact(parsed.data.id, preview);
    });
}
