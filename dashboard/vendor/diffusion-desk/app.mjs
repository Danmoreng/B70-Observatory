#!/usr/bin/env node
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, realpath, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Gallery, inside } from './gallery.mjs';
import { Jobs } from './jobs.mjs';
import { Deletion } from './deletion.mjs';
import { References, MAX_REFERENCES, MAX_UPLOAD_BYTES } from './references.mjs';
import { acceptingJobs, SIZES, SAMPLERS, SCHEDULERS } from './recipe.mjs';
import { expansionAvailable, EXPANSION_MAX_REFERENCES, EXPANDER_LABEL } from './expansion.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const notFound = () => Object.assign(Error('Not found'), { status: 404 });

function json(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { 'Content-Type': TYPES['.json'], 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  response.end(body);
}
async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw Object.assign(Error('Use application/json'), { status: 415 });
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 64 * 1024) throw Object.assign(Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(Error('Invalid JSON'), { status: 400 }); }
}
async function sendFile(request, response, file, headers = {}) {
  const info = await stat(file);
  if (!info.isFile()) throw notFound();
  response.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': info.size, ...headers });
  if (request.method === 'HEAD') { response.end(); return; }
  const stream = createReadStream(file);
  stream.on('error', error => { console.warn('File response:', error.message); response.destroy(); });
  response.once('close', () => stream.destroy());
  stream.pipe(response);
}
async function diskFree(root) { const info = await statfs(root); return info.bavail * info.bsize; }

