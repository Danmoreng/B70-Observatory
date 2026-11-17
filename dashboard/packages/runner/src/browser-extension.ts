/**
 * Immutable cockpit extension mounted by the trusted launcher (only when the
 * operator configured a browser runtime root). Registers the bounded browser
 * tools for the own sandboxed preview: open, inspect, act, screenshot.
 *
 * The extension never trusts the model for paths, hosts or URLs: navigation
 * is restricted to the isolated loopback, screenshots are validated against
 * the fixed byte/pixel policy, and an honest error is returned instead of a
 * fake success or a fake image.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { BrowserError, BrowserInputError, BrowserSession, type BrowserEngine } from './browser.js';

type ExtensionApi = {
  registerTool(tool: Record<string, unknown>): void;
  on?(event: string, handler: (event: Record<string, unknown>) => void): unknown;
};

const BROWSER_ROOT = '/browser';

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof BrowserError) return error.message;
  if (error instanceof Error && error.message.length > 0) return error.message.slice(0, 300);
  return fallback;
}

function toolError(message: string): { isError: true; content: Array<Record<string, unknown>> } {
  return { isError: true, content: [{ type: 'text', text: `Browser preview: ${message}` }] };
}

export default function browserExtension(
  pi: ExtensionApi,
  enabled = process.env.B70_BROWSER_ROOT === BROWSER_ROOT,
  createSession: (engine: BrowserEngine) => BrowserSession = (engine) => {
    if (engine === 'firefox')
      throw new BrowserInputError('Firefox benötigt die isolierte Desktop-Runtime.');
    return new BrowserSession();
  }
): void {
  if (!enabled) return;
  // After a runtime failure the broken session is closed and the next tool call
  // transparently starts a fresh one; only a real session shutdown performs
  // the final cleanup.
  let active: BrowserSession | undefined;
  let selected: BrowserEngine = 'chromium';
  const sessions = new Map<BrowserEngine, BrowserSession>();
  const session = (): BrowserSession => {
    active = sessions.get(selected);
    if (active === undefined || !active.isRunning) {
      if (active) void active.close();
      active = createSession(selected);
      sessions.set(selected, active);
    }
    return active;
  };

  // Session shutdown (abort, quit, replacement) must not leave a browser
  // process inside the scope.
  pi.on?.('session_shutdown', async () => {
    active = undefined;
    await Promise.allSettled([...sessions.values()].map((current) => current.close()));
    sessions.clear();
  });

  const stopOnError = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof BrowserInputError) throw error;
      const current = active;
      active = undefined;
      sessions.delete(selected);
      if (current !== undefined) await current.close().catch(() => undefined);
      throw error;
    }
  };

  // Return the same viewport image to the model and the human transcript.
  // A failed capture must not claim that an already completed click failed:
  // blindly retrying that click could submit a form twice.
  const withPreviewImage = async (
    text: string,
    details: Record<string, unknown> = {},
    signal?: AbortSignal
  ) => {
    try {
      const shot = await session().screenshot(false, signal);
      return {
        content: [
          ...(text ? [{ type: 'text', text }] : []),
          { type: 'image', mimeType: 'image/png', data: shot.png.toString('base64') },
        ],
        details: {
          ...details,
          screenshot: { width: shot.width, height: shot.height, byteLength: shot.byteLength },
        },
      };
    } catch (error) {
      const message = errorMessage(error, 'Capture failed.');
      return {
        content: [
          {
            type: 'text',
            text: `${text ? text + '\n' : ''}Operation completed. Automatic screenshot failed: ${message} Do not repeat the operation just because its screenshot failed.`,
          },
        ],
        details: { ...details, screenshotError: message },
      };
    }
  };

  pi.registerTool({
    name: 'browser_open',
    label: 'Vorschau öffnen',
    description:
      'Öffnet die eigene lokale Vorschau im sichtbaren Test-Desktop, wenn verfügbar. Chromium ist Standard; browser=firefox wählt den zweiten Browser. Weitere Browser-Tools bedienen die zuletzt ausgewählte Instanz. Öffnet eine eigene lokale Vorschau (nur http auf 127.0.0.1/localhost/[::1]) und liefert automatisch einen Screenshot an Modell und Transkript. Viewport standardmäßig 1440×900. Mit browser_resize kann die aktuelle Seite ohne Neuladen angepasst werden; sichtbare Größen sind durch den Test-Desktop begrenzt. Vorher muss im Workspace ein eigener Preview-Server laufen.',
    parameters: {
      '~kind': 'Object',
      type: 'object',
      properties: {
        browser: {
          type: 'string',
          enum: ['chromium', 'firefox'],
          description: 'Browser auswählen; Standard Chromium.',
        },
        url: {
          '~kind': 'String',
          type: 'string',
          description: 'Eigene Loopback-Vorschau-URL, z. B. http://127.0.0.1:5173',
        },
        width: {
          '~kind': 'Number',
          type: 'integer',
          minimum: 320,
          maximum: 1920,
          description: 'Viewport-Breite (Standard 1440).',
        },
        height: {
          '~kind': 'Number',
          type: 'integer',
          minimum: 320,
          maximum: 8192,
          description: 'Viewport-Höhe (Standard 900).',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    executionMode: 'sequential',
    async execute(
      _toolCallId: string,
      params: { url: string; width?: number; height?: number; browser?: BrowserEngine },
      signal?: AbortSignal
    ) {
      try {
        if (params.browser !== undefined && !['chromium', 'firefox'].includes(params.browser))
          throw new BrowserInputError('Ungültiger Browser.');
        selected = params.browser ?? 'chromium';
        const info = await stopOnError(() =>
          session().navigate(
            params.url,
            {
              width: params.width ?? 1440,
              height: params.height ?? 900,
            },
            signal
          )
        );
        return await withPreviewImage(
          JSON.stringify({ browser: selected, url: info.url, title: info.title }),
          { url: info.url },
          signal
        );
      } catch (error) {
        return toolError(errorMessage(error, 'Die Vorschau konnte nicht geöffnet werden.'));
      }
    },
  });

  pi.registerTool({
    name: 'browser_resize',
    label: 'Vorschau-Größe ändern',
    description:
      'Ändert Breite und Höhe der zuletzt ausgewählten Browser-Instanz ohne Neuladen der Seite. Spielstand, Formulare und JavaScript bleiben erhalten. Für breite Web-/3D-Oberflächen nutze z. B. 1800×1000. Grenzen: im sichtbaren Desktop bis zu 1880×1040; bei einem kleineren bereits gestarteten Desktop entsprechend weniger. Liefert tatsächliche Screenshot-Größe und Bild.',
    parameters: {
      '~kind': 'Object',
      type: 'object',
      properties: {
        width: { '~kind': 'Number', type: 'integer', minimum: 320, maximum: 1920 },
        height: { '~kind': 'Number', type: 'integer', minimum: 320, maximum: 8192 },
      },
      required: ['width', 'height'],
      additionalProperties: false,
    },
    executionMode: 'sequential',
    async execute(_id: string, params: { width: number; height: number }, signal?: AbortSignal) {
      try {
        const size = await stopOnError(() => session().resize(params, signal));
        return await withPreviewImage('', { viewport: size }, signal);
      } catch (error) {
        return toolError(errorMessage(error, 'Die Vorschau-Größe konnte nicht geändert werden.'));
      }
    },
  });

  pi.registerTool({
    name: 'browser_inspect',
    label: 'Vorschau prüfen',
    description:
      'Liefert einen begrenzten DOM-/Text-Überblick der aktuellen Vorschau und automatisch einen Screenshot an Modell und Transkript: URL, Titel, Bedienelemente, optional ein ausgewähltes Element und Seiten-Text (gekürzt).',
    parameters: {
      '~kind': 'Object',
      type: 'object',
      properties: {
        selector: {
          '~kind': 'String',
          type: 'string',
          description:
            'Optionaler CSS-Selector (ohne JavaScript-Injection) für ein bestimmtes Element.',
        },
      },
      additionalProperties: false,
    },
    executionMode: 'sequential',
    async execute(_toolCallId: string, params: { selector?: string }, signal?: AbortSignal) {
      try {
        const report = await stopOnError(() => session().inspect(params.selector, signal));
        return await withPreviewImage(report, {}, signal);
      } catch (error) {
        return toolError(errorMessage(error, 'Die Vorschau konnte nicht geprüft werden.'));
      }
    },
  });

  pi.registerTool({
    name: 'browser_action',
    label: 'Vorschau bedienen',
    description:
      'Führt genau eine Aktion auf der aktuellen Vorschau aus und liefert danach automatisch einen Screenshot an Modell und Transkript: click (Klick auf Selector), type (Text in fokussierbares Feld), press (erlaubte Taste), scroll (Delta in px oder Selector) oder reload.',
    parameters: {
      '~kind': 'Object',
      type: 'object',
      properties: {
        action: {
          '~kind': 'String',
          type: 'string',
          enum: ['click', 'type', 'press', 'scroll', 'reload'],
        },
        selector: {
          '~kind': 'String',
          type: 'string',
          description: 'CSS-Selector für click/type/scroll.',
        },
        text: {
          '~kind': 'String',
          type: 'string',
          description: 'Text für type (max. 4096 Zeichen).',
        },
        key: {
          '~kind': 'String',
          type: 'string',
          enum: [
            'Enter',
            'Tab',
            'Escape',
            'Backspace',
            'Delete',
            ' ',
            'Home',
            'End',
            'ArrowUp',
            'ArrowDown',
            'ArrowLeft',
            'ArrowRight',
          ],
          description: 'Taste für press.',
        },
        delta: {
          '~kind': 'Number',
          type: 'integer',
          minimum: -20000,
          maximum: 20000,
          description: 'Scroll-Delta in px (Standard 800).',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    executionMode: 'sequential',
    async execute(
      _toolCallId: string,
      params: {
        action: 'click' | 'type' | 'press' | 'scroll' | 'reload';
        selector?: string;
        text?: string;
        key?: string;
        delta?: number;
      },
      signal?: AbortSignal
    ) {
      try {
        await stopOnError(() =>
          session().act(
            {
              kind: params.action,
              ...(params.selector === undefined ? {} : { selector: params.selector }),
              ...(params.text === undefined ? {} : { text: params.text }),
              ...(params.key === undefined ? {} : { key: params.key }),
              ...(params.delta === undefined ? {} : { delta: params.delta }),
            },
            signal
          )
        );
        return await withPreviewImage('', { action: params.action }, signal);
      } catch (error) {
        return toolError(errorMessage(error, 'Die Aktion konnte nicht ausgeführt werden.'));
      }
    },
  });

  pi.registerTool({
    name: 'browser_screenshot',
    label: 'Screenshot aufnehmen',
    description:
      'Nimmt einen begrenzten PNG-Screenshot der aktuellen Vorschau auf (Standard: Viewport, optional fullPage bis 8192 px Höhe). Maximal 2 MiB und 1920×8192. Das Bild wird als Bildinhalt an das Modell zurückgegeben und kann im Dashboard am Tool-Ereignis angesehen werden.',
    parameters: {
      '~kind': 'Object',
      type: 'object',
      properties: {
        label: {
          '~kind': 'String',
          type: 'string',
          description: 'Kurzbeschriftung des Bildes (max. 128 Zeichen).',
        },
        fullPage: {
          '~kind': 'Boolean',
          type: 'boolean',
          description: 'Ganze Seite statt nur Viewport (begrenzt).',
        },
      },
      additionalProperties: false,
    },
    executionMode: 'sequential',
    async execute(
      _toolCallId: string,
      params: { label?: string; fullPage?: boolean },
      signal?: AbortSignal
    ) {
      try {
        const shot = await stopOnError(() =>
          session().screenshot(params.fullPage === true, signal)
        );
        const label = (params.label ?? 'Vorschau').trim().slice(0, 128) || 'Vorschau';
        // Optional best-effort copy under the private per-run profile; never
        // a source change and never required for the model round trip.
        const sequence = String(Date.now()).slice(-6);
        const fileName = `${sequence}-${
          label
            .toLowerCase()
            .normalize('NFKD')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 40) || 'bild'
        }.png`;
        try {
          await mkdir('/profile/screenshots', { recursive: true, mode: 0o700 });
          await writeFile(`/profile/screenshots/${fileName}`, shot.png, {
            flag: 'wx',
            mode: 0o600,
          });
        } catch {
          // A missing copy must not turn a successful screenshot into an error.
        }
        return {
          content: [
            ...(shot.clipped
              ? [{ type: 'text', text: 'Screenshot height limited to 8192 px.' }]
              : []),
            { type: 'image', mimeType: 'image/png', data: shot.png.toString('base64') },
          ],
          details: {
            width: shot.width,
            height: shot.height,
            byteLength: shot.byteLength,
            clipped: shot.clipped,
          },
        };
      } catch (error) {
        return toolError(
          errorMessage(
            error,
            'Der Screenshot konnte nicht aufgenommen werden. Prüfe, ob eine Vorschau geöffnet ist.'
          )
        );
      }
    },
  });
}
