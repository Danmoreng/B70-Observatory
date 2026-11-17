import { studioText as st, studioLabel } from './copy.js';
import {
  parseStudioResponse,
  StudioDraftSchema,
  StudioReferenceSchema,
} from '@observatory/contracts';
import { computed, reactive, ref, watch } from 'vue';

export interface Size {
  id: string;
  label: string;
  ratio: string;
  width: number;
  height: number;
}
export interface ReferenceImage {
  id: string;
  name: string;
  width: number;
  height: number;
  bytes: number;
  created: number;
  uses: number;
}
export interface ImageItem {
  id: string;
  title: string;
  category: string;
  comparisonKey: string;
  created: number;
  width: number;
  height: number;
  bytes: number;
  prompt: string;
  seed: number | null;
  steps: number | null;
  cfg: number | null;
  sampler: string;
  scheduler: string;
  noiseStart?: number | null;
  noiseEnd?: number | null;
  model: string;
  quantization: string;
  favorite: boolean;
  pinned: boolean;
  rating: number;
  keywords: string[];
  generationTime: number | null;
  jobId: string | null;
  hasWorkflow: boolean;
  hasPreview: boolean;
  mode: 'generate' | 'edit';
  references: ReferenceImage[];
}
export interface Job {
  id: string;
  created: number;
  status: string;
  elapsed: number;
  error: string | null;
  request: {
    prompt: string;
    sizeId: string;
    seed: number;
    sampler?: string;
    scheduler?: string;
    noiseStart?: number;
    noiseEnd?: number;
    mode?: 'generate' | 'edit';
    referenceIds?: string[];
  };
  progress: { phase?: string; step?: number; steps?: number };
}
export interface Expansion extends Job {
  result: { prompt?: string; ratio?: string; report?: string; model?: string };
}
interface Draft {
  sampler: string;
  scheduler: string;
  noiseStart: number;
  noiseEnd: number;
  prompt: string;
  sizeId: string;
  seed: string;
  count: number;
  mode: 'generate' | 'edit';
  referenceIds: string[];
}
const initial: Draft = {
  sampler: 'euler',
  scheduler: 'simple',
  noiseStart: 1.1,
  noiseEnd: 0.9,
  prompt: '',
  sizeId: 'landscape-8',
  seed: '-1',
  count: 1,
  mode: 'generate',
  referenceIds: [],
};

function readDraft(): Draft {
  try {
    const stored = JSON.parse(localStorage.getItem('diffusion-desk-h3-draft') || '{}');
    // Older number inputs persisted numeric seeds, which otherwise discarded
    // the entire saved prompt/settings at the schema boundary on reload.
    if (typeof stored?.seed === 'number' && Number.isSafeInteger(stored.seed))
      stored.seed = String(stored.seed);
    return StudioDraftSchema.parse(stored);
  } catch {
    return { ...initial };
  }
}

