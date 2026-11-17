import { DatabaseSync } from 'node:sqlite';
import type { ImageJobMetric } from '@observatory/contracts';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile, rename, statfs, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { validateAgentImage } from '@observatory/runner';
import { berlinMinutes } from '../durable/working-hours.js';
import {
  ImageInputSchema,
  ImageBatchSchema,
  imageBatchFingerprint,
  ImageStatusSchema,
  IMAGE_SIZES,
  type ImageInput,
  type ImageStatus,
} from './image-contract.js';
import { GpuScheduler } from './gpu-scheduler.js';
import { ComfyImages, imageGraph, IMAGE_MONITOR_RESTART } from './comfy-images.js';

interface RecordJob {
  batch?: string;
  input: ImageInput;
  state: ImageStatus;
  submitted: boolean;
  promptId?: string;
  artifact?: boolean;
  bytes?: number;
  startedAt?: number;
  generatedAt?: number;
  finishedAt?: number;
}
export class ImageJobs {
  private readonly db: DatabaseSync;
  private readonly owner: DatabaseSync;
  private readonly controllers = new Map<string, AbortController>();
  private readonly pending = new Map<string, Promise<void>>();
  private stopping = false;
  constructor(
    readonly root: string,
    readonly gpu: GpuScheduler,
    readonly comfy: ComfyImages,
    private readonly imageAdmission: () => boolean = () => true
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    // A separate, lifetime SQLite lock prevents two gateway processes from
    // replaying the same image jobs. OS locks disappear automatically on crash.
    this.owner = new DatabaseSync(join(root, 'image-owner.sqlite'), { timeout: 50 });
    try {
      this.owner.exec('BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner(id INTEGER);');
    } catch {
      this.owner.close();
      throw new Error('Another gateway owns this image archive.');
    }
    try {
      this.db = new DatabaseSync(join(root, 'image-jobs.sqlite'));
    } catch (error) {
      this.owner.close();
      throw error;
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS image_jobs(id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, created TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS image_cancellations(key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS image_batches(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);`);
  }
  private record(id: string): RecordJob {
    const row = this.db.prepare('SELECT value FROM image_jobs WHERE id=?').get(id) as
      { value: string } | undefined;
    if (!row) throw Object.assign(new Error('Image job not found.'), { statusCode: 404 });
    return JSON.parse(row.value) as RecordJob;
  }
  private save(job: RecordJob) {
    if (!this.stopping)
      this.db
        .prepare('UPDATE image_jobs SET value=? WHERE id=?')
        .run(JSON.stringify(job), job.state.id);
  }
  private capacity(additional = 1) {
    const active = this.db
      .prepare(
        "SELECT count(*) n FROM image_jobs WHERE json_extract(value,'$.state.status') IN ('queued','running','generated')"
      )
      .get() as { n: number };
    if (active.n + additional > 16) throw new Error('Image queue is full.');
    const stored = this.db
      .prepare(
        "SELECT count(*) n, coalesce(sum(json_extract(value,'$.bytes')),0) bytes FROM image_jobs"
      )
      .get() as { n: number; bytes: number };
    if (
      stored.n + additional > 2000 ||
      stored.bytes + (active.n + additional) * 66 * 1024 ** 2 > 8 * 1024 ** 3
    )
      throw new Error(
        'Image artifact archive is full (8 GiB / 2000 jobs). Archive completed jobs before continuing.'
      );
  }
  get(id: string) {
    return ImageStatusSchema.parse(this.record(id).state);
  }
  metrics(): ImageJobMetric[] {
    const rows = this.db
      .prepare(
        "SELECT created, value FROM image_jobs ORDER BY CASE WHEN json_extract(value,'$.state.status') IN ('queued','running','generated') THEN 0 ELSE 1 END, created DESC LIMIT 12"
      )
      .all() as { created: string; value: string }[];
    return rows.map((row) => {
      const job = JSON.parse(row.value) as RecordJob,
        size = IMAGE_SIZES[job.input.sizeId];
      return {
        id: job.state.id,
        source: 'agent',
        status: job.state.status,
        phase: job.state.phase,
        createdAt: row.created,
        step: job.state.step,
        steps: job.state.steps,
        width: size.width,
        height: size.height,
        seed: job.state.seed,
        ...(job.startedAt
          ? { elapsedSeconds: Math.max(0, ((job.finishedAt ?? Date.now()) - job.startedAt) / 1000) }
          : {}),
        ...(job.startedAt && job.generatedAt
          ? { renderSeconds: Math.max(0, (job.generatedAt - job.startedAt) / 1000) }
          : {}),
      };
    });
  }
  start() {
    const rows = this.db.prepare('SELECT id FROM image_jobs ORDER BY created').all() as Array<{
      id: string;
    }>;
    for (const { id } of rows) {
      const job = this.record(id);
      if (
        ['queued', 'running', 'generated'].includes(job.state.status) ||
        (job.artifact && job.state.status === 'failed')
      )
        this.launch(job);
    }
  }
  async submit(raw: unknown): Promise<ImageStatus> {
    if (!this.imageAdmission())
      throw Object.assign(new Error('Agent image tools require Hybrid mode.'), { statusCode: 409 });
    const input = ImageInputSchema.parse(raw);
    if (this.db.prepare('SELECT key FROM image_cancellations WHERE key=?').get(input.key))
      throw Object.assign(new Error('Image request was cancelled.'), { statusCode: 410 });
    const id = createHash('sha256').update(input.key).digest('hex').slice(0, 32);
    const existing = this.db.prepare('SELECT id FROM image_jobs WHERE key=?').get(input.key) as
      { id: string } | undefined;
    if (existing) {
      const job = this.record(existing.id);
      if (JSON.stringify(job.input) !== JSON.stringify(input))
        throw Object.assign(
          new Error('Image request key already belongs to different parameters.'),
          { statusCode: 409 }
        );
      return job.state;
    }
    if (berlinMinutes() >= 22 * 60 + 30)
      throw new Error('New image jobs close at 22:30 Europe/Berlin.');
    this.capacity();
    const disk = await statfs(this.root);
    if (disk.bavail * disk.bsize < 3 * 1024 ** 3)
      throw new Error('Less than 3 GiB disk space remains.');
    // Another accepted POST may have committed while statfs yielded.
    if (!this.imageAdmission())
      throw Object.assign(new Error('Agent image tools require Hybrid mode.'), { statusCode: 409 });
    if (this.db.prepare('SELECT id FROM image_jobs WHERE key=?').get(input.key))
      return this.submit(input);
    if (this.db.prepare('SELECT key FROM image_cancellations WHERE key=?').get(input.key))
      throw Object.assign(new Error('Image request was cancelled.'), { statusCode: 410 });
    this.capacity();
    const seed = input.seed === -1 ? randomInt(0, 2 ** 32) : input.seed;
    const job: RecordJob = {
      input,
      state: {
        id,
        status: 'queued',
        phase: 'Waiting for running text turns',
        seed,
        sizeId: input.sizeId,
      },
      submitted: false,
    };
    this.db
      .prepare('INSERT INTO image_jobs VALUES(?,?,?,?)')
      .run(id, input.key, new Date().toISOString(), JSON.stringify(job));
    this.launch(job);
    return job.state;
  }
  batch(id: string) {
    const row = this.db.prepare('SELECT fingerprint FROM image_batches WHERE id=?').get(id) as
      { fingerprint: string } | undefined;
    if (!row) throw Object.assign(new Error('Image batch not found.'), { statusCode: 404 });
    return row;
  }
  async submitBatch(raw: unknown): Promise<ImageStatus[]> {
    const batch = ImageBatchSchema.parse(raw),
      fingerprint = imageBatchFingerprint(batch);
    const check = () => {
      if (!this.imageAdmission())
        throw Object.assign(new Error('Agent image tools require Hybrid mode.'), {
          statusCode: 409,
        });
      for (const input of batch.images)
        if (this.db.prepare('SELECT key FROM image_cancellations WHERE key=?').get(input.key))
          throw Object.assign(new Error('Image request was cancelled.'), { statusCode: 410 });
      const previous = this.db
        .prepare('SELECT fingerprint FROM image_batches WHERE id=?')
        .get(batch.id) as { fingerprint: string } | undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw Object.assign(new Error('Image batch already belongs to different parameters.'), {
            statusCode: 409,
          });
        return batch.images.map((input) =>
          this.get(createHash('sha256').update(input.key).digest('hex').slice(0, 32))
        );
      }
      for (const input of batch.images)
        if (this.db.prepare('SELECT id FROM image_jobs WHERE key=?').get(input.key))
          throw Object.assign(new Error('Image key already belongs to another request.'), {
            statusCode: 409,
          });
      if (berlinMinutes() >= 22 * 60 + 30)
        throw new Error('New image jobs close at 22:30 Europe/Berlin.');
      this.capacity(batch.images.length);
    };
    const existing = check();
    if (existing) return existing;
    const disk = await statfs(this.root);
    if (disk.bavail * disk.bsize < 3 * 1024 ** 3)
      throw new Error('Less than 3 GiB disk space remains.');
    const raced = check();
    if (raced) return raced;
    const created = Date.now();
    const records: RecordJob[] = batch.images.map((input) => ({
      input,
      batch: batch.id,
      submitted: false,
      state: {
        id: createHash('sha256').update(input.key).digest('hex').slice(0, 32),
        status: 'queued',
        phase: 'Waiting for running text turns',
        seed: input.seed === -1 ? randomInt(0, 2 ** 32) : input.seed,
        sizeId: input.sizeId,
      },
    }));
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO image_batches VALUES(?,?)').run(batch.id, fingerprint);
      const insert = this.db.prepare('INSERT INTO image_jobs VALUES(?,?,?,?)');
      records.forEach((job, index) =>
        insert.run(
          job.state.id,
          job.input.key,
          new Date(created + index).toISOString(),
          JSON.stringify(job)
        )
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    // Enqueue the whole committed cohort synchronously before the switch can finish.
    records.forEach((job) => this.launch(job));
    return records.map((job) => job.state);
  }
  cancelBatch(raw: unknown) {
    const batch = ImageBatchSchema.parse(raw);
    const existing = this.db
      .prepare('SELECT fingerprint FROM image_batches WHERE id=?')
      .get(batch.id) as { fingerprint: string } | undefined;
    if (existing && existing.fingerprint !== imageBatchFingerprint(batch))
      throw Object.assign(new Error('Image batch already belongs to different parameters.'), {
        statusCode: 409,
      });
    // Mark every member synchronously before any aborted render can release the
    // broker to its next sibling. This also defeats a still-in-flight submit.
    for (const image of batch.images)
      this.cancel(createHash('sha256').update(image.key).digest('hex').slice(0, 32), image.key);
  }
  private launch(job: RecordJob) {
    const { id } = job.state;
    if (this.controllers.has(id) || this.stopping) return;
    const abort = new AbortController();
    this.controllers.set(id, abort);
    const remaining = Math.max(1, (22 * 60 + 50 - berlinMinutes()) * 60_000);
    const signal = AbortSignal.any([
      abort.signal,
      AbortSignal.timeout(Math.min(35 * 60_000, remaining)),
    ]);
    const progress = (phase: string, step?: number, steps?: number) => {
      if (job.state.phase === phase && job.state.step === step && job.state.steps === steps) return;
      job.state.phase = phase;
      job.state.step = step;
      job.state.steps = steps;
      this.save(job);
    };
    const operation = this.gpu
      .runImage(
        async () => {
          signal.throwIfAborted();
          if (!job.artifact) {
            if (!job.submitted && berlinMinutes() >= 22 * 60 + 30)
              throw new Error('Queued image work stopped at the daily cutoff.');
            job.state.status = 'running';
            job.startedAt ??= Date.now();
            progress('Generating image');
            const result = await this.comfy.render(
              {
                id,
                input: job.input,
                seed: job.state.seed,
                submitted: job.submitted,
                promptId: job.promptId,
                submittedAs: (promptId) => {
                  job.submitted = true;
                  job.promptId = promptId;
                  this.save(job);
                },
                progress,
              },
              signal
            );
            signal.throwIfAborted();
            const validation = validateAgentImage('image/webp', result.preview);
            if (!validation.ok)
              throw new Error('Generated preview is invalid: ' + validation.reason);
            const size = IMAGE_SIZES[job.input.sizeId];
            if (
              result.original.length < 24 ||
              result.original.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
              result.original.readUInt32BE(16) !== size.width ||
              result.original.readUInt32BE(20) !== size.height
            )
              throw new Error('Generated original has unexpected format or dimensions.');
            for (const [suffix, bytes] of [
              ['png', result.original],
              ['webp', result.preview],
            ] as const) {
              await writeFile(join(this.root, `${id}.${suffix}.tmp`), bytes, { mode: 0o600 });
              await rename(
                join(this.root, `${id}.${suffix}.tmp`),
                join(this.root, `${id}.${suffix}`)
              );
            }
            await writeFile(
              join(this.root, id + '.json'),
              JSON.stringify(
                {
                  ...job.input,
                  seed: job.state.seed,
                  graph: imageGraph(id, job.input, job.state.seed),
                },
                null,
                2
              ),
              { mode: 0o600 }
            );
            job.artifact = true;
            job.bytes = result.original.length + result.preview.length;
          }
          job.state.status = 'generated';
          job.generatedAt ??= Date.now();
          progress(
            job.batch ? 'Waiting for image batch and text restoration' : 'Restoring text engine'
          );
        },
        signal,
        job.artifact === true,
        job.batch
      )
      .then(
        () => {
          job.state.status = 'completed';
          job.finishedAt = Date.now();
          progress('Completed');
        },
        (error) => {
          if (this.stopping) return;
          job.state.status = signal.aborted ? 'cancelled' : 'failed';
          job.finishedAt = Date.now();
          job.state.error = String(
            error instanceof Error ? error.message : 'Image request failed.'
          ).slice(0, 1000);
          progress(job.state.status === 'cancelled' ? 'Cancelled' : 'Failed');
        }
      )
      .finally(() => {
        this.controllers.delete(id);
        this.pending.delete(id);
      });
    this.pending.set(id, operation);
  }
  cancel(id: string, key?: string) {
    if (key) {
      if (
        !/^[a-f0-9]{64}$/.test(key) ||
        createHash('sha256').update(key).digest('hex').slice(0, 32) !== id
      )
        throw Object.assign(new Error('Invalid image cancellation key.'), { statusCode: 400 });
      this.db.prepare('INSERT OR IGNORE INTO image_cancellations VALUES(?)').run(key);
    }
    let job: RecordJob;
    try {
      job = this.record(id);
    } catch (error) {
      if (key) return;
      throw error;
    }
    if (['completed', 'cancelled', 'failed'].includes(job.state.status)) return;
    this.controllers.get(id)?.abort();
  }
  assertDeletable(ids: string[]) {
    for (const id of ids) {
      if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid image identifier.');
      const row = this.db.prepare('SELECT id FROM image_jobs WHERE id=?').get(id);
      if (
        row &&
        (this.pending.has(id) ||
          !['completed', 'cancelled', 'failed'].includes(this.record(id).state.status))
      )
        throw Object.assign(
          new Error('Wait for image generation and engine restoration before deleting.'),
          { status: 409 }
        );
    }
  }
  async purge(ids: string[]) {
    this.assertDeletable(ids);
    for (const id of ids) {
      if (!this.db.prepare('SELECT id FROM image_jobs WHERE id=?').get(id)) continue;
      const job = this.record(id);
      // Preserve a content-free tombstone: a replay must never regenerate a deleted image.
      this.db.prepare('INSERT OR IGNORE INTO image_cancellations VALUES(?)').run(job.input.key);
      for (const extension of ['.png', '.webp', '.json', '.png.tmp', '.webp.tmp'])
        await rm(join(this.root, id + extension), { force: true });
      this.db.prepare('DELETE FROM image_jobs WHERE id=?').run(id);
    }
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  async artifact(id: string, preview: boolean) {
    const job = this.record(id);
    if (!job.artifact)
      throw Object.assign(new Error('Image artifact not ready.'), { statusCode: 409 });
    return readFile(join(this.root, id + (preview ? '.webp' : '.png')));
  }
  /** A process restart leaves ComfyUI working and reattaches by saved prompt ID. */
  stop() {
    this.stopping = true;
    this.gpu.pause();
    for (const controller of this.controllers.values()) controller.abort(IMAGE_MONITOR_RESTART);
  }
  async close() {
    this.stop();
    await Promise.all(this.pending.values());
    this.db.close();
    this.owner.close();
  }
}
