import { readdir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { validateRequest } from './recipe.mjs';
import { inside } from './gallery.mjs';

export const EXPANDER = 'qwen3.5_4b_bf16.safetensors';
export const EXPANDER_LABEL = 'Qwen3.5 4B';
export const EXPANSION_MAX_REFERENCES = 4;
const SYSTEM = `You expand image-generation briefs into precise English captions. Return only one JSON object with keys "expanded_caption" (string) and "aspect_ratio" (W:H string). No markdown, explanation or reasoning. Aim for 100–180 words in the caption. Translate the user's idea faithfully. Preserve every requested subject, count, attribute, style, relationship and exclusion. Add coherent composition, lighting, materials and camera details only where the user leaves room. Do not add people, lettering or objects that contradict the brief. A request for photography must remain a photograph, with believable textures and lighting.
For reference images, the images are numbered <Picture 1>, <Picture 2>, etc. in their input order. Inspect them. Describe their roles explicitly using these exact tags. For edits, Picture 1 is the source: state what changes and preserve the identity, pose, composition, clothing, background and lighting unless the user asks to change them. Do not invent changes to unchanged elements. Choose a suitable aspect ratio while respecting an explicitly requested one.`;

export function validateExpansion(data) {
  if (!data || Object.keys(data).some(key => !['prompt', 'mode', 'referenceIds', 'sizeId'].includes(key))) throw Error('Unknown prompt expansion setting.');
  const request = validateRequest({ ...data, seed: 0, count: 1 });
  if (request.referenceIds.length > EXPANSION_MAX_REFERENCES) throw Error('Prompt expansion supports up to four reference images.');
  return request;
}
export async function expansionAvailable(options) {
  try { return (await stat(path.join(options.comfyRoot, 'models', 'text_encoders', EXPANDER))).isFile(); }
  catch { return false; }
}
export function makeExpansionGraph(job, references = []) {
  if (references.length !== job.request.referenceIds.length) throw Error('Reference pictures are missing.');
  const graph = {
    '65': { class_type: 'CLIPLoader', inputs: { clip_name: EXPANDER, type: 'minimax', device: 'default' } },
    '60': { class_type: 'TextGenerateV2', inputs: { clip: ['65', 0],
      prompt: `Mode: ${job.request.mode === 'edit' ? 'edit the first input image' : 'create a new image'}. Input images: ${references.length}. Current canvas ratio: ${job.request.sizeId.startsWith('portrait') ? '2:3' : job.request.sizeId.startsWith('square') ? '1:1' : '3:2'}.\nUser brief:\n${job.request.prompt}`,
      system_prompt: SYSTEM, thinking: false, use_default_template: true, mtp: 'off', max_length: 768,
      sampling_mode: 'on', 'sampling_mode.temperature': 0.7, 'sampling_mode.top_k': 20, 'sampling_mode.top_p': 0.95,
      'sampling_mode.min_p': 0, 'sampling_mode.repetition_penalty': 1, 'sampling_mode.presence_penalty': 0, 'sampling_mode.seed': 0 },
      _meta: { title: 'Diffusion Desk prompt expansion', desk_job_id: job.id } },
    '61': { class_type: 'PreviewAny', inputs: { source: ['60', 0] } },
  };
  references.forEach((reference, index) => {
    const scale = Math.min(1, 1024 / Math.max(reference.width, reference.height));
    graph[100 + index] = { class_type: 'LoadImage', inputs: { image: reference.filename } };
    graph[200 + index] = { class_type: 'ImageScale', inputs: { image: [String(100 + index), 0], upscale_method: 'area', width: Math.max(16, Math.round(reference.width * scale / 16) * 16), height: Math.max(16, Math.round(reference.height * scale / 16) * 16), crop: 'disabled' } };
    graph['60'].inputs[`images.image${index + 1}`] = [String(200 + index), 0];
  });
  return { graph };
}
function captionObject(raw) {
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"' && depth) quoted = true;
    else if (char === '{') { if (!depth) start = index; depth++; }
    else if (char === '}' && depth && --depth === 0) {
      try { const object = JSON.parse(raw.slice(start, index + 1)); if (typeof object.expanded_caption === 'string' && object.expanded_caption.trim()) return object; } catch { /* Try the next complete object. */ }
    }
  }
  throw Error('The prompt model returned no usable caption. Your original prompt is unchanged.');
}
export function expansionResult(history, original = '') {
  const text = id => history.outputs?.[id]?.text?.[0] || '';
  const legacy = Boolean(history.outputs?.['63']);
  const parsed = legacy ? null : captionObject(text('61'));
  const prompt = legacy ? text('61') : parsed.expanded_caption;
  const ratio = legacy ? text('62') : parsed.aspect_ratio || parsed.target_aspect_ratio || '';
  const report = legacy ? text('63') : `expanded ${original.length} -> ${prompt.length} characters; ${EXPANDER_LABEL}, native 16-bit, thinking off`;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12000) throw Error('The expander returned no usable prompt within 12,000 characters.');
  if (!/expanded \d+ -> \d+ characters/.test(report)) throw Error(report || 'Prompt expansion did not produce an expanded caption.');
  return { prompt: prompt.trim(), ratio: /^\d{1,5}:\d{1,5}$/.test(ratio) ? ratio : '', report, model: EXPANDER };
}
export async function clearExpansionCache(output, captions) {
  const folder = path.join(output, 'h3image_expand_cache');
  let entries;
  try { if (!inside(output, await realpath(folder))) throw Error('Invalid prompt cache folder'); entries = await readdir(folder, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) continue;
    const file = path.join(folder, entry.name);
    if ((await stat(file)).size > 1024 * 1024) continue;
    let caption;
    try {
      const { reply } = JSON.parse(await readFile(file, 'utf8'));
      const quoted = typeof reply === 'string' ? reply.match(/"expanded_caption"\s*:\s*("(?:\\.|[^"\\])*")/)?.[1] : null;
      if (quoted) caption = JSON.parse(quoted).trim();
    } catch { continue; }
    if (caption && captions.has(caption)) {
      try { await unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
