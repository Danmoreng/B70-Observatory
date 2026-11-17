import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, utimes, symlink, rm, stat, readdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import sharp from 'sharp';
import { WebSocketServer } from 'ws';
import { createDesk } from '../app.mjs';
import { makeGraph, validateRequest, DIT, SIZES, SAMPLERS, SCHEDULERS, localClock } from '../recipe.mjs';
import { Gallery, pngMetadata } from '../gallery.mjs';
import { EXPANDER, expansionResult, makeExpansionGraph, validateExpansion } from '../expansion.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { if (await check()) return; await sleep(50); }
  assert.fail('Timed out waiting for adapter state');
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
async function png(file, graph, workflow = { nodes: [] }) {
  await mkdir(path.dirname(file), { recursive: true });
  let buffer = await sharp({ create: { width: 96, height: 64, channels: 3, background: '#7a92cc' } }).png().toBuffer();
  for (const [key, value] of Object.entries({ prompt: graph, workflow })) {
    const data = Buffer.from(key + '\0' + JSON.stringify(value)), type = Buffer.from('tEXt'), header = Buffer.alloc(4), crc = Buffer.alloc(4);
    header.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
    buffer = Buffer.concat([buffer.subarray(0, 33), header, type, data, crc, buffer.subarray(33)]);
  }
  await writeFile(file, buffer); await utimes(file, new Date(Date.now() - 2000), new Date(Date.now() - 2000));
}

test('default INT8 recipe, real size presets and timezone-aware cutoff', () => {
  assert.throws(() => validateRequest({ prompt: 'test', model: 'w4a8' }));
  for (const seed of [true, null, 1.2, 2 ** 32, -2]) assert.throws(() => validateRequest({ prompt: 'test', seed }));
  assert.equal(validateRequest({ prompt: ' test ', seed: 0 }).seed, 0);
  const square = SIZES.find(size => size.id === 'square-quick');
  assert.equal(square.width, 1024); assert.equal(square.height, 1024);
  assert.equal(makeGraph({ id: 'a'.repeat(32), request: validateRequest({ prompt: 'Legacy square image', sizeId: square.id }) }).graph['10'].inputs.megapixels, '1 MP (test)');
  assert.equal(localClock(new Date('2026-07-01T20:30:00Z')), 22 * 60 + 30);
  assert.equal(localClock(new Date('2026-11-13T21:30:00Z')), 22 * 60 + 30);
  for (const size of SIZES) {
    const { graph, workflow } = makeGraph({ id: 'a'.repeat(32), request: { prompt: 'A lake', sizeId: size.id, seed: 0 } });
    assert.equal(graph['1'].inputs.unet_name, DIT);
    assert.equal(graph['7'].inputs.steps, 6); assert.equal(graph['7'].inputs.seed, 0);
    assert.equal(graph['4'].inputs.use_cache, true);
    assert.equal(size.width % 32, 0); assert.equal(size.height % 32, 0);
    assert.equal(workflow.last_node_id, Math.max(...workflow.nodes.map(n => n.id)));
    assert.equal(workflow.nodes.find(n => n.id === 4).widgets_values[1], 'A lake');
    assert.deepEqual(workflow.nodes.find(n => n.id === 7).widgets_values, [0, 'fixed', 6, 1, 'euler', 'simple', 1]);
  }
});

test('sampling validation rejects unknown names and invalid noise before queueing', () => {
  for (const field of ['sampler', 'scheduler']) {
    for (const value of [null, '', 'unsupported', ['euler'], 1])
      assert.throws(() => validateRequest({ prompt: 'A lake', [field]: value }));
  }
  for (const field of ['noiseStart', 'noiseEnd']) {
    for (const value of [null, '', '1.1', true, -0.01, 64.01, NaN, Infinity])
      assert.throws(() => validateRequest({ prompt: 'A lake', [field]: value }));
  }
  assert.equal(validateRequest({ prompt: 'A lake', noiseStart: 0, noiseEnd: 64 }).noiseStart, 0);
  for (const sampler of SAMPLERS.filter(name => name !== 'lcm')) {
    for (const scheduler of SCHEDULERS) {
      const request = validateRequest({ prompt: 'A lake', sampler, scheduler, seed: 0 });
      const { graph, workflow } = makeGraph({ id: 'd'.repeat(32), request });
      assert.equal(graph['7'].inputs.sampler_name, sampler);
      assert.equal(graph['7'].inputs.scheduler, scheduler);
      assert.equal(workflow.nodes.find(node => node.id === 7).widgets_values[5], scheduler);
    }
  }
});

