import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  defineTool,
  type ToolRegistration,
  type ToolExecutionApi,
  type EntryId,
} from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { z } from 'zod';
import { getOrThrow } from '@earendil-works/pi-durable/env';
import { obj, str, int, opt } from '@earendil-works/pi-schema';
import {
  ImageInputSchema,
  ImageStatusSchema,
  ImageBatchSchema,
  imageBatchFingerprint,
} from '../engine/image-contract.js';
import { assertMayStartWork } from './working-hours.js';
import { createImageAssets } from './image-assets.js';

const defaultDirectory = 'assets/generated';
const imageCall = z
  .object({
    prompt: ImageInputSchema.shape.prompt,
    directory: z.string().min(1).max(512).optional(),
    // Saved calls can still contain a path from the older tool schema.
    path: z.string().min(1).max(512).optional(),
    sizeId: ImageInputSchema.shape.sizeId,
    seed: ImageInputSchema.shape.seed,
  })
  .strict();

function workspaceLocation(cwd: string, path: string) {
  const location = posix.resolve(cwd, path);
  const segments = path.split('/');
  if (
    path.includes('\0') ||
    path.includes('\\') ||
    segments.includes('..') ||
    (location !== '/workspace' && !location.startsWith('/workspace/')) ||
    location.split('/').includes('.git')
  )
    throw new Error('Use a directory inside /workspace, for example public/assets.');
  return location;
}

function imageLocation(cwd: string, args: z.infer<typeof imageCall>) {
  if (args.directory === undefined && args.path !== undefined) {
    const path = workspaceLocation(cwd, args.path);
    if (path.endsWith('.png')) return { directory: posix.dirname(path), legacyPath: path };
    return { directory: path === '/workspace' ? path : posix.dirname(path) };
  }
  return { directory: workspaceLocation(cwd, args.directory ?? defaultDirectory) };
}

/** Inspect only this tool's already committed assistant entry, never live partials.
 * Keys are stable across tool scheduling/replay; ordinary legacy calls keep their
 * task-based keys. No code/tool execution order or model message is changed.
 */
