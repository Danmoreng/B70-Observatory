/** Stable, safe-to-log error codes for the database layer. */
export type DatabaseErrorCode =
  | 'open_failed'
  | 'memory_not_supported'
  | 'schema_ahead'
  | 'schema_corrupt'
  | 'migrations_invalid'
  | 'migration_failed'
  | 'unknown_request'
  | 'duplicate_metric'
  | 'busy_timeout'
  | 'query_failed';

/**
 * Typed failure of a database operation. Messages are safe to log and safe
 * to surface: they never contain request content, query parameters or
 * credentials.
 */
export class DatabaseError extends Error {
  readonly code: DatabaseErrorCode;

  constructor(message: string, code: DatabaseErrorCode = 'query_failed') {
    super(message);
    this.name = 'DatabaseError';
    this.code = code;
  }
}

/**
 * Raised when a value that is about to be written to the database fails
 * the runtime contract for that table (Zod). Input never reaches SQLite
 * unchecked.
 */
export class DbContractError extends Error {
  readonly issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>;

  constructor(
    what: string,
    issues: ReadonlyArray<{ path: ReadonlyArray<string | number> | string; message: string }>
  ) {
    const normalized = issues.map((issue) => ({
      path: Array.isArray(issue.path) ? [...issue.path] : [issue.path],
      message: issue.message,
    }));
    const detail = normalized
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    super(`Rejected ${what}: ${detail}`);
    this.name = 'DbContractError';
    this.issues = normalized;
  }
}

/**
 * Extract the low-level SQLite result code (e.g. `532870400` =
 * `SQLITE_BUSY`) from a thrown `node:sqlite` error, if present.
 */
export function sqliteErrcode(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'errcode' in error) {
    const errcode = (error as { errcode?: unknown }).errcode;
    return typeof errcode === 'number' ? errcode : undefined;
  }
  return undefined;
}

/** The numeric SQLite result code for `SQLITE_BUSY` (base code). */
export const SQLITE_BUSY = 5;

/**
 * Whether the thrown error is SQLite reporting a busy database (write lock
 * held past the configured busy timeout). Extended result codes encode the
 * base code in the low bits, so both are handled.
 */
export function isSqliteBusyError(error: unknown): boolean {
  const errcode = sqliteErrcode(error);
  return errcode !== undefined && errcode % 100 === SQLITE_BUSY;
}
