import type { DatabaseSync } from 'node:sqlite';
import { UtcTimestampSchema } from '@observatory/contracts';
import { DbContractError } from './errors.js';

export interface RetentionCounts {
  requests: number;
  requestEvents: number;
  metricSamples: number;
  serviceEvents: number;
}

/**
 * Retention policy (M2, documented in the README):
 *
 * - one uniform horizon (`OBSERVATORY_RETENTION_DAYS`, default 30 days)
 *   applies to all four telemetry tables;
 * - a row is pruned when its timestamp is *strictly older* than the cutoff;
 *   rows exactly at the cutoff are kept;
 * - request events follow their request via `ON DELETE CASCADE`, so the
 *   foreign keys stay consistent without a second delete;
 * - everything runs in one transaction: prune is all-or-nothing.
 *
 * Scheduling the prune (e.g. daily via systemd timer) is deliberately M6;
 * M2 ships the validated, transactional primitive plus the cutoff helper.
 */
export function retentionCutoffUtc(retentionDays: number, now: Date): string {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new DbContractError('retentionDays', [
      { path: 'retentionDays', message: 'must be a positive whole number of days' },
    ]);
  }
  return new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
}

/**
 * Delete all telemetry strictly older than `cutoffUtc`.
 * @returns per-table counts of the deleted rows.
 */
export function pruneOlderThan(db: DatabaseSync, cutoffUtc: string): RetentionCounts {
  const check = UtcTimestampSchema.safeParse(cutoffUtc);
  if (!check.success) {
    throw new DbContractError('retention cutoff', check.error.issues);
  }

  const counts: RetentionCounts = {
    requests: 0,
    requestEvents: 0,
    metricSamples: 0,
    serviceEvents: 0,
  };
  try {
    db.exec('BEGIN');
    // Events whose request survives are pruned by their own timestamp;
    // events whose request is pruned are deleted here explicitly so the
    // returned counts are honest (the FK cascade would then find nothing).
    counts.metricSamples = Number(
      db.prepare('DELETE FROM metric_samples WHERE atUtc < ?').run(cutoffUtc).changes
    );
    counts.serviceEvents = Number(
      db.prepare('DELETE FROM service_events WHERE atUtc < ?').run(cutoffUtc).changes
    );
    counts.requestEvents = Number(
      db
        .prepare(
          'DELETE FROM request_events ' +
            'WHERE atUtc < ? OR requestId IN (SELECT id FROM requests WHERE startedAtUtc < ?)'
        )
        .run(cutoffUtc, cutoffUtc).changes
    );
    counts.requests = Number(
      db.prepare('DELETE FROM requests WHERE startedAtUtc < ?').run(cutoffUtc).changes
    );
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Transaction already gone; keep the original error.
    }
    throw error;
  }
  return counts;
}
