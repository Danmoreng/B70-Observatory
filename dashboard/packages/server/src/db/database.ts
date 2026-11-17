import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type HealthCheck } from '@observatory/contracts';
import { DatabaseError } from './errors.js';
export { DatabaseError } from './errors.js';
import { applyMigrations } from './migrations.js';

export interface OpenDatabaseOptions {
  /**
   * File path of the SQLite database. Must be a real file path –
   * `:memory:` is rejected (see below): the brief requires WAL mode and
   * in-memory databases cannot use it. Tests that want an in-memory
   * database use `new DatabaseSync(':memory:')` directly plus
   * `applyMigrations()`.
   */
  path: string;
  /**
   * How many milliseconds a connection waits for a locked database before
   * failing with `SQLITE_BUSY`. Set both via the constructor option (atomic
   * with open) and the `busy_timeout` pragma (defensive, idempotent).
   */
  busyTimeoutMs: number;
}

/**
 * Open (creating if necessary) the observatory database in WAL mode with
 * foreign keys enabled and all pending migrations applied.
 *
 * - WAL: readers never block a writer and vice versa; required by the
 *   project brief. The writer is only the API process (M2); M3 adds the
 *   gateway as a second writer in the same process, which WAL + busy
 *   timeout are exactly built for. Therefore `:memory:` is rejected with a
 *   clear error instead of silently ending up in a non-WAL database
 *   (review finding 5); tests that need an in-memory database construct
 *   `new DatabaseSync(':memory:')` and `applyMigrations()` themselves.
 * - foreign_keys: ON per connection (SQLite default is OFF).
 *
 * The caller owns the returned handle and must `closeDatabase()` it.
 */
export function openDatabase(options: OpenDatabaseOptions): DatabaseSync {
  if (options.path === ':memory:') {
    throw new DatabaseError(
      'openDatabase does not support ":memory:": the project brief requires ' +
        'WAL mode, which in-memory SQLite databases cannot use. ' +
        'Pass a real file path (e.g. data/observatory.db), or in tests ' +
        'use `new DatabaseSync(":memory:")` plus applyMigrations() directly.',
      'memory_not_supported'
    );
  }
  const directory = dirname(options.path);
  if (directory.length > 0) {
    try {
      mkdirSync(directory, { recursive: true });
    } catch (error) {
      throw new DatabaseError(
        `cannot create database directory ${directory}: ${(error as Error).message}`,
        'open_failed'
      );
    }
  }

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(options.path, { timeout: options.busyTimeoutMs });
  } catch (error) {
    throw new DatabaseError(`cannot open database: ${(error as Error).message}`, 'open_failed');
  }

  try {
    // Defensive double-setting: the constructor option is atomic with the
    // open; the pragma guards against future refactors.
    db.exec(`PRAGMA busy_timeout = ${Math.floor(options.busyTimeoutMs)};`);
    const journal = db.prepare('PRAGMA journal_mode = WAL;').get() as
      { journal_mode?: string } | undefined;
    if (journal?.journal_mode?.toLowerCase() !== 'wal') {
      throw new DatabaseError(
        `database is not in WAL mode (got: ${journal?.journal_mode ?? 'unknown'})`,
        'open_failed'
      );
    }
    db.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(db);
    return db;
  } catch (error) {
    db.close();
    if (error instanceof DatabaseError) throw error;
    throw new DatabaseError(
      `cannot initialize database: ${(error as Error).message}`,
      'open_failed'
    );
  }
}

/** Close the database, swallowing errors from already-closed handles. */
export function closeDatabase(db: DatabaseSync): void {
  try {
    db.close();
  } catch {
    // Already closed or lost; nothing left to do.
  }
}

/**
 * Health probe used by `GET /api/health` (check name: `database`).
 * `PRAGMA quick_check` validates SQLite integrity without a full backup
 * and is cheap at the dashboard's 5 s polling interval.
 */
export function databaseHealthCheck(db: DatabaseSync): HealthCheck {
  try {
    const rows = db.prepare('PRAGMA quick_check;').all() as Array<{ quick_check?: string }>;
    const bad = rows.find((row) => row.quick_check !== 'ok');
    if (bad !== undefined) {
      return {
        name: 'database',
        status: 'error',
        message: `integrity check reported: ${String(bad.quick_check).slice(0, 200)}`,
      };
    }
    return { name: 'database', status: 'ok' };
  } catch (error) {
    // Message is truncated and never includes file paths beyond the SQLite
    // result class, keeping it display-safe.
    const message = (error as Error).message.slice(0, 200);
    return { name: 'database', status: 'error', message: `database unavailable: ${message}` };
  }
}
