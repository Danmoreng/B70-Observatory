/** Managed, metadata-free input pictures shared by reproducible image jobs. */
import { mkdir, readFile, readdir, lstat, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { inside } from './gallery.mjs';

export const MAX_REFERENCES = 16;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const fail = (message, status = 400) => Object.assign(Error(message), { status });

export class References {
  constructor(options, db) {
    this.db = db; this.input = path.join(options.comfyRoot, 'input', 'DiffusionDesk');
    this.thumbs = path.join(options.stateDir, 'references'); this.busy = false;
  }
  async open() {
    await mkdir(this.input, { recursive: true, mode: 0o700 });
    await mkdir(this.thumbs, { recursive: true, mode: 0o700 });
    this.db.exec(`CREATE TABLE IF NOT EXISTS reference_images (
      id TEXT PRIMARY KEY, name TEXT, width INTEGER, height INTEGER, bytes INTEGER,
      created REAL, deleting INTEGER DEFAULT 0, digest TEXT);
      CREATE TABLE IF NOT EXISTS job_references (
        job_id TEXT, reference_id TEXT, ordinal INTEGER, PRIMARY KEY(job_id, ordinal));
      CREATE INDEX IF NOT EXISTS reference_usage ON job_references(reference_id);`);
    if (!this.db.prepare('PRAGMA table_info(reference_images)').all().some(column => column.name === 'digest'))
      this.db.exec('ALTER TABLE reference_images ADD COLUMN digest TEXT');
    for (const row of this.db.prepare('SELECT id FROM reference_images WHERE digest IS NULL AND deleting=0').all()) {
      try { this.db.prepare('UPDATE reference_images SET digest=? WHERE id=?').run(createHash('sha256').update(await readFile(path.join(this.input, row.id + '.png'))).digest('hex'), row.id); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS reference_digest ON reference_images(digest)');
    for (const row of this.db.prepare('SELECT id FROM reference_images WHERE deleting=1').all()) await this.finishDelete(row.id);
    // Discard abandoned uploads after a week; pictures used by jobs remain reproducible.
    for (const row of this.db.prepare(`SELECT id FROM reference_images WHERE created < ?
      AND id NOT IN (SELECT reference_id FROM job_references)`).all(Date.now() / 1000 - 7 * 86400)) await this.remove(row.id);
    // A crash between writing a picture and committing its row must not leak input files.
    for (const directory of [this.input, this.thumbs]) for (const name of await readdir(directory)) {
      const match = name.match(/^([0-9a-f]{32})\.(png|jpg)$/);
      if (match && !this.db.prepare('SELECT id FROM reference_images WHERE id=?').get(match[1])) await unlink(path.join(directory, name));
    }
  }
  get(id) {
    if (!/^[0-9a-f]{32}$/.test(id)) throw fail('Unknown reference image.', 404);
    const row = this.db.prepare('SELECT * FROM reference_images WHERE id=? AND deleting=0').get(id);
    if (!row) throw fail('A reference image is no longer available. Remove it or upload it again.', 404);
    return row;
  }
  public(row) {
    return { id: row.id, name: row.name, width: row.width, height: row.height, bytes: row.bytes, created: row.created,
      uses: this.db.prepare('SELECT count(*) AS n FROM job_references WHERE reference_id=?').get(row.id).n };
  }
  list() { return this.db.prepare('SELECT * FROM reference_images WHERE deleting=0 ORDER BY created DESC').all().map(row => this.public(row)); }
  resolve(ids = []) { return ids.map(id => ({ ...this.public(this.get(id)), filename: `DiffusionDesk/${id}.png` })); }
  link(jobId, ids) {
    const insert = this.db.prepare('INSERT INTO job_references(job_id,reference_id,ordinal) VALUES(?,?,?)');
    ids.forEach((id, index) => { this.get(id); insert.run(jobId, id, index + 1); });
  }
  async file(id, variant = 'image') {
    this.get(id);
    const root = variant === 'thumb' ? this.thumbs : this.input;
    const file = path.join(root, id + (variant === 'thumb' ? '.jpg' : '.png'));
    if (!(await lstat(file)).isFile() || !inside(root, await realpath(file))) throw fail('Reference file is unavailable.', 404);
    return file;
  }
  async vision(id) { return sharp(await this.file(id)).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer(); }
  async ingest(buffer, name = 'Reference image') {
    if (!buffer.length || buffer.length > 64 * 1024 * 1024) throw fail('Image file is empty or too large.', 413);
    const image = sharp(buffer, { limitInputPixels: 32 * 1024 * 1024, failOn: 'error', animated: false });
    const meta = await image.metadata().catch(() => { throw fail('This picture could not be decoded or exceeds 32 Mi pixels. Use PNG, JPEG or WebP; export unsupported HEIC files as JPEG.'); });
    if (!['png', 'jpeg', 'webp', 'heif', 'avif'].includes(meta.format) || (meta.pages || 1) > 1) throw fail('Choose a still PNG, JPEG, WebP or supported HEIC image.');
    if (Math.max(meta.width / meta.height, meta.height / meta.width) > 4) throw fail('Reference images must have an aspect ratio between 1:4 and 4:1.');
    const id = randomUUID().replaceAll('-', '');
    const output = await image.rotate().resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).removeAlpha().png().toBuffer({ resolveWithObject: true });
    const digest = createHash('sha256').update(output.data).digest('hex');
    const existing = this.db.prepare('SELECT * FROM reference_images WHERE digest=? AND deleting=0').get(digest);
    if (existing) { await this.file(existing.id); return this.public(existing); }
    // No withMetadata(): strip EXIF, locations, embedded prompts and source workflows.
    const file = path.join(this.input, id + '.png'), thumb = path.join(this.thumbs, id + '.jpg');
    try {
      await writeFile(file, output.data, { flag: 'wx', mode: 0o600 });
      await sharp(output.data).resize(240, 240, { fit: 'inside' }).jpeg({ quality: 80 }).toFile(thumb);
      this.db.prepare('INSERT INTO reference_images(id,name,width,height,bytes,created,digest) VALUES(?,?,?,?,?,?,?)')
        .run(id, String(name).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120) || 'Reference image', output.info.width, output.info.height, output.data.length, Date.now() / 1000, digest);
      return this.public(this.get(id));
    } catch (error) { await Promise.allSettled([unlink(file), unlink(thumb)]); throw error; }
  }
  async upload(request) {
    if (this.busy) throw fail('Another picture is uploading. Please try again in a moment.', 409);
    if (request.headers['content-type']?.split(';')[0] !== 'application/octet-stream') throw fail('Send an image file.', 415);
    if (Number(request.headers['content-length']) > MAX_UPLOAD_BYTES) throw fail('Choose an image smaller than 20 MiB.', 413);
    this.busy = true;
    try {
      const chunks = []; let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > MAX_UPLOAD_BYTES) throw fail('Choose an image smaller than 20 MiB.', 413);
        chunks.push(chunk);
      }
      let name;
      try { name = decodeURIComponent(request.headers['x-file-name'] || 'Reference image'); } catch { name = 'Reference image'; }
      return await this.ingest(Buffer.concat(chunks), name);
    } finally { this.busy = false; }
  }
  async fromGallery(file) {
    if (this.busy) throw fail('Another picture is uploading. Please try again in a moment.', 409);
    this.busy = true;
    try {
      if ((await stat(file)).size > 64 * 1024 * 1024) throw fail('This gallery image is larger than 64 MiB.', 413);
      return await this.ingest(await readFile(file), 'Gallery image');
    } finally { this.busy = false; }
  }
  async remove(id) {
    this.get(id);
    if (this.db.prepare('SELECT count(*) AS n FROM job_references WHERE reference_id=?').get(id).n)
      throw fail('This reference is used by saved jobs. Delete those results first to remove the reference.', 409);
    this.db.prepare('UPDATE reference_images SET deleting=1 WHERE id=?').run(id);
    await this.finishDelete(id);
    return { deleted: true, id };
  }
  async finishDelete(id) {
    for (const file of [path.join(this.input, id + '.png'), path.join(this.thumbs, id + '.jpg')]) {
      try { await unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    this.db.prepare('DELETE FROM reference_images WHERE id=?').run(id);
  }
}
