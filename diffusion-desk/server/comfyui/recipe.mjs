import { readFileSync } from 'node:fs';
import { MAX_REFERENCES } from './references.mjs';

export const DIT = 'minimax_h3_image_pruned_int8_convrot.safetensors';
export const ENCODER = 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors';
export const VAE = 'minimax_h3_image_vae_fp16.safetensors';
export const SIZES = [
  { id: 'landscape-quick', label: 'Landscape · Quick', ratio: '3:2', preset: '1.5 MP', width: 1536, height: 1024 },
  { id: 'landscape-4', label: 'Landscape · 4 MP', ratio: '3:2', preset: '4 MP (fast)', width: 2496, height: 1664 },
  { id: 'landscape-8', label: 'Landscape · 8 MP', ratio: '3:2', preset: '8 MP', width: 3552, height: 2368 },
  { id: 'landscape-16', label: 'Landscape · 16 MP', ratio: '3:2', preset: '15.84 MP', width: 4992, height: 3328 },
  { id: 'portrait-quick', label: 'Portrait · Quick', ratio: '2:3', preset: '1.5 MP', width: 1024, height: 1536 },
  { id: 'portrait-4', label: 'Portrait · 4 MP', ratio: '2:3', preset: '4 MP (fast)', width: 1664, height: 2496 },
  { id: 'portrait-8', label: 'Portrait · 8 MP', ratio: '2:3', preset: '8 MP', width: 2368, height: 3552 },
  { id: 'square-4', label: 'Square · 4 MP', ratio: '1:1', preset: '4 MP (fast)', width: 2048, height: 2048 },
  { id: 'square-8', label: 'Square · 8 MP', ratio: '1:1', preset: '8 MP', width: 2912, height: 2912 },
];
export const SIZE_MAP = new Map(SIZES.map(s => [s.id, s]));
const template = JSON.parse(readFileSync(new URL('workflow.json', import.meta.url), 'utf8'));

export function localClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  return Number(parts.find(p => p.type === 'hour').value) * 60 + Number(parts.find(p => p.type === 'minute').value);
}
export const acceptingJobs = () => localClock() < 22 * 60 + 30;

export function validateRequest(data) {
  if (!data || Array.isArray(data) || typeof data !== 'object' || Object.keys(data).some(k => !['prompt', 'sizeId', 'seed', 'count', 'mode', 'referenceIds'].includes(k)))
    throw Error('Unknown generation setting. The INT8 sampling recipe is fixed.');
  if (typeof data.prompt !== 'string' || !data.prompt.trim() || data.prompt.length > 12000) throw Error('Enter a prompt between 1 and 12,000 characters.');
  const sizeId = data.sizeId === undefined ? 'landscape-8' : data.sizeId;
  const seed = data.seed === undefined ? -1 : data.seed, count = data.count === undefined ? 1 : data.count;
  if (!SIZE_MAP.has(sizeId)) throw Error('Choose one of the available image sizes.');
  if (!Number.isInteger(seed) || seed < -1 || seed > 4294967295) throw Error('Seed must be -1 (random) or an integer from 0 to 4294967295.');
  if (!Number.isInteger(count) || count < 1 || count > 8) throw Error('Choose between one and eight images.');
  const mode = data.mode ?? 'generate', referenceIds = data.referenceIds ?? [];
  if (!['generate', 'edit'].includes(mode)) throw Error('Choose Create or Edit.');
  if (!Array.isArray(referenceIds) || referenceIds.length > MAX_REFERENCES || referenceIds.some(id => typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) || new Set(referenceIds).size !== referenceIds.length)
    throw Error(`Choose up to ${MAX_REFERENCES} different reference images.`);
  if (mode === 'edit' && !referenceIds.length) throw Error('Add the image to edit as Picture 1.');
  return { prompt: data.prompt.trim(), sizeId, seed, count, mode, referenceIds };
}

