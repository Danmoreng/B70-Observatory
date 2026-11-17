import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isSqliteBusyError } from '../../src/db/errors.js';
import { applyMigrations } from '../../src/db/migrations.js';
import { RequestRepository } from '../../src/db/requests.js';

/**
 * Concurrent access to one WAL database from two connections (the shape
 * M3 will have: API reads health while the gateway persists telemetry).
 * Everything runs in this process against a temp file – no production
 * service is involved.
 */
describe('WAL concurrency', () => {
  let dir: string;
  let writer: DatabaseSync;
  let reader: DatabaseSync;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'observatory-conc-'));
    writer = new DatabaseSync(join(dir, 'db.db'), { timeout: 3000 });
    reader = new DatabaseSync(join(dir, 'db.db'), { timeout: 3000 });
    for (const connection of [writer, reader]) {
      connection.exec('PRAGMA journal_mode = WAL;');
      connection.exec('PRAGMA foreign_keys = ON;');
    }
    applyMigrations(writer);
    writer.exec('CREATE TABLE load (id TEXT PRIMARY KEY);');
  });

  afterEach(() => {
    for (const connection of [writer, reader]) {
      try {
        connection.close();
      } catch {
        // best effort
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('lets readers proceed while a writer commits in batches', () => {
    const repo = new RequestRepository(writer);
    const batchSize = 10;
    const batches = 5;

    const observed: number[] = [];
    for (let batch = 0; batch < batches; batch += 1) {
      writer.exec('BEGIN');
      for (let i = 0; i < batchSize; i += 1) {
        const id = randomUUID();
        repo.create({
          id,
          endpoint: '/v1/chat/completions',
          startedAtUtc: new Date().toISOString(),
        });
      }
      writer.exec('COMMIT');

      // The reader must be able to see committed state without SQLITE_BUSY.
      const row = reader.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number };
      observed.push(row.n);
    }

    // Monotonic, consistent progression 10, 20, …, 50.
    expect(observed).toEqual([10, 20, 30, 40, 50]);
    expect(reader.prepare('SELECT COUNT(*) AS n FROM requests').get()).toMatchObject({ n: 50 });
  });

  it('blocks readers on nothing: uncommitted writer state is invisible (WAL isolation)', () => {
    writer.exec('BEGIN');
    writer.prepare('INSERT INTO load (id) VALUES (?)').run('uncommitted-row');
    const row = reader
      .prepare("SELECT COUNT(*) AS n FROM load WHERE id = 'uncommitted-row'")
      .get() as {
      n: number;
    };
    expect(row.n).toBe(0);
    writer.exec('COMMIT');
    expect(
      (
        reader.prepare("SELECT COUNT(*) AS n FROM load WHERE id = 'uncommitted-row'").get() as {
          n: number;
        }
      ).n
    ).toBe(1);
  });

  it('reports SQLITE_BUSY after the busy timeout when a write lock is held too long', () => {
    const impatient = new DatabaseSync(join(dir, 'db.db'), { timeout: 50 });
    impatient.exec('PRAGMA journal_mode = WAL;');
    impatient.exec('PRAGMA foreign_keys = ON;');

    writer.exec('BEGIN');
    writer.prepare('INSERT INTO load (id) VALUES (?)').run('lock-holder');

    const started = Date.now();
    let thrown: unknown;
    try {
      impatient.exec('BEGIN');
      impatient.prepare('INSERT INTO load (id) VALUES (?)').run('contended-row');
      impatient.exec('COMMIT');
    } catch (error) {
      thrown = error;
    }
    const waitedMs = Date.now() - started;
    impatient.close();

    expect(thrown).toBeDefined();
    expect(isSqliteBusyError(thrown)).toBe(true);
    // The busy timeout (50 ms) must actually bound the wait.
    expect(waitedMs).toBeGreaterThanOrEqual(40);
    expect(waitedMs).toBeLessThan(3000);

    // A *read* still succeeds against a locked WAL database.
    expect(reader.prepare('SELECT COUNT(*) AS n FROM load').get()).toMatchObject({ n: 0 });

    writer.exec('COMMIT');
    expect((reader.prepare('SELECT COUNT(*) AS n FROM load').get() as { n: number }).n).toBe(1);
  });
});
