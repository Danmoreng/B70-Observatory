import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { createStudio } from '../../src/engine/studio.js';
import { GpuScheduler } from '../../src/engine/gpu-scheduler.js';
import { png } from './image-fixture.js';
import type { EngineModes } from '../../src/engine/mode-controller.js';

it('mounts the real studio API with uploads, gallery, policy gates and Qwen enhancement through the gateway', async () => {
  vi.setSystemTime(new Date('2026-11-15T12:00:00Z'));
  const root = await mkdtemp(join(tmpdir(), 'b70-integrated-studio-'));
  const events: string[] = [],
    requests: { headers: Record<string, unknown>; body: Record<string, unknown> }[] = [];
  let allowed = false;
  const gpu = new GpuScheduler({
    image: async () => {
      events.push('image');
    },
    text: async () => {
      events.push('text');
    },
  });
  gpu.setStudio(true);
  const gateway = createServer(async (req, res) => {
    const release = await gpu.acquireText();
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                expanded_caption: 'A detailed photograph of an alpine lake.',
                aspect_ratio: '3:2',
              }),
            },
          },
        ],
      })
    );
    release();
  });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const studio = await createStudio({
    runtimeRoot: fileURLToPath(new URL('../../../../vendor/diffusion-desk', import.meta.url)),
    comfyRoot: join(root, 'comfy'),
    stateDir: join(root, 'state'),
    comfyUrl: 'http://127.0.0.1:1',
    internalToken: 'private-studio-token',
    gatewayUrl: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`,
    model: () => 'qualified-qwen-27b',
    gpu,
    modes: { allowsImages: () => allowed } as EngineModes,
  });
  const app = Fastify();
  studio.register(app);
  const mutate = (url: string, payload: unknown, method: 'POST' | 'DELETE' = 'POST') =>
    app.inject({
      method,
      url: '/api/studio' + url,
      payload: JSON.stringify(payload),
      headers: { 'x-desk-request': '1', 'content-type': 'application/json' },
    });
  try {
    const config = (await app.inject('/api/studio/api/config')).json();
    expect(config.promptExpansion).toMatchObject({ available: true, model: 'Qwen 27B · vLLM' });
    expect(config.acceptingJobs).toBe(false);
    expect(config.sampling.samplers).toContain('lcm');
    expect(config.sampling.schedulers).toContain('beta');
    expect((await mutate('/api/jobs', { prompt: 'lake' })).statusCode).toBe(409);
    expect((await mutate('/api/expansions', { prompt: 'lake' })).statusCode).toBe(409);
    expect((await app.inject('/api/studio/../../etc/passwd')).statusCode).toBe(404);
    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/studio/api/references',
      headers: {
        'x-desk-request': '1',
        'content-type': 'application/octet-stream',
        'x-file-name': 'reference.png',
      },
      payload: png(24, 16),
    });
    expect(uploaded.statusCode).toBe(201);
    const reference = uploaded.json().reference;
    expect(
      (await app.inject(`/api/studio/references/${reference.id}/thumb`)).headers['content-type']
    ).toContain('image/jpeg');
    expect((await app.inject('/api/studio/api/images')).json().images).toEqual([]);
    allowed = true;
    studio.start();
    const submitted = await mutate('/api/expansions', {
      prompt: 'alpine lake',
      mode: 'edit',
      referenceIds: [reference.id],
      sizeId: 'landscape-quick',
    });
    expect(submitted.statusCode).toBe(202);
    const id = submitted.json().id;
    await expect
      .poll(async () => (await app.inject('/api/studio/api/expansions/' + id)).json().job.status)
      .toBe('completed');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.authorization).toBe('Bearer private-studio-token');
    expect(requests[0]!.body.model).toBe('qualified-qwen-27b');
    expect(JSON.stringify(requests[0]!.body)).toContain('data:image/jpeg;base64,');
    expect(events).toEqual(['text', 'image']);
    const result = (await app.inject('/api/studio/api/expansions/' + id)).json().job.result;
    expect(result).toMatchObject({
      prompt: 'A detailed photograph of an alpine lake.',
      model: 'Qwen 27B · vLLM',
      ratio: '3:2',
    });
    expect((await mutate('/api/expansions/' + id, {}, 'DELETE')).statusCode).toBe(200);
    expect((await mutate('/api/references/' + reference.id, {}, 'DELETE')).statusCode).toBe(200);
  } finally {
    await studio.close();
    await gpu.close();
    await app.close();
    gateway.closeAllConnections();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    vi.useRealTimers();
  }
});