export const draft = reactive(readDraft());
export const sizes = ref<Size[]>([]);
export const samplingOptions = ref({ samplers: ['euler', 'lcm'], schedulers: ['simple'] });
export const references = ref<ReferenceImage[]>([]);
export const uploading = ref(false);
export const selectedReferences = computed(() =>
  draft.referenceIds.map((id) => references.value.find((reference) => reference.id === id))
);
export const referencesReady = computed(
  () =>
    !uploading.value &&
    draft.referenceIds.every((id) => references.value.some((reference) => reference.id === id)) &&
    (draft.mode !== 'edit' || draft.referenceIds.length > 0)
);
export const images = ref<ImageItem[]>([]);
export const jobs = ref<Job[]>([]);
export const engine = ref({ online: false, busy: false });
export const accepting = ref(true);
export const freeGiB = ref(0);
export const error = ref('');
export const pollError = ref('');
export const connected = ref(false);
export const submitting = ref(false);
export const expansionConfig = ref({ available: false, maxReferences: 4, model: 'Qwen3.5 4B' });
export const expansion = ref<Expansion | null>(null);
export const startingExpansion = ref(false);
export const discardingExpansion = ref(false);
export const expansionError = ref('');
export const expansionId = ref('');
try {
  expansionId.value = localStorage.getItem('diffusion-desk-expansion-id') || '';
} catch {
  /* Private browser. */
}
export const canExpand = computed(
  () =>
    expansionConfig.value.available &&
    referencesReady.value &&
    Boolean(draft.prompt.trim()) &&
    draft.referenceIds.length <= expansionConfig.value.maxReferences &&
    !startingExpansion.value &&
    accepting.value &&
    connected.value
);
export const deleteTarget = ref<ImageItem | null>(null);
export const deletingImage = ref(false);
export const deleteError = ref('');
export const selectedJobId = ref('');
export const selectedImageId = ref('');
export const followQueue = ref(true);
export const activeJobs = computed(() =>
  jobs.value.filter((j) => ['queued', 'running', 'cancelling', 'generated'].includes(j.status))
);
export const currentJob = computed(
  () =>
    (followQueue.value && activeJobs.value.length
      ? activeJobs.value.find((j) => j.status !== 'queued') ||
        activeJobs.value[activeJobs.value.length - 1]
      : null) ||
    jobs.value.find((j) => j.id === selectedJobId.value) ||
    jobs.value[0]
);
export const currentImage = computed(
  () =>
    (!followQueue.value && images.value.find((i) => i.id === selectedImageId.value)) ||
    images.value.find((i) => i.jobId === currentJob.value?.id) ||
    images.value[0]
);
export const selectedSize = computed(() => sizes.value.find((s) => s.id === draft.sizeId));
let timer: ReturnType<typeof setTimeout> | undefined;
let polling = false;
let stopped = false;
let pollGeneration = 0;
let pollController: AbortController | undefined;
let activePoll: (() => Promise<void>) | undefined;

class StudioConnectionError extends Error {}

watch(
  draft,
  () => {
    try {
      localStorage.setItem('diffusion-desk-h3-draft', JSON.stringify(draft));
    } catch {
      /* Storage may be full/private. */
    }
  },
  { deep: true }
);

export async function api<T>(
  path: string,
  method = 'GET',
  data?: unknown,
  signal?: AbortSignal
): Promise<T> {
  // Retry only reads: a lost mutation response must never duplicate a render.
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      let response: Response;
      try {
        response = await fetch('/api/studio' + path, {
          method,
          cache: 'no-store',
          headers:
            method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Desk-Request': '1' },
          body: data === undefined ? undefined : JSON.stringify(data),
          signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        });
      } catch (cause) {
        if (signal?.aborted) throw cause;
        if (method === 'GET' && attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 350));
          continue;
        }
        throw new StudioConnectionError(
          st('Connection to the image studio interrupted. The display will reload automatically.')
        );
      }
      let body;
      try {
        body = await response.json();
      } catch (cause) {
        if (signal?.aborted || cause instanceof SyntaxError) throw cause;
        if (method === 'GET' && attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 350));
          continue;
        }
        throw new StudioConnectionError(
          st('Connection to the image studio interrupted. The display will reload automatically.')
        );
      }
      if (!response.ok)
        throw Object.assign(
          new Error(
            typeof body.error === 'string'
              ? body.error
              : body.error?.message || st('Request failed ({status})', { status: response.status })
          ),
          {
            status: response.status,
          }
        );
      return parseStudioResponse(path, method, body) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function refreshImages(signal?: AbortSignal) {
  images.value = (
    await api<{ images: ImageItem[] }>('/api/images', 'GET', undefined, signal)
  ).images;
}

