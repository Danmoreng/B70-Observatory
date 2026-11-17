import { DatabaseSync } from 'node:sqlite';
import type { InferenceTelemetryTotals } from '@observatory/contracts';

/** Read only the pinned Pi SQLite metadata. Opening through Pi's storage adapter
 * initializes/migrates tables, so historical observation uses SELECTs on a
 * read-only connection instead. Unknown formats/ambiguous runs stay unavailable.
 */
export async function readSingleRunUsage(
  path: string,
  turnId: string
): Promise<InferenceTelemetryTotals | undefined> {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const conversations = database.prepare('SELECT COUNT(*) AS n FROM conversations').get() as {
      n: number;
    };
    if (conversations.n !== 1) return undefined;
    const inputs = database
      .prepare(
        `SELECT json_extract(record, '$.data.id') AS id
      FROM entries WHERE json_extract(record, '$.kind')='b70.input'
      AND json_extract(record, '$.data.kind')='task' LIMIT 2`
      )
      .all() as Array<{ id: string }>;
    if (inputs.length !== 1 || inputs[0]!.id !== turnId) return undefined;
    // Only numbers/stop reasons leave SQLite; prompts, images and tool output do not.
    const rows = database
      .prepare(
        `SELECT
      json_extract(m.value, '$.usage.input') AS input,
      json_extract(m.value, '$.usage.output') AS output,
      json_extract(m.value, '$.usage.cacheRead') AS cache_read,
      json_extract(m.value, '$.usage.cacheWrite') AS cache_write,
      json_extract(m.value, '$.stopReason') AS stop_reason
      FROM entries e, json_each(e.record, '$.model') m
      WHERE json_extract(m.value, '$.role')='assistant' LIMIT 10001`
      )
      .all() as Array<{
      input: number;
      output: number;
      cache_read: number;
      cache_write: number;
      stop_reason: string;
    }>;
    if (rows.length > 10_000) return undefined;
    let requests = 0,
      inputTokens = 0,
      outputTokens = 0,
      cachedTokens = 0;
    for (const row of rows) {
      if (['error', 'aborted'].includes(row.stop_reason)) continue;
      if (
        ![row.input, row.output, row.cache_read, row.cache_write].every(
          (n) => Number.isSafeInteger(n) && n >= 0
        )
      )
        return undefined;
      if (!(row.input + row.output + row.cache_read + row.cache_write)) continue;
      requests++;
      inputTokens += row.input + row.cache_read + row.cache_write;
      outputTokens += row.output; // Reasoning is already included.
      cachedTokens += row.cache_read;
    }
    if (!requests) return undefined;
    return {
      requests,
      completedRequests: requests,
      failedRequests: 0,
      usage: { inputTokens, outputTokens, cachedInputTokens: cachedTokens || null },
      prefill: null,
      decode: null,
      usageSource: 'durable-history',
    };
  } catch {
    return undefined;
  } finally {
    database?.close();
  }
}
