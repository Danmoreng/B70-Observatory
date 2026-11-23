import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  EngineUnitStateSchema,
  type EngineRuntimes,
  type EngineServiceAction,
  type EngineServiceStatus,
} from '@observatory/contracts';
import type { GpuScheduler } from './gpu-scheduler.js';

const execFileAsync = promisify(execFile);
const UNIT = 'b70-qwen38-vllm.service';
const IMAGE_UNIT = 'diffusion-desk-comfyui.service';
const SYSTEMCTL = '/usr/bin/systemctl';

export interface EngineServiceController {
  status(): Promise<EngineServiceStatus>;
  action(action: EngineServiceAction): Promise<EngineServiceStatus>;
  runtimes(): Promise<Pick<EngineRuntimes, 'text' | 'image'>>;
}

function unitProperties(output: string) {
  const properties = new Map<string, string>();
  for (const line of output.trim().split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) properties.set(line.slice(0, at), line.slice(at + 1));
  }
  return properties;
}

function unitState(properties: Map<string, string>) {
  const state = EngineUnitStateSchema.safeParse(properties.get('ActiveState'));
  return properties.get('LoadState') === 'loaded' && state.success ? state.data : 'unknown';
}

function runtime(
  properties: Map<string, string> | undefined,
  nowMicros: number
): EngineRuntimes['text'] {
  if (!properties) return { state: 'unknown' };
  const state = unitState(properties);
  // systemd and libuv both use CLOCK_MONOTONIC on Linux.
  const started = Number(properties.get('ActiveEnterTimestampMonotonic'));
  if (state === 'active' && Number.isSafeInteger(started) && started > 0 && started <= nowMicros) {
    return { state, uptimeSeconds: Math.floor((nowMicros - started) / 1_000_000) };
  }
  return { state };
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
  runtimeActionsAllowed: () => boolean = () => true,
  selectedUnit: () => string = () => UNIT,
  autostartUnit: () => string = selectedUnit
): EngineServiceController {
  let busy = false;
  const status = async (): Promise<EngineServiceStatus> => {
    const output = await run([
      'show',
      selectedUnit(),
      '--no-pager',
      '--property=LoadState,ActiveState,UnitFileState',
    ]);
    const properties = unitProperties(output);
    if (properties.get('LoadState') !== 'loaded')
      throw new Error(`${selectedUnit()} is not loaded.`);
    const activeState = unitState(properties);
    const unitFileState =
      autostartUnit() === selectedUnit()
        ? properties.get('UnitFileState')
        : (await run(['show', autostartUnit(), '--property=UnitFileState', '--value'])).trim();
    if (unitFileState === undefined) throw new Error('Autostart state is unavailable.');
    return {
      activeState,
      autostart: unitFileState === 'enabled',
      ...(gpu ? { gpu: gpu.status() } : {}),
    };
  };
  return {
    status,
    async runtimes() {
      const output = await run([
        'show',
        selectedUnit(),
        IMAGE_UNIT,
        '--no-pager',
        '--property=Id,LoadState,ActiveState,ActiveEnterTimestampMonotonic',
      ]);
      const units = output
        .trim()
        .split(/\n\s*\n/)
        .map(unitProperties);
      const nowMicros = Number(process.hrtime.bigint() / 1000n);
      return {
        text: runtime(
          units.find((p) => p.get('Id') === selectedUnit()),
          nowMicros
        ),
        image: runtime(
          units.find((p) => p.get('Id') === IMAGE_UNIT),
          nowMicros
        ),
      };
    },
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
              ? [action, ...(gpu ? [] : ['--no-block']), selectedUnit()]
              : [action, autostartUnit()]
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
