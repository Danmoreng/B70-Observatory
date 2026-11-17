import type { DatabaseSync } from 'node:sqlite';
import { DatabaseError } from './errors.js';

/**
 * Versioned, forward-only database migrations.
 *
 * Conventions (M2 + review rework):
 * - Migrations only ever ADD or EXTEND. They are never rolled back;
 *   "down" migrations are intentionally not supported (project brief:
 *   "vorwärts laufende Migrationen").
 * - Each migration runs in its **own transaction together with its
 *   `schema_migrations` bookkeeping row** (review finding 6). A successful
 *   earlier migration therefore survives a later failure and is not
 *   re-run on the next start.
 * - The migration table itself must be a contiguous, ascending sequence
 *   1..N; anything else (gaps, out of order, not starting at 1) is
 *   rejected before anything is executed.
 * - Timestamps are stored in the canonical `Date.toISOString()` form
 *   (`YYYY-MM-DDTHH:mm:ss.sssZ`). They sort correctly lexicographically,
 *   which the retention pruner and all range queries rely on.
 * - Durations are stored as whole milliseconds (`*Ms`); the API wire
 *   contract uses whole seconds (`*Seconds`); `responseBytes` is only
 *   known when the request finishes, so `finish()` writes it (review
 *   finding 3).
 *
 * Security: only sanitized metadata is stored. The write contracts contain
 * no free-text fields, so raw LLM content has no column to land in; the
 * pre-existing `detail`/`errorMessage` columns are kept for compatibility
 * but are never written (review finding 4).
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-telemetry-schema',
    up: `
CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL DEFAULT 'unknown'
    CHECK (origin IN ('web', 'pi', 'script', 'cli', 'unknown')),
  model TEXT CHECK (model IS NULL OR length(model) <= 128),
  endpoint TEXT NOT NULL CHECK (length(endpoint) <= 512),
  method TEXT NOT NULL DEFAULT 'POST'
    CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')),
  status TEXT NOT NULL
    CHECK (status IN ('in_progress', 'completed', 'error', 'aborted')),
  httpStatus INTEGER CHECK (httpStatus IS NULL OR httpStatus BETWEEN 100 AND 599),
  startedAtUtc TEXT NOT NULL,
  completedAtUtc TEXT,
  durationMs INTEGER CHECK (durationMs IS NULL OR durationMs >= 0),
  ttftMs INTEGER CHECK (ttftMs IS NULL OR ttftMs >= 0),
  promptTokens INTEGER CHECK (promptTokens IS NULL OR promptTokens >= 0),
  completionTokens INTEGER CHECK (completionTokens IS NULL OR completionTokens >= 0),
  totalTokens INTEGER CHECK (totalTokens IS NULL OR totalTokens >= 0),
  promptBytes INTEGER NOT NULL DEFAULT 0 CHECK (promptBytes >= 0),
  responseBytes INTEGER NOT NULL DEFAULT 0 CHECK (responseBytes >= 0),
  prefixCacheQueries INTEGER CHECK (prefixCacheQueries IS NULL OR prefixCacheQueries >= 0),
  prefixCacheHits INTEGER CHECK (prefixCacheHits IS NULL OR prefixCacheHits >= 0),
  mtpDraftTokens INTEGER CHECK (mtpDraftTokens IS NULL OR mtpDraftTokens >= 0),
  mtpAcceptedTokens INTEGER CHECK (mtpAcceptedTokens IS NULL OR mtpAcceptedTokens >= 0),
  errorCode TEXT CHECK (errorCode IS NULL OR length(errorCode) <= 64),
  errorMessage TEXT CHECK (errorMessage IS NULL OR length(errorMessage) <= 512)
);
CREATE INDEX idx_requests_started_at ON requests(startedAtUtc);
CREATE INDEX idx_requests_status ON requests(status);
CREATE INDEX idx_requests_model ON requests(model);

CREATE TABLE request_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requestId TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  eventType TEXT NOT NULL
    CHECK (eventType IN ('start', 'first_token', 'token', 'error', 'abort', 'complete')),
  atUtc TEXT NOT NULL,
  detail TEXT CHECK (detail IS NULL OR length(detail) <= 4096)
);
CREATE UNIQUE INDEX uq_request_events_sequence ON request_events(requestId, sequence);
CREATE INDEX idx_request_events_at ON request_events(atUtc);

CREATE TABLE metric_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK (source IN ('vllm', 'gpu', 'system', 'service')),
  name TEXT NOT NULL CHECK (length(name) <= 128),
  value REAL NOT NULL,
  unit TEXT NOT NULL CHECK (length(unit) <= 32),
  atUtc TEXT NOT NULL,
  labels TEXT
);
CREATE UNIQUE INDEX uq_metric_samples ON metric_samples(source, name, atUtc);
CREATE INDEX idx_metric_samples_at ON metric_samples(atUtc);

CREATE TABLE service_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL CHECK (service IN ('api', 'gateway', 'vllm', 'gpu', 'system')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'error')),
  type TEXT NOT NULL CHECK (length(type) <= 64),
  atUtc TEXT NOT NULL,
  detail TEXT CHECK (detail IS NULL OR length(detail) <= 4096)
);
CREATE INDEX idx_service_events_at ON service_events(atUtc);
CREATE INDEX idx_service_events_service ON service_events(service);
`,
  },
  {
    // Review finding 2: labels are part of the metric series identity, so
    // the same (source, name, atUtc) may exist once per distinct label
    // set. The v1 unique index (source, name, atUtc) is replaced; the v1
    // table definition itself stays untouched (forward-only: indexes
    // only). COALESCE maps "no labels" (SQL NULL) onto a stable key so
    // two label-less samples of the same series still collide.
    version: 2,
    name: 'metric-samples-series-identity',
    up: `
DROP INDEX uq_metric_samples;
CREATE UNIQUE INDEX uq_metric_samples_series
  ON metric_samples(source, name, COALESCE(labels, ''), atUtc);
`,
  },
  {
    version: 3,
    name: 'browser-auth-sessions',
    up: `
CREATE TABLE auth_sessions (
  tokenHash TEXT PRIMARY KEY CHECK (length(tokenHash) = 64),
  credentialHash TEXT NOT NULL CHECK (length(credentialHash) = 64),
  createdAtUtc TEXT NOT NULL,
  lastSeenAtUtc TEXT NOT NULL,
  expiresAtUtc TEXT NOT NULL
);
CREATE INDEX idx_auth_sessions_expires_at ON auth_sessions(expiresAtUtc);
`,
  },
  {
    // M5A: the read-only history API pages the request list newest first
    // with the keyset `(startedAtUtc DESC, id DESC)` and aggregates metric
    // history per series. Both hot read access patterns get indexes.
    // Forward-only: v1/v2/v3 schema objects stay untouched.
    version: 4,
    name: 'history-query-indexes',
    up: `
CREATE INDEX idx_requests_keyset ON requests(startedAtUtc DESC, id DESC);
CREATE INDEX idx_metric_samples_series_at ON metric_samples(source, name, atUtc);
`,
  },
];

interface SchemaMigrationRow {
  version: number;
}

function appliedVersions(db: DatabaseSync): number[] {
  const rows = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all() as unknown as SchemaMigrationRow[];
  return rows.map((row) => row.version);
}

/**
 * Apply all pending migrations. Idempotent: already applied versions are
 * skipped. Invariants are enforced up front:
 *
 * - the migration table itself must be a contiguous, ascending sequence
 *   starting at 1 (`migrations_invalid` otherwise);
 * - the database may not contain versions the code does not know
 *   ("database is ahead of the application" – roll back the binary, not
 *   the data);
 * - applied version history must be gap-free (1, 2, 3, …), otherwise it
 *   is considered corrupt and the application refuses to start.
 *
 * Each pending migration runs in its own transaction that also commits the
 * bookkeeping row (review finding 6): if migration 3 fails, migrations 1
 * and 2 stay committed and are not re-run on the next start.
 *
 * @returns the number of migrations applied during this call.
 */
