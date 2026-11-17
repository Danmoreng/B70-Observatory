import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { UtcTimestampSchema } from '@observatory/contracts';
import { DbContractError } from './errors.js';
import { MetricSampleSchema, type MetricSample } from './contracts.js';
import { ChangeSignal } from './change-signal.js';

const METRIC_NAME_REGEX = /^[A-Za-z0-9_:.-]+$/;

/**
 * Serialize label records canonically: keys sorted, stable JSON. Returns
 * `null` for "no labels" so the v2 unique index
 * `(source, name, COALESCE(labels, ''), atUtc)` treats an absent and an empty
 * label set identically (M2 review finding 2).
 */
function canonicalLabels(labels: Record<string, string> | undefined): string | null {
  if (labels === undefined || Object.keys(labels).length === 0) {
    return null;
  }
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(labels).sort()) {
    const value = labels[key];
    if (value !== undefined) {
      sorted[key] = value;
    }
  }
  return JSON.stringify(sorted);
}

export interface StoredMetricSample {
  id: number;
  source: string;
  name: string;
  value: number;
  unit: string;
  atUtc: string;
  /** Parsed back from the JSON `labels` column; `null` if absent. */
  labels: Record<string, string> | null;
}

export interface MetricQuery {
  source?: string;
  name?: string;
  /** Include samples at or after this instant. */
  fromUtc?: string;
  /** Include samples strictly before this instant. */
  toUtc?: string;
  limit?: number;
}

/**
 * Read-boundary contract for `aggregateHistory()` (M5A): the series is
 * fully pinned down by (source, name, label key), the window is a pair of
 * canonical UTC instants (inclusive) and the bucket width a bounded whole
 * number of seconds.
 */
const MetricHistoryQuerySchema = z
  .object({
    source: z.enum(['vllm', 'gpu', 'system', 'service']),
    name: z.string().min(1).max(128).regex(METRIC_NAME_REGEX),
    /**
     * Canonical (key-sorted) JSON of the label set, or the empty string
     * for a label-less series. Mirrors the `COALESCE(labels, '')` column
     * expression so equality matches the v2 series identity.
     */
    labelKey: z.string().max(1024).optional(),
    fromUtc: UtcTimestampSchema,
    toUtc: UtcTimestampSchema,
    bucketSeconds: z.number().int().min(1).max(86_400),
  })
  .strict();
export type MetricHistoryQuery = z.infer<typeof MetricHistoryQuerySchema>;

/** One aggregation bucket as returned by `aggregateHistory()`. */
export interface MetricBucketAggregation {
  /** Canonical UTC instant of the bucket start (epoch-aligned). */
  atUtc: string;
  min: number;
  max: number;
  avg: number;
  count: number;
}

/**
 * Repository for `metric_samples` (vLLM Prometheus, Intel GPU and system
 * collectors). Samples are normalized: one row = one named value with an
 * explicit unit, so the dashboard can graph without guessing.
 */
export class MetricRepository {
  readonly changes = new ChangeSignal();
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private insertOne(sample: MetricSample): number {
    const result = this.db
      .prepare(
        'INSERT INTO metric_samples (source, name, value, unit, atUtc, labels) ' +
          'VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        sample.source,
        sample.name,
        sample.value,
        sample.unit,
        sample.atUtc,
        canonicalLabels(sample.labels)
      );
    return Number(result.lastInsertRowid);
  }

  /** Insert one sample. Returns the new row id. */
  insert(input: unknown): number {
    const id = this.insertOne(this.parse(input));
    this.changes.notify();
    return id;
  }

  /**
   * Insert several samples atomically: if any sample fails its contract
   * check, none are written (single transaction).
   *
   * @returns the number of samples inserted.
   */
  insertMany(inputs: readonly unknown[]): number {
    const samples = inputs.map((input) => this.parse(input));
    this.db.exec('BEGIN');
    try {
      for (const sample of samples) {
        this.insertOne(sample);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    if (samples.length > 0) this.changes.notify();
    return samples.length;
  }

  query(filter: MetricQuery = {}): StoredMetricSample[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.source !== undefined) {
      clauses.push('source = ?');
      params.push(filter.source);
    }
    if (filter.name !== undefined) {
      clauses.push('name = ?');
      params.push(filter.name);
    }
    if (filter.fromUtc !== undefined) {
      clauses.push('atUtc >= ?');
      params.push(filter.fromUtc);
    }
    if (filter.toUtc !== undefined) {
      clauses.push('atUtc < ?');
      params.push(filter.toUtc);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(1, Math.trunc(filter.limit ?? 1000)), 10000);
    const rows = this.db
      .prepare(`SELECT * FROM metric_samples${where} ORDER BY atUtc ASC LIMIT ?`)
      .all(...params, limit) as Array<{
      id: number;
      source: string;
      name: string;
      value: number;
      unit: string;
      atUtc: string;
      labels: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      source: row.source,
      name: row.name,
      value: row.value,
      unit: row.unit,
      atUtc: row.atUtc,
      labels: row.labels === null ? null : (JSON.parse(row.labels) as Record<string, string>),
    }));
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM metric_samples').get() as { n: number };
    return row.n;
  }

  /**
   * Aggregate one series into fixed-width buckets (M5A). All math happens
   * inside SQLite – `GROUP BY` over the epoch-aligned bucket key – so only
   * the (bounded) result rows ever reach Node; the raw samples themselves
   * are never loaded into the process.
   *
   * The bucket width parameters are bound twice and cast to INTEGER in the
   * expression: `node:sqlite` binds plain JS numbers as REAL, which would
   * silently turn the floor-division into floating-point arithmetic.
   *
   * Buckets are aligned to the Unix epoch (`floor(epoch/bucket) * bucket`),
   * so `atUtc` values are comparable across calls and clients. Both window
   * bounds are inclusive; a bucket is emitted only when it contains at
   * least one sample (gaps are left out, `count` never reports zero).
   */
  aggregateHistory(query: MetricHistoryQuery): MetricBucketAggregation[] {
    const parsed = MetricHistoryQuerySchema.parse(query);
    const clauses = ['source = ?', 'name = ?', 'atUtc >= ?', 'atUtc <= ?'];
    const params: Array<string | number> = [
      parsed.source,
      parsed.name,
      parsed.fromUtc,
      parsed.toUtc,
    ];
    if (parsed.labelKey !== undefined) {
      clauses.push("COALESCE(labels, '') = ?");
      params.push(parsed.labelKey);
    }
    const rows = this.db
      .prepare(
        "SELECT (CAST(strftime('%s', atUtc) AS INTEGER) " +
          '/ CAST(? AS INTEGER) * CAST(? AS INTEGER)) AS bucket, ' +
          'MIN(value) AS min, MAX(value) AS max, AVG(value) AS avg, COUNT(*) AS count ' +
          `FROM metric_samples WHERE ${clauses.join(' AND ')} ` +
          'GROUP BY bucket ORDER BY bucket ASC'
      )
      .all(parsed.bucketSeconds, parsed.bucketSeconds, ...params) as Array<{
      bucket: number;
      min: number;
      max: number;
      avg: number;
      count: number;
    }>;
    return rows.map((row) => ({
      // Whole-second bucket starts format to the canonical .000Z form.
      atUtc: new Date(row.bucket * 1000).toISOString(),
      min: row.min,
      max: row.max,
      avg: row.avg,
      count: row.count,
    }));
  }

  private parse(input: unknown): MetricSample {
    const result = MetricSampleSchema.safeParse(input);
    if (!result.success) {
      throw new DbContractError('metric sample', result.error.issues);
    }
    return result.data;
  }
}
