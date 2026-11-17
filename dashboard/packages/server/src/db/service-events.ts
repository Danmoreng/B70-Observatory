import type { DatabaseSync } from 'node:sqlite';
import { DbContractError } from './errors.js';
import { ServiceEventSchema, type ServiceEvent } from './contracts.js';

export interface StoredServiceEvent {
  id: number;
  service: string;
  severity: string;
  type: string;
  atUtc: string;
  detail: string | null;
}

export interface ServiceEventFilter {
  service?: string;
  /** Include events at or after this instant. */
  sinceUtc?: string;
  limit?: number;
}

/** Repository for `service_events` (lifecycle of the observatory itself). */
export class ServiceEventRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Insert one event. Returns the new row id. */
  insert(input: unknown): number {
    const result = ServiceEventSchema.safeParse(input);
    if (!result.success) {
      throw new DbContractError('service event', result.error.issues);
    }
    const event: ServiceEvent = result.data;
    const run = this.db
      .prepare(
        'INSERT INTO service_events (service, severity, type, atUtc, detail) ' +
          'VALUES (?, ?, ?, ?, ?)'
      )
      .run(event.service, event.severity, event.type, event.atUtc, null);
    return Number(run.lastInsertRowid);
  }

  list(filter: ServiceEventFilter = {}): StoredServiceEvent[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.service !== undefined) {
      clauses.push('service = ?');
      params.push(filter.service);
    }
    if (filter.sinceUtc !== undefined) {
      clauses.push('atUtc >= ?');
      params.push(filter.sinceUtc);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(1, Math.trunc(filter.limit ?? 200)), 1000);
    const rows = this.db
      .prepare(`SELECT * FROM service_events${where} ORDER BY atUtc ASC LIMIT ?`)
      .all(...params, limit) as unknown as StoredServiceEvent[];
    return rows;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM service_events').get() as { n: number };
    return row.n;
  }
}
