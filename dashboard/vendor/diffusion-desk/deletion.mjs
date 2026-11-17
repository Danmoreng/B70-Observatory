/** Delete a logical image and its owned metadata; journal partial cleanup for retry. */
import { lstat, realpath, readdir, open, mkdir, rename, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { inside } from './gallery.mjs';

const missing = error => error.code === 'ENOENT';
const conflict = message => Object.assign(Error(message), { status: 409 });
const terminals = new Set(['completed', 'failed', 'cancelled']);

async function safeFile(file, roots) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw conflict('A file changed. Refresh the gallery before deleting.');
  const actual = await realpath(file);
  if (!roots.some(root => inside(root, actual))) throw Object.assign(Error('Deletion outside the managed image folders is not allowed.'), { status: 403 });
  return { path: file, ino: info.ino, dev: info.dev };
}
async function conditioningPrompt(file) {
  const handle = await open(file, 'r');
  try {
    const size = Buffer.alloc(8);
    if ((await handle.read(size, 0, 8, 0)).bytesRead !== 8) return null;
    const length = Number(size.readBigUInt64LE());
    if (!Number.isSafeInteger(length) || length < 2 || length > 4 * 1024 * 1024) return null;
    const data = Buffer.alloc(length);
    if ((await handle.read(data, 0, length, 8)).bytesRead !== length) return null;
    const metadata = JSON.parse(data.toString('utf8')).__metadata__;
    return metadata?.format === 'h3image-conditioning/1' ? metadata.prompt : null;
  } finally { await handle.close(); }
}

