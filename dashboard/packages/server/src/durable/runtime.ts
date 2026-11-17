import { DatabaseSync } from 'node:sqlite';
import type { InferenceTelemetryTotals } from '@observatory/contracts';
type Span = [number, number];
type Runtime = NonNullable<InferenceTelemetryTotals['runtime']>;
export function mergeSpans(spans: Span[]): Span[] {
  const result: Span[] = [];
  for (const [start, end] of spans
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  return result;
}
const length = (spans: Span[]) => mergeSpans(spans).reduce((sum, [a, b]) => sum + b - a, 0);
const intersect = (a: Span[], b: Span[]) =>
  a
    .flatMap(([x, y]) => b.map(([u, v]) => [Math.max(x, u), Math.min(y, v)] as Span))
    .filter(([a, b]) => b > a);
/** Read only durable Pi task clocks. Parallel/nested tool spans count once;
 * pauses and other runs are excluded by clipping to each runner-owned window.
 * No prompt, arguments or tool output leave SQLite. Old formats stay unknown.
 */
export function readDurableRuntime(
  path: string,
  runs: readonly { runId: string; startedAt?: string; finishedAt?: string }[],
  waits: (runId: string) => Span[] | undefined,
  now = Date.now()
): Map<string, Runtime> | undefined {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const rows = db
      .prepare(
        "SELECT json_extract(record,'$.kind') kind, json_extract(record,'$.startedAt') started, json_extract(record,'$.endedAt') ended, status FROM tasks WHERE json_extract(record,'$.kind') IN ('pi.tool','pi.generation') LIMIT 10001"
      )
      .all() as { kind: string; started: number | null; ended: number | null; status: string }[];
    if (rows.length > 10000) return undefined;
    const clocksKnown = rows.every(
      (row) =>
        row.status === 'pending' ||
        (typeof row.started === 'number' &&
          Number.isFinite(row.started) &&
          (row.status === 'terminal'
            ? typeof row.ended === 'number' && Number.isFinite(row.ended)
            : row.ended === null || Number.isFinite(row.ended)))
    );
    const result = new Map<string, Runtime>();
    for (const run of runs) {
      if (!run.startedAt) continue;
      const start = Date.parse(run.startedAt),
        end = run.finishedAt ? Date.parse(run.finishedAt) : now;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
      const window: Span[] = [[start, end]],
        wallMs = end - start;
      if (!clocksKnown) {
        result.set(run.runId, {
          wallMs,
          toolMs: null,
          modelMs: null,
          engineWaitMs: null,
          otherMs: null,
        });
        continue;
      }
      const spans = (kind: string) =>
        mergeSpans(
          intersect(
            rows
              .filter((row) => row.kind === kind && typeof row.started === 'number')
              .map((row) => [row.started!, row.ended ?? now] as Span),
            window
          )
        );
      const tools = spans('pi.tool'),
        generation = spans('pi.generation'),
        toolMs = length(tools),
        both = length([...tools, ...generation]);
      const engine = waits(run.runId);
      const inGeneration = engine ? intersect(engine, generation) : [];
      const engineWaitMs = engine
        ? Math.max(0, length(inGeneration) - length(intersect(inGeneration, tools)))
        : null;
      result.set(run.runId, {
        wallMs,
        toolMs,
        modelMs: Math.max(0, both - toolMs - (engineWaitMs ?? 0)),
        engineWaitMs,
        otherMs: Math.max(0, wallMs - both),
      });
    }
    return result;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}
export function sumRuntime(values: Runtime[]): Runtime | undefined {
  if (!values.length) return undefined;
  const sum = (key: keyof Runtime) =>
    values.some((value) => value[key] === null)
      ? null
      : values.reduce((total, value) => total + value[key]!, 0);
  return {
    wallMs: sum('wallMs')!,
    toolMs: sum('toolMs'),
    modelMs: sum('modelMs'),
    engineWaitMs: sum('engineWaitMs'),
    otherMs: sum('otherMs'),
  };
}
