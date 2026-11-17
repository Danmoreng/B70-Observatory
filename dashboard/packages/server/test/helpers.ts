import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.js';

/**
 * Open a throwaway file-backed database in a fresh temp directory.
 * File-backed on purpose: `openDatabase()` enforces WAL mode and therefore
 * rejects `:memory:` (review finding 5). Tests that only need the schema
 * (e.g. migration tests) use `new DatabaseSync(':memory:')` plus
 * `applyMigrations()` directly. The production vLLM service and any real
 * database are never touched.
 */
export function newTempDb(): {
  db: DatabaseSync;
  dir: string;
  close: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'observatory-db-'));
  const db = openDatabase({ path: join(dir, 'test.db'), busyTimeoutMs: 2000 });
  return {
    db,
    dir,
    close: () => {
      try {
        db.close();
      } catch {
        // best effort
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A fresh, valid UUID for request ids. */
export function newRequestId(): string {
  return randomUUID();
}

/** `new Date(nowMs - days * 86400000).toISOString()` for time-based fixtures. */
export function daysAgoIso(nowMs: number, days: number): string {
  return new Date(nowMs - days * 86_400_000).toISOString();
}