export async function refresh() {
  if (polling) return;
  polling = true;
  const generation = pollGeneration;
  const controller = new AbortController();
  pollController = controller;
  try {
    // Wait for every branch, even on failure, before starting the next poll.
    const results = await Promise.allSettled([
      api<{ jobs: Job[]; engine: typeof engine.value; acceptingJobs: boolean }>(
        '/api/jobs',
        'GET',
        undefined,
        controller.signal
      ),
      api<{
        sizes: Size[];
        sampling: typeof samplingOptions.value;
        acceptingJobs: boolean;
        freeGiB: number;
        promptExpansion: typeof expansionConfig.value;
      }>('/api/config', 'GET', undefined, controller.signal),
      refreshImages(controller.signal),
      refreshReferences(controller.signal),
      refreshExpansion(controller.signal),
    ]);
    if (controller.signal.aborted || generation !== pollGeneration) return;
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    const state = (
      results[0] as PromiseFulfilledResult<{ jobs: Job[]; engine: typeof engine.value }>
    ).value;
    const config = (
      results[1] as PromiseFulfilledResult<{
        sizes: Size[];
        sampling: typeof samplingOptions.value;
        acceptingJobs: boolean;
        freeGiB: number;
        promptExpansion: typeof expansionConfig.value;
      }>
    ).value;
    jobs.value = state.jobs;
    engine.value = state.engine;
    sizes.value = config.sizes;
    samplingOptions.value = config.sampling;
    accepting.value = config.acceptingJobs;
    freeGiB.value = config.freeGiB;
    if (config.promptExpansion) expansionConfig.value = config.promptExpansion;
    connected.value = true;
    pollError.value = '';
  } catch (e) {
    if (controller.signal.aborted || generation !== pollGeneration) return;
    connected.value = false;
    pollError.value = (e as Error).message;
  } finally {
    polling = false;
    if (pollController === controller) pollController = undefined;
  }
}

export function startPolling() {
  const generation = ++pollGeneration;
  stopped = false;
  async function poll() {
    if (stopped || generation !== pollGeneration || document.hidden) return;
    await refresh();
    if (!stopped && generation === pollGeneration && !document.hidden)
      timer = setTimeout(poll, 2000);
  }
  activePoll = poll;
  void poll();
  document.addEventListener('visibilitychange', onVisible);
}
function onVisible() {
  clearTimeout(timer);
  if (document.hidden) pollController?.abort();
  else if (!polling) void activePoll?.();
}
export function stopPolling() {
  pollGeneration++;
  stopped = true;
  clearTimeout(timer);
  pollController?.abort();
  activePoll = undefined;
  document.removeEventListener('visibilitychange', onVisible);
}

