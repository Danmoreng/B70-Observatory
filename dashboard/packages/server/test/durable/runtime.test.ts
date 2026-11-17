import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readDurableRuntime, sumRuntime } from '../../src/durable/runtime.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(records: Record<string, unknown>[]) {
  const root = mkdtempSync(join(tmpdir(), 'b70-runtime-'));
  roots.push(root);
  const file = join(root, 'conversation.sqlite'),
    db = new DatabaseSync(file);
  db.exec('CREATE TABLE tasks(kind TEXT,status TEXT,record TEXT)');
  for (const record of records)
    db.prepare('INSERT INTO tasks VALUES(?,?,?)').run(
      JSON.stringify(record.kind),
      String(record.status ?? 'terminal'),
      JSON.stringify(record)
    );
  db.close();
  return file;
}
const time = (ms: number) => new Date(ms).toISOString();
it('counts overlapping tools once, separates recorded GPU wait, and excludes pauses across runs', () => {
  const file = fixture([
    { kind: 'pi.generation', startedAt: 0, endedAt: 200 },
    { kind: 'pi.tool', startedAt: 20, endedAt: 60 },
    { kind: 'pi.tool', startedAt: 30, endedAt: 40 },
  ]);
  const values = readDurableRuntime(
    file,
    [
      { runId: 'a', startedAt: time(0), finishedAt: time(100) },
      { runId: 'b', startedAt: time(150), finishedAt: time(200) },
    ],
    () => [
      [10, 20],
      [30, 40],
    ],
    200
  )!;
  expect(values.get('a')).toEqual({
    wallMs: 100,
    toolMs: 40,
    modelMs: 50,
    engineWaitMs: 10,
    otherMs: 0,
  });
  expect(values.get('b')).toEqual({
    wallMs: 50,
    toolMs: 0,
    modelMs: 50,
    engineWaitMs: 0,
    otherMs: 0,
  });
  expect(sumRuntime([...values.values()])).toEqual({
    wallMs: 150,
    toolMs: 40,
    modelMs: 100,
    engineWaitMs: 10,
    otherMs: 0,
  });
});
it('leaves older missing task clocks and unrecorded engine wait unknown', () => {
  const runs = [{ runId: 'a', startedAt: time(0), finishedAt: time(100) }];
  const missing = fixture([{ kind: 'pi.tool', endedAt: 80 }]);
  expect(readDurableRuntime(missing, runs, () => undefined)?.get('a')).toMatchObject({
    wallMs: 100,
    toolMs: null,
    modelMs: null,
  });
  const recorded = fixture([
    { kind: 'pi.generation', startedAt: 0, endedAt: 100 },
    { kind: 'pi.tool', startedAt: 20, endedAt: 60 },
  ]);
  expect(readDurableRuntime(recorded, runs, () => undefined)?.get('a')).toEqual({
    wallMs: 100,
    toolMs: 40,
    modelMs: 60,
    engineWaitMs: null,
    otherMs: 0,
  });
});
