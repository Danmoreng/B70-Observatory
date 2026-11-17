import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-durable';
import { obj } from '@earendil-works/pi-schema';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { imageTools, imageDestination } from '../../src/durable/image-tool.js';
import { DurableAgentManager } from '../../src/durable/manager.js';
import { GpuScheduler } from '../../src/engine/gpu-scheduler.js';
import { ImageJobs } from '../../src/engine/image-jobs.js';
import { buildApp } from '../../src/app.js';
import { loadServerConfig } from '../../src/config.js';
import { comfyFixture } from '../engine/image-fixture.js';
import { validateAgentImage } from '@observatory/runner';

afterEach(() => vi.useRealTimers());

it('rejects host destinations and traversal while accepting project PNG paths', () => {
  expect(imageDestination('/workspace/site', 'public/hero.png')).toBe(
    '/workspace/site/public/hero.png'
  );
  for (const path of [
    '/etc/passwd.png',
    '../hero.png',
    'x\\hero.png',
    '/workspace/.git/hero.png',
    '/workspace/site/.git/hero.png',
    'hero.svg',
  ])
    expect(() => imageDestination('/workspace', path)).toThrow();
});

it.each([
  { restart: false, count: 1, cancel: false },
  { restart: true, count: 1, cancel: false },
  { restart: false, count: 3, cancel: false },
  { restart: true, count: 3, cancel: false },
  { restart: false, count: 3, cancel: true },
])(
  'two Pi Durable agents drain, render $count images with one swap (restarted: $restart, cancelled: $cancel)',
  async ({ restart, count, cancel }) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-15T11:00:00+01:00'));
    const root = await mkdtemp(join(tmpdir(), 'b70-pi-images-')),
      fake = comfyFixture();
    fake.state.finished = false;
    const events: string[] = [],
      gpu = new GpuScheduler({
        image: async () => {
          events.push('image');
        },
        text: async () => {
          events.push('text');
        },
      });
    const jobs = new ImageJobs(join(root, 'images'), gpu, fake.engine);
    const app = buildApp({
      version: 'test',
      config: loadServerConfig(),
      imageJobs: jobs,
      loggerLevel: 'silent',
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const files = new Map<string, Buffer>();
    const env = {
      cwd: '/workspace/site',
      writeFile: async (path: string, value: Uint8Array) => {
        files.set(path, Buffer.from(value));
        return { ok: true, value: undefined };
      },
      exec: async (args: string[]) => {
        if (args[0] === '/usr/bin/head') return { ok: false, error: 'Fixture has no AGENTS.md' };
        if (String(args[2]).includes('linkSync')) {
          const [source, target] = args.slice(-2);
          files.set(target!, files.get(source!)!);
          files.delete(source!);
        }
        return { ok: true, value: { exitCode: 0 } };
      },
    } as unknown as ExecutionEnv;
    const provider = (name: string) => {
      const faux = fauxProvider({ provider: name, tokensPerSecond: Infinity }),
        models = createModels();
      models.setProvider({
        ...faux.provider,
        streamSimple: (model, context, options) => {
          const stream = createAssistantMessageEventStream();
          void (async () => {
            const release = await gpu.acquireText(options?.signal);
            try {
              for await (const event of faux.provider.streamSimple(model, context, options))
                stream.push(event);
            } finally {
              release();
            }
          })().catch((error) => {
            stream.push({
              type: 'error',
              reason: 'aborted',
              error: fauxAssistantMessage('', {
                stopReason: 'aborted',
                errorMessage: String(error),
              }),
            });
          });
          return stream;
        },
      });
      return { faux, models };
    };
    const a = provider('image-agent-a'),
      b = provider('image-agent-b');
    let finishB!: () => void;
    const bTurn = new Promise<void>((resolve) => {
      finishB = resolve;
    });
    b.faux.setResponses([
      async () => {
        await bTurn;
        return fauxAssistantMessage(fauxToolCall('proof', {}), { stopReason: 'toolUse' });
      },
      () => {
        expect(events.at(-1)).toBe('text');
        return fauxAssistantMessage('Agent B continued coding.');
      },
    ]);
    a.faux.setResponses([
      fauxAssistantMessage(
        Array.from({ length: count }, (_, index) =>
          fauxToolCall('generate_image', {
            prompt: 'A red boat on a misty lake',
            path: index ? `public/hero-${index}.png` : 'public/hero.png',
            sizeId: 'landscape-quick',
            seed: 5,
          })
        ).flatMap((call, index) =>
          count > 1 && index === 1 ? [fauxToolCall('proof', {}), call] : [call]
        ),
        { stopReason: 'toolUse' }
      ),
      (context) => {
        const result = context.messages.find((message) => message.role === 'toolResult');
        const latest = [...context.messages]
          .reverse()
          .find((message) => message.role === 'toolResult');
        const previewName = count > 1 ? `hero-${count - 1}` : 'hero';
        expect(
          latest &&
            Array.isArray(latest.content) &&
            latest.content.some(
              (block) =>
                block.type === 'image' &&
                block.data ===
                  files
                    .get(`/workspace/site/public/${previewName}.preview.webp`)
                    ?.toString('base64')
            )
        ).toBe(true);
        expect(files.get('/workspace/site/public/hero.png')?.subarray(0, 8).toString('hex')).toBe(
          '89504e470d0a1a0a'
        );
        expect(
          validateAgentImage('image/webp', files.get('/workspace/site/public/hero.preview.webp')!)
        ).toMatchObject({ ok: true, width: 1200, height: 800 });
        expect(
          validateAgentImage('image/webp', files.get('/workspace/site/public/hero.webp')!)
        ).toMatchObject({ ok: true, width: 1536, height: 1024 });
        const text =
          result &&
          Array.isArray(result.content) &&
          result.content.find((block) => block.type === 'text');
        expect(text && JSON.parse(text.text)).toMatchObject({
          previewPath: '/workspace/site/public/hero.preview.webp',
          webPath: '/workspace/site/public/hero.webp',
          preview: { width: 1200, height: 800 },
          web: { width: 1536, height: 1024, quality: 82 },
        });
        expect(events.at(-1)).toBe('text');
        expect(JSON.stringify(context.messages)).not.toContain('test-image-secret');
        return fauxAssistantMessage(
          'Inspected the picture and continued implementing the website.'
        );
      },
    ]);
    const common = {
      thinkingLevel: 'off' as const,
      instructions: 'Fixture: execute the requested tool once, then continue.',
      env,
      browser: false,
      closeEnvironment: async () => {},
    };
    const runA = randomUUID(),
      runB = randomUUID();
    let restarting = false;
    const optionsA = {
      ...common,
      runId: runA,
      requestId: randomUUID(),
      provider: a.faux.provider.id,
      model: a.faux.getModel().id,
      models: a.models,
      storagePath: join(root, 'a.sqlite'),
      extraTools: [
        ...imageTools({
          runId: runA,
          gatewayUrl: base,
          gatewayToken: 'test-image-secret',
          cancelOnAbort: () => !restarting,
        }),
        defineTool({
          name: 'proof',
          description: 'A sequential CPU-only operation between image calls',
          parameters: obj({}),
          executionMode: 'sequential',
          async execute() {
            expect(fake.state.submissions).toBe(count);
            expect(events.at(-1)).toBe('text');
            return {
              output: [{ type: 'text', text: 'Batch already rendered; CPU tool order preserved.' }],
            };
          },
        }),
      ],
      onImage: (input: { data: Buffer }) => ({
        id: randomUUID(),
        runId: runA,
        mimeType: 'image/webp' as const,
        byteLength: input.data.length,
        width: 1,
        height: 1,
      }),
    };
    let agentA = new DurableAgentManager(optionsA);
    const agentB = new DurableAgentManager({
      ...common,
      runId: runB,
      requestId: randomUUID(),
      provider: b.faux.provider.id,
      model: b.faux.getModel().id,
      models: b.models,
      storagePath: join(root, 'b.sqlite'),
      extraTools: [
        defineTool({
          name: 'proof',
          description: 'A CPU-only tool',
          parameters: obj({}),
          async execute() {
            return { output: [{ type: 'text', text: 'Code saved.' }] };
          },
        }),
      ],
    });
    try {
      await agentB.start({ task: 'Finish this turn, use proof, and continue.' });
      await vi.waitFor(() => expect(b.faux.state.callCount).toBe(1));
      await agentA.start({ task: 'Generate a hero image and use it in the website.' });
      await vi.waitFor(() => expect(gpu.status().phase).toBe('draining'));
      expect(fake.state.submissions).toBe(0);
      expect(events).toEqual([]);
      finishB();
      await vi.waitFor(() => expect(fake.state.submissions).toBe(1));
      expect(jobs.metrics()).toHaveLength(count);
      await vi.waitFor(() => expect(gpu.status().waitingText).toBeGreaterThan(0));
      expect(b.faux.state.callCount).toBe(1);
      expect(events).toEqual(['image']);
      if (restart) {
        const snapshot = agentA.snapshot();
        restarting = true;
        await agentA.close();
        agentA = new DurableAgentManager({ ...optionsA, initialSnapshot: snapshot });
        restarting = false;
        await agentA.start({ task: 'Generate a hero image and use it in the website.' });
        expect(fake.state.submissions).toBe(1);
        expect(fake.state.interrupted).toBe(0);
      }
      if (cancel) {
        const stopping = agentA.cancel({
          runId: runA,
          expectedRunVersion: 1,
          expectedTaskVersion: 1,
          idempotencyKey: randomUUID(),
        });
        await vi.waitFor(
          () =>
            expect(jobs.metrics().map((job) => job.status)).toEqual([
              'cancelled',
              'cancelled',
              'cancelled',
            ]),
          { timeout: 3000 }
        );
        await stopping;
        await vi.waitFor(() => expect(agentB.snapshot().status).toBe('settled'));
        expect(events).toEqual(['image', 'text']);
        expect(fake.state.submissions).toBe(1);
        expect(fake.state.interrupted).toBe(1);
        expect(a.faux.state.callCount).toBe(1);
        return;
      }
      fake.state.finished = true;
      await vi.waitFor(() => expect(agentA.snapshot().status).toBe('settled'), { timeout: 8000 });
      await vi.waitFor(() => expect(agentB.snapshot().status).toBe('settled'));
      expect(fake.state.submissions).toBe(count);
      expect(events).toEqual(['image', 'text']);
      expect(
        agentA.snapshot().timeline.find((item) => item.toolName === 'generate_image')?.images
      ).toHaveLength(1);
      expect(
        agentA
          .snapshot()
          .timeline.filter(
            (item) => item.toolName === 'generate_image' && item.images?.length === 1
          )
      ).toHaveLength(count);
      for (let index = 1; index < count; index++)
        expect(files.has(`/workspace/site/public/hero-${index}.webp`)).toBe(true);
      expect(a.faux.state.callCount).toBe(2);
      expect(b.faux.state.callCount).toBe(2);
    } finally {
      finishB();
      fake.state.finished = true;
      await agentA.close();
      await agentB.close();
      await app.close();
      await jobs.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  15000
);
