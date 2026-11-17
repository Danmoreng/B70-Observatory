import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  MemoryRecordSchema,
  MemoryWriteSchema,
  type MemoryRecord,
  type MemoryWrite,
} from '@observatory/contracts';
import { EMBEDDING_FINGERPRINT, type MemoryEmbedder } from './embedding.js';

export interface MemoryPolicy {
  owner: boolean;
  projectId?: string;
  sharedOnly?: boolean;
}
interface Row {
  id: string;
  version: number;
  payload: string;
  created_at: string;
  updated_at: string;
}
export class MemoryError extends Error {
  constructor(
    readonly code: 'conflict' | 'not_found' | 'invalid' | 'unavailable',
    message: string
  ) {
    super(message);
  }
}
export function redactMemory(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~-]{16,}/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
      '[REDACTED]'
    )
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY))\s*=\s*[^\s\n]+/g,
      '$1=[REDACTED]'
    );
}
/** Independent canonical store; source histories are never modified. */
export class MemoryStore {
  readonly database: DatabaseSync;
  private indexing?: Promise<void>;
  private stopped = false;
  private error?: string;
  private importError?: string;
  private vector = false;
  constructor(
    path: string | DatabaseSync,
    private readonly embedder?: MemoryEmbedder,
    extension?: string,
    readonly machineId = 'b70-workstation',
    private readonly canIndex: () => boolean = () => true
  ) {
    if (typeof path === 'string' && path !== ':memory:')
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database =
      typeof path === 'string'
        ? new DatabaseSync(path, { allowExtension: extension !== undefined, timeout: 5000 })
        : path;
    const db = this.database;
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    if (version > 1) throw new Error('Unsupported memory schema.');
    db.exec(`CREATE TABLE IF NOT EXISTS memory_records(
      id TEXT PRIMARY KEY,version INTEGER NOT NULL,scope TEXT NOT NULL,project_id TEXT,machine_id TEXT NOT NULL,
      kind TEXT NOT NULL,status TEXT NOT NULL,visibility TEXT NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,
      payload TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,valid_until TEXT,identity TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS memory_revisions(record_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,version INTEGER NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(record_id,version));
      CREATE TABLE IF NOT EXISTS memory_chunks(id INTEGER PRIMARY KEY,record_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,text TEXT NOT NULL,digest TEXT NOT NULL,embedded INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS memory_chunk_record ON memory_chunks(record_id);
      CREATE INDEX IF NOT EXISTS memory_scope ON memory_records(scope,project_id,status);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(title,text,content='');
      CREATE TABLE IF NOT EXISTS memory_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_jobs(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,request_id TEXT NOT NULL,created_at TEXT NOT NULL,status TEXT NOT NULL,details_json TEXT NOT NULL);
      PRAGMA user_version=1;`);
    db.exec(`CREATE TABLE IF NOT EXISTS memory_images(
      id INTEGER PRIMARY KEY,record_id TEXT UNIQUE NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
      data BLOB NOT NULL,mime_type TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,sha256 TEXT NOT NULL,
      purpose TEXT NOT NULL,run_id TEXT NOT NULL,source_image_id TEXT NOT NULL,captured_at TEXT NOT NULL,revision TEXT NOT NULL,embedded INTEGER NOT NULL DEFAULT 0);`);
    if (extension) {
      db.loadExtension(extension);
      db.enableLoadExtension(false);
      db.exec(
        'CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(chunk_id INTEGER PRIMARY KEY,embedding float[768] distance_metric=cosine)'
      );
      db.exec(
        'CREATE VIRTUAL TABLE IF NOT EXISTS memory_image_vectors USING vec0(image_id INTEGER PRIMARY KEY,embedding float[768] distance_metric=cosine)'
      );
      this.vector = true;
    }
    db.prepare("UPDATE memory_jobs SET status='interrupted' WHERE status='running'").run();
    this.importError = (
      db.prepare("SELECT value FROM memory_meta WHERE key='import_error'").get() as
        { value: string } | undefined
    )?.value;
    const old = db
      .prepare("SELECT value FROM memory_meta WHERE key='embedding_fingerprint'")
      .get() as { value: string } | undefined;
    if (old && old.value !== EMBEDDING_FINGERPRINT)
      throw new Error('Memory embedding fingerprint changed; rebuild the derived vector index.');
    db.prepare("INSERT OR IGNORE INTO memory_meta VALUES('embedding_fingerprint',?)").run(
      EMBEDDING_FINGERPRINT
    );
  }
  private decode(row: Row): MemoryRecord {
    return MemoryRecordSchema.parse({
      ...JSON.parse(row.payload),
      id: row.id,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      machineId: this.machineId,
      image: this.imageMetadata(row.id),
    });
  }
  private imageMetadata(id: string) {
    const r = this.database
      .prepare(
        'SELECT id,mime_type,width,height,sha256,purpose,run_id,source_image_id,captured_at,revision,embedded,length(data) byte_length FROM memory_images WHERE record_id=?'
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: Number(r.id),
      mimeType: r.mime_type,
      width: r.width,
      height: r.height,
      byteLength: r.byte_length,
      sha256: r.sha256,
      purpose: r.purpose,
      runId: r.run_id,
      sourceImageId: r.source_image_id,
      capturedAt: r.captured_at,
      revision: r.revision,
      embedded: !!r.embedded,
    };
  }
  attachImage(
    id: string,
    input: {
      data: Buffer;
      mimeType: string;
      width: number;
      height: number;
      purpose: string;
      runId: string;
      sourceImageId: string;
      capturedAt: string;
      revision: string;
    }
  ): void {
    this.get(id, { owner: true });
    const used = (
      this.database.prepare('SELECT coalesce(sum(length(data)),0) n FROM memory_images').get() as {
        n: number;
      }
    ).n;
    if (input.data.length > 2 * 1024 * 1024 || used + input.data.length > 2 * 1024 ** 3)
      throw new MemoryError('invalid', 'Visual memory storage budget reached.');
    this.database
      .prepare(
        'INSERT INTO memory_images(record_id,data,mime_type,width,height,sha256,purpose,run_id,source_image_id,captured_at,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        id,
        input.data,
        input.mimeType,
        input.width,
        input.height,
        createHash('sha256').update(input.data).digest('hex'),
        input.purpose,
        input.runId,
        input.sourceImageId,
        input.capturedAt,
        input.revision
      );
    this.error = undefined;
    void this.indexPending();
  }
  image(id: string, policy: MemoryPolicy): { mimeType: string; data: string } {
    this.get(id, policy);
    if (policy.sharedOnly) throw new MemoryError('not_found', 'Original image is local.');
    const row = this.database
      .prepare('SELECT mime_type,data FROM memory_images WHERE record_id=?')
      .get(id) as { mime_type: string; data: Uint8Array } | undefined;
    if (!row) throw new MemoryError('not_found', 'Memory image not found.');
    return { mimeType: row.mime_type, data: Buffer.from(row.data).toString('base64') };
  }
  private row(id: string): Row {
    const row = this.database
      .prepare('SELECT * FROM memory_records WHERE id=?')
      .get(id) as unknown as Row | undefined;
    if (!row) throw new MemoryError('not_found', 'Memory entry not found.');
    return row;
  }
  private predicate(
    policy: MemoryPolicy,
    options: { projectId?: string; scope?: string; includeEpisodes?: boolean } = {}
  ): { sql: string; args: Array<string> } {
    const parts = ['1=1'];
    const args: string[] = [];
    if (!policy.owner) {
      parts.push(
        "r.status='confirmed'",
        '(r.valid_until IS NULL OR r.valid_until>?)',
        "(r.scope='developer' OR (r.scope='workstation' AND r.machine_id=?) OR (r.scope='project' AND r.project_id=?))"
      );
      args.push(new Date().toISOString(), this.machineId, policy.projectId ?? '');
      if (policy.sharedOnly) parts.push("r.visibility='shared'");
    }
    if (options.projectId) {
      parts.push("(r.scope<>'project' OR r.project_id=?)");
      args.push(options.projectId);
    }
    if (options.scope) {
      parts.push('r.scope=?');
      args.push(options.scope);
    }
    if (!options.includeEpisodes) parts.push("r.kind<>'episode'");
    return { sql: parts.join(' AND '), args };
  }
  list(policy: MemoryPolicy, options: { projectId?: string; scope?: string } = {}): MemoryRecord[] {
    const f = this.predicate(policy, { ...options, includeEpisodes: true });
    return (
      this.database
        .prepare(
          'SELECT r.* FROM memory_records r WHERE ' +
            f.sql +
            ' ORDER BY updated_at DESC,id LIMIT 300'
        )
        .all(...f.args) as unknown as Row[]
    ).map((row) => this.decode(row));
  }
  get(id: string, policy: MemoryPolicy): MemoryRecord {
    const row = this.row(id);
    const f = this.predicate(policy, { includeEpisodes: true });
    if (
      !this.database
        .prepare('SELECT 1 FROM memory_records r WHERE r.id=? AND ' + f.sql)
        .get(id, ...f.args)
    )
      throw new MemoryError('not_found', 'Memory entry not found.');
    return this.decode(row);
  }
  write(
    raw: MemoryWrite,
    policy: MemoryPolicy,
    expected?: { id: string; version: number },
    identity?: string
  ): MemoryRecord {
    const value = MemoryWriteSchema.parse(raw);
    if (
      !policy.owner &&
      (value.status !== 'proposed' ||
        value.projectId !== policy.projectId ||
        value.scope !== 'project' ||
        value.kind === 'episode' ||
        value.visibility !== 'local' ||
        expected)
    )
      throw new MemoryError(
        'invalid',
        'Agents can only propose local memory for their current project.'
      );
    const entry = {
      ...value,
      title: redactMemory(value.title),
      content: redactMemory(value.content),
    };
    const db = this.database;
    const id = expected?.id ?? randomUUID();
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      if (expected && this.decode(this.row(id)).kind === 'episode')
        throw new MemoryError(
          'invalid',
          'Historical source passages are read-only; create a separate knowledge note or delete the indexed passage.'
        );
      if (expected && this.row(id).version !== expected.version)
        throw new MemoryError('conflict', 'Memory changed; reload before editing.');
      const usage = db
        .prepare(
          `SELECT COUNT(*) n,
        COALESCE(SUM(length(CAST(payload AS BLOB))),0) + (SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) FROM memory_revisions) bytes
        FROM memory_records`
        )
        .get() as { n: number; bytes: number };
      const payloadBytes = Buffer.byteLength(JSON.stringify(entry));
      if ((!expected && usage.n >= 20000) || usage.bytes + payloadBytes * 2 > 128 * 1024 * 1024)
        throw new MemoryError(
          'invalid',
          'Memory storage budget reached (128 MiB canonical text and revisions).'
        );
      const version = (expected?.version ?? 0) + 1;
      if (expected) {
        this.removeChunks(id);
        db.prepare(
          'UPDATE memory_records SET version=?,scope=?,project_id=?,machine_id=?,kind=?,status=?,visibility=?,title=?,content=?,payload=?,updated_at=?,valid_until=? WHERE id=?'
        ).run(
          version,
          entry.scope,
          entry.projectId ?? null,
          this.machineId,
          entry.kind,
          entry.status,
          entry.visibility,
          entry.title,
          entry.content,
          JSON.stringify(entry),
          now,
          entry.validUntil ?? null,
          id
        );
      } else
        db.prepare('INSERT INTO memory_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
          id,
          version,
          entry.scope,
          entry.projectId ?? null,
          this.machineId,
          entry.kind,
          entry.status,
          entry.visibility,
          entry.title,
          entry.content,
          JSON.stringify(entry),
          now,
          now,
          entry.validUntil ?? null,
          identity ?? null
        );
      db.prepare('INSERT INTO memory_revisions VALUES(?,?,?,?)').run(
        id,
        version,
        JSON.stringify(entry),
        now
      );
      // Small chunks preserve source record IDs; no chat-level aggregation.
      const characters = Array.from(entry.content);
      for (let offset = 0; offset < characters.length;) {
        let end = offset,
          bytes = 0;
        while (end < characters.length && bytes + Buffer.byteLength(characters[end]!) <= 2400)
          bytes += Buffer.byteLength(characters[end++]!);
        const text = characters.slice(offset, end).join('');
        const digest = createHash('sha256')
          .update(entry.title + '\n' + text)
          .digest('hex');
        const result = db
          .prepare('INSERT INTO memory_chunks(record_id,text,digest) VALUES(?,?,?)')
          .run(id, text, digest);
        db.prepare('INSERT INTO memory_fts(rowid,title,text) VALUES(?,?,?)').run(
          result.lastInsertRowid,
          entry.title,
          text
        );
        if (end === characters.length) break;
        offset = Math.max(offset + 1, end - 80);
      }
      db.exec('COMMIT');
      this.error = undefined;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    void this.indexPending();
    return this.get(id, { owner: true });
  }
  private removeChunks(id: string): void {
    const db = this.database;
    const chunks = db
      .prepare('SELECT id,text FROM memory_chunks WHERE record_id=?')
      .all(id) as Array<{ id: number; text: string }>;
    const record = db.prepare('SELECT title FROM memory_records WHERE id=?').get(id) as
      { title: string } | undefined;
    for (const chunk of chunks) {
      db.prepare("INSERT INTO memory_fts(memory_fts,rowid,title,text) VALUES('delete',?,?,?)").run(
        chunk.id,
        record?.title ?? '',
        chunk.text
      );
      if (this.vector)
        db.prepare('DELETE FROM memory_vectors WHERE chunk_id=?').run(BigInt(chunk.id));
    }
    db.prepare('DELETE FROM memory_chunks WHERE record_id=?').run(id);
  }
  remove(id: string, version: number): void {
    const db = this.database;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (this.row(id).version !== version)
        throw new MemoryError('conflict', 'Memory changed; reload before deleting.');
      this.removeChunks(id);
      if (this.vector)
        db.prepare(
          'DELETE FROM memory_image_vectors WHERE image_id IN (SELECT id FROM memory_images WHERE record_id=?)'
        ).run(id);
      db.prepare('DELETE FROM memory_records WHERE id=?').run(id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  history(id: string): MemoryRecord[] {
    const current = this.get(id, { owner: true });
    return (
      this.database
        .prepare(
          'SELECT version,payload,created_at FROM memory_revisions WHERE record_id=? ORDER BY version DESC LIMIT 100'
        )
        .all(id) as Array<{ version: number; payload: string; created_at: string }>
    ).map((row) =>
      MemoryRecordSchema.parse({
        ...JSON.parse(row.payload),
        id,
        version: row.version,
        machineId: this.machineId,
        createdAt: row.created_at,
        updatedAt: row.created_at,
        ...(current.score === undefined ? {} : { score: current.score }),
      })
    );
  }
  async search(
    query: string,
    policy: MemoryPolicy,
    options: { projectId?: string; includeEpisodes?: boolean; limit?: number } = {}
  ): Promise<{ items: MemoryRecord[]; warning?: string }> {
    const f = this.predicate(policy, options);
    const db = this.database;
    const terms = query
      .match(/[\p{L}\p{N}_-]+/gu)
      ?.slice(0, 24)
      .map((term) => '"' + term.replace(/"/g, '""') + '"')
      .join(' OR ');
    if (!terms) return { items: [] };
    const candidates = new Map<string, number>();
    const add = (rows: Array<{ record_id: string }>, weight: number) => {
      const seen = new Set<string>();
      let rank = 0;
      for (const row of rows) {
        if (seen.has(row.record_id)) continue;
        seen.add(row.record_id);
        candidates.set(
          row.record_id,
          (candidates.get(row.record_id) ?? 0) + weight / (60 + ++rank)
        );
      }
    };
    add(
      db
        .prepare(
          'SELECT c.record_id FROM memory_fts JOIN memory_chunks c ON c.id=memory_fts.rowid JOIN memory_records r ON r.id=c.record_id WHERE memory_fts MATCH ? AND ' +
            f.sql +
            ' ORDER BY bm25(memory_fts,4,1) LIMIT 100'
        )
        .all(terms, ...f.args) as Array<{ record_id: string }>,
      1
    );
    let warning: string | undefined;
    if (this.vector && this.embedder?.ready()) {
      try {
        const vector = await this.embedder.encode(query, true);
        if (this.embedder.visionReady?.())
          add(
            db
              .prepare(
                'SELECT a.record_id FROM memory_image_vectors v JOIN memory_images a ON a.id=v.image_id WHERE v.embedding MATCH ? AND k=100 AND v.image_id IN (SELECT a2.id FROM memory_images a2 JOIN memory_records r ON r.id=a2.record_id WHERE ' +
                  f.sql +
                  ') ORDER BY distance'
              )
              .all(new Float32Array(vector), ...f.args) as Array<{ record_id: string }>,
            1
          );
        // Authorization and expiry constrain the KNN candidate set before ranking.
        add(
          db
            .prepare(
              'SELECT c.record_id FROM memory_vectors v JOIN memory_chunks c ON c.id=v.chunk_id WHERE v.embedding MATCH ? AND k=100 AND v.chunk_id IN (SELECT c2.id FROM memory_chunks c2 JOIN memory_records r ON r.id=c2.record_id WHERE ' +
                f.sql +
                ') ORDER BY distance'
            )
            .all(new Float32Array(vector), ...f.args) as Array<{ record_id: string }>,
          1
        );
      } catch {
        warning = 'Semantic search unavailable; showing keyword results.';
      }
    } else warning = 'Semantic search is not configured; showing keyword results.';
    const items = [...candidates]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, options.limit ?? 12)
      .flatMap(([id, score]) => {
        // Recheck after asynchronous inference: correction/deletion can happen meanwhile.
        try {
          return [{ ...this.get(id, policy), score }];
        } catch {
          return [];
        }
      });
    return { items, ...(warning ? { warning } : {}) };
  }
  indexPending(): Promise<void> {
    if (this.indexing) return this.indexing;
    if (!this.vector || !this.embedder?.ready() || this.stopped || this.error)
      return Promise.resolve();
    this.indexing = (async () => {
      while (!this.stopped && this.canIndex()) {
        const hour = Number(
          new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Europe/Berlin',
            hour: '2-digit',
            hourCycle: 'h23',
          }).format(new Date())
        );
        const minute = Number(
          new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', minute: '2-digit' }).format(
            new Date()
          )
        );
        if (hour > 22 || (hour === 22 && minute >= 45)) break;
        const chunk = this.database
          .prepare(
            'SELECT c.id,c.text,c.digest,r.title FROM memory_chunks c JOIN memory_records r ON r.id=c.record_id WHERE c.embedded=0 ORDER BY c.id LIMIT 1'
          )
          .get() as { id: number; text: string; digest: string; title: string } | undefined;
        if (!chunk) {
          if (!this.embedder?.visionReady?.() || !this.embedder.encodeImage) break;
          const image = this.database
            .prepare('SELECT id,data FROM memory_images WHERE embedded=0 ORDER BY id LIMIT 1')
            .get() as { id: number; data: Uint8Array } | undefined;
          if (!image) break;
          const vector = await this.embedder.encodeImage(Buffer.from(image.data));
          if (this.stopped) break;
          if (!this.database.prepare('SELECT 1 FROM memory_images WHERE id=?').get(image.id))
            continue;
          this.database
            .prepare('INSERT OR REPLACE INTO memory_image_vectors(image_id,embedding) VALUES(?,?)')
            .run(BigInt(image.id), new Float32Array(vector));
          this.database.prepare('UPDATE memory_images SET embedded=1 WHERE id=?').run(image.id);
          continue;
        }
        const vector = await this.embedder!.encode(
          'title: ' + chunk.title + ' | text: ' + chunk.text,
          false
        );
        if (this.stopped) break;
        const current = this.database
          .prepare('SELECT digest FROM memory_chunks WHERE id=?')
          .get(chunk.id) as { digest: string } | undefined;
        if (current?.digest !== chunk.digest) continue;
        this.database
          .prepare('INSERT OR REPLACE INTO memory_vectors(chunk_id,embedding) VALUES(?,?)')
          .run(BigInt(chunk.id), new Float32Array(vector));
        this.database.prepare('UPDATE memory_chunks SET embedded=1 WHERE id=?').run(chunk.id);
      }
    })()
      .catch(() => {
        this.error = 'Background embedding failed; use maintenance to retry.';
      })
      .finally(() => {
        this.indexing = undefined;
      });
    return this.indexing;
  }
  status() {
    const db = this.database;
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    return {
      records: n('SELECT COUNT(*) n FROM memory_records'),
      proposed: n(
        "SELECT COUNT(*) n FROM memory_records WHERE status='proposed' AND kind<>'episode'"
      ),
      confirmed: n(
        "SELECT COUNT(*) n FROM memory_records WHERE status='confirmed' AND kind<>'episode'"
      ),
      episodes: n("SELECT COUNT(*) n FROM memory_records WHERE kind='episode'"),
      embedded: n('SELECT COUNT(*) n FROM memory_chunks WHERE embedded=1'),
      chunks: n('SELECT COUNT(*) n FROM memory_chunks'),
      model: 'google/embeddinggemma-2',
      dimensions: 768,
      backend: 'cpu' as const,
      images: n('SELECT count(*) n FROM memory_images'),
      embeddedImages: n('SELECT count(*) n FROM memory_images WHERE embedded=1'),
      visionReady: this.embedder?.visionReady?.() ?? false,
      semanticReady: this.vector && (this.embedder?.ready() ?? false),
      indexing: this.indexing !== undefined,
      ...(this.error || this.importError ? { error: this.error ?? this.importError } : {}),
    };
  }
  noteImportFailure(): void {
    this.importError =
      'A completed run could not be indexed. Its original trace is preserved; retry its import after checking storage.';
    this.database
      .prepare(
        "INSERT INTO memory_meta VALUES('import_error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      )
      .run(this.importError);
  }
  clearImportError(): void {
    this.importError = undefined;
    this.database.prepare("DELETE FROM memory_meta WHERE key='import_error'").run();
  }
  maintenance() {
    const groups = this.database
      .prepare(
        "SELECT group_concat(id) ids FROM memory_records WHERE kind<>'episode' AND status<>'superseded' GROUP BY scope,COALESCE(project_id,''),lower(trim(content)) HAVING count(*)>1"
      )
      .all() as Array<{ ids: string }>;
    const expired = this.database
      .prepare('SELECT id FROM memory_records WHERE valid_until<=?')
      .all(new Date().toISOString()) as Array<{ id: string }>;
    this.error = undefined;
    void this.indexPending();
    return {
      duplicateGroups: groups.map((g) => g.ids.split(',')),
      expired: expired.map((r) => r.id),
    };
  }
  async context(
    query: string,
    projectId: string,
    revision?: string
  ): Promise<{ text: string; ids: string[] }> {
    const policy: MemoryPolicy = { owner: false, projectId };
    const fixed = this.list(policy)
      .filter((r) => r.kind !== 'episode' && r.scope !== 'project')
      .slice(0, 6);
    const results = (await this.search(query, policy, { limit: 8 })).items;
    const chosen = [...new Map([...fixed, ...results].map((item) => [item.id, item])).values()];
    let text = '';
    const ids: string[] = [];
    for (const item of chosen) {
      const stale =
        revision &&
        item.sources.some(
          (source) =>
            source.kind === 'code' && /^[a-f0-9]{40}$/.test(source.ref) && source.ref !== revision
        );
      const block = `${stale ? '[Different source revision: recheck against current code]\n' : ''}[${item.id} v${item.version} | ${item.scope} | ${item.updatedAt}] ${item.title}\n${item.content}\nSources: ${item.sources.map((s) => s.kind + ':' + s.ref).join(', ')}\n`;
      if (text.length + block.length > 6000) continue;
      text += block + '\n';
      ids.push(item.id);
    }
    return { text, ids };
  }
  ingest(identity: string, entry: MemoryWrite): boolean {
    if (this.database.prepare('SELECT 1 FROM memory_records WHERE identity=?').get(identity))
      return false;
    this.write(
      { ...entry, kind: 'episode', status: 'confirmed', visibility: 'local' },
      { owner: true },
      undefined,
      identity
    );
    return true;
  }
  async close(): Promise<void> {
    this.stopped = true;
    await this.embedder?.close();
    await this.indexing;
    this.database.close();
  }
}
