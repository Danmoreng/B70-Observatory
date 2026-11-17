import { DesktopSession, type DesktopOperation } from './desktop.js';

type ExtensionApi = {
  registerTool(tool: Record<string, unknown>): void;
  on?(event: string, handler: (event: Record<string, unknown>) => void | Promise<void>): unknown;
};
const text = (maxLength = 4096) => ({ type: 'string', minLength: 1, maxLength });
const number = (minimum: number, maximum: number) => ({ type: 'integer', minimum, maximum });
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

/** Same registrations used by Durable; no new model provider or external service. */
export default function registerDesktopTools(
  pi: ExtensionApi,
  enabled = process.env.B70_DESKTOP_ROOT === '/runtime/desktop',
  session = new DesktopSession()
): void {
  if (!enabled) return;
  pi.on?.('session_shutdown', async () => session.close());
  const add = (
    operation: DesktopOperation,
    description: string,
    parameters: Record<string, unknown>
  ) => {
    pi.registerTool({
      name: `desktop_${operation}`,
      label: `Desktop ${operation}`,
      description,
      parameters,
      executionMode: 'sequential',
      execute: (_id: string, args: unknown, signal?: AbortSignal) =>
        session.call(operation, args, signal),
    });
  };
  add(
    'start',
    'Start your own isolated X11 test desktop (default 1280×800). Returns its screenshot and snapshot identifier. Supports native apps independently of their GUI toolkit. After environment restart the desktop is new.',
    object({ width: number(640, 1920), height: number(480, 1200) })
  );
  add(
    'launch',
    'Launch a compiled application in your test desktop. command is an argv array, e.g. ["./build/app"]. cwd must be in /workspace; default /workspace. Build first with bash. Returns a desktop screenshot; call desktop_observe if the app is still loading.',
    object(
      { command: { type: 'array', items: text(), minItems: 1, maxItems: 32 }, cwd: text(1024) },
      ['command']
    )
  );
  add(
    'observe',
    'Inspect your test desktop: window list, focus, pointer and screenshot. Returns a new snapshot identifier. Use it before input and to inspect uncertain outcomes. Coordinates refer to the full screenshot, not to a window crop.',
    object({})
  );
  add(
    'action',
    'Perform one native desktop input using the snapshot identifier from the latest screenshot. Returns a new screenshot. Supported actions: click/double_click (x,y,button 1–3), type(text, max 512), paste(text, max 4096 via PRIVATE clipboard and Ctrl+V; prefer for Unicode/long text when the app supports paste), press(key e.g. ctrl+s,Return), scroll(x,y,direction,amount), drag(x,y,toX,toY), focus/close(windowId from observation). Never blindly retry an uncertain action.',
    object(
      {
        action: {
          type: 'string',
          enum: [
            'click',
            'double_click',
            'type',
            'paste',
            'press',
            'scroll',
            'drag',
            'focus',
            'close',
          ],
        },
        snapshot: text(64),
        x: number(0, 1919),
        y: number(0, 1199),
        toX: number(0, 1919),
        toY: number(0, 1199),
        button: number(1, 3),
        text: text(),
        key: text(100),
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: number(1, 20),
        windowId: text(32),
      },
      ['action', 'snapshot']
    )
  );
  add(
    'stop',
    'Stop your test desktop and its applications. Save application data first. Code files in /workspace remain available.',
    object({})
  );
}