test('LCM noise ramp survives the persisted job, PNG metadata and downloadable workflow with references', async t => {
  const state = await setup(t);
  const references = Array.from({ length: 16 }, (_, index) => ({ id: index.toString(16).padStart(32, '0'), filename: `picture-${index}.png` }));
  const request = validateRequest({ prompt: 'A misty alpine lake', seed: 0, sampler: 'lcm', scheduler: 'beta', noiseStart: 1.27, noiseEnd: 0.81 });
  // The same validated request is persisted in SQLite for every queued image.
  const response = await state.client('/api/jobs', { ...request, count: 2 });
  assert.equal(response.status, 202);
  const { ids } = await response.json();
  assert.deepEqual(state.desk.jobs.get(ids[0]).request, { ...request, count: 1 });
  assert.equal(state.desk.jobs.get(ids[1]).request.seed, 1);
  await until(() => ids.every(id => state.desk.jobs.get(id)?.status === 'completed'));
  assert.equal(state.fake.count, 2);
  assert.equal(state.fake.graphs.get(state.desk.jobs.get(ids[0]).prompt_id)['20'].inputs.s_noise, 1.27);
  const { graph, workflow } = makeGraph({ id: ids[0], request: { ...request, mode: 'edit', referenceIds: references.map(ref => ref.id) } }, references);
  assert.equal(graph['7'].class_type, 'SamplerCustom');
  assert.equal(graph['7'].inputs.noise_seed, 0);
  assert.deepEqual(graph['20'].inputs, { s_noise: 1.27, s_noise_end: 0.81, noise_clip_std: 0 });
  assert.deepEqual(graph['21'].inputs, { model: ['1', 0], scheduler: 'beta', steps: 6, denoise: 1 });
  for (const [id, source, output, target, input] of workflow.links) {
    const node = workflow.nodes.find(n => n.id === target), origin = workflow.nodes.find(n => n.id === source);
    assert.equal(node.inputs[input].link, id); assert.ok(origin.outputs[output].links.includes(id));
  }
  assert.equal(new Set(workflow.links.map(link => link[0])).size, workflow.links.length);
  assert.deepEqual(workflow.extra.diffusionDesk.sampling, { sampler: 'lcm', scheduler: 'beta', noiseStart: 1.27, noiseEnd: 0.81 });
  const root = await mkdtemp(path.join(tmpdir(), 'desk-lcm-')); t.after(() => rm(root, { recursive: true, force: true }));
  await png(path.join(root, 'output/lcm-native_00001_.png'), graph, workflow);
  const gallery = new Gallery(path.join(root, 'output'), path.join(root, 'thumbs'));
  const item = [...(await gallery.scan()).values()][0];
  assert.deepEqual(Object.fromEntries(['sampler', 'scheduler', 'noiseStart', 'noiseEnd', 'seed', 'steps', 'cfg'].map(key => [key, gallery.public(item)[key]])), { sampler: 'lcm', scheduler: 'beta', noiseStart: 1.27, noiseEnd: 0.81, seed: 0, steps: 6, cfg: 1 });
  const downloaded = JSON.parse((await pngMetadata(item.original.path)).texts.workflow);
  assert.deepEqual(downloaded.nodes.find(node => node.id === 20).widgets_values, [1.27, 0.81, 0]);
});

test('reference workflows wire every numbered picture to the low-RAM encoder and VAE', () => {
  const ids = ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)];
  const request = validateRequest({ prompt: 'Edit <Picture 1> using <Picture 2> and <Picture 3>.', mode: 'edit', referenceIds: ids });
  const references = ids.map(id => ({ id, filename: `DiffusionDesk/${id}.png` }));
  const { graph, workflow } = makeGraph({ id: 'a'.repeat(32), request }, references);
  assert.deepEqual(graph['4'].inputs.vae, ['3', 0]);
  ids.forEach((id, index) => {
    assert.equal(graph[100 + index].inputs.image, `DiffusionDesk/${id}.png`);
    assert.deepEqual(graph['4'].inputs[`images.image_${index + 1}`], [String(100 + index), 0]);
  });
  for (const [id, source, output, target, input] of workflow.links) {
    const node = workflow.nodes.find(node => node.id === target), origin = workflow.nodes.find(node => node.id === source);
    assert.equal(node.inputs[input].link, id); assert.ok(origin.outputs[output].links.includes(id));
  }
  assert.deepEqual(workflow.extra.diffusionDesk.references.map(reference => reference.id), ids);
  assert.throws(() => validateRequest({ prompt: 'edit', mode: 'edit' }));
  assert.throws(() => validateRequest({ prompt: 'edit', referenceIds: [ids[0], ids[0]] }));
  assert.throws(() => validateRequest({ prompt: 'edit', referenceIds: ['../../outside'] }));
  assert.throws(() => makeGraph({ id: 'a'.repeat(32), request }));
});