export async function generate() {
  if (submitting.value) return;
  submitting.value = true;
  error.value = '';
  try {
    if (!referencesReady.value)
      throw new Error(st('Wait for uploads to finish and select the image to edit as Picture 1.'));
    const seed = Number(draft.seed);
    if (!draft.seed.trim() || !Number.isInteger(seed))
      throw new Error(st('Enter a whole seed, or -1 for random.'));
    if (!samplingOptions.value.samplers.includes(draft.sampler))
      throw new Error(st('Choose an available sampler.'));
    if (!samplingOptions.value.schedulers.includes(draft.scheduler))
      throw new Error(st('Choose an available scheduler.'));
    if (
      draft.sampler === 'lcm' &&
      ![draft.noiseStart, draft.noiseEnd].every(
        (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 64
      )
    )
      throw new Error(st('Noise scaling must be between 0 and 64.'));
    const result = await api<{ ids: string[] }>('/api/jobs', 'POST', {
      ...draft,
      seed,
      count: Number(draft.count),
      noiseStart: draft.sampler === 'lcm' ? draft.noiseStart : undefined,
      noiseEnd: draft.sampler === 'lcm' ? draft.noiseEnd : undefined,
    });
    selectedJobId.value = result.ids[0] ?? '';
    selectedImageId.value = '';
    followQueue.value = true;
    await refresh();
  } catch (e) {
    error.value = studioLabel((e as Error).message);
  } finally {
    submitting.value = false;
  }
}

export async function cancel(job: Job) {
  try {
    await api(`/api/jobs/${job.id}/cancel`, 'POST', {});
    await refresh();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

export async function annotate(image: ImageItem, changes: Partial<ImageItem>) {
  try {
    await api(`/api/images/${image.id}`, 'PATCH', changes);
    Object.assign(image, changes);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

export function requestDelete(image: ImageItem) {
  deleteError.value = '';
  deleteTarget.value = image;
}
export async function confirmDelete() {
  const image = deleteTarget.value;
  if (!image || deletingImage.value) return;
  deletingImage.value = true;
  deleteError.value = '';
  try {
    const result = await api<{ jobIds: string[] }>(`/api/images/${image.id}`, 'DELETE', {
      confirm: true,
    });
    images.value = images.value.filter((item) => item.id !== image.id);
    jobs.value = jobs.value.filter((job) => !result.jobIds.includes(job.id));
    if (result.jobIds.includes(selectedJobId.value)) {
      selectedJobId.value = '';
      followQueue.value = true;
    }
    if (draft.prompt === image.prompt) {
      draft.prompt = '';
      draft.seed = '-1';
      try {
        localStorage.removeItem('diffusion-desk-h3-draft');
      } catch {
        /* Private browser. */
      }
    }
    window.dispatchEvent(
      new CustomEvent('desk-image-deleted', { detail: { id: image.id, prompt: image.prompt } })
    );
    deleteTarget.value = null;
    await refresh();
  } catch (e) {
    deleteError.value = (e as Error).message;
  } finally {
    deletingImage.value = false;
  }
}

export function reuse(image: ImageItem, withSeed = true) {
  restoreSampling(image);
  draft.prompt = image.prompt;
  draft.seed = withSeed && image.seed != null ? String(image.seed) : '-1';
  const size = sizes.value.find((s) => s.width === image.width && s.height === image.height);
  if (size) draft.sizeId = size.id;
  draft.count = 1;
  draft.mode = image.mode || 'generate';
  draft.referenceIds = (image.references || []).map((reference) => reference.id);
  selectedImageId.value = image.id;
  selectedJobId.value = image.jobId ?? '';
  followQueue.value = false;
}

export function restoreSampling(value: {
  sampler?: string;
  scheduler?: string;
  noiseStart?: number | null;
  noiseEnd?: number | null;
}) {
  draft.sampler = value.sampler || initial.sampler;
  draft.scheduler = value.scheduler || initial.scheduler;
  draft.noiseStart = value.noiseStart ?? (value.sampler === 'lcm' ? 1 : initial.noiseStart);
  draft.noiseEnd = value.noiseEnd ?? (value.sampler === 'lcm' ? 1 : initial.noiseEnd);
}

export function resetRecipe() {
  restoreSampling(initial);
  draft.sizeId = 'landscape-8';
  draft.seed = '-1';
  draft.count = 1;
}
function setExpansionId(id: string) {
  expansionId.value = id;
  try {
    if (id) localStorage.setItem('diffusion-desk-expansion-id', id);
    else localStorage.removeItem('diffusion-desk-expansion-id');
  } catch {
    /* Private browser. */
  }
}
export async function refreshExpansion(signal?: AbortSignal) {
  if (!expansionId.value) return;
  const id = expansionId.value;
  try {
    const { job } = await api<{ job: Expansion }>(
      `/api/expansions/${id}`,
      'GET',
      undefined,
      signal
    );
    if (id === expansionId.value) expansion.value = job;
  } catch (e) {
    if ((e as Error & { status?: number }).status === 404) {
      if (id === expansionId.value) {
        setExpansionId('');
        expansion.value = null;
      }
    } else throw e;
  }
}
export async function startExpansion() {
  if (startingExpansion.value || expansionId.value) return;
  startingExpansion.value = true;
  error.value = '';
  expansionError.value = '';
  try {
    const { id } = await api<{ id: string }>('/api/expansions', 'POST', {
      prompt: draft.prompt,
      mode: draft.mode,
      referenceIds: [...draft.referenceIds],
      sizeId: draft.sizeId,
    });
    setExpansionId(id);
    await refreshExpansion();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    startingExpansion.value = false;
  }
}
export async function discardExpansion() {
  if (!expansionId.value || discardingExpansion.value) return false;
  discardingExpansion.value = true;
  expansionError.value = '';
  try {
    await api(`/api/expansions/${expansionId.value}`, 'DELETE', {});
    setExpansionId('');
    expansion.value = null;
    await refreshReferences();
    return true;
  } catch (e) {
    if ((e as Error & { status?: number }).status === 404) {
      setExpansionId('');
      expansion.value = null;
      return true;
    }
    expansionError.value = (e as Error).message;
    return false;
  } finally {
    discardingExpansion.value = false;
  }
}
export async function refreshReferences(signal?: AbortSignal) {
  references.value = (
    await api<{ references: ReferenceImage[] }>('/api/references', 'GET', undefined, signal)
  ).references;
}
export function addReference(reference: ReferenceImage) {
  if (!references.value.some((item) => item.id === reference.id))
    references.value.unshift(reference);
  if (draft.referenceIds.includes(reference.id)) return;
  if (draft.referenceIds.length >= 16) throw new Error(st('Select up to 16 reference images.'));
  draft.referenceIds.push(reference.id);
}
export async function uploadReferences(files: File[]) {
  if (uploading.value) return;
  uploading.value = true;
  error.value = '';
  try {
    if (draft.referenceIds.length + files.length > 16)
      throw new Error(st('Select up to 16 reference images.'));
    for (const file of files) {
      if (file.size > 20 * 1024 * 1024)
        throw new Error(st('{name}: maximum upload size is 20 MiB.', { name: file.name }));
      const response = await fetch('/api/studio/api/references', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Desk-Request': '1',
          'X-File-Name': encodeURIComponent(file.name),
        },
        body: file,
        signal: AbortSignal.timeout(90000),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || st('Image upload failed.'));
      addReference(StudioReferenceSchema.parse(body.reference));
    }
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    uploading.value = false;
  }
}
export async function galleryReference(image: ImageItem, edit = false) {
  if (uploading.value) return false;
  uploading.value = true;
  error.value = '';
  try {
    if (!edit && draft.referenceIds.length >= 16)
      throw new Error(st('Select up to 16 reference images.'));
    const { reference } = await api<{ reference: ReferenceImage }>('/api/references', 'POST', {
      imageId: image.id,
    });
    if (edit) {
      draft.mode = 'edit';
      draft.referenceIds = [];
      draft.seed = '-1';
      draft.count = 1;
      const size = sizes.value.find(
        (size) => size.width === image.width && size.height === image.height
      );
      if (size) draft.sizeId = size.id;
      draft.prompt = 'Edit <Picture 1>. Keep the subject, composition and photographic realism. ';
    }
    addReference(reference);
    return true;
  } catch (e) {
    error.value = (e as Error).message;
    return false;
  } finally {
    uploading.value = false;
  }
}
export async function deleteReference(reference: ReferenceImage) {
  await api(`/api/references/${reference.id}`, 'DELETE', {});
  draft.referenceIds = draft.referenceIds.filter((id) => id !== reference.id);
  await refreshReferences();
}
export const referenceMedia = (reference: ReferenceImage, variant = 'thumb') =>
  `/api/studio/references/${reference.id}/${variant}`;
export const media = (image: ImageItem, variant = 'preview', download = false) =>
  `/api/studio/media/${image.id}/${variant}${download ? '?download=1' : ''}`;
export const duration = (seconds: number) =>
  seconds < 60
    ? `${Math.round(seconds)}s`
    : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