export function makeGraph(job, references = []) {
  const request = job.request, size = SIZE_MAP.get(request.sizeId), prefix = `DiffusionDesk/${job.id}`;
  const preview = size.ratio === '2:3' ? [1024, 1536] : size.ratio === '3:2' ? [1536, 1024] : [1536, 1536];
  const graph = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: DIT, weight_dtype: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: VAE } },
    '4': { class_type: 'MiniMaxH3XImageEncodeLowRAM', inputs: { clip_name: ENCODER, prompt: request.prompt, use_cache: true } },
    '10': { class_type: 'MiniMaxH3XImageSize', inputs: { aspect_ratio: size.ratio, megapixels: size.preset } },
    '7': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['4', 0], negative: ['4', 1], latent_image: ['10', 0], seed: request.seed, steps: 6, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: prefix + '-native' } },
    '11': { class_type: 'ImageScale', inputs: { image: ['8', 0], upscale_method: 'lanczos', width: preview[0], height: preview[1], crop: 'disabled' } },
    '12': { class_type: 'SaveImage', inputs: { images: ['11', 0], filename_prefix: prefix + '-1536' } },
    '50': { class_type: 'PreviewAny', inputs: { source: ['4', 2] } },
  };
  const workflow = structuredClone(template);
  workflow.id = job.id;
  const values = { 1: [DIT, 'default'], 4: [ENCODER, request.prompt, true], 7: [request.seed, 'fixed', 6, 1, 'euler', 'simple', 1], 9: [prefix + '-native'], 10: [size.ratio, size.preset] };
  for (const node of workflow.nodes) {
    if (values[node.id]) node.widgets_values = values[node.id];
    if (node.id === 8) node.outputs[0].links.push(13);
  }
  workflow.nodes.push(
    { id: 11, type: 'ImageScale', pos: [1650, 600], size: [310, 130], flags: {}, order: 8, mode: 0, inputs: [{ name: 'image', type: 'IMAGE', link: 13 }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [14] }], properties: { 'Node name for S&R': 'ImageScale' }, widgets_values: ['lanczos', ...preview, 'disabled'] },
    { id: 12, type: 'SaveImage', pos: [2000, 600], size: [350, 300], flags: {}, order: 9, mode: 0, inputs: [{ name: 'images', type: 'IMAGE', link: 14 }], outputs: [], properties: { 'Node name for S&R': 'SaveImage' }, widgets_values: [prefix + '-1536'] });
  workflow.links.push([13, 8, 0, 11, 0, 'IMAGE'], [14, 11, 0, 12, 0, 'IMAGE']);
  if ((request.referenceIds || []).length !== references.length) throw Error('Reference pictures are missing.');
  if (references.length) {
    graph['4'].inputs.vae = ['3', 0];
    const encoder = workflow.nodes.find(n => n.id === 4), vae = workflow.nodes.find(n => n.id === 3);
    encoder.inputs = encoder.inputs.filter(input => !input.name.startsWith('images.'));
    encoder.inputs.find(input => input.name === 'vae').link = 15;
    vae.outputs[0].links.push(15);
    workflow.links.push([15, 3, 0, 4, 0, 'VAE']);
    references.forEach((reference, index) => {
      const id = 100 + index, link = 16 + index, input = `images.image_${index + 1}`;
      graph[id] = { class_type: 'LoadImage', inputs: { image: reference.filename } };
      graph['4'].inputs[input] = [String(id), 0];
      // Autogrow inputs precede the encoder's widgets in ComfyUI's visual workflow.
      encoder.inputs.splice(1 + index, 0, { name: input, type: 'IMAGE', shape: 7, link });
      workflow.links.push([link, id, 0, 4, 1 + index, 'IMAGE']);
      workflow.nodes.push({ id, type: 'LoadImage', title: `Picture ${index + 1}${request.mode === 'edit' && index === 0 ? ' · Image to edit' : ''}`,
        pos: [100, 520 + index * 340], size: [300, 300], flags: {}, order: 2, mode: 0,
        inputs: [{ name: 'image', type: 'COMBO', widget: { name: 'image' }, link: null }, { name: 'upload', type: 'IMAGEUPLOAD', widget: { name: 'upload' }, link: null }],
        outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [link] }, { name: 'MASK', type: 'MASK', links: null }],
        properties: { 'Node name for S&R': 'LoadImage' }, widgets_values: [reference.filename, 'image'] });
    });
  }
  workflow.extra.diffusionDesk = { version: 1, mode: request.mode || 'generate', references: references.map((reference, index) => ({ id: reference.id, picture: index + 1, filename: reference.filename })) };
  // Keep downloads self-describing instead of advertising the old W4 model from the base template.
  for (const node of workflow.nodes) {
    if (node.id === 1) { node.title = 'MiniMax H3 Image · INT8'; delete node.properties.models; }
    if (node.id === 4) { node.title = 'Encode prompt and pictures · Low RAM'; delete node.properties.models; }
  }
  workflow.last_node_id = Math.max(...workflow.nodes.map(n => n.id)); workflow.last_link_id = Math.max(...workflow.links.map(link => link[0]));
  return { graph, workflow };
}
