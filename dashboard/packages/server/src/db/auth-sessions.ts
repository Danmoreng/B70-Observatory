import type { DatabaseSync } from 'node:sqlite';

export interface AuthSessionRecord {
  tokenHash: string;
  credentialHash: string;
  createdAtUtc: string;
  lastSeenAtUtc: string;
  expiresAtUtc: string;
}

/** Minimal persistence boundary for revocable browser sessions. */
export class AuthSessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(record: AuthSessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO auth_sessions
          (tokenHash, credentialHash, createdAtUtc, lastSeenAtUtc, expiresAtUtc)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        record.tokenHash,
        record.credentialHash,
        record.createdAtUtc,
        record.lastSeenAtUtc,
        record.expiresAtUtc
      );
  }

  find(tokenHash: string): AuthSessionRecord | undefined {
    return this.db
      .prepare(
        `SELECT tokenHash, credentialHash, createdAtUtc, lastSeenAtUtc, expiresAtUtc
         FROM auth_sessions WHERE tokenHash = ?`
      )
      .get(tokenHash) as AuthSessionRecord | undefined;
  }

  touch(tokenHash: string, lastSeenAtUtc: string, expiresAtUtc: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE auth_sessions SET lastSeenAtUtc = ?, expiresAtUtc = ?
         WHERE tokenHash = ?`
      )
      .run(lastSeenAtUtc, expiresAtUtc, tokenHash);
    return result.changes === 1;
  }

  delete(tokenHash: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE tokenHash = ?').run(tokenHash);
  }

  deleteExpired(nowUtc: string): number {
    return Number(
      this.db.prepare('DELETE FROM auth_sessions WHERE expiresAtUtc <= ?').run(nowUtc).changes
    );
  }

  revokeAll(): number {
    return Number(this.db.prepare('DELETE FROM auth_sessions').run().changes);
  }
}
