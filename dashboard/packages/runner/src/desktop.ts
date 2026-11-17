/** Agent Workspace Linux adapter. Runs ONLY inside the existing job sandbox. */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { MAX_IMAGE_BYTES, validateAgentImage } from './image-validation.js';

const ROOT = '/runtime/desktop';
const STATE = '/tmp/b70-desktop';
const ID = 'b70';
type Content = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string };
export type DesktopResult = { content: Content[]; isError?: boolean };
type Json = Record<string, unknown>;
export type DesktopOperation = 'start' | 'launch' | 'observe' | 'action' | 'stop';
export type DesktopBackend = (args: string[], signal?: AbortSignal) => Promise<Json>;

function record(value: unknown): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Expected an argument object.');
  return value as Json;
}
function fields(args: Json, allowed: string[]) {
  if (Object.keys(args).some((key) => !allowed.includes(key))) throw new Error('Unknown argument.');
}
function string(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || !value.length || value.length > max || value.includes('\0'))
    throw new Error(`Invalid ${label}.`);
  return value;
}
function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${label} (${min}–${max}).`);
  return value;
}
function reason(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 500) : 'Desktop operation failed.';
}

/** Clean environment: never inherit host display, buses, agents or credentials. */
export function desktopEnvironment(): NodeJS.ProcessEnv {
  return {
    HOME: `${STATE}/home`,
    XDG_RUNTIME_DIR: `${STATE}/run`,
    XDG_CONFIG_HOME: `${STATE}/config`,
    XDG_CACHE_HOME: `${STATE}/cache`,
    XDG_DATA_DIRS: `${ROOT}/usr/share:/usr/share`,
    XDG_CONFIG_DIRS: `${ROOT}/etc/xdg`,
    PATH: `${ROOT}/bin:${ROOT}/usr/bin:/usr/bin:/bin`,
    LD_LIBRARY_PATH: `${ROOT}/usr/lib:/usr/lib`,
    LANG: 'C.UTF-8',
    LIBGL_ALWAYS_SOFTWARE: '1',
    GALLIUM_DRIVER: 'llvmpipe',
    LP_NUM_THREADS: '2',
    OMP_NUM_THREADS: '2',
    QT_X11_NO_MITSHM: '1',
  };
}

const execute: DesktopBackend = async (args, signal) => {
  for (const dir of ['home', 'run', 'config', 'cache'])
    await mkdir(`${STATE}/${dir}`, { recursive: true, mode: 0o700 });
  return await new Promise<Json>((accept, reject) => {
    execFile(
      `${ROOT}/bin/agent-workspace-linux`,
      ['workspace', args[0]!, '--id', ID, ...args.slice(1)],
      {
        env: desktopEnvironment(),
        cwd: '/workspace',
        timeout: 25_000,
        maxBuffer: 512 * 1024,
        killSignal: 'SIGKILL',
        ...(signal ? { signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(String(stderr || error.message).slice(0, 500)));
        try {
          const result = record(JSON.parse(stdout));
          if (result.ok === false)
            throw new Error(String(result.message ?? 'Backend refused operation.'));
          accept(result);
        } catch (failure) {
          reject(failure);
        }
      }
    );
  });
};

export class DesktopSession {
  private running = false;
  private width = 1280;
  private height = 800;
  private snapshot?: string;
  private windows = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private epoch = 0;
  get generation() {
    return this.epoch;
  }
  invalidateSnapshot() {
    this.snapshot = undefined;
  }

  constructor(
    private readonly backend: DesktopBackend = execute,
    private readonly readScreenshot: () => Promise<Buffer> = readDesktopFrame
  ) {}

  call(operation: DesktopOperation, input: unknown, signal?: AbortSignal): Promise<DesktopResult> {
    this.pending++;
    const task = this.queue
      .then(() => this.perform(operation, input, signal))
      .finally(() => {
        this.pending--;
      });
    this.queue = task.catch(() => undefined);
    return task;
  }

  /** Trusted browser controller attaches only to this private X11 display. */
  async prepareBrowser() {
    this.pending++;
    const task = this.queue
      .then(async () => {
        if (!this.running) {
          const result = await this.perform('start', {
            width: 1920,
            height: 1200,
          });
          if (result.isError || !this.running)
            throw new Error('Test desktop could not be started.');
        }
        const response = await this.backend(['env']);
        const variables = record(response.environment).variables;
        if (!Array.isArray(variables)) throw new Error('Desktop environment unavailable.');
        const values = Object.fromEntries(
          variables.map((item) => {
            const value = record(item);
            return [String(value.name), String(value.value)];
          })
        );
        if (
          !/^:(?:9[0-9]|1[0-7][0-9])$/.test(values.DISPLAY ?? '') ||
          !values.XAUTHORITY?.startsWith(STATE + '/') ||
          values.XAUTHORITY.split('/').includes('..')
        )
          throw new Error('Invalid private desktop identity.');
        return {
          env: {
            ...desktopEnvironment(),
            DISPLAY: values.DISPLAY,
            XAUTHORITY: values.XAUTHORITY,
          } as NodeJS.ProcessEnv,
          width: this.width,
          height: this.height,
          generation: this.epoch,
        };
      })
      .finally(() => {
        this.pending--;
      });
    this.queue = task.catch(() => undefined);
    return task;
  }

  /** Observer-only capture: skips busy input and never renews the agent's snapshot. */
  async viewerFrame(): Promise<DesktopResult> {
    if (!this.running || this.pending > 0) return { content: [] };
    this.pending++;
    const task = this.queue
      .then(async () => {
        const { png } = await this.capture(AbortSignal.timeout(5000));
        return {
          content: [
            {
              type: 'image' as const,
              mimeType: 'image/png' as const,
              data: png.toString('base64'),
            },
          ],
        };
      })
      .catch(() => ({ content: [] }))
      .finally(() => {
        this.pending--;
      });
    this.queue = task;
    return task;
  }

  async close(): Promise<void> {
    await this.call('stop', {}).catch(() => undefined);
  }

  private async perform(
    operation: DesktopOperation,
    input: unknown,
    signal?: AbortSignal
  ): Promise<DesktopResult> {
    let dispatched = false;
    try {
      signal?.throwIfAborted();
      const args = record(input);
      if (operation === 'stop') {
        fields(args, []);
        this.snapshot = undefined;
        dispatched = true;
        await this.backend(['stop', '--timeout-ms', '5000'], signal);
        this.running = false;
        this.epoch++;
        this.windows.clear();
        return {
          content: [{ type: 'text', text: 'Agent desktop stopped; its applications were closed.' }],
        };
      }
      if (operation === 'start') {
        fields(args, ['width', 'height']);
        const width = integer(args.width ?? 1280, 'width', 640, 1920);
        const height = integer(args.height ?? 800, 'height', 480, 1200);
        if (this.running && (width !== this.width || height !== this.height))
          throw new Error('Stop the desktop before changing its resolution.');
        this.snapshot = undefined;
        const wasRunning = this.running;
        dispatched = true;
        const started = await this.backend(
          [
            'start',
            '--ack-hidden-workspace',
            '--session',
            'x11',
            '--width',
            String(width),
            '--height',
            String(height),
            '--purpose',
            'B70 sandboxed GUI testing',
          ],
          signal
        );
        const status = record(started.status);
        if (status.width !== width || status.height !== height)
          throw new Error(
            'Desktop resolution differs from the requested resolution. Stop and restart it.'
          );
        this.width = width;
        this.height = height;
        this.running = true;
        if (!wasRunning) this.epoch++;
        return await this.preview('Agent desktop started.', signal);
      }
      if (!this.running)
        throw new Error(
          'No desktop in this environment. Call desktop_start first; after a restart the desktop is new.'
        );
      if (operation === 'observe') {
        fields(args, []);
        return await this.preview('Current agent desktop.', signal);
      }
      let command: string[];
      if (operation === 'launch') {
        fields(args, ['command', 'cwd']);
        if (!Array.isArray(args.command) || args.command.length < 1 || args.command.length > 32)
          throw new Error('command must be an argv array (1–32 items), without a shell wrapper.');
        const argv = args.command.map((value) => string(value, 'command argument', 4096));
        const cwd = string(args.cwd ?? '/workspace', 'cwd', 1024);
        const canonicalCwd = await realpath(cwd);
        if (canonicalCwd !== '/workspace' && !canonicalCwd.startsWith('/workspace/'))
          throw new Error('cwd must stay inside /workspace.');
        const executable = await realpath(
          isAbsolute(argv[0]!) ? argv[0]! : resolve(canonicalCwd, argv[0]!)
        );
        if (!executable.startsWith('/workspace/') && !executable.startsWith('/usr/bin/'))
          throw new Error('Launch an executable inside /workspace or /usr/bin.');
        command = ['launch', '--cwd', canonicalCwd, '--', executable, ...argv.slice(1)];
      } else {
        fields(args, [
          'action',
          'snapshot',
          'x',
          'y',
          'toX',
          'toY',
          'button',
          'text',
          'key',
          'direction',
          'amount',
          'windowId',
        ]);
        if (!this.snapshot || args.snapshot !== this.snapshot)
          throw new Error(
            'Missing or stale snapshot. Call desktop_observe and use its snapshot identifier and screenshot.'
          );
        const action = string(args.action, 'action', 32);
        const point = () => [
          String(integer(args.x, 'x', 0, this.width - 1)),
          String(integer(args.y, 'y', 0, this.height - 1)),
        ];
        const button = () => String(integer(args.button ?? 1, 'button', 1, 3));
        switch (action) {
          case 'click':
          case 'double_click':
            command = [
              'click',
              '--button',
              button(),
              '--count',
              action === 'double_click' ? '2' : '1',
              ...point(),
            ];
            break;
          case 'type':
            command = [
              'type',
              '--',
              string(args.text, 'text (max 512; use paste for longer text)', 512),
            ];
            break;
          case 'paste':
            command = ['paste', '--', string(args.text, 'text')];
            break;
          case 'press': {
            const key = string(args.key, 'key', 100);
            if (
              !/^(?:(?:ctrl|alt|shift|super)\+)*(?:[a-zA-Z0-9]|F(?:[1-9]|1[0-2])|Return|Tab|Escape|BackSpace|Delete|space|Home|End|Left|Right|Up|Down|Page_Up|Page_Down)$/.test(
                key
              )
            )
              throw new Error('Unsupported key chord. Example: ctrl+s, Return, Escape, Down.');
            command = ['key', key];
            break;
          }
          case 'scroll': {
            const direction = string(args.direction, 'direction', 8);
            if (!['up', 'down', 'left', 'right'].includes(direction))
              throw new Error('Invalid scroll direction.');
            command = [
              'scroll',
              '--amount',
              String(integer(args.amount ?? 3, 'amount', 1, 20)),
              ...point(),
              direction,
            ];
            break;
          }
          case 'drag':
            command = [
              'drag',
              '--button',
              button(),
              ...point(),
              String(integer(args.toX, 'toX', 0, this.width - 1)),
              String(integer(args.toY, 'toY', 0, this.height - 1)),
            ];
            break;
          case 'focus':
          case 'close': {
            const id = string(args.windowId, 'windowId', 32);
            if (!this.windows.has(id)) throw new Error('Window is not in the latest observation.');
            command = [action === 'focus' ? 'focus-window' : 'close-window', id];
            break;
          }
          default:
            throw new Error('Unknown desktop action.');
        }
      }
      this.snapshot = undefined;
      dispatched = true;
      const response = await this.backend(command, signal);
      return await this.preview(String(response.message ?? 'Desktop operation completed.'), signal);
    } catch (error) {
      if (dispatched) this.snapshot = undefined;
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Agent desktop: ${reason(error)}${dispatched ? '\nOperation outcome may be unknown. Inspect with desktop_observe before deciding whether to repeat an input or launch.' : ''}`,
          },
        ],
      };
    }
  }

  private async capture(signal?: AbortSignal) {
    const state = await this.backend(
      ['observe', '--screenshot', '--output', `${STATE}/frame.png`],
      signal
    );
    const shot = record(state.screenshot);
    if (shot.path !== `${STATE}/frame.png`) throw new Error('Unexpected screenshot path.');
    const png = await this.readScreenshot();
    const validation = validateAgentImage('image/png', png);
    if (!validation.ok) throw new Error(validation.reason);
    if (validation.width !== this.width || validation.height !== this.height)
      throw new Error('Screenshot size changed. Stop and restart the desktop.');
    return { state, png };
  }

  private async preview(message: string, signal?: AbortSignal): Promise<DesktopResult> {
    this.snapshot = undefined;
    try {
      const { state, png } = await this.capture(signal);
      const windows = Array.isArray(state.windows) ? state.windows.slice(0, 32) : [];
      this.windows = new Set(windows.map((window) => String(record(window).id)));
      this.snapshot = randomUUID();
      const observation = {
        snapshot: this.snapshot,
        width: this.width,
        height: this.height,
        windows,
        activeWindow: state.active_window,
        pointer: state.pointer,
      };
      return {
        content: [
          {
            type: 'text',
            text: `${message}\n${JSON.stringify(observation)}\nCoordinates are pixels in this full-desktop screenshot. The same image is shown in the dashboard.`,
          },
          { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
        ],
      };
    } catch (error) {
      // A failed observation must not turn a completed click/launch into an invitation to retry it.
      return {
        content: [
          {
            type: 'text',
            text: `${message}\nObservation failed: ${reason(error)}\nCall desktop_observe. Do not repeat a completed action solely because its screenshot failed.`,
          },
        ],
      };
    }
  }
}

async function readDesktopFrame(): Promise<Buffer> {
  const file = await open(
    `${STATE}/frame.png`,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES)
      throw new Error('Screenshot exceeds the image budget.');
    const buffer = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const chunk = await file.read(buffer, length, buffer.length - length, length);
      if (!chunk.bytesRead) break;
      length += chunk.bytesRead;
    }
    if (length > MAX_IMAGE_BYTES) throw new Error('Screenshot exceeds the image budget.');
    return buffer.subarray(0, length);
  } finally {
    await file.close();
  }
}
