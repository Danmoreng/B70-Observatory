import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createCodingTools } from '@earendil-works/pi-durable/tools';
import {
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import type { ImageContent, Message } from '@earendil-works/pi-ai';
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
  // Keep user attachments at the instruction that introduced them. Tool
  // screenshots rotate much more often. Their historical reference stays
  // byte-stable while the two current images travel together in one frame near the end of the prompt.
  let userImages = 0;
  for (const message of messages) {
    if (message.role === 'user' && Array.isArray(message.content))
      userImages += message.content.filter((block) => block.type === 'image').length;
  }
  let number = 0;
  const previews: Array<{ label: string; image: ImageContent }> = [];
  let previewAnchor = -1;
  let assistantTurns = 0;
  const result = messages.map((message, index) => {
    // Advance together every four assistant turns. Text/tool work after an
    // old screenshot can then stay cached when a new screenshot arrives.
    if (message.role === 'assistant' && ++assistantTurns % 4 === 0) previewAnchor = index;
    if (!Array.isArray(message.content) || !message.content.some((block) => block.type === 'image'))
      return message;
    const content = message.content.map((block) => {
      if (block.type !== 'image') return block;
      if (message.role === 'user') {
        if (userImages-- <= 4) return block;
        return {
          type: 'text' as const,
          text: 'Älteres Bild aus dem Modellkontext entfernt; es bleibt im Gespräch gespeichert.',
        };
      }
      if (message.role !== 'toolResult') return block;
      previewAnchor = index;
      const label = `Werkzeugbild ${++number} (${message.toolName})`;
      previews.push({ label, image: block });
      if (previews.length > 2) previews.shift();
      return { type: 'text' as const, text: '[' + label + ']' };
    });
    return { ...message, content } as Message;
  });
  if (previews.length) {
    const frame: Extract<Message, { role: 'user' }> = {
      role: 'user',
      timestamp: messages[previewAnchor]!.timestamp,
      content: previews.flatMap(({ label, image }) => [
        { type: 'text' as const, text: label + ' aus dem Werkzeugverlauf:' },
        image,
      ]),
    };
    // Keep all results of a single parallel tool call together.
    let tail = previewAnchor + 1;
    while (tail < result.length && result[tail]?.role === 'toolResult') tail++;
    result.splice(tail, 0, frame);
  }
  return result;
}