test('gallery groups native/preview, reads Comfy metadata and rejects symlink escapes', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'desk-gallery-')); t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'output'); await mkdir(output);
  const { graph, workflow } = makeGraph({ id: 'b'.repeat(32), request: { prompt: 'Über den Bergen', sizeId: 'landscape-8', seed: 0 } });
  await png(path.join(output, 'example-native_00001_.png'), graph, workflow);
  await png(path.join(output, 'example-1536_00001_.png'), graph, workflow);
  await png(path.join(root, 'outside.png'), graph);
  await symlink(path.join(root, 'outside.png'), path.join(output, 'escape.png'));
  await writeFile(path.join(output, 'broken.png'), 'incomplete');
  const gallery = new Gallery(output, path.join(root, 'thumbs')), items = await gallery.scan();
  assert.equal(items.size, 1);
  const item = [...items.values()][0], publicImage = gallery.public(item);
  assert.equal(publicImage.prompt, 'Über den Bergen'); assert.equal(publicImage.seed, 0); assert.equal(publicImage.quantization, 'INT8');
  assert.equal(JSON.parse((await pngMetadata(item.original.path)).texts.workflow).nodes.length, workflow.nodes.length);
  const thumb = await gallery.file(item, 'thumb'); assert.equal((await sharp(thumb).metadata()).format, 'jpeg');
  graph['7'].inputs.sampler_name = 'lcm';
  await png(path.join(output, 'legacy-lcm.png'), graph);
  const legacy = [...(await gallery.scan(true)).values()].find(image => image.original.sampler === 'lcm');
  assert.equal(gallery.public(legacy).noiseStart, 1);
  assert.equal(gallery.public(legacy).noiseEnd, 1);
});