function validateMigrationTable(migrations: readonly Migration[]): void {
  if (migrations.length === 0) {
    throw new DatabaseError(
      'invalid migration table: no migrations provided',
      'migrations_invalid'
    );
  }
  let expected = 1;
  for (const migration of migrations) {
    if (migration.version !== expected) {
      throw new DatabaseError(
        `invalid migration table: entry ${expected} has version ` +
          `${migration.version}; migrations must be contiguous and ` +
          'strictly ascending starting at 1',
        'migrations_invalid'
      );
    }
    expected += 1;
  }
}

export function applyMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS
): number {
  validateMigrationTable(migrations);
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (' +
      'version INTEGER PRIMARY KEY, ' +
      'name TEXT NOT NULL, ' +
      'appliedAtUtc TEXT NOT NULL' +
      ')'
  );

  const applied = new Set(appliedVersions(db));
  if (applied.size > 0) {
    const maxApplied = Math.max(...applied);
    const maxKnown = Math.max(...migrations.map((migration) => migration.version));
    if (maxApplied > maxKnown) {
      throw new DatabaseError(
        `database is ahead of the application: schema version ${maxApplied} applied, ` +
          `but the code only knows up to version ${maxKnown}. Refusing to migrate backwards.`,
        'schema_ahead'
      );
    }
    for (let version = 1; version <= maxApplied; version += 1) {
      if (!applied.has(version)) {
        throw new DatabaseError(
          `schema history is corrupt: version ${version} is missing while newer versions are applied`,
          'schema_corrupt'
        );
      }
    }
  }

  const pending = migrations.filter((migration) => !applied.has(migration.version));
  if (pending.length === 0) {
    return 0;
  }

  const inserted = db.prepare(
    'INSERT INTO schema_migrations (version, name, appliedAtUtc) VALUES (?, ?, ?)'
  );
  let appliedInThisCall = 0;
  for (const migration of pending) {
    // One transaction per migration, including its bookkeeping row: a
    // successful earlier migration stays committed even if a later one
    // fails (review finding 6).
    db.exec('BEGIN');
    try {
      db.exec(migration.up);
      inserted.run(migration.version, migration.name, new Date().toISOString());
      db.exec('COMMIT');
      appliedInThisCall += 1;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The transaction is already gone (e.g. connection loss); keep
        // the original error, which is the more useful one.
      }
      throw new DatabaseError(
        `migration ${migration.version} (${migration.name}) failed and was rolled back: ` +
          `${(error as Error).message}`,
        'migration_failed'
      );
    }
  }
  return appliedInThisCall;
}
