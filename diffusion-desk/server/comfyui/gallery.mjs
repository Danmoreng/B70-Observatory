/** Index ComfyUI outputs in place; explicit deletion is handled by the library service. */
import { createHash } from 'node:crypto';
import { open, readdir, stat, realpath, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import sharp from 'sharp';

sharp.cache({ memory: 32, files: 16, items: 32 });
sharp.concurrency(2);

export function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export async function pngMetadata(file) {
  const handle = await open(file, 'r');
  try {
    const signature = Buffer.alloc(8);
    await handle.read(signature, 0, 8, 0);
    if (!signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw Error('Not a PNG');
    let position = 8, width = 0, height = 0;
    const texts = {};
    // ComfyUI writes metadata before IDAT. Avoid reading multi-megabyte pixel payloads.
    for (let count = 0; count < 100; count++) {
      const header = Buffer.alloc(8);
      if ((await handle.read(header, 0, 8, position)).bytesRead !== 8) throw Error('Incomplete PNG');
      const length = header.readUInt32BE(), type = header.toString('ascii', 4);
      if (type === 'IDAT' || type === 'IEND') break;
      if (length > 4 * 1024 * 1024) throw Error('Oversized PNG metadata');
      const data = Buffer.alloc(length);
      if ((await handle.read(data, 0, length, position + 8)).bytesRead !== length) throw Error('Incomplete PNG');
      if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); }
      if (type === 'tEXt' || type === 'zTXt') {
        const split = data.indexOf(0);
        if (split >= 0) texts[data.toString('latin1', 0, split)] = type === 'tEXt'
          ? data.toString('utf8', split + 1) : inflateSync(data.subarray(split + 2), { maxOutputLength: 4 * 1024 * 1024 }).toString('utf8');
      }
      if (type === 'iTXt') {
        const split = data.indexOf(0), languageEnd = data.indexOf(0, split + 3), translatedEnd = data.indexOf(0, languageEnd + 1);
        if (split >= 0 && translatedEnd >= 0) {
          const body = data.subarray(translatedEnd + 1);
          texts[data.toString('latin1', 0, split)] = (data[split + 1] ? inflateSync(body, { maxOutputLength: 4 * 1024 * 1024 }) : body).toString('utf8');
        }
      }
      position += length + 12;
    }
    if (!width || !height) throw Error('PNG has no dimensions');
    return { width, height, texts };
  } finally { await handle.close(); }
}

async function* files(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) yield* files(file);
    else if (entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name)) yield file;
  }
}

