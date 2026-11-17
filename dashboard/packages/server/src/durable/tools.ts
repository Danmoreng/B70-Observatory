import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createCodingTools } from '@earendil-works/pi-durable/tools';
import {
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import type { Message } from '@earendil-works/pi-ai';
import { obj, str, type Schema } from '@earendil-works/pi-schema';
import { getOrThrow, type ExecutionEnv } from '@earendil-works/pi-durable/env';
import { registerBrowserTools, registerDesktopTools } from '@observatory/runner';

export function createDashboardTools(browser: boolean, desktop = false) {
  const coding = createCodingTools();
  const tools: ToolRegistration[] = [...(coding.tools ?? [])];
  // Reading is replay-safe; writes and shell commands are deliberately not.
  for (const tool of tools) if (tool.name === 'read') Object.assign(tool, { replay: 'safe' });
  tools.push(
    defineTool({
      name: 'ask_user',
      description: 'Stelle eine notwendige Rückfrage und warte auf die Antwort des Nutzers.',
      parameters: obj({ question: str({ minLength: 1, maxLength: 16384 }) }),
      executionMode: 'sequential',
      async execute(args, api, context) {
        if (!api.env) throw new Error('Sandbox unavailable');
        getOrThrow(
          await api.env.writeFile(
            '/workspace/.b70-question.json',
            JSON.stringify({ version: 1, question: args.question }),
            context
          )
        );
        return { output: [{ type: 'text', text: args.question }], control: { terminate: true } };
      },
    })
  );
  for (const register of [
    ...(browser ? [registerBrowserTools] : []),
    ...(desktop ? [registerDesktopTools] : []),
  ])
    register(
      {
        registerTool(raw) {
          const schema = JSON.parse(
            JSON.stringify(raw.parameters, (key, value: unknown) =>
              key === '~kind' ? undefined : value
            )
          ) as Schema;
          tools.push(
            defineTool({
              name: String(raw.name),
              description: String(raw.description),
              parameters: schema,
              executionMode: 'sequential',
              async execute(args, api, context) {
                return await sandboxToolCall(api.env, args, String(raw.name), context);
              },
            })
          );
        },
        on() {
          return undefined;
        },
      },
      true
    );
  return defineExtension({
    name: 'b70-coding',
    tools,
    hooks: [
      hook(GenerationTask, {
        beforeRequest: (request) => ({ messages: trimModelImages(request.messages) }),
      }),
    ],
    sections: [
      {
        key: 'b70-tools',
        render: () =>
          'Du arbeitest in /workspace in einer isolierten Entwicklungsumgebung. Nutze read, edit, write und bash. Bilder aus read, Browser- und Desktop-Tools kannst du sehen. ' +
          "Für Bildkonvertierung stehen magick (ImageMagick) und ffmpeg in bash bereit, ohne Paketinstallation. Für Websites verwende komprimierte WebP-Dateien in passender Anzeigegröße statt großer PNG/JPEG-Originale. Beispiel: magick input.png -auto-orient -resize '1920x1920>' -strip -quality 82 output.webp. generate_image liefert bereits webPath für Websites und previewPath zum erneuten Ansehen; lies nicht das große Original-PNG. Ältere Inline-Bilder können aus dem Modellkontext fallen; previewPath bleibt im Projekt lesbar. " +
          (desktop
            ? 'Für native GUI-Tests: baue die Anwendung mit bash, starte desktop_start und desktop_launch, prüfe mit desktop_observe und desktop_action. Verwende für Eingaben die snapshot-ID und Pixelkoordinaten des neuesten Desktop-Bildes. Eine neue Laufzeit hat einen neuen Desktop; Quellcode bleibt im Workspace erhalten. '
            : '') +
          'Beende einen Auftrag erst nach passenden Prüfungen. Stelle nötige Rückfragen mit ask_user. Nutzer-Einwürfe ändern den laufenden Auftrag. Keine externen Netzwerkverbindungen. Nutze nur die tatsächlich angebotenen Werkzeuge.',
      },
    ],
  });
}
export async function sandboxToolCall(
  env: ExecutionEnv | undefined,
  args: unknown,
  name: string,
  context: typeof BACKGROUND_CONTEXT,
  timeout = 120
) {
  if (!env) throw new Error('Sandbox unavailable');
  let output = '';
  const result = getOrThrow(
    await env.exec(
      [
        '/usr/bin/node',
        '/runtime/durable-browser-client.js',
        Buffer.from(JSON.stringify({ name, args })).toString('base64url'),
      ],
      {
        timeout,
        onOutput: (text) => {
          if (output.length + text.length > 4 * 1024 * 1024)
            throw new Error('Sandbox tool result too large');
          output += text;
        },
      },
      context
    )
  );
  if (result.exitCode !== 0) throw new Error('Sandbox tool worker failed');
  const parsed = JSON.parse(output) as {
    content?: Array<
      { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
    >;
    isError?: boolean;
  };
  return {
    output: parsed.content ?? [{ type: 'text' as const, text: 'No sandbox tool result.' }],
    isError: parsed.isError,
  };
}

export function trimModelImages(messages: readonly Message[]): Message[] {
  let users = 4,
    tools = 2;
  return [...messages]
    .reverse()
    .map((message) => {
      if (!Array.isArray(message.content)) return message;
      const content = [...message.content]
        .reverse()
        .map((block) => {
          if (block.type !== 'image') return block;
          const keep = message.role === 'user' ? users-- > 0 : tools-- > 0;
          return keep
            ? block
            : {
                type: 'text' as const,
                text: 'Älteres Bild aus dem Modellkontext entfernt; es bleibt im Gespräch gespeichert.',
              };
        })
        .reverse();
      return { ...message, content } as Message;
    })
    .reverse();
}
