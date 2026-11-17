import { setTimeout as delay } from 'node:timers/promises';
import { IMAGE_SIZES, type ImageInput } from './image-contract.js';
export const IMAGE_MONITOR_RESTART = 'Image monitor restarting';

export function imageGraph(id: string, input: ImageInput, seed: number) {
  const size = IMAGE_SIZES[input.sizeId],
    portrait = size.ratio === '2:3';
  return {
    '1': {
      class_type: 'UNETLoader',
      inputs: {
        unet_name: 'minimax_h3_image_pruned_int8_convrot.safetensors',
        weight_dtype: 'default',
      },
    },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_image_vae_fp16.safetensors' } },
    '4': {
      class_type: 'MiniMaxH3XImageEncodeLowRAM',
      inputs: {
        clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
        prompt: input.prompt,
        use_cache: true,
      },
    },
    '10': {
      class_type: 'MiniMaxH3XImageSize',
      inputs: { aspect_ratio: size.ratio, megapixels: size.preset },
    },
    '7': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        positive: ['4', 0],
        negative: ['4', 1],
        latent_image: ['10', 0],
        seed,
        steps: 6,
        cfg: 1,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1,
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
    '9': {
      class_type: 'SaveImage',
      inputs: { images: ['8', 0], filename_prefix: `DiffusionDesk/${id}-native` },
    },
    '11': {
      class_type: 'ImageScale',
      inputs: {
        image: ['8', 0],
        upscale_method: 'lanczos',
        width: portrait ? 1024 : 1536,
        height: portrait || size.ratio === '1:1' ? 1536 : 1024,
        crop: 'disabled',
      },
    },
    '12': {
      class_type: 'SaveImage',
      inputs: { images: ['11', 0], filename_prefix: `DiffusionDesk/${id}-1536` },
    },
  };
}
interface Queue {
  queue_running: Array<[number, string, Record<string, { inputs?: { filename_prefix?: string } }>]>;
  queue_pending: Queue['queue_running'];
}
interface History {
  status: { status_str: string };
  outputs?: Record<
    string,
    { images?: Array<{ filename: string; subfolder: string; type: string }> }
  >;
  prompt?: Queue['queue_running'][number];
}
export interface RenderTask {
  id: string;
  input: ImageInput;
  seed: number;
  submitted: boolean;
  promptId?: string;
  submittedAs: (id: string | undefined) => void;
  progress: (phase: string, step?: number, steps?: number) => void;
}
export class ComfyImages {
  constructor(
    readonly origin: string,
    private readonly fetcher: typeof fetch = fetch
  ) {}
  async api<T>(route: string, data?: unknown): Promise<T> {
    const response = await this.fetcher(new URL(route, this.origin), {
      method: data === undefined ? 'GET' : 'POST',
      redirect: 'error',
      headers: data === undefined ? {} : { 'content-type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Image engine request failed (${response.status}).`);
    }
    const body = await response.text();
    if (body.length > 16 * 1024 * 1024) throw new Error('Image engine response too large.');
    return JSON.parse(body) as T;
  }
  async render(
    task: RenderTask,
    signal: AbortSignal
  ): Promise<{ original: Buffer; preview: Buffer }> {
    const deadline = Date.now() + 20 * 60_000;
    const matches = (item: Queue['queue_running'][number]) =>
      item?.[2]?.['9']?.inputs?.filename_prefix === `DiffusionDesk/${task.id}-native`;
    let promptId = task.promptId;
    let socket: WebSocket | undefined;
    let progressActive = true;
    let livePhase = '',
      liveStep: number | undefined,
      liveSteps: number | undefined;
    try {
      const url = new URL('/ws', this.origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('clientId', 'b70-image-' + task.id);
      socket = new WebSocket(url);
      socket.addEventListener('error', () => {}); // Polling remains authoritative on disconnect.
      socket.addEventListener('message', (event) => {
        if (!progressActive || typeof event.data !== 'string' || event.data.length > 16384) return;
        try {
          const message = JSON.parse(event.data) as {
            type?: string;
            data?: { prompt_id?: string; node?: string; value?: number; max?: number };
          };
          const data = message.data;
          if (!data || data.prompt_id !== promptId) return;
          if (message.type === 'executing' && data.node) {
            livePhase =
              (
                {
                  '1': 'Loading INT8 model',
                  '3': 'Loading image decoder',
                  '4': 'Encoding prompt',
                  '7': 'Generating image',
                  '8': 'Decoding image',
                  '9': 'Saving original',
                  '11': 'Creating preview',
                  '12': 'Saving preview',
                } as Record<string, string>
              )[data.node] ?? 'Processing image';
            liveStep = undefined;
            liveSteps = undefined;
          } else if (
            message.type === 'progress' &&
            Number.isInteger(data.value) &&
            Number.isInteger(data.max) &&
            data.value! >= 0 &&
            data.value! <= data.max! &&
            data.max! > 0 &&
            data.max! <= 10000
          ) {
            livePhase = 'Generating image';
            liveStep = data.value;
            liveSteps = data.max;
          } else return;
          task.progress(livePhase, liveStep, liveSteps);
        } catch {
          /* Ignore malformed diagnostics, never affect the render. */
        }
      });
    } catch {
      /* Progress stream is optional. */
    }
    try {
      if (!promptId && task.submitted) {
        const queue = await this.api<Queue>('/queue');
        promptId = [...queue.queue_running, ...queue.queue_pending].find(matches)?.[1];
        if (!promptId) {
          const history = await this.api<Record<string, History>>('/history?max_items=200');
          promptId = Object.entries(history).find(([, h]) => h.prompt && matches(h.prompt))?.[0];
        }
        if (!promptId)
          throw new Error(
            'Interrupted image submission could not be reconciled. No duplicate was generated.'
          );
        task.submittedAs(promptId);
      }
      if (!promptId) {
        const queue = await this.api<Queue>('/queue');
        if (queue.queue_running.length || queue.queue_pending.length)
          throw new Error('Image engine has work outside the shared queue. Wait for it to finish.');
        signal.throwIfAborted();
        // Persist intent before sending: an uncertain response must be reconciled.
        task.submittedAs(undefined);
        const result = await this.api<{ prompt_id: string }>('/prompt', {
          prompt: imageGraph(task.id, task.input, task.seed),
          client_id: 'b70-image-' + task.id,
        });
        if (typeof result.prompt_id !== 'string')
          throw new Error('Image engine returned no prompt ID.');
        promptId = result.prompt_id;
        task.submittedAs(promptId);
      }
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        const result = (
          await this.api<Record<string, History>>('/history/' + encodeURIComponent(promptId))
        )[promptId];
        if (result) {
          if (result.status.status_str !== 'success')
            throw new Error('Image generation failed. Saved request retained.');
          const native = result.outputs?.['9']?.images?.[0],
            preview = result.outputs?.['12']?.images?.[0];
          for (const file of [native, preview])
            if (
              !file ||
              file.type !== 'output' ||
              file.subfolder !== 'DiffusionDesk' ||
              !file.filename.startsWith(task.id + '-') ||
              !/^[A-Za-z0-9_.-]+\.png$/.test(file.filename)
            )
              throw new Error('Image engine returned an invalid artifact.');
          const download = async (file: NonNullable<typeof native>, small: boolean) => {
            const query = new URLSearchParams({
              filename: file.filename,
              subfolder: file.subfolder,
              type: 'output',
              ...(small ? { preview: 'webp;75', channel: 'rgb' } : {}),
            });
            const response = await this.fetcher(new URL('/view?' + query, this.origin), {
              redirect: 'error',
              signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
            });
            if (!response.ok || !response.body) throw new Error('Generated image download failed.');
            const parts: Uint8Array[] = [];
            let bytes = 0;
            for await (const part of response.body) {
              bytes += part.byteLength;
              if (bytes > (small ? 2 : 64) * 1024 * 1024) {
                await response.body.cancel().catch(() => {});
                throw new Error('Generated image exceeds artifact budget.');
              }
              parts.push(part);
            }
            return Buffer.concat(parts);
          };
          task.progress('Saving image');
          return {
            original: await download(native!, false),
            preview: await download(preview!, true),
          };
        }
        const queue = await this.api<Queue>('/queue');
        if (![...queue.queue_running, ...queue.queue_pending].some((row) => row[1] === promptId))
          throw new Error('Image engine lost the saved request. No duplicate was generated.');
        if (queue.queue_running.some((row) => row[1] === promptId))
          task.progress(livePhase || 'Generating image', liveStep, liveSteps);
        else task.progress('Waiting in image queue');
        await delay(1000, undefined, { signal });
      }
      throw new Error('Image generation exceeded the 20-minute budget.');
    } catch (error) {
      if (signal.reason === IMAGE_MONITOR_RESTART) throw error;
      if (!promptId) {
        const queue = await this.api<Queue>('/queue').catch(() => undefined);
        promptId = [...(queue?.queue_running ?? []), ...(queue?.queue_pending ?? [])].find(
          matches
        )?.[1];
        if (promptId) task.submittedAs(promptId);
      }
      if (promptId) {
        const queue = await this.api<Queue>('/queue').catch(() => undefined);
        if (queue?.queue_pending.some((row) => row[1] === promptId))
          await this.api('/queue', { delete: [promptId] });
        if (queue?.queue_running.some((row) => row[1] === promptId)) {
          await this.api('/interrupt', { prompt_id: promptId });
          // Do not release GPU ownership while cancelled kernels still run.
          for (let i = 0; i < 30; i++) {
            const q = await this.api<Queue>('/queue');
            if (!q.queue_running.some((row) => row[1] === promptId)) break;
            await delay(500);
          }
        }
      }
      throw error;
    } finally {
      progressActive = false;
      socket?.close();
    }
  }
}
