import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EngineServiceAction, EngineServiceStatus } from '@observatory/contracts';
import type { GpuScheduler } from './gpu-scheduler.js';

const execFileAsync = promisify(execFile);
const UNIT = 'b70-qwen38-vllm.service';
const SYSTEMCTL = '/usr/bin/systemctl';

export interface EngineServiceController {
  status(): Promise<EngineServiceStatus>;
  action(action: EngineServiceAction): Promise<EngineServiceStatus>;
}

/** Address the dashboard user's own systemd manager, including from a system unit. */
export function createEngineServiceController(
  run: (args: string[]) => Promise<string> = async (args) => {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error('User service control requires a POSIX user.');
    const runtime = `/run/user/${uid}`;
    const { stdout } = await execFileAsync(SYSTEMCTL, ['--user', ...args], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
      env: {
        ...process.env,
        XDG_RUNTIME_DIR: runtime,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
      },
    });
    return stdout;
  },
  gpu?: GpuScheduler,
  runtimeActionsAllowed: () => boolean = () => true
): EngineServiceController {
  let busy = false;
  const status = async (): Promise<EngineServiceStatus> => {
    const output = await run([
      'show',
      UNIT,
      '--no-pager',
      '--property=LoadState,ActiveState,UnitFileState',
    ]);
    const properties = new Map(
      output
        .trim()
        .split('\n')
        .map((line) => {
          const split = line.indexOf('=');
          return [line.slice(0, split), line.slice(split + 1)] as const;
        })
    );
    if (properties.get('LoadState') !== 'loaded') throw new Error(`${UNIT} is not loaded.`);
    const rawState = properties.get('ActiveState');
    const activeState =
      rawState === 'active' ||
      rawState === 'activating' ||
      rawState === 'deactivating' ||
      rawState === 'inactive' ||
      rawState === 'failed'
        ? rawState
        : 'unknown';
    const unitFileState = properties.get('UnitFileState');
    if (unitFileState === undefined) throw new Error('Autostart state is unavailable.');
    return {
      activeState,
      autostart: unitFileState === 'enabled',
      ...(gpu ? { gpu: gpu.status() } : {}),
    };
  };
  return {
    status,
    async action(action) {
      if (!runtimeActionsAllowed()) throw new EngineServiceBusyError();
      if (busy) throw new EngineServiceBusyError();
      if (gpu?.busy) throw new EngineServiceBusyError();
      busy = true;
      try {
        // A missing or replaced unit must never be changed through this API.
        await status();
        const perform = async () =>
          run(
            action === 'start' || action === 'stop' || action === 'restart'
              ? [action, ...(gpu ? [] : ['--no-block']), UNIT]
              : [action, UNIT]
          );
        if (gpu) await gpu.manual(perform);
        else await perform();
        return await status();
      } finally {
        busy = false;
      }
    },
  };
}

export class EngineServiceBusyError extends Error {}
