import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { RunnerConfig } from './config.js';

/**
 * Generates a short, descriptive title for an agent task by running one
 * brief chat completion against the locally loaded model. Used only when
 * the user did not supply an explicit task name, so the dashboard never
 * has to show the raw task text twice.
 */

const ENDPOINT = '/v1/chat/completions';
const MAX_BODY_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;
/** The title request must stay quick; the run start only waits briefly. */
const REQUEST_TIMEOUT_MS = 20_000;
/** Prompt budget: titles only need the beginning of the task description. */
const MAX_TASK_CHARS = 2_000;
/** Keep generated titles short enough for the task list. */
const MAX_TITLE_LENGTH = 60;

function titlePrompt(taskText: string): string {
  return [
    'Erzeuge einen kurzen, beschreibenden Titel für die folgende Aufgabenbeschreibung.',
    'Der Titel muss höchstens 60 Zeichen lang sein, ein Nomen oder Verb am Anfang haben und den Kern der Aufgabe wiedergeben.',
    'Antworte ausschließlich mit dem Titel selbst – ohne Anführungszeichen, ohne Gedankenstrich, ohne Punkt am Ende und ohne weitere Erklärungen.',
    '',
    `Aufgabenbeschreibung:\n${taskText.slice(0, MAX_TASK_CHARS)}`,
  ].join('\n');
}

function cleanTitle(raw: string): string {
  const firstLine =
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? '';
  if (firstLine === '') return '';
  const unquoted = firstLine
    .replace(/^["'`*]+\s*/, '')
    .replace(/\s*["'`*]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (unquoted === '') return '';
  const trimmed =
    unquoted.length <= MAX_TITLE_LENGTH
      ? unquoted
      : `${unquoted.slice(0, MAX_TITLE_LENGTH - 1).replace(/\s+$/, '')}…`;
  return trimmed.replace(/[.,;:!?]+$/u, '');
}

function parseCompletion(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') return undefined;
    const cleaned = cleanTitle(content);
    return cleaned === '' ? undefined : cleaned;
  } catch {
    return undefined;
  }
}

/**
 * Runs a single short chat completion asking the loaded model for a title.
 * Returns `undefined` on any failure so the caller can keep the plain
 * first-line fallback instead of failing the run start.
 */
export function generateTaskTitle(
  config: Pick<RunnerConfig, 'gatewayUrl' | 'gatewayToken' | 'model'>,
  taskText: string
): Promise<string | undefined> {
  const endpoint = new URL(ENDPOINT, config.gatewayUrl ?? 'http://127.0.0.1:8090');
  const requestFunction = endpoint.protocol === 'https:' ? httpsRequest : httpRequest;
  const payload = JSON.stringify({
    model: config.model,
    stream: false,
    temperature: 0,
    max_tokens: 96,
    reasoning_effort: 'none',
    chat_template_kwargs: { enable_thinking: false },
    messages: [
      { role: 'system', content: 'Du gibst knappe, treffende Titel. Keine Erklärungen.' },
      { role: 'user', content: titlePrompt(taskText) },
    ],
  });
  if (Buffer.byteLength(payload) > MAX_BODY_BYTES) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (!settled) {
        settled = true;
        clearTimeout(deadline);
        request.destroy();
        resolve(value);
      }
    };
    const request = requestFunction(
      endpoint,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
          'x-observatory-origin': 'pi',
          ...(config.gatewayToken ? { authorization: `Bearer ${config.gatewayToken}` } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            finish(undefined);
            return;
          }
          chunks.push(chunk);
        });
        response.once('end', () => {
          if ((response.statusCode ?? 500) !== 200) {
            response.destroy();
            return finish(undefined);
          }
          finish(parseCompletion(Buffer.concat(chunks).toString('utf8')));
        });
        response.once('error', () => finish(undefined));
        response.once('aborted', () => finish(undefined));
      }
    );
    // An absolute deadline also bounds connection setup and trickling responses.
    const deadline = setTimeout(() => finish(undefined), REQUEST_TIMEOUT_MS);
    request.once('error', () => finish(undefined));
    request.end(payload);
  });
}