export async function createDesk(options) {
  options = { host: '127.0.0.1', port: 8094, comfyUrl: 'http://127.0.0.1:8188', engineService: '',
    stateDir: path.join(homedir(), '.local/state/diffusion-desk-comfyui'), staticDir: path.resolve(HERE, '../../public/comfyui'), ...options };
  const target = new URL(options.comfyUrl);
  if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !['http:', 'https:'].includes(target.protocol)) throw Error('ComfyUI must stay on loopback.');
  if (!options.comfyRoot) throw Error('--comfy-root is required');
  options.comfyRoot = path.resolve(options.comfyRoot); options.stateDir = path.resolve(options.stateDir); options.staticDir = path.resolve(options.staticDir);
  await mkdir(path.join(options.comfyRoot, 'output'), { recursive: true });
  const gallery = new Gallery(path.join(options.comfyRoot, 'output'), path.join(options.stateDir, 'thumbs'));
  const jobs = new Jobs(options, gallery); await jobs.open();
  const references = new References(options, jobs.db); await references.open(); jobs.references = references;
  const deletion = new Deletion(options, gallery, jobs); await deletion.recover();
  await jobs.recoverExpansions();

  async function route(request, response) {
    const authority = request.headers.host || '', host = authority.split(':')[0];
    if (!options.integrated && ![options.host, '127.0.0.1', 'localhost'].includes(host)) throw Object.assign(Error('Unknown host'), { status: 403 });
    const url = new URL(request.url, 'http://' + authority), pathname = decodeURIComponent(url.pathname);
    const mutation = !['GET', 'HEAD'].includes(request.method);
    if (mutation) {
      if ((request.headers.origin && request.headers.origin !== 'http://' + authority) || request.headers['sec-fetch-site'] === 'cross-site')
        throw Object.assign(Error('Cross-origin request rejected'), { status: 403 });
      if (request.headers['x-desk-request'] !== '1') throw Object.assign(Error('Missing request header'), { status: 403 });
    }
    if (!mutation && pathname === '/api/config') {
      return json(response, 200, { model: 'MiniMax H3 Image · INT8', sizes: SIZES, steps: 6, cfg: 1, sampler: 'euler', scheduler: 'simple',
        sampling: { samplers: SAMPLERS, schedulers: SCHEDULERS },
        maxReferences: MAX_REFERENCES, maxUploadBytes: MAX_UPLOAD_BYTES,
        promptExpansion: { available: (options.expandPrompt ? true : await expansionAvailable(options)), maxReferences: EXPANSION_MAX_REFERENCES, model: options.expandPrompt ? 'Qwen 27B · vLLM' : EXPANDER_LABEL },
        acceptingJobs: acceptingJobs() && (options.allowImages?.() ?? true), freeGiB: Math.round(await diskFree(options.comfyRoot) / 2 ** 30 * 10) / 10 });
    }
    if (mutation && ['/api/jobs', '/api/expansions'].includes(pathname) && options.allowImages && !options.allowImages()) throw Object.assign(Error('Select Hybrid or Bildstudio to generate images.'), { status: 409 });
    if (pathname === '/api/expansions' && request.method === 'POST') return json(response, 202, { id: await jobs.submitExpansion(await readJson(request)) });
    const expansion = pathname.match(/^\/api\/expansions\/([0-9a-f]{32})$/);
    if (expansion) {
      if (!mutation) return json(response, 200, { job: jobs.expansion(expansion[1]) });
      if (request.method === 'DELETE') { await readJson(request); return json(response, 200, await jobs.discardExpansion(expansion[1])); }
    }
    if (pathname === '/api/references') {
      if (!mutation) return json(response, 200, { references: references.list() });
      if (request.method === 'POST') {
        if (await diskFree(options.comfyRoot) < 3 * 2 ** 30) throw Error('Less than 3 GiB disk space remains. Free space before uploading.');
        if (request.headers['content-type']?.split(';')[0] === 'application/json') {
          const body = await readJson(request), item = (await gallery.scan()).get(body?.imageId);
          if (!item) throw notFound();
          return json(response, 201, { reference: await references.fromGallery(await gallery.file(item, 'original')) });
        }
        return json(response, 201, { reference: await references.upload(request) });
      }
    }
    const reference = pathname.match(/^\/api\/references\/([0-9a-f]{32})$/);
    if (reference && request.method === 'DELETE') { await readJson(request); return json(response, 200, await references.remove(reference[1])); }
    const referenceMedia = pathname.match(/^\/references\/([0-9a-f]{32})\/(image|thumb)$/);
    if (!mutation && referenceMedia) return sendFile(request, response, await references.file(referenceMedia[1], referenceMedia[2]), { 'Cache-Control': 'no-store' });
    if (pathname === '/api/jobs') {
      if (request.method === 'POST') {
        const body = await readJson(request);
        if (await diskFree(options.comfyRoot) < 3 * 2 ** 30) throw Error('Less than 3 GiB disk space remains. Free space before generating more images.');
        return json(response, 202, { ids: jobs.submit(body) });
      }
      if (!mutation) {
        let engine;
        try { const queue = await jobs.api('/queue'); engine = { online: true, busy: Boolean(queue.queue_running.length || queue.queue_pending.length) }; }
        catch { engine = { online: false, busy: false }; }
        return json(response, 200, { jobs: jobs.list(), engine, acceptingJobs: acceptingJobs() && (options.allowImages?.() ?? true) });
      }
    }
    const cancel = pathname.match(/^\/api\/jobs\/([0-9a-f]{32})\/cancel$/);
    if (cancel && request.method === 'POST') { await readJson(request); return json(response, 200, { status: await jobs.cancel(cancel[1]) }); }
    if (!mutation && pathname === '/api/images') {
      const indexed = await gallery.scan(), annotations = jobs.annotations();
      const images = [...indexed.values()].map(item => {
        const job = jobs.forImage(path.relative(gallery.output, item.original.path));
        return { ...gallery.public(item), favorite: false, pinned: false, rating: 0, keywords: [], ...annotations.get(item.id),
          generationTime: job?.elapsed ?? null, jobId: job?.id ?? null, mode: job?.request.mode || 'generate',
          references: job ? references.resolve(job.request.referenceIds) : [], ...(job ? { title: job.request.prompt.slice(0, 90) } : {}) };
      }).sort((a, b) => b.created - a.created);
      return json(response, 200, { images });
    }
    const annotation = pathname.match(/^\/api\/images\/([0-9a-f]{20})$/);
    if (annotation && request.method === 'DELETE') {
      const data = await readJson(request);
      if (data?.confirm !== true) throw Error('Confirm permanent deletion of this image.');
      return json(response, 200, await deletion.remove(annotation[1]));
    }
    if (annotation && request.method === 'PATCH') {
      if (!(await gallery.scan()).has(annotation[1])) throw notFound();
      jobs.annotate(annotation[1], await readJson(request));
      return json(response, 200, { saved: true });
    }
    const media = pathname.match(/^\/media\/([0-9a-f]{20})\/(original|preview|thumb|workflow|settings)$/);
    if (!mutation && media) {
      const item = (await gallery.scan()).get(media[1]), variant = media[2];
      if (!item) throw notFound();
      if (variant === 'workflow' || variant === 'settings') {
        const job = jobs.forImage(path.relative(gallery.output, item.original.path));
        const body = variant === 'workflow' ? item.original.workflow : JSON.stringify({ ...gallery.public(item),
          mode: job?.request.mode || 'generate', references: job ? references.resolve(job.request.referenceIds) : [] }, null, 2);
        if (!body) throw notFound();
        response.writeHead(200, { 'Content-Type': TYPES['.json'], 'Content-Length': Buffer.byteLength(body),
          'Content-Disposition': `attachment; filename="${item.id}-${variant}.json"`, 'Cache-Control': 'no-store' });
        return response.end(request.method === 'HEAD' ? undefined : body);
      }
      const file = await gallery.file(item, variant), headers = { 'Cache-Control': 'private, max-age=3600' };
      if (url.searchParams.get('download') === '1') {
        const filename = `${item.original.quantization.toLowerCase()}-${path.basename(file)}`.replace(/["\r\n]/g, '');
        headers['Content-Disposition'] = `attachment; filename="${filename}"`;
      }
      headers['Cache-Control'] = 'no-store';
      return sendFile(request, response, file, headers);
    }
    if (mutation || pathname.startsWith('/api/') || pathname.startsWith('/media/')) throw notFound();
    let file = path.resolve(options.staticDir, '.' + pathname);
    if (!inside(options.staticDir, file)) throw notFound();
    try { if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html'); }
    catch { if (path.extname(file)) throw notFound(); file = path.join(options.staticDir, 'index.html'); }
    if (!inside(options.staticDir, await realpath(file))) throw notFound();
    return sendFile(request, response, file, { 'Cache-Control': 'no-cache' });
  }

  const server = http.createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'");
    route(request, response).catch(error => {
      if (response.headersSent) { response.destroy(); return; }
      const status = error.status || (['ENOENT', 'EACCES'].includes(error.code) ? 404 : 400);
      if (status !== 404) console.warn('Request failed:', request.method, request.url, error.message);
      json(response, status, { error: status === 404 ? 'Not found' : error.message });
    });
  });
  server.headersTimeout = 15000; server.requestTimeout = 90000;
  return { server, jobs, gallery, deletion, references, options, route,
    async listen() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port, options.host, resolve); });
      jobs.start(); return server.address();
    },
    async close() {
      const closed = new Promise(resolve => server.close(resolve)); server.closeIdleConnections();
      // Drain uploads before closing their SQLite connection; keep queued work for restart.
      jobs.stopped = true; jobs.wakeup?.();
      await closed; await jobs.close();
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'comfy-root': { type: 'string' }, 'state-dir': { type: 'string' }, 'static-dir': { type: 'string' },
    host: { type: 'string' }, port: { type: 'string' }, 'comfy-url': { type: 'string' }, 'engine-service': { type: 'string' }, 'legacy-thumbnail-dir': { type: 'string' } } });
  const camel = { 'comfy-root': 'comfyRoot', 'state-dir': 'stateDir', 'static-dir': 'staticDir', 'comfy-url': 'comfyUrl', 'engine-service': 'engineService', 'legacy-thumbnail-dir': 'legacyThumbnailDir' };
  const options = Object.fromEntries(Object.entries(values).map(([k, v]) => [camel[k] || k, k === 'port' ? Number(v) : v]));
  const desk = await createDesk(options); await desk.listen();
  console.log(`Diffusion Desk: http://${desk.options.host}:${desk.options.port} (INT8)`);
  let closing = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
    if (closing) return; closing = true;
    await desk.close(); process.exit(0);
  });
}
