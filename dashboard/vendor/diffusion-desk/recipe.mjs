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
  { id: 'square-quick', label: 'Square · Quick', ratio: '1:1', preset: '1 MP (test)', width: 1024, height: 1024 },
  { id: 'square-4', label: 'Square · 4 MP', ratio: '1:1', preset: '4 MP (fast)', width: 2048, height: 2048 },
  { id: 'square-8', label: 'Square · 8 MP', ratio: '1:1', preset: '8 MP', width: 2912, height: 2912 },
];
export const SIZE_MAP = new Map(SIZES.map(s => [s.id, s]));
// Names supported by the pinned local ComfyUI installation (dc9ffe6).
export const SAMPLERS = ['euler', 'lcm', 'heun', 'euler_cfg_pp', 'euler_ancestral', 'euler_ancestral_cfg_pp', 'heunpp2', 'exp_heun_2_x0', 'exp_heun_2_x0_sde', 'dpm_2', 'dpm_2_ancestral', 'lms', 'dpm_fast', 'dpm_adaptive', 'dpmpp_2s_ancestral', 'dpmpp_2s_ancestral_cfg_pp', 'dpmpp_sde', 'dpmpp_sde_gpu', 'dpmpp_2m', 'dpmpp_2m_cfg_pp', 'dpmpp_2m_sde', 'dpmpp_2m_sde_gpu', 'dpmpp_2m_sde_heun', 'dpmpp_2m_sde_heun_gpu', 'dpmpp_3m_sde', 'dpmpp_3m_sde_gpu', 'ddpm', 'ipndm', 'ipndm_v', 'deis', 'cfgpp_ud10_ab', 'res_multistep', 'res_multistep_cfg_pp', 'res_multistep_ancestral', 'res_multistep_ancestral_cfg_pp', 'gradient_estimation', 'gradient_estimation_cfg_pp', 'er_sde', 'seeds_2', 'seeds_3', 'sa_solver', 'sa_solver_pece', 'ddim', 'uni_pc', 'uni_pc_bh2'];
export const SCHEDULERS = ['simple', 'sgm_uniform', 'karras', 'exponential', 'ddim_uniform', 'beta', 'normal', 'linear_quadratic', 'kl_optimal'];
export function samplingSettings(data) {
  const sampler = data.sampler === undefined ? 'euler' : data.sampler, scheduler = data.scheduler === undefined ? 'simple' : data.scheduler;
  const noiseStart = data.noiseStart === undefined ? 1.1 : data.noiseStart;
  const noiseEnd = data.noiseEnd === undefined ? 0.9 : data.noiseEnd;
  if (!SAMPLERS.includes(sampler)) throw Error('Choose an available sampler.');
  if (!SCHEDULERS.includes(scheduler)) throw Error('Choose an available scheduler.');
  if (![noiseStart, noiseEnd].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 64))
    throw Error('Noise scaling must be between 0 and 64.');
  return { sampler, scheduler, noiseStart, noiseEnd };
}
const template = JSON.parse(readFileSync(new URL('workflow.json', import.meta.url), 'utf8'));

export function localClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  return Number(parts.find(p => p.type === 'hour').value) * 60 + Number(parts.find(p => p.type === 'minute').value);
}
export const acceptingJobs = () => localClock() < 22 * 60 + 30;

export function validateRequest(data) {
  if (!data || Array.isArray(data) || typeof data !== 'object' || Object.keys(data).some(k => !['prompt', 'sizeId', 'seed', 'count', 'mode', 'referenceIds', 'sampler', 'scheduler', 'noiseStart', 'noiseEnd'].includes(k)))
    throw Error('Unknown generation setting.');
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
  return { prompt: data.prompt.trim(), sizeId, seed, count, mode, referenceIds, ...samplingSettings(data) };
}

