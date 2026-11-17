import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { GpuScheduler } from '../engine/gpu-scheduler.js';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { pickForwardedHeaders } from './headers.js';

const image = z
  .object({
    type: z.literal('image_url'),
    image_url: z
      .object({
        url: z
          .string()
          .max(2_800_000)
          .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/),
      })
      .strict(),
  })
  .strict();
const base = { model: z.string().min(1).max(256) };
const bodySchema = z.union([
  z.object({ ...base, prompt: z.string().max(2_000_000) }).strict(),
  z
    .object({
      ...base,
      messages: z.tuple([
        z.object({ role: z.literal('user'), content: z.array(image).max(4) }).strict(),
      ]),
    })
    .strict(),
]);

/** Authenticated, fixed tokenizer surface. No generation, raw-token response or request-log row. */
export function registerTokenize(
  app: FastifyInstance,
  config: ServerConfig,
  gpu?: GpuScheduler,
  mayCall: (request: FastifyRequest) => boolean = () => true
): void {
  app.post('/v1/tokenize', { bodyLimit: config.maxRequestBytes }, async (request, reply) => {
    if (!mayCall(request))
      return reply.code(409).send({ error: 'Agent inference is disabled in Bildstudio mode.' });
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid tokenizer input.' });
    const body = {
      ...parsed.data,
      add_special_tokens: false,
      ...('messages' in parsed.data ? { add_generation_prompt: false } : {}),
    };
    let release: (() => void) | undefined;
    const abort = new AbortController();
    const disconnect = () => abort.abort();
    request.raw.socket.once('close', disconnect);
    try {
      release = await gpu?.acquireText(
        AbortSignal.any([abort.signal, AbortSignal.timeout(45 * 60_000)])
      );
      const upstream = await fetch(new URL('/tokenize', config.upstreamUrl), {
        method: 'POST',
        headers: { ...pickForwardedHeaders(request.headers), 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
      });
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel();
        return reply.code(503).send({ error: 'Tokenizer unavailable.' });
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of upstream.body) {
        size += chunk.byteLength;
        if (size > 16 * 1024 * 1024) throw new Error('Tokenizer response too large');
        chunks.push(chunk);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { count?: unknown };
      if (!Number.isSafeInteger(value.count) || (value.count as number) < 0)
        throw new Error('Invalid count');
      return { count: value.count };
    } catch {
      return reply.code(503).send({ error: 'Tokenizer unavailable.' });
    } finally {
      request.raw.socket.off('close', disconnect);
      release?.();
    }
  });
}
