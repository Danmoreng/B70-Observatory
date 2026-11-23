import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { RunnerConfig } from '../runner/config.js';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
export type InputUnit =
  { text: string } | { data: string; mimeType: string; source?: 'user' | 'tool' };
type RunBinding = { runId: string; turnId: string };

/** Tokenize content with the serving model through the gateway, never use cache hits or character estimates. */
export function createInputTokenCounter(
  config: Pick<RunnerConfig, 'model' | 'gatewayUrl' | 'gatewayToken' | 'imageGenerationEnabled'>,
  fetchRequest: typeof fetch = globalThis.fetch
): (unit: InputUnit, model?: string) => Promise<number> {
  const cache = new Map<string, Promise<number>>();
  async function tokenize(body: ObjectValue, model: string): Promise<number> {
    const response = await fetchRequest(
      new URL('/v1/tokenize', config.gatewayUrl ?? 'http://127.0.0.1:8090'),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.gatewayToken ?? 'local-b70-gateway'}`,
        },
        body: JSON.stringify({ model, ...body }),
        signal: AbortSignal.timeout(config.imageGenerationEnabled ? 45 * 60_000 : 12_000),
      }
    );
    if (!response.ok) throw new Error('Input tokenizer unavailable');
    const value = object(await response.json());
    if (!count(value?.count)) throw new Error('Invalid tokenizer count');
    return value.count;
  }
  function cached(model: string, body: ObjectValue): Promise<number> {
    const encoded = JSON.stringify(body);
    const key = createHash('sha256').update(model).update('\0').update(encoded).digest('hex');
    const existing = cache.get(key);
    if (existing) return existing;
    const pending = tokenize(body, model).catch((error) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, pending);
    if (cache.size > 2048) cache.delete(cache.keys().next().value!);
    return pending;
  }
  return async (unit, model = config.model) => {
    if ('text' in unit) return unit.text.length ? await cached(model, { prompt: unit.text }) : 0;
    const baseline = await cached(model, { messages: [{ role: 'user', content: [] }] });
    const image = await cached(model, {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${unit.mimeType};base64,${unit.data}` } },
          ],
        },
      ],
    });
    if (image < baseline) throw new Error('Invalid image token count');
    return image - baseline;
  };
}

/**
 * Count the first accepted prompt once (instructions/tools/reference images included),
 * then original user/tool content consumed by later successful model calls. Assistant
 * entries and generated compaction records never become input again. Original entries
 * survive compaction, so no context-length subtraction or cache/block-boundary guess is needed.
 * New content is tokenized without repeated chat framing; this measures input content,
 * deliberately distinct from the provider's sum of processed prompt tokens.
 * Unknown ownership/formats stay unavailable instead of showing that processing sum.
 */
export async function readUniqueInputTokens(
  path: string,
  runs: readonly RunBinding[],
  tokenize: (unit: InputUnit, model?: string) => Promise<number>
): Promise<Map<string, number> | undefined> {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    if (
      (database.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n !== 1
    )
      return undefined;
    const byTurn = new Map(runs.map((run) => [run.turnId, run.runId]));
    const totals = new Map<string, number>();
    let current: string | undefined;
    let initial = true;
    let pending: InputUnit[] = [];
    const seenInputs = new Set<string>();
    const seenTools = new Set<string>();
    let bytes = 0,
      rows = 0;
    // Read the append-only history to a fixed high-water mark. Release each
    // SQLite statement before awaiting the tokenizer so writers can checkpoint.
    const last = database.prepare('SELECT MAX(id) AS id FROM entries').get()?.id;
    if (!count(last)) return undefined;
    const next = database.prepare(
      'SELECT id, record FROM entries WHERE id > ? AND id <= ? ORDER BY id LIMIT 1'
    );
    let cursor = 0;
    while (cursor < last) {
      const row = next.get(cursor, last);
      if (!row || !count(row.id)) return undefined;
      cursor = row.id;
      if (
        ++rows > 10_000 ||
        typeof row.record !== 'string' ||
        (bytes += Buffer.byteLength(row.record)) > 32 * 1024 * 1024
      )
        return undefined;
      const entry = object(JSON.parse(row.record));
      if (!entry) return undefined;
      const data = object(entry.data);
      if (entry.kind === 'b70.input' && data) {
        if (typeof data.id !== 'string') return undefined;
        if (seenInputs.has(data.id)) continue;
        seenInputs.add(data.id);
        const bound = typeof data.id === 'string' ? byTurn.get(data.id) : undefined;
        if (bound) {
          current = bound;
          if (!totals.has(current)) totals.set(current, 0);
        } else if (!current || data.kind === 'task') return undefined;
      }
      if (!Array.isArray(entry.model)) continue;
      for (const raw of entry.model) {
        const message = object(raw);
        if (!message) return undefined;
        if (message.role === 'assistant') {
          const usage = object(message.usage);
          if (['error', 'aborted'].includes(String(message.stopReason))) continue;
          if (!current || !usage || ![usage.input, usage.cacheRead, usage.cacheWrite].every(count))
            return undefined;
          if (initial) {
            totals.set(
              current,
              (usage.input as number) + (usage.cacheRead as number) + (usage.cacheWrite as number)
            );
            initial = false;
          } else {
            // Match trimModelImages: only the newest 4 user / 2 tool images
            // reach this model call. Earlier unconsumed images are not input.
            let userImages = 4,
              toolImages = 2;
            const visible = [...pending]
              .reverse()
              .filter(
                (unit) =>
                  'text' in unit || (unit.source === 'user' ? userImages-- > 0 : toolImages-- > 0)
              )
              .reverse();
            let total = totals.get(current) ?? 0;
            for (const unit of visible) {
              const tokens = await tokenize(
                unit,
                typeof message.model === 'string' ? message.model : undefined
              );
              if (!count(tokens)) return undefined;
              total += tokens;
              if (!count(total)) return undefined;
            }
            totals.set(current, total);
          }
          pending = [];
          bytes = 0; // Bound the outstanding turn, including its image payloads.
          continue;
        }
        if (initial || message.role === 'system' || entry.kind === 'pi.compaction') continue;
        if (message.role !== 'user' && message.role !== 'toolResult') return undefined;
        if (entry.kind !== 'b70.input' && entry.kind !== 'pi.tool-result') return undefined;
        if (message.role === 'toolResult') {
          if (typeof message.toolCallId !== 'string') return undefined;
          if (seenTools.has(message.toolCallId)) continue;
          seenTools.add(message.toolCallId);
        }
        if (!Array.isArray(message.content)) return undefined;
        for (const rawBlock of message.content) {
          const block = object(rawBlock);
          if (block?.type === 'text' && typeof block.text === 'string')
            pending.push({ text: block.text });
          else if (
            block?.type === 'image' &&
            typeof block.data === 'string' &&
            typeof block.mimeType === 'string'
          )
            pending.push({
              data: block.data,
              mimeType: block.mimeType,
              source: message.role === 'user' ? 'user' : 'tool',
            });
          else return undefined;
        }
      }
    }
    return initial ? undefined : totals;
  } catch {
    return undefined;
  } finally {
    database?.close();
  }
}
