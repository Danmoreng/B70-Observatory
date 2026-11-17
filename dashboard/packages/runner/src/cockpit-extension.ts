import { writeFile } from 'node:fs/promises';
import { registerSubagentTools } from './subagents.js';

type ExtensionApi = {
  registerTool(tool: Record<string, unknown>): void;
  /**
   * Structurally typed (the Pi package is a runtime, not a build dependency):
   * the `context` event carries a projection of the model context and accepts
   * a replacement messages array. Handlers must transform copies only.
   */
  on?(event: string, handler: (event: unknown, context?: unknown) => unknown): unknown;
};

/** Keep four user references independently of the two latest tool screenshots.
 * Only the model projection is trimmed; the durable transcript stays complete.
 */
const IMAGE_CONTEXT_NOTE =
  'Ältere Bildantwort aus dem Modellkontext entfernt. Das Bild bleibt in der Dashboard-Historie gespeichert.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function trimImageContext(event: {
  messages: unknown[];
}): { messages: unknown[] } | undefined {
  let userRemaining = 4;
  let toolRemaining = 2;
  let changed = false;
  const messages = [...event.messages]
    .reverse()
    .map((message) => {
      if (!isRecord(message) || !Array.isArray(message.content)) return message;
      let messageChanged = false;
      const content = [...message.content]
        .reverse()
        .map((block) => {
          if (!isRecord(block) || block.type !== 'image') return block;
          const keep = message.role === 'user' ? userRemaining-- > 0 : toolRemaining-- > 0;
          if (keep) return block;
          changed = true;
          messageChanged = true;
          return { type: 'text', text: IMAGE_CONTEXT_NOTE };
        })
        .reverse();
      return messageChanged ? { ...message, content } : message;
    })
    .reverse();
  return changed ? { messages } : undefined;
}

/** Fixed non-interactive question bridge for Pi RPC mode. */
export default function cockpitExtension(pi: ExtensionApi): void {
  // Registered in every mode (implementation and review) and before the
  // review early return, so image-heavy reads are bounded in both.
  pi.on?.('context', (event) =>
    isRecord(event) && Array.isArray(event.messages)
      ? trimImageContext({ messages: event.messages })
      : undefined
  );
  if (process.env.B70_SUBAGENT_CHILD === '1') return;
  registerSubagentTools(pi);
  if (process.env.B70_RUN_MODE === 'review') {
    pi.registerTool({
      name: 'submit_review',
      label: 'Review abschließen',
      description:
        'Speichere den abschließenden strukturierten Reviewbericht. Rufe das Tool genau einmal auf und beende danach den Lauf.',
      parameters: {
        '~kind': 'Object',
        type: 'object',
        properties: {
          summary: { '~kind': 'String', type: 'string', description: 'Knappe Gesamtbewertung.' },
          findings: {
            '~kind': 'Array',
            type: 'array',
            maxItems: 100,
            items: {
              '~kind': 'Object',
              type: 'object',
              properties: {
                severity: {
                  '~kind': 'String',
                  type: 'string',
                  enum: ['critical', 'high', 'medium', 'low', 'info'],
                },
                title: { '~kind': 'String', type: 'string' },
                file: { '~kind': 'String', type: 'string' },
                line: { '~kind': 'Number', type: 'integer', minimum: 1 },
                reasoning: { '~kind': 'String', type: 'string' },
                evidence: { '~kind': 'String', type: 'string' },
              },
              required: ['severity', 'title', 'reasoning'],
              additionalProperties: false,
            },
          },
        },
        required: ['summary', 'findings'],
        additionalProperties: false,
      },
      executionMode: 'sequential',
      async execute(
        _toolCallId: string,
        params: { summary: string; findings: Array<Record<string, unknown>> }
      ) {
        await writeFile(
          '/profile/review.json',
          JSON.stringify({ version: 1, summary: params.summary, findings: params.findings }),
          { encoding: 'utf8', flag: 'wx', mode: 0o600 }
        );
        return {
          content: [
            {
              type: 'text',
              text: 'Der strukturierte Reviewbericht wurde gespeichert. Beende den Lauf jetzt.',
            },
          ],
          details: { findings: params.findings.length, stored: true },
        };
      },
    });
    return;
  }

  pi.registerTool({
    name: 'ask_user',
    label: 'Rückfrage',
    description:
      'Stelle genau eine notwendige Rückfrage. Rufe das Tool auf und beende danach sofort den aktuellen Lauf.',
    parameters: {
      '~kind': 'Object',
      type: 'object',
      properties: {
        question: {
          '~kind': 'String',
          type: 'string',
          description: 'Eine konkrete Rückfrage an den Nutzer.',
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
    executionMode: 'sequential',
    async execute(_toolCallId: string, params: { question: string }) {
      const question = params.question.trim().slice(0, 16_384);
      if (question.length === 0) {
        return { content: [{ type: 'text', text: 'Die Rückfrage darf nicht leer sein.' }] };
      }
      await writeFile('/workspace/.b70-question.json', JSON.stringify({ version: 1, question }), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      return {
        content: [
          {
            type: 'text',
            text: 'Die Rückfrage wurde gespeichert. Beende den Lauf jetzt ohne weitere Toolaufrufe.',
          },
        ],
        details: { question, waiting: true },
      };
    },
  });
}