async function setup(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'desk-api-'));
  const comfyRoot = path.join(root, 'comfy'), output = path.join(comfyRoot, 'output'), staticDir = path.join(root, 'public');
  await mkdir(output, { recursive: true }); await mkdir(staticDir); await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>Diffusion Desk</title>');
  await mkdir(path.join(comfyRoot, 'models', 'text_encoders'), { recursive: true });
  await writeFile(path.join(comfyRoot, 'models', 'text_encoders', EXPANDER), 'mock model');
  const fake = { count: 0, running: [], history: {}, graphs: new Map(), interrupted: [], paused: false };
  const sockets = new Map();
  fake.complete = async id => {
    const graph = fake.graphs.get(id), saved = [];
    if (graph['60']) {
      const original = graph['60'].inputs.prompt, caption = 'Expanded English photograph: ' + original;
      const report = fake.expansionFailure || `expanded ${original.length} -> ${caption.length} characters in 1 s; model freed`;
      const cache = path.join(output, 'h3image_expand_cache'); await mkdir(cache, { recursive: true });
      await writeFile(path.join(cache, 'e'.repeat(64) + '.json'), JSON.stringify({ reply: JSON.stringify({ expanded_caption: caption, aspect_ratio: '3:2' }) }));
      fake.running = fake.running.filter(q => q[1] !== id);
      fake.history[id] = { prompt: [0, id, graph], status: { status_str: 'success' }, outputs: { 61: { text: [JSON.stringify({ expanded_caption: caption, aspect_ratio: '3:2' })] }, ...(fake.expansionFailure ? { 61: { text: [caption] }, 62: { text: ['3:2'] }, 63: { text: [report] } } : {}) } };
      return;
    }
    for (const node of ['9', '12']) {
      const prefix = graph[node].inputs.filename_prefix, relative = prefix + '_00001_.png';
      await png(path.join(output, relative), graph);
      saved.push({ filename: path.basename(relative), subfolder: path.dirname(relative), type: 'output' });
    }
    fake.running = fake.running.filter(q => q[1] !== id);
    fake.history[id] = { prompt: [0, id, graph], status: { status_str: 'success', messages: [] }, outputs: { 9: { images: [saved[0]] }, 12: { images: [saved[1]] } } };
  };
  const engine = http.createServer(async (request, response) => {
    let value, body = '';
    for await (const part of request) body += part;
    const data = body ? JSON.parse(body) : {};
    if (request.url === '/history' && request.method === 'POST') {
      for (const id of data.delete || []) { delete fake.history[id]; fake.graphs.delete(id); }
      response.writeHead(200); response.end(); return;
    }
    if (request.url === '/system_stats') value = fake.stats || {};
    else if (request.url === '/queue') value = { queue_running: fake.running, queue_pending: [] };
    else if (request.url === '/prompt') {
      const id = 'prompt-' + (++fake.count); fake.graphs.set(id, data.prompt); fake.running.push([0, id, data.prompt]); value = { prompt_id: id };
      setTimeout(() => sockets.get(data.client_id)?.send(JSON.stringify({ type: 'progress', data: { prompt_id: id, value: 2, max: 6 } })), 100);
      if (!fake.paused) setTimeout(() => { void fake.complete(id); }, 250);
    } else if (request.url.startsWith('/history')) value = fake.history;
    else if (request.url === '/interrupt') {
      fake.interrupted.push(data.prompt_id); fake.running = fake.running.filter(q => q[1] !== data.prompt_id);
      fake.history[data.prompt_id] = { status: { status_str: 'error', messages: [['execution_interrupted', {}]] } }; value = {};
    } else value = {};
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value));
  });
  const wss = new WebSocketServer({ server: engine });
  wss.on('connection', (socket, request) => sockets.set(new URL(request.url, 'http://localhost').searchParams.get('clientId'), socket));
  await new Promise(resolve => engine.listen(0, '127.0.0.1', resolve));
  const options = { comfyRoot, staticDir, stateDir: path.join(root, 'state'), port: 0, comfyUrl: 'http://127.0.0.1:' + engine.address().port, ...overrides };
  let desk = await createDesk(options); await desk.listen();
  const client = async (route, data, extra = {}) => {
    const url = 'http://127.0.0.1:' + desk.server.address().port + route;
    return fetch(url, { method: data === undefined ? 'GET' : 'POST', headers: data === undefined ? {} : { 'Content-Type': 'application/json', 'X-Desk-Request': '1', ...extra }, body: data === undefined ? undefined : JSON.stringify(data) });
  };
  t.after(async () => { await desk.close(); for (const socket of wss.clients) socket.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => engine.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { fake, client, get desk() { return desk; }, restart: async () => { await desk.close(); desk = await createDesk(options); await desk.listen(); } };
}

test('durable sequential jobs, gallery annotations, downloads and same-origin protections', async t => {
  const state = await setup(t), { fake, client } = state;
  assert.equal((await client('/')).status, 200);
  assert.equal((await client('/api/jobs', { prompt: 'A lake' }, { Origin: 'https://outside.example' })).status, 403);
  assert.equal((await client('/api/jobs', { prompt: 'A lake', model: 'W4A8' })).status, 400);
  const response = await client('/api/jobs', { prompt: 'A lake', sizeId: 'landscape-quick', seed: 0, count: 2 });
  assert.equal(response.status, 202); const { ids } = await response.json();
  await until(() => ids.every(id => state.desk.jobs.get(id).status === 'completed'));
  assert.equal(fake.count, 2); assert.equal(state.desk.jobs.get(ids[0]).request.seed, 0); assert.equal(state.desk.jobs.get(ids[1]).request.seed, 1);
  assert.ok(state.desk.jobs.get(ids[0]).elapsed > 0);
  await state.desk.gallery.scan(true);
  const images = (await (await client('/api/images')).json()).images;
  assert.equal(images.length, 2); const image = images[0]; assert.equal(image.quantization, 'INT8');
  const original = await client(`/media/${image.id}/original?download=1`);
  assert.equal(original.status, 200); assert.match(original.headers.get('content-disposition'), /attachment.*int8-/); await original.arrayBuffer();
  const thumb = await client(`/media/${image.id}/thumb`); assert.equal(thumb.headers.get('content-type'), 'image/jpeg'); await thumb.arrayBuffer();
  assert.equal((await client('/api/not-a-route')).status, 404);
  assert.equal((await client('/media/invalid/original')).status, 404);
  const annotate = await fetch('http://127.0.0.1:' + state.desk.server.address().port + `/api/images/${image.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Desk-Request': '1' }, body: JSON.stringify({ favorite: true, rating: 5, pinned: true, keywords: ['landscape'] }) });
  assert.equal(annotate.status, 200);
  await state.restart();
  assert.equal(state.desk.jobs.list().length, 2); assert.equal(state.desk.jobs.annotations().get(image.id).rating, 5);
});

test('prompt expansion validates inputs and refuses silent pass-through results', () => {
  const request = validateExpansion({ prompt: 'A lake', mode: 'generate', referenceIds: [], sizeId: 'landscape-4' });
  assert.equal(request.seed, 0);
  assert.throws(() => validateExpansion({ prompt: 'A lake', model: 'anything' }));
  assert.throws(() => validateExpansion({ prompt: 'A lake', referenceIds: [1, 2, 3, 4, 5].map(n => String(n).repeat(32)) }));
  assert.throws(() => validateExpansion({ prompt: 'Edit', mode: 'edit' }));
  const { graph } = makeExpansionGraph({ id: 'a'.repeat(32), request });
  assert.equal(graph['65'].inputs.clip_name, EXPANDER); assert.equal(graph['60']._meta.desk_job_id, 'a'.repeat(32));
  assert.equal(graph['60'].inputs.thinking, false);
  assert.throws(() => expansionResult({ outputs: { 61: { text: ['A lake'] }, 63: { text: ['The template was not found; prompt passed unchanged.'] } } }));
});

test('prompt expansion shares the image queue, resumes after restart and purges reviewed prompt/history/cache', async t => {
  const state = await setup(t); state.fake.paused = true;
  const imageId = (await (await state.client('/api/jobs', { prompt: 'Keep this image' })).json()).ids[0];
  await until(() => state.desk.jobs.get(imageId).prompt_id);
  const reference = await state.desk.references.ingest(await sharp({ create: { width: 100, height: 100, channels: 3, background: '#336699' } }).png().toBuffer(), 'Reference');
  const original = 'Unique original prompt 89fe30 for the red jacket';
  const response = await state.client('/api/expansions', { prompt: original, mode: 'edit', referenceIds: [reference.id] });
  assert.equal(response.status, 202); const { id } = await response.json();
  assert.equal(state.desk.jobs.get(id).status, 'queued'); assert.equal(state.fake.count, 1);
  assert.equal(state.desk.jobs.list().length, 1);
  await state.fake.complete(state.desk.jobs.get(imageId).prompt_id);
  await until(() => state.desk.jobs.get(id).prompt_id);
  const promptId = state.desk.jobs.get(id).prompt_id;
  assert.deepEqual(state.fake.graphs.get(promptId)['60'].inputs['images.image1'], ['200', 0]);
  assert.equal(state.fake.graphs.get(promptId)['200'].inputs.width, 96);
  await state.restart(); assert.equal(state.desk.jobs.get(id).prompt_id, promptId);
  await state.fake.complete(promptId);
  await until(() => state.desk.jobs.get(id).status === 'completed');
  const result = (await (await state.client('/api/expansions/' + id)).json()).job;
  assert.ok(result.result.prompt.startsWith('Expanded English photograph: ')); assert.ok(result.result.prompt.includes(original)); assert.equal(result.result.ratio, '3:2');
  assert.equal(state.desk.references.get(reference.id).id, reference.id); assert.equal(state.desk.references.list()[0].uses, 1);
  const deleted = await fetch('http://127.0.0.1:' + state.desk.server.address().port + '/api/expansions/' + id, { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'X-Desk-Request': '1' }, body: '{}' });
  assert.equal(deleted.status, 200); assert.equal(state.desk.jobs.get(id), null);
  assert.equal(state.fake.history[promptId], undefined); assert.equal(state.desk.references.list()[0].uses, 0);
  assert.equal((await readdir(path.join(state.desk.gallery.output, 'h3image_expand_cache'))).length, 0);
  assert.equal((await readFile(path.join(state.desk.options.stateDir, 'desk.db'))).includes(Buffer.from(original)), false);
  assert.equal(state.desk.jobs.get(imageId).status, 'completed');
});

test('queued expansion cancellation preserves image jobs; running cancellation targets and purges only the expansion', async t => {
  const state = await setup(t); state.fake.paused = true;
  const imageId = (await (await state.client('/api/jobs', { prompt: 'Keep running' })).json()).ids[0];
  await until(() => state.desk.jobs.get(imageId).prompt_id);
  const queuedId = (await (await state.client('/api/expansions', { prompt: 'Queued caption' })).json()).id;
  await state.desk.jobs.discardExpansion(queuedId);
  assert.equal(state.desk.jobs.get(queuedId), null); assert.equal(state.fake.interrupted.length, 0);
  await state.fake.complete(state.desk.jobs.get(imageId).prompt_id);
  const next = (await (await state.client('/api/expansions', { prompt: 'Running caption' })).json()).id;
  await until(() => state.desk.jobs.get(next).prompt_id);
  const promptId = state.desk.jobs.get(next).prompt_id;
  await state.desk.jobs.discardExpansion(next);
  await until(() => state.desk.jobs.get(next) === null);
  assert.deepEqual(state.fake.interrupted, [promptId]); assert.equal(state.desk.jobs.get(imageId).status, 'completed');
});

test('failed expansions expose the failure and abandoned reviews expire with their cache and history', async t => {
  const state = await setup(t); state.fake.expansionFailure = 'The official template was not found, so the prompt passes unchanged.';
  const id = (await (await state.client('/api/expansions', { prompt: 'Failed expansion' })).json()).id;
  await until(() => state.desk.jobs.get(id).status === 'failed');
  assert.match(state.desk.jobs.get(id).error, /official template was not found/);
  await state.desk.jobs.discardExpansion(id); assert.equal(state.desk.jobs.get(id), null);
  assert.equal((await readdir(path.join(state.desk.gallery.output, 'h3image_expand_cache'))).length, 0);
  state.fake.expansionFailure = '';
  const expired = (await (await state.client('/api/expansions', { prompt: 'Expired review unique 12ccc' })).json()).id;
  await until(() => state.desk.jobs.get(expired).status === 'completed');
  const promptId = state.desk.jobs.get(expired).prompt_id;
  state.desk.jobs.db.prepare('UPDATE jobs SET created=? WHERE id=?').run(Date.now() / 1000 - 90000, expired);
  await state.restart(); assert.equal(state.desk.jobs.get(expired), null); assert.equal(state.fake.history[promptId], undefined);
  assert.equal((await readdir(path.join(state.desk.gallery.output, 'h3image_expand_cache'))).length, 0);
});

test('a generated caption survives service restart after the engine history was recycled', async t => {
  const state = await setup(t);
  const id = (await (await state.client('/api/expansions', { prompt: 'A misty lake' })).json()).id;
  await until(() => state.desk.jobs.get(id).status === 'completed');
  const finished = state.desk.jobs.get(id), count = state.fake.count;
  delete state.fake.history[finished.prompt_id];
  state.desk.jobs.update(id, { status: 'running', progress: { phase: 'Releasing prompt model' } });
  await state.restart();
  await until(() => state.desk.jobs.get(id).status === 'completed');
  assert.equal(state.fake.count, count); assert.deepEqual(state.desk.jobs.get(id).result, finished.result);
  await state.desk.jobs.discardExpansion(id);
});

test('expansion refuses to load alongside retained host allocations when no idle-engine restart is configured', async t => {
  const state = await setup(t);
  state.fake.stats = { system: { ram_free: 8 * 2 ** 30 }, devices: [{ vram_total: 32 * 2 ** 30, vram_free: 31 * 2 ** 30 }] };
  const id = (await (await state.client('/api/expansions', { prompt: 'A lake' })).json()).id;
  await until(() => state.desk.jobs.get(id).status === 'failed');
  assert.equal(state.fake.count, 0); assert.match(state.desk.jobs.get(id).error, /could not release its previous model/);
  await state.desk.jobs.discardExpansion(id);
});

test('reattaches after adapter restart without a second generation; targeted cancellation', async t => {
  const state = await setup(t); state.fake.paused = true;
  const { ids } = await (await state.client('/api/jobs', { prompt: 'Portrait', seed: 123, count: 2 })).json();
  await until(() => state.desk.jobs.get(ids[0]).prompt_id);
  const promptId = state.desk.jobs.get(ids[0]).prompt_id;
  assert.equal((await state.client(`/api/jobs/${ids[1]}/cancel`, {})).status, 200);
  assert.equal(state.desk.jobs.get(ids[1]).status, 'cancelled'); assert.equal(state.fake.interrupted.length, 0);
  await state.restart();
  await state.fake.complete(promptId);
  await until(() => state.desk.jobs.get(ids[0]).status === 'completed');
  assert.equal(state.fake.count, 1);
  const next = await (await state.client('/api/jobs', { prompt: 'Another portrait' })).json();
  await until(() => state.desk.jobs.get(next.ids[0]).prompt_id);
  const activePrompt = state.desk.jobs.get(next.ids[0]).prompt_id;
  await state.client(`/api/jobs/${next.ids[0]}/cancel`, {});
  await until(() => state.desk.jobs.get(next.ids[0]).status === 'cancelled');
  assert.deepEqual(state.fake.interrupted, [activePrompt]);
});

async function makeCache(file, prompt) {
  const header = Buffer.from(JSON.stringify({ __metadata__: { format: 'h3image-conditioning/1', prompt } }));
  const prefix = Buffer.alloc(8); prefix.writeBigUInt64LE(BigInt(header.length));
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, Buffer.concat([prefix, header]));
}
async function permanentDelete(state, id, confirm = true) {
  return fetch('http://127.0.0.1:' + state.desk.server.address().port + `/api/images/${id}`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json', 'X-Desk-Request': '1' }, body: JSON.stringify({ confirm }),
  });
}

test('uploads are sanitized, persist with numbered references across restart and remain protected while jobs use them', async t => {
  const state = await setup(t);
  const upload = async (buffer, extra = {}) => fetch('http://127.0.0.1:' + state.desk.server.address().port + '/api/references', {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Desk-Request': '1', 'X-File-Name': encodeURIComponent('Test ü.png'), ...extra }, body: buffer,
  });
  const image = await sharp({ create: { width: 90, height: 60, channels: 4, background: '#10203080' } }).png().withMetadata({ orientation: 6 }).toBuffer();
  assert.equal((await upload(image, { Origin: 'https://outside.example' })).status, 403);
  assert.equal((await upload(Buffer.from('<svg></svg>'))).status, 400);
  const first = await upload(image); assert.equal(first.status, 201);
  const reference = (await first.json()).reference;
  assert.equal((await (await upload(image)).json()).reference.id, reference.id);
  assert.equal(reference.width, 60); assert.equal(reference.height, 90); assert.equal(reference.name, 'Test ü.png');
  const sanitized = await sharp(await state.desk.references.file(reference.id)).metadata();
  assert.equal(sanitized.orientation, undefined); assert.equal(sanitized.exif, undefined); assert.equal(sanitized.hasAlpha, false);
  const second = (await (await upload(await sharp({ create: { width: 100, height: 100, channels: 3, background: '#cc3344' } }).jpeg().toBuffer())).json()).reference;
  assert.equal((await state.client('/api/jobs', { prompt: 'Missing', referenceIds: ['f'.repeat(32)] })).status, 404);
  const request = { prompt: 'Edit <Picture 1> using the colors of <Picture 2>.', mode: 'edit', referenceIds: [second.id, reference.id], sizeId: 'portrait-4', seed: 7 };
  const { ids } = await (await state.client('/api/jobs', request)).json();
  await until(() => state.desk.jobs.get(ids[0]).status === 'completed');
  assert.deepEqual(state.fake.graphs.get(state.desk.jobs.get(ids[0]).prompt_id)['4'].inputs['images.image_1'], ['100', 0]);
  await state.restart(); await state.desk.gallery.scan(true);
  const result = (await (await state.client('/api/images')).json()).images[0];
  assert.equal(result.mode, 'edit'); assert.deepEqual(result.references.map(ref => ref.id), request.referenceIds);
  assert.equal((await (await state.client(`/media/${result.id}/settings`)).json()).references.length, 2);
  const remove = id => fetch('http://127.0.0.1:' + state.desk.server.address().port + '/api/references/' + id, { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'X-Desk-Request': '1' }, body: '{}' });
  assert.equal((await remove(reference.id)).status, 409);
  assert.equal((await state.client(`/references/${reference.id}/thumb`)).status, 200);
  const imported = await state.client('/api/references', { imageId: result.id }); assert.equal(imported.status, 201);
  const importedId = (await imported.json()).reference.id;
  assert.equal((await permanentDelete(state, result.id)).status, 200);
  assert.equal((await state.client(`/references/${importedId}/image`)).status, 200);
  assert.equal((await remove(reference.id)).status, 200);
  assert.equal((await state.client(`/references/${reference.id}/image`)).status, 404);
  assert.equal(state.desk.jobs.db.prepare('SELECT count(*) AS n FROM job_references').get().n, 0);
  const outside = path.join(path.dirname(state.desk.options.stateDir), 'outside-reference.png');
  await writeFile(outside, image);
  const stored = await state.desk.references.file(second.id); await unlink(stored); await symlink(outside, stored);
  assert.equal((await state.client(`/references/${second.id}/image`)).status, 404);
});

test('permanent deletion purges versions, sidecars, thumbnails, prompt cache, SQLite and engine history only for the selected image', async t => {
  const state = await setup(t), prompt = 'Victim prompt private unique 72bb15';
  const victimId = (await (await state.client('/api/jobs', { prompt })).json()).ids[0];
  await until(() => state.desk.jobs.get(victimId).status === 'completed');
  const keepId = (await (await state.client('/api/jobs', { prompt: 'Keep this other image' })).json()).ids[0];
  await until(() => state.desk.jobs.get(keepId).status === 'completed');
  const job = state.desk.jobs.get(victimId), keeper = state.desk.jobs.get(keepId);
  const indexed = await state.desk.gallery.scan(true);
  const item = [...indexed.values()].find(i => i.original.prompt === prompt);
  state.desk.jobs.annotate(item.id, { favorite: true, pinned: true, rating: 4, keywords: ['private keyword'] });
  await state.desk.gallery.file(item, 'thumb');
  const sidecar = item.original.path + '.json'; await writeFile(sidecar, JSON.stringify({ prompt }));
  const cache = path.join(state.desk.gallery.output, 'h3image_encode_cache');
  const removeCache = path.join(cache, 'a'.repeat(64) + '.safetensors'), keepCache = path.join(cache, 'b'.repeat(64) + '.safetensors');
  await makeCache(removeCache, prompt); await makeCache(keepCache, 'Keep this other image');
  assert.equal((await permanentDelete(state, item.id, false)).status, 400);
  assert.ok((await stat(item.original.path)).isFile());
  const response = await permanentDelete(state, item.id);
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).jobIds, [victimId]);
  for (const file of [...job.images.map(file => path.join(state.desk.gallery.output, file)), sidecar, removeCache])
    await assert.rejects(stat(file), { code: 'ENOENT' });
  assert.ok((await stat(keepCache)).isFile());
  for (const file of keeper.images) assert.ok((await stat(path.join(state.desk.gallery.output, file))).isFile());
  assert.equal(state.desk.jobs.get(victimId), null); assert.ok(state.desk.jobs.get(keepId));
  assert.equal(state.desk.jobs.annotations().has(item.id), false);
  assert.equal(state.fake.history[job.prompt_id], undefined); assert.ok(state.fake.history[keeper.prompt_id]);
  assert.equal((await readdir(state.desk.gallery.cache)).some(name => name.startsWith(item.id + '-')), false);
  assert.equal((await state.client(`/media/${item.id}/original`)).status, 404);
  assert.equal((await state.client(`/media/${item.id}/workflow`)).status, 404);
  assert.equal((await permanentDelete(state, item.id)).status, 404);
  assert.equal((await readFile(path.join(state.desk.options.stateDir, 'desk.db'))).includes(Buffer.from(prompt)), false);
});

test('deletion refuses a partially saved running job and resumes a recorded deletion after restart', async t => {
  const state = await setup(t); state.fake.paused = true;
  const id = (await (await state.client('/api/jobs', { prompt: 'Running image' })).json()).ids[0];
  await until(() => state.desk.jobs.get(id).prompt_id);
  const job = state.desk.jobs.get(id), graph = state.fake.graphs.get(job.prompt_id);
  await png(path.join(state.desk.gallery.output, graph['9'].inputs.filename_prefix + '_00001_.png'), graph);
  let item = [...(await state.desk.gallery.scan(true)).values()][0];
  assert.equal((await permanentDelete(state, item.id)).status, 409);
  assert.ok((await stat(item.original.path)).isFile());
  await state.fake.complete(job.prompt_id);
  await until(() => state.desk.jobs.get(id).status === 'completed');
  item = [...(await state.desk.gallery.scan(true)).values()][0];
  const plan = await state.desk.deletion.plan(item.id);
  assert.equal(JSON.stringify(plan).includes('Running image'), false);
  await writeFile(path.join(state.desk.deletion.journals, item.id + '.json'), JSON.stringify(plan));
  await unlink(plan.files[0].path); // Simulate a process exit after the first file was removed.
  await state.restart();
  assert.equal(state.desk.jobs.get(id), null);
  assert.equal((await state.desk.gallery.scan(true)).size, 0);
  assert.deepEqual(await readdir(state.desk.deletion.journals), []);
});


test('integrated manual image jobs use the central GPU broker instead of starting an independent engine', async t => {
  const events = [];
  let release;
  const drained = new Promise(resolve => { release = resolve; });
  const state = await setup(t, { runImage: async action => {
    events.push('waiting-for-agent-turns'); await drained;
    events.push('image'); await action(); events.push('text-restored');
  } });
  const response = await state.client('/api/jobs', { prompt: 'A lake', sizeId: 'landscape-quick' });
  const { ids } = await response.json();
  await until(() => events.length);
  assert.equal(state.fake.count, 0);
  release();
  await until(() => events.includes('text-restored'));
  assert.equal(state.desk.jobs.get(ids[0]).status, 'completed');
  assert.equal(state.fake.count, 1);
  assert.deepEqual(events, ['waiting-for-agent-turns', 'image', 'text-restored']);
});

test('studio restoration failure retains the saved image and resumes restoration without rendering twice', async t => {
  let failRestore = true;
  const state = await setup(t, { runImage: async (action, job) => {
    await action();
    if (failRestore) throw Error('text restart failed');
  } });
  const { ids } = await (await state.client('/api/jobs', { prompt: 'A studio lake', sizeId: 'landscape-quick' })).json();
  await until(() => state.desk.jobs.get(ids[0]).status === 'failed');
  assert.ok(state.desk.jobs.get(ids[0]).images.length);
  assert.equal(state.fake.count, 1);
  failRestore = false;
  await state.restart();
  await until(() => state.desk.jobs.get(ids[0]).status === 'completed');
  assert.equal(state.fake.count, 1);
});