export function makeGraph(job, references = []) {
  const request = job.request, size = SIZE_MAP.get(request.sizeId), prefix = `DiffusionDesk/${job.id}`;
  const sampling = samplingSettings(request);
  const preview = size.ratio === '2:3' ? [1024, 1536] : size.ratio === '3:2' ? [1536, 1024] : [1536, 1536];
  const graph = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: DIT, weight_dtype: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: VAE } },
    '4': { class_type: 'MiniMaxH3XImageEncodeLowRAM', inputs: { clip_name: ENCODER, prompt: request.prompt, use_cache: true } },
    '10': { class_type: 'MiniMaxH3XImageSize', inputs: { aspect_ratio: size.ratio, megapixels: size.preset } },
    '7': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['4', 0], negative: ['4', 1], latent_image: ['10', 0], seed: request.seed, steps: 6, cfg: 1, sampler_name: sampling.sampler, scheduler: sampling.scheduler, denoise: 1 } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: prefix + '-native' } },
    '11': { class_type: 'ImageScale', inputs: { image: ['8', 0], upscale_method: 'lanczos', width: preview[0], height: preview[1], crop: 'disabled' } },
    '12': { class_type: 'SaveImage', inputs: { images: ['11', 0], filename_prefix: prefix + '-1536' } },
    '50': { class_type: 'PreviewAny', inputs: { source: ['4', 2] } },
  };
  const workflow = structuredClone(template);
  workflow.id = job.id;
  const values = { 1: [DIT, 'default'], 4: [ENCODER, request.prompt, true], 7: [request.seed, 'fixed', 6, 1, sampling.sampler, sampling.scheduler, 1], 9: [prefix + '-native'], 10: [size.ratio, size.preset] };
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
  if (sampling.sampler === 'lcm') {
    graph['7'] = { class_type: 'SamplerCustom', inputs: { model: ['1', 0], positive: ['4', 0], negative: ['4', 1], latent_image: ['10', 0], add_noise: true, noise_seed: request.seed, cfg: 1, sampler: ['20', 0], sigmas: ['21', 0] } };
    graph['20'] = { class_type: 'SamplerLCM', inputs: { s_noise: sampling.noiseStart, s_noise_end: sampling.noiseEnd, noise_clip_std: 0 } };
    graph['21'] = { class_type: 'BasicScheduler', inputs: { model: ['1', 0], scheduler: sampling.scheduler, steps: 6, denoise: 1 } };
    const node = workflow.nodes.find(n => n.id === 7);
    node.type = 'SamplerCustom'; node.title = 'LCM · 6 steps, CFG 1'; node.properties = { 'Node name for S&R': 'SamplerCustom' };
    node.widgets_values = [true, request.seed, 'fixed', 1];
    node.inputs = [
      { name: 'model', type: 'MODEL', link: null }, { name: 'positive', type: 'CONDITIONING', link: null },
      { name: 'negative', type: 'CONDITIONING', link: null }, { name: 'sampler', type: 'SAMPLER', link: 40 },
      { name: 'sigmas', type: 'SIGMAS', link: 41 }, { name: 'latent_image', type: 'LATENT', link: null },
    ];
    for (const link of workflow.links.filter(link => link[3] === 7)) {
      const input = { MODEL: 0, CONDITIONING: link[2] === 0 ? 1 : 2, LATENT: 5 }[link[5]];
      if (input === undefined) throw Error('Unexpected sampler input.');
      link[4] = input; node.inputs[input].link = link[0];
    }
    node.outputs = [{ name: 'output', type: 'LATENT', links: node.outputs[0].links }, { name: 'denoised_output', type: 'LATENT', links: null }];
    workflow.nodes.find(n => n.id === 1).outputs[0].links.push(42);
    workflow.nodes.push(
      { id: 20, type: 'SamplerLCM', pos: [800, 650], size: [300, 110], flags: {}, order: 4, mode: 0, inputs: [], outputs: [{ name: 'SAMPLER', type: 'SAMPLER', links: [40] }], properties: { 'Node name for S&R': 'SamplerLCM' }, widgets_values: [sampling.noiseStart, sampling.noiseEnd, 0] },
      { id: 21, type: 'BasicScheduler', pos: [800, 820], size: [300, 110], flags: {}, order: 4, mode: 0, inputs: [{ name: 'model', type: 'MODEL', link: 42 }], outputs: [{ name: 'SIGMAS', type: 'SIGMAS', links: [41] }], properties: { 'Node name for S&R': 'BasicScheduler' }, widgets_values: [sampling.scheduler, 6, 1] });
    workflow.links.push([40, 20, 0, 7, 3, 'SAMPLER'], [41, 21, 0, 7, 4, 'SIGMAS'], [42, 1, 0, 21, 0, 'MODEL']);
  }
  workflow.extra.diffusionDesk = { version: 2, mode: request.mode || 'generate', sampling, references: references.map((reference, index) => ({ id: reference.id, picture: index + 1, filename: reference.filename })) };
  // Keep downloads self-describing instead of advertising the old W4 model from the base template.
  for (const node of workflow.nodes) {
    if (node.id === 1) { node.title = 'MiniMax H3 Image · INT8'; delete node.properties.models; }
    if (node.id === 4) { node.title = 'Encode prompt and pictures · Low RAM'; delete node.properties.models; }
  }
  workflow.last_node_id = Math.max(...workflow.nodes.map(n => n.id)); workflow.last_link_id = Math.max(...workflow.links.map(link => link[0]));
  return { graph, workflow };
}