async function imageRound(
  api: ToolExecutionApi,
  runId: string,
  context: typeof BACKGROUND_CONTEXT
) {
  return api.commit(async (tx) => {
    const task = await tx.task(api.taskId);
    const source = z
      .object({ kind: z.literal('model'), assistant: z.number().int().nonnegative() })
      .safeParse(task?.input);
    if (!source.success || !api.env) return undefined;
    const entry = await tx.entry(source.data.assistant as EntryId);
    if (entry?.conversationId !== api.conversationId) return undefined;
    const message = entry.model?.[0];
    if (message?.role !== 'assistant') return undefined;
    const calls = message.content.flatMap((call) => {
      if (call.type !== 'toolCall' || call.name !== 'generate_image') return [];
      const args = imageCall.safeParse(call.arguments);
      if (!args.success) return [];
      try {
        const location = imageLocation(api.env!.cwd, args.data);
        // Keep the membership of batches recorded under the old PNG-only schema.
        if (args.data.directory === undefined && args.data.path && !location.legacyPath) return [];
      } catch {
        return [];
      }
      return [{ id: call.id, args: args.data }];
    });
    const index = calls.findIndex((call) => call.id === api.callId);
    if (index < 0) return undefined;
    const group = Math.floor(index / 16),
      members = calls.slice(group * 16, group * 16 + 16);
    if (members.length < 2) return undefined;
    const id = createHash('sha256')
      .update(JSON.stringify([runId, 'image-round-v1', entry.id, group]))
      .digest('hex');
    const images = members.map((call) =>
      ImageInputSchema.parse({
        key: createHash('sha256')
          .update(JSON.stringify([id, call.id]))
          .digest('hex'),
        prompt: call.args.prompt,
        sizeId: call.args.sizeId,
        seed: call.args.seed,
      })
    );
    return {
      batch: ImageBatchSchema.parse({ id, images }),
      input: images[index % 16]!,
      first: index % 16 === 0,
    };
  }, context);
}
export function imageTools(
  binding: {
    runId: string;
    gatewayUrl: string;
    gatewayToken: string;
    cancelOnAbort: () => boolean;
  },
  fetcher: typeof fetch = fetch
): ToolRegistration[] {
  const headers = {
    'content-type': 'application/json',
    authorization: 'Bearer ' + binding.gatewayToken,
  };
  return [
    defineTool({
      name: 'generate_image',
      description:
        'Generate an original image with local H3 INT8. A prompt is enough. The tool names the files and returns path (source PNG), webPath (compressed WebP for use in apps), and previewPath (WebP for read), plus the inline preview. Inspect the preview directly and use webPath as the asset. For multiple independent images, issue all calls together in one assistant turn so they can render in one GPU batch. Describe each complete image in its prompt. This tool generates new images with an opaque background.',
      parameters: obj(
        {
          prompt: str({ minLength: 1, maxLength: 12000 }),
          directory: opt(
            str({
              minLength: 1,
              maxLength: 512,
              description:
                'Output folder inside the project, for example public/assets. Defaults to assets/generated relative to the working directory.',
            })
          ),
          sizeId: opt(
            str({
              pattern: '^(landscape-(quick|4|8)|portrait-(quick|4|8)|square-4)$',
              description: 'Defaults to landscape-4 (2496×1664); quick is 1.5 MP, 8 is about 8 MP.',
            })
          ),
          seed: opt(int({ minimum: -1, maximum: 4294967295 })),
        },
        { open: true }
      ), // Execution also accepts the old path field when replaying saved calls.
      executionMode: 'sequential',
      replay: 'safe',
      async execute(rawArgs, api, context) {
        if (!api.env) throw new Error('Sandbox unavailable.');
        assertMayStartWork();
        const args = imageCall.parse(rawArgs);
        const location = imageLocation(api.env.cwd, args);
        let key = createHash('sha256')
          .update(JSON.stringify([binding.runId, api.taskId]))
          .digest('hex');
        let input = ImageInputSchema.parse({
          key,
          prompt: args.prompt,
          sizeId: args.sizeId,
          seed: args.seed,
        });
        let id = createHash('sha256').update(key).digest('hex').slice(0, 32);
        const signal = context.abortSignal ?? AbortSignal.timeout(35 * 60_000);
        let endpoint = '/v1/image-jobs/' + id;
        const request = async (route: string, method = 'GET', body?: unknown) => {
          const result = await fetcher(new URL(route, binding.gatewayUrl), {
            method,
            headers,
            redirect: 'error',
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
          });
          if (!result.ok) {
            await result.body?.cancel();
            throw Object.assign(new Error(`Image gateway request failed (${result.status}).`), {
              status: result.status,
            });
          }
          return result;
        };
        const cutoff = Date.now() + 35 * 60_000;
        let submitted = false,
          phase = '';
        let batch: z.infer<typeof ImageBatchSchema> | undefined;
        let roundBatch: z.infer<typeof ImageBatchSchema> | undefined;
        try {
          const round = await imageRound(api, binding.runId, context);
          if (round) {
            roundBatch = round.batch;
            const probe = async (route: string) => {
              while (Date.now() < cutoff) {
                try {
                  return await request(route);
                } catch (error) {
                  const status = (error as { status?: number }).status;
                  if (status === 404) return undefined;
                  if (signal.aborted || (status !== undefined && status < 500)) throw error;
                  await delay(1500, undefined, { signal });
                }
              }
              throw new Error('Image tool processing deadline exceeded.');
            };
            const existing = await probe('/v1/image-batches/' + round.batch.id);
            if (existing) {
              const fingerprint = z
                .object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
                .parse(await existing.json());
              if (fingerprint.fingerprint !== imageBatchFingerprint(round.batch))
                throw new Error('Image batch parameters changed.');
              batch = round.batch;
              submitted = true;
            } else if (round.first) {
              // A task interrupted under an older release keeps its old job.
              const legacy = await probe(endpoint);
              if (legacy) await legacy.body?.cancel();
              else batch = round.batch;
            }
            if (batch) {
              input = round.input;
              key = input.key;
              id = createHash('sha256').update(key).digest('hex').slice(0, 32);
              endpoint = '/v1/image-jobs/' + id;
              if (!submitted)
                api.output(`Generating ${batch.images.length} images in one GPU batch.\n`);
            }
          }
          // Repeating the POST is safe even if its accepted response was lost.
          while (!submitted && Date.now() < cutoff) {
            signal.throwIfAborted();
            try {
              await (
                await request(
                  batch ? '/v1/image-batches' : '/v1/image-jobs',
                  'POST',
                  batch ?? input
                )
              ).body?.cancel();
              submitted = true;
            } catch (error) {
              if (
                signal.aborted ||
                (typeof error === 'object' &&
                  error !== null &&
                  'status' in error &&
                  Number(error.status) < 500)
              )
                throw error;
              await delay(1500, undefined, { signal });
            }
          }
          let result;
          while (Date.now() < cutoff) {
            signal.throwIfAborted();
            try {
              result = ImageStatusSchema.parse(await (await request(endpoint)).json());
            } catch (error) {
              if (
                signal.aborted ||
                (typeof error === 'object' &&
                  error !== null &&
                  'status' in error &&
                  Number(error.status) < 500)
              )
                throw error;
              await delay(1500, undefined, { signal });
              continue;
            }
            if (result.phase !== phase) {
              phase = result.phase;
              api.output(phase + '\n');
            }
            if (result.status === 'completed') break;
            if (result.status === 'failed' || result.status === 'cancelled')
              throw new Error(result.error ?? result.phase);
            await delay(1000, undefined, { signal });
          }
          if (result?.status !== 'completed')
            throw new Error('Image tool processing deadline exceeded.');
          const download = async (suffix: string, limit: number) => {
            const response = await request(endpoint + suffix);
            if (!response.body) throw new Error('Empty image artifact.');
            const parts: Uint8Array[] = [];
            let bytes = 0;
            for await (const part of response.body) {
              bytes += part.byteLength;
              if (bytes > limit) throw new Error('Image artifact exceeds its budget.');
              parts.push(part);
            }
            return Buffer.concat(parts);
          };
          const original = await download('/original', 64 * 1024 * 1024);
          if (original.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
            throw new Error('Image artifact is not PNG.');
          const assets = await createImageAssets(original);
          const destination =
            location.legacyPath ?? posix.join(location.directory, `image-${id}.png`);
          const previewPath = destination.slice(0, -4) + '.preview.webp';
          const webPath = destination.slice(0, -4) + '.webp';
          getOrThrow(
            await api.env.exec(
              [
                '/usr/bin/node',
                '-e',
                "require('node:fs').mkdirSync(process.argv[1],{recursive:true})",
                location.directory,
              ],
              { timeout: 10 },
              context
            )
          );
          for (const [path, data] of [
            [destination, original],
            [previewPath, assets.preview.data],
            [webPath, assets.web.data],
          ] as const) {
            const temporary = path + '.b70-' + id + '.tmp';
            getOrThrow(await api.env.writeFile(temporary, data, context));
            // Link without overwrite, including races between two agent tools.
            const install = getOrThrow(
              await api.env.exec(
                [
                  '/usr/bin/node',
                  '-e',
                  "const f=require('node:fs'),c=require('node:crypto'),[s,d]=process.argv.slice(1);try{f.linkSync(s,d)}catch(e){if(e.code!=='EEXIST'||!c.timingSafeEqual(c.createHash('sha256').update(f.readFileSync(s)).digest(),c.createHash('sha256').update(f.readFileSync(d)).digest()))throw Error('Image destination already contains a different file')}finally{f.unlinkSync(s)}",
                  temporary,
                  path,
                ],
                { timeout: 10 },
                context
              )
            );
            if (install.exitCode !== 0)
              throw new Error(
                'Image files could not be saved without overwriting existing files. Choose a different directory.'
              );
          }
          return {
            output: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  path: destination,
                  previewPath,
                  preview: {
                    width: assets.preview.width,
                    height: assets.preview.height,
                    bytes: assets.preview.bytes,
                  },
                  webPath,
                  web: {
                    width: assets.web.width,
                    height: assets.web.height,
                    bytes: assets.web.bytes,
                    quality: 82,
                  },
                  jobId: id,
                  seed: result.seed,
                  sizeId: result.sizeId,
                  model: 'MiniMax H3 Image INT8',
                  note: 'Use webPath in the app. Inspect the inline preview or read previewPath later.',
                }),
              },
              {
                type: 'image' as const,
                mimeType: 'image/webp',
                data: assets.preview.data.toString('base64'),
              },
            ],
          };
        } catch (error) {
          if ((signal.aborted && binding.cancelOnAbort()) || Date.now() >= cutoff) {
            // Abort may arrive while probing an existing batch, before it was
            // selected locally. Recover its committed keys solely for cleanup.
            if (!roundBatch) {
              try {
                roundBatch = (await imageRound(api, binding.runId, BACKGROUND_CONTEXT))?.batch;
              } catch {
                /* A closed Harness may no longer permit a state read. */
              }
            }
            if (roundBatch) {
              for (let attempt = 0; attempt < 3; attempt++) {
                try {
                  const response = await fetcher(
                    new URL('/v1/image-batches/cancel', binding.gatewayUrl),
                    {
                      method: 'POST',
                      headers,
                      body: JSON.stringify(roundBatch),
                      redirect: 'error',
                      signal: AbortSignal.timeout(8000),
                    }
                  );
                  await response.body?.cancel();
                  if (response.ok) break;
                } catch {
                  /* A lost cancellation response is safe to repeat. */
                }
              }
            }
            const members = [
              ...new Map(
                [input, ...(roundBatch?.images ?? [])].map((member) => [member.key, member])
              ).values(),
            ];
            await Promise.all(
              members.map((member) =>
                fetcher(
                  new URL(
                    '/v1/image-jobs/' +
                      createHash('sha256').update(member.key).digest('hex').slice(0, 32),
                    binding.gatewayUrl
                  ),
                  {
                    method: 'DELETE',
                    headers: { ...headers, 'x-image-job-key': member.key },
                    body: '{}',
                    redirect: 'error',
                    signal: AbortSignal.timeout(8000),
                  }
                )
                  .then((response) => response.body?.cancel())
                  .catch(() => undefined)
              )
            );
          }
          throw error;
        }
      },
    }),
  ];
}