export class Deletion {
  constructor(options, gallery, jobs) {
    this.options = options; this.gallery = gallery; this.jobs = jobs;
    this.journals = path.join(options.stateDir, 'deletions');
    this.cacheDirs = [gallery.cache, ...(options.legacyThumbnailDir ? [path.resolve(options.legacyThumbnailDir)] : [])];
    this.roots = [gallery.output, ...this.cacheDirs.map(dir => path.resolve(dir)), path.resolve(options.stateDir)];
    this.locks = new Map();
  }
  async recover() {
    await mkdir(this.journals, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(this.journals)) {
      if (!/^[0-9a-f]{20}\.json$/.test(entry)) continue;
      try { await this.remove(entry.slice(0, 20)); }
      catch (error) { console.error('Image deletion awaits retry:', entry.slice(0, 20), error.message); }
    }
  }
  remove(id) {
    if (this.locks.has(id)) return this.locks.get(id);
    const task = this.execute(id).finally(() => this.locks.delete(id));
    this.locks.set(id, task);
    return task;
  }
  async plan(id) {
    const item = (await this.gallery.scan(true)).get(id);
    if (!item) throw Object.assign(Error('Not found'), { status: 404 });
    const files = new Map();
    const add = async file => {
      try { files.set(file, await safeFile(file, this.roots)); }
      catch (error) { if (!missing(error)) throw error; }
    };
    const imageFiles = (item.versions || [item.original, item.preview]).map(v => v.path);
    const imagePaths = new Set(imageFiles.map(file => path.relative(this.gallery.output, file)));
    await this.options.assertDeleteImages?.([...imagePaths]);
    const ownJob = file => file.match(/^DiffusionDesk\/([0-9a-f]{32})-(native|1536)_\d+_\.png$/)?.[1];
    const rows = this.jobs.db.prepare('SELECT * FROM jobs').all().map(row => this.jobs.decode(row));
    const related = rows.filter(job => job.images.some(file => imagePaths.has(file)) || imageFiles.some(file => ownJob(path.relative(this.gallery.output, file)) === job.id));
    if (related.some(job => !terminals.has(job.status))) throw conflict('This image is still being generated. Wait for it to finish or stop the job first.');

    let historyIds = related.map(job => job.prompt_id).filter(Boolean);
    let queue;
    try { queue = await this.jobs.api('/queue'); }
    catch (error) { if (error.cause?.code !== 'ECONNREFUSED') throw error; }
    if (queue) {
      for (const entry of [...queue.queue_running, ...queue.queue_pending]) {
        const prefixes = Object.values(entry[2] || {}).filter(node => node.class_type === 'SaveImage').map(node => node.inputs.filename_prefix);
        if ([...imagePaths].some(file => prefixes.some(prefix => file.startsWith(prefix + '_')))) throw conflict('This image is still being generated. Wait for it to finish first.');
      }
      const history = await this.jobs.api('/history?max_items=10000');
      for (const [promptId, record] of Object.entries(history)) {
        const outputFiles = Object.values(record.outputs || {}).flatMap(output => output.images || [])
          .filter(image => image.type === 'output').map(image => path.join(image.subfolder || '', image.filename));
        if (outputFiles.length && outputFiles.every(file => imagePaths.has(file))) historyIds.push(promptId);
      }
    }
    for (const file of imageFiles) {
      await add(file);
      const stem = file.slice(0, -path.extname(file).length);
      for (const sidecar of [file + '.json', stem + '.json', stem + '.workflow.json', stem + '.txt']) await add(sidecar);
    }
    for (const directory of this.cacheDirs) {
      let entries;
      try { entries = await readdir(directory); } catch (error) { if (missing(error)) continue; throw error; }
      for (const name of entries) if (name.startsWith(id + '-') && /\.(jpg|tmp)$/.test(name)) await add(path.join(directory, name));
    }
    const cache = path.join(this.gallery.output, 'h3image_encode_cache');
    try {
      for (const entry of await readdir(cache, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[0-9a-f]{64}\.safetensors$/.test(entry.name)) continue;
        const file = path.join(cache, entry.name);
        if (await conditioningPrompt(file) === item.original.prompt) await add(file);
      }
    } catch (error) { if (!missing(error)) throw error; }
    // Local acceptance reports are owned by this adapter, not arbitrary exports.
    for (const name of ['acceptance-result.json', 'acceptance-job.json', 'reference-acceptance.json']) {
      const file = path.join(this.options.stateDir, name);
      try {
        const data = JSON.parse(await readFile(file, 'utf8'));
        if (data.image?.id === id || related.some(job => data.job?.id === job.id || data.ids?.includes(job.id) || data.jobIds?.includes(job.id) || data.multiJobIds?.includes(job.id))) await add(file);
      } catch (error) { if (!missing(error)) throw error; }
    }
    return { version: 1, id, files: [...files.values()], imagePaths: [...imagePaths], jobIds: related.map(job => job.id), historyIds: [...new Set(historyIds)] };
  }
  async execute(id) {
    if (!/^[0-9a-f]{20}$/.test(id)) throw Object.assign(Error('Not found'), { status: 404 });
    const journal = path.join(this.journals, id + '.json');
    let plan;
    try { plan = JSON.parse(await readFile(journal, 'utf8')); }
    catch (error) {
      if (!missing(error)) throw error;
      plan = await this.plan(id);
      const file = await open(journal + '.tmp', 'w', 0o600);
      try { await file.writeFile(JSON.stringify(plan)); await file.sync(); } finally { await file.close(); }
      await rename(journal + '.tmp', journal);
    }
    if (plan.id !== id || plan.version !== 1) throw Error('Invalid deletion journal');
    this.gallery.deleting.add(id); this.gallery.items.delete(id);
    await Promise.allSettled([...this.gallery.thumbnails.entries()].filter(([name]) => path.basename(name).startsWith(id + '-')).map(([, task]) => task));
    // A thumbnail might have completed after the plan was written; include it too.
    for (const directory of this.cacheDirs) {
      let entries;
      try { entries = await readdir(directory); } catch (error) { if (missing(error)) continue; throw error; }
      for (const name of entries) if (name.startsWith(id + '-') && /\.(jpg|tmp)$/.test(name) && !plan.files.some(f => f.path === path.join(directory, name)))
        plan.files.push(await safeFile(path.join(directory, name), this.roots));
    }
    for (const file of plan.files) {
      let actual;
      try { actual = await safeFile(file.path, this.roots); } catch (error) { if (missing(error)) continue; throw error; }
      if (actual.ino !== file.ino || actual.dev !== file.dev) throw conflict('A file was replaced during deletion. Its replacement was preserved.');
      await unlink(file.path); this.gallery.metadata.delete(file.path);
    }
    // Do not wake or restart an offline GPU engine merely to clear its volatile history.
    if (plan.historyIds.length) {
      try { await this.jobs.api('/history', { delete: plan.historyIds }); }
      catch (error) {
        if (error.cause?.code !== 'ECONNREFUSED') throw Error('Image files were removed; retry to finish clearing the engine history.');
      }
    }
    await this.options.deleteImages?.(plan.imagePaths);
    this.jobs.db.exec('BEGIN');
    try {
      this.jobs.db.prepare('DELETE FROM annotations WHERE id=?').run(id);
      for (const jobId of plan.jobIds) {
        this.jobs.db.prepare('DELETE FROM job_references WHERE job_id=?').run(jobId);
        this.jobs.db.prepare('DELETE FROM jobs WHERE id=?').run(jobId);
      }
      this.jobs.db.exec('COMMIT');
    } catch (error) { this.jobs.db.exec('ROLLBACK'); throw error; }
    this.jobs.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    await unlink(journal);
    this.gallery.deleting.delete(id); this.gallery.lastScan = 0;
    return { deleted: true, id, files: plan.files.length, jobIds: plan.jobIds };
  }
}
