import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { berlinMinutes } from '../durable/working-hours.js';
import { TextEngineUnchanged } from './gpu-scheduler.js';
import { type TextRecipe } from '@observatory/contracts';
import { z } from 'zod';

const MemorySnapshot = z.object({
  system: z.object({ ram_free: z.number().finite().nonnegative() }),
  devices: z.array(z.object({ vram_free: z.number().finite().nonnegative() })).min(1),
});

const exec = promisify(execFile);
export const textUnits: Record<TextRecipe, string> = {
  'Qwen3.8-27B': 'b70-qwen38-vllm.service',
  'inkling2-mini-exl3-b70': 'b70-inkling2-vllm.service',
};
const TEXT = 'b70-qwen38-vllm.service',
  IMAGE = 'diffusion-desk-comfyui.service';
interface SwitchIO {
  run: (args: string[]) => Promise<string>;
  fetch: typeof fetch;
  wait: (ms: number) => Promise<unknown>;
  now: () => number;
}
export function createGpuSwitch(
  textOrigin: string,
  comfyOrigin: string,
  io: Partial<SwitchIO> = {},
  selectedUnit: () => string = () => TEXT
) {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('GPU switching requires a POSIX user service manager.');
  const run =
    io.run ??
    (async (args: string[]) => {
      const result = await exec('/usr/bin/systemctl', ['--user', ...args], {
        timeout: 90000,
        maxBuffer: 16384,
        env: {
          ...process.env,
          XDG_RUNTIME_DIR: `/run/user/${uid}`,
          DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
        },
      });
      return result.stdout;
    });
  const command = async (action: 'start' | 'stop', unit: string) => {
    await run([action, unit]);
  };
  const fetcher = io.fetch ?? fetch,
    wait = io.wait ?? delay,
    now = io.now ?? Date.now;
  const get = async (origin: string, route: string) => {
    const response = await fetcher(new URL(route, origin), {
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Engine not ready.');
    }
    return response;
  };
  const ready = async (origin: string, route: string, seconds: number) => {
    const deadline = now() + seconds * 1000;
    while (now() < deadline && berlinMinutes() < 22 * 60 + 55) {
      try {
        const response = await get(origin, route);
        await response.body?.cancel();
        return;
      } catch {
        await wait(1000);
      }
    }
    throw new Error('Engine readiness deadline exceeded.');
  };
  const assertOwnership = async () => {
    const legacy = await run([
      'show',
      'diffusion-desk-web.service',
      '--property=ActiveState',
      '--value',
    ]);
    if (['active', 'activating'].includes(legacy.trim()))
      throw new TextEngineUnchanged(
        'Standalone Diffusion Desk generation is active. An operator must transfer exclusive image-engine ownership to this gateway before enabling agent image tools.'
      );
  };
  const assertTextIdle = async (required = false) => {
    try {
      const until = now() + 30000;
      while (true) {
        const metrics = await (await get(textOrigin, '/metrics')).text();
        const counters = [
          ...metrics.matchAll(
            /^vllm:num_requests_(running|waiting)(?:\{[^\n]*\})?\s+([\d.eE+-]+)/gm
          ),
        ];
        const names = new Set(counters.map((m) => m[1]));
        if (
          names.has('running') &&
          names.has('waiting') &&
          counters.every((m) => Number(m[2]) === 0)
        )
          break;
        if (now() >= until) throw new Error('Text engine still has running or untracked requests.');
        await wait(500);
      }
    } catch (error) {
      if (required) throw error;
      const health = await get(textOrigin, '/health').catch(() => undefined);
      if (health) {
        await health.body?.cancel();
        throw error;
      }
    }
  };
  const checkModel = async (model: TextRecipe) => {
    await ready(textOrigin, '/health', 660);
    const list = (await (await get(textOrigin, '/v1/models')).json()) as {
      data?: Array<{ id: string }>;
    };
    if (!list.data?.some((entry) => entry.id === model))
      throw new Error('Loaded engine returned a different model ID.');
  };
  const restoreText = async (previous: TextRecipe, next: TextRecipe, wasActive: boolean) => {
    await command('stop', textUnits[next]);
    if (wasActive && berlinMinutes() < 22 * 60 + 45) {
      await command('start', textUnits[previous]);
      await checkModel(previous);
    }
  };
  return {
    assertOwnership,
    restoreText,
    async selectText(
      previous: TextRecipe,
      next: TextRecipe,
      commit: () => void,
      journal?: {
        begin(wasActive: boolean): void;
        rollback(): void;
      }
    ) {
      if (berlinMinutes() >= 22 * 60 + 45) throw new Error('Daily shutdown: no new model load.');
      await assertOwnership();
      const unitState = async (unit: string) =>
        (await run(['show', unit, '--property=ActiveState', '--value'])).trim();
      const imageState = await unitState(IMAGE);
      if (imageState !== 'inactive' && imageState !== 'failed')
        throw new Error('Finish image work and return to text mode before switching models.');
      const oldUnit = textUnits[previous],
        nextUnit = textUnits[next];
      if ((await run(['show', nextUnit, '--property=LoadState', '--value'])).trim() !== 'loaded')
        throw new Error('Selected text service is not installed.');
      const previousState = await unitState(oldUnit);
      if (!['active', 'inactive', 'failed'].includes(previousState))
        throw new Error('Previous text service is changing state.');
      const wasActive = previousState === 'active';
      if (wasActive) {
        await checkModel(previous);
        await assertTextIdle(true);
      } else {
        const endpoint = await fetcher(new URL('/health', textOrigin), {
          signal: AbortSignal.timeout(3000),
        }).catch(() => undefined);
        if (endpoint) {
          await endpoint.body?.cancel();
          throw new Error('Another service owns the text endpoint.');
        }
      }
      journal?.begin(wasActive);
      try {
        await command('stop', oldUnit);
        await command('start', nextUnit);
        await checkModel(next);
        commit();
      } catch (error) {
        await restoreText(previous, next, wasActive);
        journal?.rollback();
        throw error;
      }
    },
    async image() {
      let textStopRequested = false;
      try {
        if (berlinMinutes() >= 22 * 60 + 45)
          throw new Error('Daily shutdown: no new image-engine start after 22:45.');
        await assertOwnership();
        // The gateway has drained all of its streams. Also verify the engine's
        // own counters before stopping it; direct/bypassing callers block swap.
        await assertTextIdle();
        textStopRequested = true;
        await command('stop', selectedUnit());
        let existing = false;
        try {
          await (await get(comfyOrigin, '/queue')).body?.cancel();
          existing = true;
        } catch {
          /* start on demand */
        }
        if (!existing) {
          await command('start', IMAGE);
          await ready(comfyOrigin, '/queue', 100);
          const stats = MemorySnapshot.parse(
            await (await get(comfyOrigin, '/system_stats')).json()
          );
          if (
            !stats.devices?.length ||
            stats.devices.some((d) => d.vram_free < 28 * 1024 ** 3) ||
            (stats.system?.ram_free ?? 0) < 17 * 1024 ** 3
          ) {
            await command('stop', IMAGE);
            throw new Error('GPU or host RAM was not released sufficiently for image generation.');
          }
        }
      } catch (error) {
        if (!textStopRequested)
          throw new TextEngineUnchanged(
            error instanceof Error ? error.message : 'GPU switch preflight failed.'
          );
        throw error;
      }
    },
    async text() {
      await assertOwnership();
      try {
        const queue = (await (await get(comfyOrigin, '/queue')).json()) as {
          queue_running: unknown[];
          queue_pending: unknown[];
        };
        if (queue.queue_running.length || queue.queue_pending.length)
          throw new Error(
            'Image engine still has work. Text restoration blocked to avoid interrupting it.'
          );
      } catch (error) {
        const health = await get(comfyOrigin, '/system_stats').catch(() => undefined);
        if (health) {
          await health.body?.cancel();
          throw error;
        }
      }
      await command('stop', IMAGE);
      if (berlinMinutes() >= 22 * 60 + 55)
        throw new Error('Daily shutdown: text engine was not restarted.');
      await command('start', selectedUnit());
      await ready(textOrigin, '/health', 660);
    },
  };
}
