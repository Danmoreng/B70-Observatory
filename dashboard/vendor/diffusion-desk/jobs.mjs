import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { acceptingJobs, localClock, makeGraph, validateRequest } from './recipe.mjs';
import { inside } from './gallery.mjs';
import { clearExpansionCache, expansionAvailable, expansionResult, makeExpansionGraph, validateExpansion } from './expansion.mjs';

const exec = promisify(execFile);
const TERMINAL = ['completed', 'failed', 'cancelled'];
const now = () => Date.now() / 1000;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export class Jobs {
  constructor(options, gallery) {
    this.options = options; this.gallery = gallery; this.stopped = false; this.worker = null;
    this.lock = Promise.resolve(); this.wakeup = null;
    this.expansionPurges = new Map();
  }
  async open() {
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(this.options.stateDir, 'desk.db'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, created REAL, status TEXT, request TEXT,
        prompt_id TEXT, started REAL, finished REAL, error TEXT,
        progress TEXT DEFAULT '{}', images TEXT DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS annotations (
        id TEXT PRIMARY KEY, favorite INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0,
        rating INTEGER DEFAULT 0, keywords TEXT DEFAULT '[]');`);
    const columns = this.db.prepare('PRAGMA table_info(jobs)').all().map(column => column.name);
    for (const [name, type] of [['kind', "TEXT DEFAULT 'image'"], ['result', "TEXT DEFAULT '{}'"], ['discarded', 'INTEGER DEFAULT 0']])
      if (!columns.includes(name)) this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`);
  }
  decode(row) {
    if (!row) return null;
    const job = { ...row };
    for (const field of ['request', 'progress', 'images', 'result']) job[field] = JSON.parse(job[field]);
    job.elapsed = job.started ? Math.round(Math.max(0, (job.finished || now()) - job.started) * 10) / 10 : 0;
    return job;
  }
  list() { return this.db.prepare("SELECT * FROM jobs WHERE kind='image' ORDER BY created DESC LIMIT 200").all().map(r => this.decode(r)); }
  get(id) { return this.decode(this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id)); }
  forImage(file) { return this.decode(this.db.prepare('SELECT jobs.* FROM jobs, json_each(jobs.images) WHERE json_each.value=? LIMIT 1').get(file)); }
  update(id, values) {
    const entries = Object.entries(values).map(([key, value]) => [key, ['request', 'progress', 'images', 'result'].includes(key) ? JSON.stringify(value) : value]);
    this.db.prepare('UPDATE jobs SET ' + entries.map(([k]) => k + '=?').join(',') + ' WHERE id=?').run(...entries.map(([, v]) => v), id);
  }
  async exclusive(action) {
    const previous = this.lock;
    let release;
    this.lock = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await action(); } finally { release(); }
  }
  async api(route, data) {
    const response = await fetch(this.options.comfyUrl + route, {
      method: data === undefined ? 'GET' : 'POST', headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(8000),
    });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 1800) }; }
    if (!response.ok) throw Error('Image engine rejected the request: ' + JSON.stringify(body).slice(0, 1800));
    return body;
  }
  submit(data) {
    if (this.options.allowImages && !this.options.allowImages()) throw Error('Image generation is disabled in Text mode.');
    const params = validateRequest(data);
    this.references?.resolve(params.referenceIds);
    if (!acceptingJobs()) throw Error('New image jobs close at 22:30 Europe/Berlin for the daily shutdown.');
    const active = this.db.prepare("SELECT count(*) AS n FROM jobs WHERE status IN ('queued','running','cancelling')").get().n;
    if (active + params.count > 16) throw Error('The queue is full (16 images). Wait for a job to finish.');
    const ids = [], created = now();
    this.db.exec('BEGIN');
    try {
      const insert = this.db.prepare('INSERT INTO jobs(id,created,status,request) VALUES(?,?,?,?)');
      for (let index = 0; index < params.count; index++) {
        const id = randomUUID().replaceAll('-', '');
        const seed = params.seed === -1 ? randomInt(0, 2 ** 32) : (params.seed + index) % 2 ** 32;
        insert.run(id, created + index * .0001, 'queued', JSON.stringify({ ...params, count: 1, seed }));
        this.references?.link(id, params.referenceIds);
        ids.push(id);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.wakeup?.();
    return ids;
  }
  async submitExpansion(data) {
    if (this.options.allowImages && !this.options.allowImages()) throw Error('Prompt expansion is disabled in Text mode.');
    const request = validateExpansion(data);
    if (!acceptingJobs()) throw Error('New prompt expansions close at 22:30 Europe/Berlin for the daily shutdown.');
    if (!this.options.expandPrompt && !await expansionAvailable(this.options)) throw Error('The local prompt expansion model is not installed.');
    await this.recoverExpansions();
    if (this.options.allowImages && !this.options.allowImages()) throw Error('Prompt expansion is disabled in Text mode.');
    this.references.resolve(request.referenceIds);
    if (this.db.prepare("SELECT count(*) AS n FROM jobs WHERE kind='expand' AND discarded=0").get().n >= 4)
      throw Error('Review or discard an existing prompt expansion first (maximum four).');
    const id = randomUUID().replaceAll('-', '');
    this.db.exec('BEGIN');
    try {
      this.db.prepare("INSERT INTO jobs(id,created,status,request,kind) VALUES(?,?,'queued',?,'expand')").run(id, now(), JSON.stringify(request));
      this.references.link(id, request.referenceIds); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.wakeup?.(); return id;
  }
  expansion(id) {
    const job = this.get(id);
    if (!job || job.kind !== 'expand' || job.discarded) throw Object.assign(Error('Prompt expansion is no longer available.'), { status: 404 });
    return job;
  }
  async discardExpansion(id) {
    const job = this.get(id);
    if (!job || job.kind !== 'expand') throw Object.assign(Error('Unknown prompt expansion'), { status: 404 });
    this.update(id, { discarded: 1 });
    if (!TERMINAL.includes(job.status)) await this.cancel(id);
    if (TERMINAL.includes(this.get(id)?.status)) await this.purgeExpansion(id);
    return { discarded: true, id };
  }
  purgeExpansion(id) {
    if (this.expansionPurges.has(id)) return this.expansionPurges.get(id);
    const pending = this.finishExpansionPurge(id).finally(() => this.expansionPurges.delete(id));
    this.expansionPurges.set(id, pending); return pending;
  }
  async finishExpansionPurge(id) {
    const job = this.get(id); if (!job || job.kind !== 'expand' || !TERMINAL.includes(job.status)) return;
    const captions = new Set([job.result?.prompt, job.request.prompt].filter(Boolean));
    if (job.prompt_id) {
      try {
        const history = (await this.api('/history/' + job.prompt_id))[job.prompt_id];
        const caption = history?.outputs?.['61']?.text?.[0];
        if (typeof caption === 'string' && caption.trim()) { captions.add(caption.trim()); this.update(id, { result: { ...job.result, prompt: caption.trim() } }); }
        await this.api('/history', { delete: [job.prompt_id] });
      } catch (error) { if (error.cause?.code !== 'ECONNREFUSED') throw error; }
    }
    await clearExpansionCache(this.gallery.output, captions);
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM job_references WHERE job_id=?').run(id);
      this.db.prepare('DELETE FROM jobs WHERE id=?').run(id); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  async recoverExpansions() {
    const rows = this.db.prepare("SELECT id FROM jobs WHERE kind='expand' AND (discarded=1 OR created<?)").all(now() - 86400);
    for (const { id } of rows) {
      const job = this.get(id);
      try {
        if (TERMINAL.includes(job.status)) { this.update(id, { discarded: 1 }); await this.purgeExpansion(id); }
        else await this.discardExpansion(id);
      } catch (error) { console.warn('Prompt expansion cleanup awaits retry:', id, error.message); }
    }
  }
  async engineReady() {
    if (this.options.runImage) { await this.api('/queue'); return; }
    try { await this.api('/queue'); return; } catch { /* Start only the configured existing engine. */ }
    if (!this.options.engineService) throw Error('The image engine is offline. Start ComfyUI first.');
    const service = this.options.engineService;
    await exec('systemctl', ['--user', 'start', service], { timeout: 15000 });
    const deadline = Date.now() + 100_000;
    while (Date.now() < deadline && !this.stopped) {
      try { await this.api('/queue'); return; } catch { await sleep(1500); }
    }
    throw Error('The image engine did not become ready. Check its service log.');
  }
  async releaseModels() {
    await this.api('/free', { unload_models: true, free_memory: true });
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline && !this.stopped) {
      const stats = await this.api('/system_stats');
      if (!stats.devices?.length) return;
      const gpuFree = stats.devices.every(device => !device.vram_total || device.vram_free >= device.vram_total * 0.8);
      if (gpuFree) {
        if (!stats.system?.ram_free || stats.system.ram_free >= 17 * 2 ** 30) return;
        break;
      }
      await sleep(250);
    }
    if (this.stopped) return;
    const queue = await this.api('/queue');
    if (!this.options.engineService || queue.queue_running.length || queue.queue_pending.length)
      throw Error('The engine could not release its previous model. Retry once the engine is idle.');
    // Native text generation can retain host allocations after GC on XPU. Recycle only an idle engine.
    await exec('systemctl', ['--user', 'restart', this.options.engineService], { timeout: 45000 });
    await this.engineReady();
  }
  start() { if (!this.worker) {
    if (this.options.runImage) this.db.exec("UPDATE jobs SET status='generated' WHERE kind='image' AND status='failed' AND json_array_length(images)>0");
    this.worker = this.consume();
  } }
  async close() { this.stopped = true; this.wakeup?.(); await this.worker; this.db.close(); }
  async consume() {
    while (!this.stopped) {
      const row = this.db.prepare("SELECT * FROM jobs WHERE status IN ('queued','running','cancelling','generated') ORDER BY created LIMIT 1").get();
      if (!row) { await new Promise(resolve => { this.wakeup = resolve; }); this.wakeup = null; continue; }
      const job = this.decode(row);
      if (!acceptingJobs() && !job.prompt_id) {
        this.update(job.id, { status: 'cancelled', finished: now(), error: 'Daily shutdown: queued work stopped at 22:30.' });
        continue;
      }
      try {
        if (job.kind === 'expand' && this.options.expandPrompt) {
          this.update(job.id, { status: 'running', started: now(), progress: { phase: 'Enhancing with Qwen 27B' } });
          const result = await this.options.expandPrompt(job.request, this.references, job.id);
          if (this.get(job.id)?.status !== 'cancelled') this.update(job.id, { result, status: 'completed', finished: now(), progress: { phase: 'Ready to review' } });
        } else if (this.options.runImage) {
          await this.options.runImage(job.status === 'generated' ? async () => {} : () => this.execute(job), job);
          if (!this.stopped && this.get(job.id)?.status === 'generated') this.update(job.id, { status: 'completed', finished: now(), progress: { phase: 'Completed', step: 6, steps: 6 } });
        }
        else await this.execute(job);
      }
      catch (error) {
        if (this.stopped) break;
        if (this.get(job.id)?.status === 'cancelled') continue;
        console.error('Job failed:', job.id, error);
        this.update(job.id, { status: 'failed', error: String(error.message).slice(0, 3000), finished: now() });
      }
      if (!this.stopped && job.kind === 'expand' && this.get(job.id)?.discarded) {
        try { await this.purgeExpansion(job.id); } catch (error) { console.warn('Prompt expansion cleanup awaits retry:', error.message); }
      }
    }
  }
  async recoverSubmission(job) {
    // A process could exit after ComfyUI accepted /prompt but before SQLite got its ID.
    const queue = await this.api('/queue');
    const matches = item => job.kind === 'expand' ? item?.[2]?.['60']?._meta?.desk_job_id === job.id : item?.[2]?.['9']?.inputs?.filename_prefix === `DiffusionDesk/${job.id}-native`;
    const queued = [...queue.queue_running, ...queue.queue_pending].find(matches);
    if (queued) { this.update(job.id, { prompt_id: queued[1] }); return; }
    const history = await this.api('/history?max_items=200');
    const finished = Object.entries(history).find(([, item]) => matches(item.prompt));
    if (finished) { this.update(job.id, { prompt_id: finished[0] }); return; }
    throw Error('Submission was interrupted. No duplicate was submitted; use the prompt to retry.');
  }
  connectProgress(job) {
    const url = new URL('/ws', this.options.comfyUrl); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('clientId', 'diffusion-desk-' + job.id);
    const socket = new WebSocket(url, { handshakeTimeout: 8000 });
    const phases = { 1: 'Loading INT8 image model', 3: 'Loading image decoder', 4: 'Encoding prompt', 10: 'Preparing image',
      7: 'Generating image', 8: 'Decoding image', 9: 'Saving original', 11: 'Creating preview', 12: 'Saving preview',
      60: 'Expanding prompt', 61: 'Preparing expanded prompt', 62: 'Preparing aspect ratio', 63: 'Finishing prompt expansion', 65: 'Loading prompt model' };
    socket.on('message', (message, binary) => {
      if (binary || this.stopped) return;
      try {
        const event = JSON.parse(message.toString()), data = event.data || {}, current = this.get(job.id);
        if (!current || !['running', 'cancelling'].includes(current.status) || data.prompt_id !== current.prompt_id) return;
        const progress = { ...current.progress };
        if (event.type === 'executing' && data.node) progress.phase = phases[data.node] || (job.kind === 'expand' ? 'Preparing reference pictures' : 'Processing image');
        else if (event.type === 'progress') Object.assign(progress, { phase: job.kind === 'expand' ? 'Expanding prompt' : 'Generating image', step: data.value || 0, steps: data.max || 6 });
        else return;
        this.update(job.id, { progress });
      } catch (error) { console.warn('Progress message skipped:', error.message); }
    });
    socket.on('error', error => console.warn('Progress stream:', error.message));
    return socket;
  }
  async execute(job) {
    if (job.kind === 'expand' && job.result?.prompt && job.result?.model) {
      if (job.discarded || job.status === 'cancelling') { this.update(job.id, { status: 'cancelled', finished: now() }); return; }
      await this.engineReady();
      const queue = await this.api('/queue');
      if (queue.queue_running.length || queue.queue_pending.length) { await sleep(2000); return; }
      await this.finishExpansion(job.id, job.result); return;
    }
    if (!job.prompt_id) this.update(job.id, { progress: { phase: 'Starting image engine', step: 0, steps: 6 } });
    await this.engineReady();
    if (this.stopped || !this.get(job.id)) return;
    if (['running', 'cancelling'].includes(job.status) && !job.prompt_id) await this.recoverSubmission(job);
    if (job.kind === 'expand' && !this.get(job.id)?.prompt_id) {
      const queue = await this.api('/queue');
      if (queue.queue_running.length || queue.queue_pending.length) {
        this.update(job.id, { progress: { phase: 'Waiting for the image engine' } }); await sleep(2000); return;
      }
      this.update(job.id, { progress: { phase: 'Releasing previous model' } });
      await this.releaseModels();
      if (this.stopped || !this.get(job.id) || this.get(job.id).status === 'cancelled') return;
    }
    const socket = this.connectProgress(job);
    try {
      let wait = false;
      await this.exclusive(async () => {
        let current = this.get(job.id);
        if (!current || current.status === 'cancelled') return;
        if (!current.prompt_id) {
          const queue = await this.api('/queue');
          if (queue.queue_running.length || queue.queue_pending.length) {
            this.update(job.id, { progress: { phase: 'Waiting for the image engine', step: 0, steps: 6 } }); wait = true; return;
          }
          const references = this.references?.resolve(current.request.referenceIds) || [];
          for (const reference of references) await this.references.file(reference.id);
          const { graph, workflow } = current.kind === 'expand' ? makeExpansionGraph(current, references) : makeGraph(current, references);
          this.update(job.id, { status: 'running', started: now(), progress: { phase: 'Preparing text encoder', step: 0, steps: 6 } });
          const result = await this.api('/prompt', { prompt: graph, client_id: 'diffusion-desk-' + job.id, extra_data: { extra_pnginfo: { workflow } } });
          this.update(job.id, { prompt_id: result.prompt_id });
        }
      });
      if (wait) { await sleep(2000); return; }
      let missingSince = 0, unavailableSince = 0;
      while (!this.stopped) {
        const current = this.get(job.id);
        if (current.status === 'cancelled') return;
        if (localClock() >= 22 * 60 + 50 || current.elapsed > (current.kind === 'expand' ? 600 : 1200)) {
          await this.cancelEngineJob(current);
          this.update(job.id, { status: 'cancelled', finished: now(), error: 'Stopped at the daily shutdown or processing time limit.' }); return;
        }
        const memory = await readFile('/proc/meminfo', 'utf8');
        const available = Number(memory.match(/^MemAvailable:\s+(\d+)/m)?.[1] || Infinity) * 1024;
        if (available < 1536 * 2 ** 20) {
          await this.cancelEngineJob(current);
          if (this.options.engineService) await exec('systemctl', ['--user', 'stop', this.options.engineService], { timeout: 45000 });
          throw Error('Stopped to protect system memory. Retry with a smaller image.');
        }
        let history, queue;
        try { history = await this.api('/history/' + current.prompt_id); unavailableSince = 0; }
        catch (error) {
          unavailableSince ||= Date.now();
          if (Date.now() - unavailableSince > 20000) throw Error('Connection to the image engine was lost. Its saved job state is retained.');
          await sleep(1500); continue;
        }
        const result = history[current.prompt_id];
        if (result) {
          if (this.get(job.id)?.status === 'cancelling') { this.update(job.id, { status: 'cancelled', finished: now() }); return; }
          if (result.status?.status_str !== 'success') {
            const errors = (result.status?.messages || []).filter(m => ['execution_error', 'execution_interrupted'].includes(m[0])).map(m => m[1].exception_message || m[0]);
            throw Error(errors.join('; ') || 'Image generation failed.');
          }
          if (current.kind === 'expand') {
            const expanded = expansionResult(result, current.request.prompt);
            await this.finishExpansion(job.id, expanded);
            return;
          }
          const saved = [];
          for (const output of Object.values(result.outputs || {})) {
            for (const image of output.images || []) {
              if (image.type !== 'output') continue;
              const file = path.resolve(this.gallery.output, image.subfolder || '', image.filename);
              if (inside(this.gallery.output, file) && (await stat(file)).isFile()) saved.push(path.relative(this.gallery.output, file));
            }
          }
          if (!saved.length) throw Error('The image engine returned no saved images.');
          this.update(job.id, { status: this.options.runImage ? 'generated' : 'completed', finished: now(), images: saved, progress: { phase: this.options.runImage ? 'Restoring engine' : 'Completed', step: 6, steps: 6 } });
          this.gallery.lastScan = 0; return;
        }
        queue = await this.api('/queue');
        if (![...queue.queue_running, ...queue.queue_pending].some(q => q[1] === current.prompt_id)) {
          missingSince ||= Date.now();
          if (Date.now() - missingSince > 6000) {
            if (current.status === 'cancelling') { this.update(job.id, { status: 'cancelled', finished: now() }); return; }
            throw Error('The image engine lost this job. No duplicate was submitted; retry explicitly.');
          }
        } else missingSince = 0;
        await sleep(1000);
      }
    } finally { socket.close(); }
  }
  async finishExpansion(id, expanded) {
    this.update(id, { result: expanded, progress: { phase: 'Releasing prompt model' } });
    await this.releaseModels();
    if (this.stopped) return;
    const current = this.get(id); if (!current) return;
    this.update(id, { status: current.discarded || current.status === 'cancelling' ? 'cancelled' : 'completed', finished: now(), progress: { phase: 'Ready to review' } });
  }
  async cancelEngineJob(job) {
    if (!job.prompt_id) return;
    const queue = await this.api('/queue');
    if (queue.queue_running.some(q => q[1] === job.prompt_id)) await this.api('/interrupt', { prompt_id: job.prompt_id });
    else if (queue.queue_pending.some(q => q[1] === job.prompt_id)) await this.api('/queue', { delete: [job.prompt_id] });
    const deadline = Date.now() + 15000;
    while (!this.stopped) {
      const current = await this.api('/queue');
      if (![...current.queue_running, ...current.queue_pending].some(q => q[1] === job.prompt_id)) return;
      if (Date.now() >= deadline) throw Error('Image cancellation is still pending; engine ownership was retained.');
      await sleep(250);
    }
  }
  async cancel(id) {
    this.options.cancelExpansion?.(id);
    return this.exclusive(async () => {
      const job = this.get(id);
      if (!job) throw Object.assign(Error('Unknown image job'), { status: 404 });
      if (TERMINAL.includes(job.status) || job.status === 'generated') return job.status;
      if (!job.prompt_id && job.kind !== 'expand') this.options.cancelImageWaiter?.(id);
      if (job.prompt_id) {
        this.update(id, { status: 'cancelling' });
        try { await this.cancelEngineJob(job); }
        catch { this.update(id, { status: 'cancelled', finished: now() }); }
      } else this.update(id, { status: 'cancelled', finished: now() });
      this.wakeup?.();
      return this.get(id).status;
    });
  }
  annotations() { return new Map(this.db.prepare('SELECT * FROM annotations').all().map(r => [r.id, { favorite: Boolean(r.favorite), pinned: Boolean(r.pinned), rating: r.rating, keywords: JSON.parse(r.keywords) }])); }
  annotate(id, data) {
    if (!data || Array.isArray(data) || typeof data !== 'object' || Object.keys(data).some(k => !['favorite', 'pinned', 'rating', 'keywords'].includes(k))) throw Error('Invalid image annotation.');
    for (const key of ['favorite', 'pinned']) if (key in data && typeof data[key] !== 'boolean') throw Error('Favorite and pinned must be true or false.');
    if ('rating' in data && (!Number.isInteger(data.rating) || data.rating < 0 || data.rating > 5)) throw Error('Rating must be between zero and five.');
    if ('keywords' in data && (!Array.isArray(data.keywords) || data.keywords.length > 20 || data.keywords.some(t => typeof t !== 'string' || !t.trim() || t.length > 40))) throw Error('Use up to 20 keywords, each between 1 and 40 characters.');
    const values = Object.entries(data).map(([k, v]) => [k, k === 'keywords' ? JSON.stringify([...new Set(v.map(t => t.trim()))]) : typeof v === 'boolean' ? Number(v) : v]);
    this.db.prepare('INSERT OR IGNORE INTO annotations(id) VALUES(?)').run(id);
    if (values.length) this.db.prepare('UPDATE annotations SET ' + values.map(([k]) => k + '=?').join(',') + ' WHERE id=?').run(...values.map(([, v]) => v), id);
  }
}