export class Gallery {
  constructor(output, cache) {
    this.output = path.resolve(output); this.cache = cache;
    this.items = new Map(); this.metadata = new Map(); this.lastScan = 0;
    this.scanning = null; this.thumbnails = new Map(); this.thumbSlots = 0; this.thumbWaiters = [];
    this.deleting = new Set();
  }
  async scan(force = false) {
    if (this.scanning) return this.scanning;
    if (!force && Date.now() - this.lastScan < 3000) return this.items;
    this.scanning = this.index();
    try { return await this.scanning; } finally { this.scanning = null; }
  }
  async index() {
    const groups = new Map(), activeMetadata = new Map();
    for await (const file of files(this.output)) {
      try {
        if (!inside(this.output, await realpath(file))) continue;
        const info = await stat(file);
        if (Date.now() - info.mtimeMs < 1000) continue;
        const stamp = `${info.size}:${info.mtimeMs}`;
        let data = this.metadata.get(file)?.stamp === stamp ? this.metadata.get(file).data : null;
        if (!data) {
          const meta = /\.png$/i.test(file) ? await pngMetadata(file) : { ...await sharp(file).metadata(), texts: {} };
          const graph = JSON.parse(meta.texts.prompt || '{}');
          const nodes = Object.values(graph);
          const inputs = kind => nodes.find(n => n?.class_type === kind)?.inputs || {};
          const sampler = inputs('KSampler'), model = inputs('UNETLoader').unet_name || '';
          data = { width: meta.width, height: meta.height, prompt: inputs('MiniMaxH3XImageEncodeLowRAM').prompt || '',
            seed: sampler.seed ?? null, steps: sampler.steps ?? null, cfg: sampler.cfg ?? null,
            sampler: sampler.sampler_name || '', scheduler: sampler.scheduler || '', model,
            quantization: /int8/i.test(model) ? 'INT8' : /w4a8/i.test(model) ? 'W4A8' : '',
            workflow: meta.texts.workflow || null, graph };
        }
        activeMetadata.set(file, { stamp, data });
        const relative = path.relative(this.output, file), match = path.basename(file).match(/^(.+)-(?:native|1536)_(\d+)_\.(png|jpe?g|webp)$/i);
        const group = match ? path.join(path.dirname(relative), `${match[1]}_${match[2]}`) : relative;
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push({ ...data, path: file, created: info.mtimeMs / 1000, bytes: info.size });
      } catch (error) {
        // A partially written/corrupt output must not break the whole gallery.
        if (!['ENOENT', 'EACCES'].includes(error.code)) console.warn('Skipping image:', path.basename(file), error.message);
      }
    }
    const indexed = new Map();
    for (const [key, versions] of groups) {
      const original = versions.reduce((a, b) => a.width * a.height >= b.width * b.height ? a : b);
      const preview = versions.reduce((a, b) => Math.abs(Math.max(a.width, a.height) - 1536) <= Math.abs(Math.max(b.width, b.height) - 1536) ? a : b);
      const id = createHash('sha256').update(key).digest('hex').slice(0, 20);
      const comparisonKey = path.basename(key).replace(/_\d+$/, '');
      const category = key.startsWith('H3-Fashion-Portraits') ? 'Fashion' : key.startsWith('H3-Landscapes') ? 'Landscapes'
        : key.startsWith('DiffusionDesk/') ? 'New images' : key.startsWith('H3-Pingpong') ? 'Humor' : 'Other';
      if (this.deleting.has(id)) continue;
      indexed.set(id, { id, title: comparisonKey.replace(/[-_]/g, ' '), category, comparisonKey, original, preview, versions,
        created: Math.max(...versions.map(v => v.created)) });
    }
    this.items = indexed; this.metadata = activeMetadata; this.lastScan = Date.now();
    return indexed;
  }
  public(item) {
    const { original } = item;
    const keys = ['width', 'height', 'bytes', 'prompt', 'seed', 'steps', 'cfg', 'sampler', 'scheduler', 'model', 'quantization'];
    return { ...Object.fromEntries(['id', 'title', 'category', 'comparisonKey', 'created'].map(k => [k, item[k]])),
      ...Object.fromEntries(keys.map(k => [k, original[k]])), hasWorkflow: Boolean(original.workflow), hasPreview: item.preview.path !== original.path };
  }
  async file(item, variant) {
    if (this.deleting.has(item.id)) throw Object.assign(Error('Image is being deleted'), { status: 404 });
    const source = item[variant === 'original' ? 'original' : 'preview'].path;
    if (!inside(this.output, await realpath(source))) throw Object.assign(Error('Unknown image'), { status: 404 });
    if (variant !== 'thumb') return source;
    const info = await stat(source), target = path.join(this.cache, `${item.id}-${info.mtimeMs}.jpg`);
    if (this.deleting.has(item.id)) throw Object.assign(Error('Image is being deleted'), { status: 404 });
    try { await stat(target); return target; } catch { /* Create on demand. */ }
    if (this.thumbnails.has(target)) return this.thumbnails.get(target);
    const task = this.makeThumbnail(source, target);
    this.thumbnails.set(target, task);
    try { return await task; } finally { this.thumbnails.delete(target); }
  }
  async makeThumbnail(source, target) {
    if (this.thumbSlots >= 2) await new Promise(resolve => this.thumbWaiters.push(resolve));
    this.thumbSlots++;
    try {
      await mkdir(this.cache, { recursive: true });
      await sharp(source, { limitInputPixels: 40_000_000 }).rotate().resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 87 }).toFile(target + '.tmp');
      await rename(target + '.tmp', target);
      return target;
    } finally { this.thumbSlots--; this.thumbWaiters.shift()?.(); }
  }
}
