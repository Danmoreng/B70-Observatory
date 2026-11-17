import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, DatabaseError, openDatabase } from '../../src/db/database.js';

describe('openDatabase', () => {
  it('refuses ":memory:" with a clear error (WAL mode is required, in-memory DBs cannot use it)', () => {
    // Review finding 5: the old documentation claimed :memory: support,
    // but openDatabase enforces WAL – an in-memory database reports
    // journal_mode "memory" and would end up non-WAL. Reject it up front
    // instead, with an actionable message.
    try {
      openDatabase({ path: ':memory:', busyTimeoutMs: 1000 });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseError);
      expect((error as DatabaseError).code).toBe('memory_not_supported');
      expect((error as Error).message).toContain(':memory:');
      expect((error as Error).message).toContain('WAL');
    }
  });

  it('opens a file-backed database in WAL mode with foreign keys on', () => {
    const dir = mkdtempSync(join(tmpdir(), 'observatory-open-'));
    const db = openDatabase({ path: join(dir, 'nested', 'dir', 'test.db'), busyTimeoutMs: 1000 });
    try {
      const journal = db.prepare('PRAGMA journal_mode;').get() as { journal_mode: string };
      expect(journal.journal_mode).toBe('wal');
      const foreignKeys = db.prepare('PRAGMA foreign_keys;').get() as { foreign_keys: number };
      expect(foreignKeys.foreign_keys).toBe(1);
      // Migrations ran as part of openDatabase (v1…v4).
      const row = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as {
        n: number;
      };
      expect(row.n).toBe(4);
    } finally {
      closeDatabase(db);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
