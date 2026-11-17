import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, MIGRATIONS, type Migration } from '../../src/db/migrations.js';
import { DatabaseError } from '../../src/db/errors.js';

function memoryDb(): DatabaseSync {
  return new DatabaseSync(':memory:');
}

function tableNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

describe('applyMigrations', () => {
  it('applies the full migration history to a fresh database', () => {
    const db = memoryDb();
    const applied = applyMigrations(db);

    expect(applied).toBe(4); // v1 telemetry + v2 series identity + v3 auth + v4 history indexes
    expect(tableNames(db)).toEqual(
      expect.arrayContaining([
        'requests',
        'request_events',
        'metric_samples',
        'service_events',
        'auth_sessions',
        'schema_migrations',
      ])
    );
    // The v2 migration replaced the v1 unique index with the label-aware one.
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'metric_samples'"
      )
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((row) => row.name);
    expect(indexNames).not.toContain('uq_metric_samples');
    expect(indexNames).toContain('uq_metric_samples_series');
    // v4 adds the keyset pagination and per-series history indexes.
    const requestIndexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'requests'")
      .all() as Array<{ name: string }>;
    expect(requestIndexes.map((row) => row.name)).toContain('idx_requests_keyset');
    const metricIndexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'metric_samples'"
      )
      .all() as Array<{ name: string }>;
    expect(metricIndexes.map((row) => row.name)).toContain('idx_metric_samples_series_at');
    const rows = db
      .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number; name: string }>;
    expect(rows).toEqual([
      { version: 1, name: 'initial-telemetry-schema' },
      { version: 2, name: 'metric-samples-series-identity' },
      { version: 3, name: 'browser-auth-sessions' },
      { version: 4, name: 'history-query-indexes' },
    ]);
    db.close();
  });

  it('is idempotent: a second run applies nothing', () => {
    const db = memoryDb();
    applyMigrations(db);
    expect(applyMigrations(db)).toBe(0);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as {
      n: number;
    };
    expect(rows.n).toBe(4);
    db.close();
  });

  it('upgrades a v1-only database to v2 (labels join the series identity)', () => {
    const db = memoryDb();
    // Simulate a database created by the first release: only v1 applied.
    const first = MIGRATIONS[0];
    if (first === undefined) throw new Error('v1 migration missing');
    applyMigrations(db, [first]);

    const applied = applyMigrations(db);
    expect(applied).toBe(3); // v2, v3 and v4 are new
    const versions = (
      db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{
        version: number;
      }>
    ).map((row) => row.version);
    expect(versions).toEqual([1, 2, 3, 4]);

    // Series identity now includes labels: same (source, name, atUtc) with
    // different label sets is allowed…
    db.prepare(
      'INSERT INTO metric_samples (source, name, value, unit, atUtc, labels) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('gpu', 'gpu.vram', 100, 'bytes', '2025-06-15T12:00:00.000Z', '{"device":"a"}');
    db.prepare(
      'INSERT INTO metric_samples (source, name, value, unit, atUtc, labels) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('gpu', 'gpu.vram', 200, 'bytes', '2025-06-15T12:00:00.000Z', '{"device":"b"}');
    // …the same series at the same instant is rejected…
    expect(() =>
      db
        .prepare(
          'INSERT INTO metric_samples (source, name, value, unit, atUtc, labels) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run('gpu', 'gpu.vram', 300, 'bytes', '2025-06-15T12:00:00.000Z', '{"device":"a"}')
    ).toThrowError(/UNIQUE constraint/i);
    // …and two label-less samples of the same series still collide (NULLs
    // are collapsed by the v2 index).
    db.prepare(
      'INSERT INTO metric_samples (source, name, value, unit, atUtc, labels) VALUES (?, ?, ?, ?, ?, NULL)'
    ).run('gpu', 'gpu.utilization', 1, 'percent', '2025-06-15T13:00:00.000Z');
    expect(() =>
      db
        .prepare(
          'INSERT INTO metric_samples (source, name, value, unit, atUtc, labels) VALUES (?, ?, ?, ?, ?, NULL)'
        )
        .run('gpu', 'gpu.utilization', 2, 'percent', '2025-06-15T13:00:00.000Z')
    ).toThrowError(/UNIQUE constraint/i);
    db.close();
  });

  it('keeps multiple migrations in strict forward order', () => {
    const custom: Migration[] = [
      { version: 1, name: 'first', up: 'CREATE TABLE t1 (id INTEGER PRIMARY KEY);' },
      { version: 2, name: 'second', up: 'CREATE TABLE t2 (id INTEGER PRIMARY KEY);' },
      { version: 3, name: 'third', up: 'CREATE TABLE t3 (id INTEGER PRIMARY KEY);' },
    ];
    const db = memoryDb();
    // Simulate: only the first migration was applied before restart.
    db.exec('CREATE TABLE t1 (id INTEGER PRIMARY KEY);');
    db.exec(
      'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, appliedAtUtc TEXT NOT NULL);'
    );
    db.prepare('INSERT INTO schema_migrations (version, name, appliedAtUtc) VALUES (1, ?, ?)').run(
      'first',
      new Date().toISOString()
    );

    const applied = applyMigrations(db, custom);
    expect(applied).toBe(2);
    expect(tableNames(db)).toEqual(expect.arrayContaining(['t1', 't2', 't3', 'schema_migrations']));
    db.close();
  });

  it('refuses to run when the database is ahead of the code (forward-only)', () => {
    const db = memoryDb();
    applyMigrations(db); // applies v1 + v2 + v3 + v4
    // Simulate a newer application version having applied v5.
    db.prepare('INSERT INTO schema_migrations (version, name, appliedAtUtc) VALUES (5, ?, ?)').run(
      'future-version',
      new Date().toISOString()
    );

    expect(() => applyMigrations(db)).toThrowError(DatabaseError);
    try {
      applyMigrations(db);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as DatabaseError).code).toBe('schema_ahead');
      expect((error as Error).message).toContain('ahead of the application');
    }
    db.close();
  });

  it('refuses a gap in the applied history (corrupt schema)', () => {
    const custom: Migration[] = [
      { version: 1, name: 'first', up: 'CREATE TABLE t1 (id INTEGER PRIMARY KEY);' },
      { version: 2, name: 'second', up: 'CREATE TABLE t2 (id INTEGER PRIMARY KEY);' },
      { version: 3, name: 'third', up: 'CREATE TABLE t3 (id INTEGER PRIMARY KEY);' },
    ];
    const db = memoryDb();
    // Someone applied only v3 – v1 and v2 are missing.
    db.exec(
      'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, appliedAtUtc TEXT NOT NULL);'
    );
    db.prepare('INSERT INTO schema_migrations (version, name, appliedAtUtc) VALUES (3, ?, ?)').run(
      'third',
      new Date().toISOString()
    );

    expect(() => applyMigrations(db, custom)).toThrowError(DatabaseError);
    try {
      applyMigrations(db, custom);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as DatabaseError).code).toBe('schema_corrupt');
    }
    db.close();
  });

  it('rolls back only the failing migration; earlier ones stay committed', () => {
    const goodV1: Migration = {
      version: 1,
      name: 'good',
      up: 'CREATE TABLE ok_table (id INTEGER PRIMARY KEY);',
    };
    const brokenV2: Migration = {
      version: 2,
      name: 'broken',
      up: 'CREATE TABLE broken_table (id INTEGER PRIMARY KEY); INSERT INTO broken_table (id, nonexistent_column) VALUES (1, 2);',
    };
    const db = memoryDb();
    expect(() => applyMigrations(db, [goodV1, brokenV2])).toThrowError(DatabaseError);
    try {
      applyMigrations(db, [goodV1, brokenV2]);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as DatabaseError).code).toBe('migration_failed');
      expect((error as Error).message).toContain('broken_table');
    }
    // Nothing of the failing v2 survived (own transaction, incl. bookkeeping)…
    expect(tableNames(db)).not.toContain('broken_table');
    const rows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{
      version: number;
    }>;
    expect(rows.map((row) => row.version)).toEqual([1]);
    // …and the earlier v1 migration is fully recorded (transaction per
    // migration, review finding 6).
    expect(tableNames(db)).toContain('ok_table');

    // On the next start v1 must NOT be re-run – only the fixed v2 applies.
    const fixedV2: Migration = {
      version: 2,
      name: 'fixed',
      up: 'CREATE TABLE broken_table (id INTEGER PRIMARY KEY);',
    };
    const applied = applyMigrations(db, [goodV1, fixedV2]);
    expect(applied).toBe(1);
    expect(
      (db.prepare('SELECT name FROM schema_migrations WHERE version = 2').get() as { name: string })
        .name
    ).toBe('fixed');
    expect(tableNames(db)).toContain('broken_table');
    db.close();
  });

  it('refuses invalid migration definitions (unsorted, gapped, empty)', () => {
    const v1: Migration = { version: 1, name: 'first', up: 'CREATE TABLE t1 (id INTEGER);' };
    const v2: Migration = { version: 2, name: 'second', up: 'CREATE TABLE t2 (id INTEGER);' };
    const v3: Migration = { version: 3, name: 'third', up: 'CREATE TABLE t3 (id INTEGER);' };
    const db = memoryDb();

    const cases: Array<readonly Migration[]> = [
      [], // empty
      [v2, v1], // out of order
      [v1, v3], // gapped
      [v2], // does not start at 1
    ];
    for (const invalid of cases) {
      expect(() => applyMigrations(db, invalid)).toThrowError(DatabaseError);
      try {
        applyMigrations(db, invalid);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as DatabaseError).code).toBe('migrations_invalid');
      }
    }
    // Nothing was applied by any of the invalid attempts (they are rejected
    // before any schema object is created).
    expect(tableNames(db)).not.toContain('t1');
    expect(tableNames(db)).not.toContain('t2');
    expect(tableNames(db)).not.toContain('t3');

    // A valid table still works afterwards.
    expect(applyMigrations(db, [v1, v2, v3])).toBe(3);
    db.close();
  });
});
