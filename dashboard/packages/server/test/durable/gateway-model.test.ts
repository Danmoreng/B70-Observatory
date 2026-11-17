import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { newTempDb } from '../helpers.js';
import { buildApp } from '../../src/app.js';
import { loadServerConfig } from '../../src/config.js';
import { RequestRepository } from '../../src/db/index.js';
import { createLocalModels } from '../../src/durable/model.js';
import type { RunnerConfig } from '../../src/runner/config.js';
import { createInferenceRelay } from '../../src/runner/inference-relay.js';
import { request } from 'node:http';

it('routes Durable and RPC through the real gateway with matching central and per-run request IDs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'b70-gateway-model-'));
  const temp = newTempDb();
  const backendCalls: string[] = [];
  const backend = createServer((incoming, response) => {
    backendCalls.push(incoming.url!);
    incoming.resume();
    incoming.on('end', () => {
      const chunk = {
        id: 'chatcmpl-fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'Gateway verified.' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 30,
          completion_tokens: 5,
          total_tokens: 35,
          prompt_tokens_details: { cached_tokens: 10 },
        },
        metrics: { time_to_first_token_ms: 100, generation_time_ms: 200 },
      };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const address = backend.address();
  if (!address || typeof address === 'string') throw new Error('backend address');
  const config = loadServerConfig({ OBSERVATORY_UPSTREAM_URL: `http://127.0.0.1:${address.port}` });
  const requests = new RequestRepository(temp.db);
  const app = buildApp({
    config,
    version: 'test',
    loggerLevel: 'silent',
    gateway: { config, requests },
  });
  const gatewayUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const onTelemetry = vi.fn();
  const relay = createInferenceRelay({
    socketPath: join(root, 'relay.sock'),
    upstreamUrl: new URL(gatewayUrl),
    upstreamToken: 'gateway-credential',
  });
  try {
    await mkdir(join(root, 'profile'));
    await writeFile(
      join(root, 'profile/models.json'),
      JSON.stringify({
        providers: {
          fixture: { models: [{ id: 'fixture', contextWindow: 16384, maxTokens: 512 }] },
        },
      })
    );
    const models = await createLocalModels(
      {
        profileRoot: join(root, 'profile'),
        provider: 'fixture',
        model: 'fixture',
        upstreamUrl: 'http://127.0.0.1:1',
        gatewayUrl,
      } as RunnerConfig,
      onTelemetry
    );
    const model = models.getModel('fixture', 'fixture')!;
    const answer = await models.completeSimple(model, {
      messages: [{ role: 'user', content: 'Verify', timestamp: Date.now() }],
    });
    expect(answer.stopReason, answer.errorMessage).toBe('stop');
    expect(onTelemetry).toHaveBeenCalledTimes(1);
    const sample = onTelemetry.mock.calls[0]![0];
    await vi.waitFor(() => expect(requests.get(sample.requestId)?.status).toBe('completed'));
    expect(requests.get(sample.requestId)).toMatchObject({
      origin: 'pi',
      promptTokens: 30,
      completionTokens: 5,
    });
    expect(sample).toMatchObject({
      outcome: 'completed',
      prefill: { tokens: 20, durationMs: 100 },
      decode: { tokens: 4, durationMs: 200 },
    });
    const rpcTelemetry = vi.fn();
    const capability = 'a'.repeat(64);
    relay.register(capability, rpcTelemetry);
    await relay.start();
    await new Promise<void>((resolve, reject) => {
      const call = request(
        {
          socketPath: join(root, 'relay.sock'),
          path: '/v1/chat/completions',
          method: 'POST',
          headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json' },
        },
        (response) => {
          response.resume();
          response.on('end', resolve);
        }
      );
      call.on('error', reject);
      call.end(JSON.stringify({ model: 'fixture', stream: true, messages: [] }));
    });
    await vi.waitFor(() => expect(rpcTelemetry).toHaveBeenCalledTimes(1));
    const rpc = rpcTelemetry.mock.calls[0]![0];
    await vi.waitFor(() => expect(requests.get(rpc.requestId)?.status).toBe('completed'));
    expect(rpc).toMatchObject({
      outcome: 'completed',
      usage: { inputTokens: 30, outputTokens: 5 },
    });
    expect(backendCalls).toEqual(['/v1/chat/completions', '/v1/chat/completions']);
    // Gateway failure must surface; it must never fall back to the engine URL.
    await app.close();
    const failed = await models.completeSimple(
      model,
      { messages: [{ role: 'user', content: 'Offline', timestamp: Date.now() }] },
      { maxRetries: 0 }
    );
    expect(failed.stopReason).toBe('error');
    expect(backendCalls).toHaveLength(2);
  } finally {
    await relay.close().catch(() => {});
    await app.close();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    temp.close();
    await rm(root, { recursive: true, force: true });
  }
});
