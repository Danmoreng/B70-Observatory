import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { berlinMinutes } from '../durable/working-hours.js';
import { TextEngineUnchanged, type GpuSwitch } from './gpu-scheduler.js';
import { z } from 'zod';

const MemorySnapshot = z.object({
  system: z.object({ ram_free: z.number().finite().nonnegative() }),
  devices: z.array(z.object({ vram_free: z.number().finite().nonnegative() })).min(1),
});

const exec = promisify(execFile);
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
  io: Partial<SwitchIO> = {}
): GpuSwitch {
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
  const command = async (action: 'start' | 'stop', unit: typeof TEXT | typeof IMAGE) => {
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
  return {
    assertOwnership,
    async image() {
      let textStopRequested = false;
      try {
        if (berlinMinutes() >= 22 * 60 + 45)
          throw new Error('Daily shutdown: no new image-engine start after 22:45.');
        await assertOwnership();
        // The gateway has drained all of its streams. Also verify the engine's
        // own counters before stopping it; direct/bypassing callers block swap.
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
            if (now() >= until)
              throw new Error('Text engine still has running or untracked requests.');
            await wait(500);
          }
        } catch (error) {
          const health = await get(textOrigin, '/health').catch(() => undefined);
          if (health) {
            await health.body?.cancel();
            throw error;
          }
        }
        textStopRequested = true;
        await command('stop', TEXT);
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
      await command('start', TEXT);
      await ready(textOrigin, '/health', 660);
    },
  };
}
