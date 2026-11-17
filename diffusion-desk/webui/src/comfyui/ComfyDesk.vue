<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import GenerationProgress from '../components/GenerationProgress.vue'
import DeskGallery from './DeskGallery.vue'
import ImageViewer from './ImageViewer.vue'
import DeleteImageDialog from './DeleteImageDialog.vue'
import ReferencePanel from './ReferencePanel.vue'
import PromptExpansionDialog from './PromptExpansionDialog.vue'
import { activeJobs, accepting, connected, currentImage, currentJob, draft, engine, error, freeGiB, generate,
  images, jobs, media, resetRecipe, reuse, selectedJobId, selectedSize, sizes, startPolling, stopPolling,
  submitting, cancel, duration, followQueue, galleryReference, referencesReady, uploading, canExpand, startExpansion,
  startingExpansion, expansionConfig, type ImageItem, type Job } from './desk'
import './desk.css'

const tab = ref(location.hash === '#gallery' || new URLSearchParams(location.search).has('category') ? 'gallery' : 'generate')
const viewer = ref<ImageItem | null>(null), viewerImages = ref<ImageItem[]>([])
const workspace = ref<HTMLElement | null>(null)
const promptField = ref<HTMLTextAreaElement | null>(null)
const promptExpanded = ref(false), showHistory = ref(false), starter = ref('')
const runningJob = computed(() => activeJobs.value.find(job => ['running', 'cancelling'].includes(job.status)))
const busy = computed(() => Boolean(runningJob.value))
const examples = [
  { label: 'Alpine landscape', size: 'landscape-8', prompt: 'A natural landscape photograph of a quiet alpine lake at sunrise, pale mist drifting across still water, rugged mountains reflected in the lake, detailed rocks and grasses in the foreground, soft warm light on distant peaks, realistic colors, subtle atmospheric haze, photographed on a full-frame camera with a 35mm lens, no people.' },
  { label: 'Fashion · Studio', size: 'portrait-8', prompt: 'An editorial fashion photograph of an adult woman in a sculptural black silk jacket, waist-up portrait in a charcoal photography studio, soft directional key light and a narrow rim light, natural skin texture, subtle makeup, relaxed confident expression, realistic fabric folds, photographed on a full-frame camera with an 85mm lens, refined neutral color grading.' },
  { label: 'Fashion · Neon rain', size: 'portrait-8', prompt: 'A photorealistic editorial close-up portrait of an adult man wearing a tailored dark coat on a rainy city street at night, red and blue neon reflections in the background, natural skin pores, soft droplets on the fabric, shallow depth of field, believable street lighting, photographed with an 85mm portrait lens, subtle film grain.' },
]
const promptHistory = ref([draft.prompt]), promptIndex = ref(0)
const canUndo = computed(() => promptIndex.value > 0 || draft.prompt !== promptHistory.value[promptIndex.value])
const canRedo = computed(() => promptIndex.value < promptHistory.value.length - 1 && draft.prompt === promptHistory.value[promptIndex.value])
function commitPrompt() {
  if (draft.prompt === promptHistory.value[promptIndex.value]) return
  promptHistory.value = [...promptHistory.value.slice(0, promptIndex.value + 1), draft.prompt].slice(-50)
  promptIndex.value = promptHistory.value.length - 1
}
function undoPrompt() { commitPrompt(); if (promptIndex.value > 0) draft.prompt = promptHistory.value[--promptIndex.value] }
function redoPrompt() { if (canRedo.value) draft.prompt = promptHistory.value[++promptIndex.value] }
async function enhancePrompt() { commitPrompt(); await startExpansion() }
function applyExpandedPrompt(prompt: string, request: Job['request'], sizeId: string) {
  commitPrompt(); draft.prompt = prompt; draft.mode = request.mode || 'generate'; draft.referenceIds = [...(request.referenceIds || [])]; draft.sizeId = sizeId; commitPrompt()
}
function chooseExample() {
  const example = examples.find(e => e.label === starter.value)
  if (example) { commitPrompt(); draft.prompt = example.prompt; draft.sizeId = example.size; draft.mode = 'generate'; draft.referenceIds = []; commitPrompt() }
  starter.value = ''
}
const formatSizes = computed(() => sizes.value.filter(s => s.ratio === selectedSize.value?.ratio))
const sizeIndex = computed(() => Math.max(0, formatSizes.value.findIndex(s => s.id === draft.sizeId)))
const history = computed(() => [...jobs.value].reverse())
const historyIndex = computed(() => history.value.findIndex(j => j.id === currentJob.value?.id))
const lastSeed = computed(() => jobs.value.find(j => j.status === 'completed')?.request.seed)
const widthOptions = computed(() => [...new Set(sizes.value.map(s => s.width))].sort((a, b) => a - b))
const heightOptions = computed(() => [...new Set(sizes.value.map(s => s.height))].sort((a, b) => a - b))
function chooseDimension(axis: 'width' | 'height', event: Event) {
  const value = Number((event.target as HTMLSelectElement).value)
  const candidates = sizes.value.filter(s => s[axis] === value)
  const match = candidates.find(s => s.ratio === selectedSize.value?.ratio) || candidates[0]
  if (match) draft.sizeId = match.id
}
function chooseRatio(event: Event) {
  const ratio = (event.target as HTMLSelectElement).value
  const options = sizes.value.filter(s => s.ratio === ratio)
  const match = options.find(s => s.id.split('-').slice(1).join('-') === draft.sizeId.split('-').slice(1).join('-')) || options.find(s => s.id.endsWith('-8')) || options[0]
  if (match) draft.sizeId = match.id
}
function swapDimensions() {
  const size = selectedSize.value
  if (!size) return
  const match = sizes.value.find(s => s.width === size.height && s.height === size.width)
  if (match) draft.sizeId = match.id
}
const canSwap = computed(() => sizes.value.some(s => s.width === selectedSize.value?.height && s.height === selectedSize.value?.width))
function scaleResolution(event: Event) { const size = formatSizes.value[Number((event.target as HTMLInputElement).value)]; if (size) draft.sizeId = size.id }
function changeTab(value: string) { tab.value = value; showHistory.value = false; location.hash = value }
function openViewer(image: ImageItem, collection = images.value) { viewerImages.value = collection; viewer.value = image }
function reuseImage(image: ImageItem) { commitPrompt(); reuse(image); commitPrompt(); viewer.value = null; changeTab('generate') }
async function editImage(image: ImageItem) {
  commitPrompt()
  if (await galleryReference(image, true)) { commitPrompt(); viewer.value = null; changeTab('generate'); promptField.value?.focus() }
}
async function referenceImage(image: ImageItem) {
  if (await galleryReference(image)) { viewer.value = null; changeTab('generate') }
}
function insertPicture(text: string) {
  const field = promptField.value, start = field?.selectionStart ?? draft.prompt.length, end = field?.selectionEnd ?? start
  commitPrompt(); draft.prompt = draft.prompt.slice(0, start) + text + draft.prompt.slice(end); commitPrompt()
  requestAnimationFrame(() => { field?.focus(); field?.setSelectionRange(start + text.length, start + text.length) })
}
function selectJob(id: string) {
  const job = jobs.value.find(j => j.id === id)
  if (!job) return
  commitPrompt(); draft.prompt = job.request.prompt; draft.seed = String(job.request.seed); draft.sizeId = job.request.sizeId; commitPrompt()
  draft.mode = job.request.mode || 'generate'; draft.referenceIds = [...(job.request.referenceIds || [])]
  selectedJobId.value = id; followQueue.value = false; showHistory.value = false
}
function navigateHistory(direction: number) { const job = history.value[historyIndex.value + direction]; if (job) selectJob(job.id) }
function syncHash() { tab.value = location.hash === '#gallery' ? 'gallery' : 'generate' }
function imageDeleted(event: Event) {
  const { id, prompt } = (event as CustomEvent).detail
  if (viewer.value?.id === id) viewer.value = null
  viewerImages.value = viewerImages.value.filter(image => image.id !== id)
  promptHistory.value = promptHistory.value.filter(value => value !== prompt)
  if (!promptHistory.value.length) promptHistory.value = ['']
  promptIndex.value = Math.min(promptIndex.value, promptHistory.value.length - 1)
}
async function submit() { commitPrompt(); await generate() }

const panelWidth = ref(560)
try { panelWidth.value = Number(localStorage.getItem('diffusion-desk-panel-width')) || 560 } catch { /* Private browser. */ }
watch(panelWidth, value => { try { localStorage.setItem('diffusion-desk-panel-width', String(value)) } catch { /* Private browser. */ } })
function resizePanel(event: PointerEvent) {
  const splitter = event.currentTarget as HTMLElement
  splitter.setPointerCapture(event.pointerId)
  const move = (e: PointerEvent) => {
    if (!workspace.value) return
    const bounds = workspace.value.getBoundingClientRect()
    panelWidth.value = Math.round(Math.max(330, Math.min(bounds.width - 226, e.clientX - bounds.left)))
  }
  const end = () => { splitter.removeEventListener('pointermove', move); splitter.removeEventListener('pointerup', end); splitter.removeEventListener('pointercancel', end) }
  splitter.addEventListener('pointermove', move); splitter.addEventListener('pointerup', end); splitter.addEventListener('pointercancel', end)
}
onMounted(() => { startPolling(); window.addEventListener('hashchange', syncHash); window.addEventListener('desk-image-deleted', imageDeleted) })
onUnmounted(() => { stopPolling(); window.removeEventListener('hashchange', syncHash); window.removeEventListener('desk-image-deleted', imageDeleted) })
</script>

<template>
  <div class="desk-shell desk-compact">
    <aside class="desk-sidebar" aria-label="Diffusion Desk">
      <a class="desk-brand" href="#generate" title="Diffusion Desk" aria-label="Diffusion Desk" @click="changeTab('generate')"><img src="/diffusion-desk-icon-256.png" alt="" width="28" height="28"></a>
      <nav aria-label="Main navigation">
        <button :class="{ active: tab === 'generate' }" @click="changeTab('generate')"><i class="bi bi-image" aria-hidden="true"></i><span>Generate</span></button>
        <button :class="{ active: tab === 'gallery' }" @click="changeTab('gallery')"><i class="bi bi-images" aria-hidden="true"></i><span>Gallery</span></button>
      </nav>
      <div class="desk-sidebar-bottom" :title="`${freeGiB} GiB free · ${connected ? 'Connected' : 'Reconnecting'}`"><span class="desk-dot" :class="{ online: connected }"></span><small>{{ freeGiB }} GiB</small></div>
    </aside>

    <main class="desk-main" :class="{ 'is-gallery': tab === 'gallery' }">
      <div v-if="error" class="alert alert-danger desk-alert" role="alert"><span>{{ error }}</span><button class="btn-close" aria-label="Dismiss error" @click="error = ''"></button></div>
      <div v-if="!accepting" class="alert alert-warning desk-alert">New image jobs close at 22:30 for the daily shutdown.</div>

      <template v-if="tab === 'generate'">
        <div ref="workspace" class="desk-workspace" :class="{ 'prompt-expanded': promptExpanded }" :style="{ '--panel-width': `${panelWidth}px` }">
          <section class="desk-controls island" aria-label="Image generation settings">
            <form id="generation-form" @submit.prevent="submit">
              <div class="desk-prompt-toolbar"><label for="prompt">Prompt</label><div class="desk-toolbar-actions"><button type="button" class="desk-enhance-button" :disabled="!canExpand" :title="!expansionConfig.available ? 'Prompt expansion model is unavailable' : draft.referenceIds.length > expansionConfig.maxReferences ? 'Prompt expansion supports up to four reference images' : 'Expand and translate your idea into a detailed English prompt'" @click="enhancePrompt"><i class="bi bi-stars" aria-hidden="true"></i>{{ startingExpansion ? 'Starting…' : 'Enhance' }}</button><select v-model="starter" @change="chooseExample" class="form-select" aria-label="Example prompt"><option value="">Examples</option><option v-for="example in examples" :key="example.label">{{ example.label }}</option></select><button type="button" class="desk-icon-button" :disabled="!canUndo" title="Previous prompt" aria-label="Previous prompt" @click="undoPrompt"><i class="bi bi-arrow-counterclockwise" aria-hidden="true"></i></button><button type="button" class="desk-icon-button" :disabled="!canRedo" title="Next prompt" aria-label="Next prompt" @click="redoPrompt"><i class="bi bi-arrow-clockwise" aria-hidden="true"></i></button><button type="button" class="desk-icon-button" :aria-pressed="promptExpanded" :title="promptExpanded ? 'Restore preview' : 'Expand editor'" :aria-label="promptExpanded ? 'Restore preview' : 'Expand editor'" @click="promptExpanded = !promptExpanded"><i class="bi" :class="promptExpanded ? 'bi-fullscreen-exit' : 'bi-arrows-fullscreen'" aria-hidden="true"></i></button></div></div>
              <textarea id="prompt" ref="promptField" v-model="draft.prompt" class="form-control desk-prompt" :placeholder="draft.mode === 'edit' ? 'Edit <Picture 1>. Describe what to keep and what to change…' : 'Prompt…'" maxlength="12000" required @blur="commitPrompt" @keydown.ctrl.enter.prevent="submit" @keydown.meta.enter.prevent="submit"></textarea>
              <ReferencePanel @insert="insertPicture" />

              <div class="desk-parameters">
                <div class="desk-section-title"><span>Parameters</span><button type="button" class="desk-text-button" @click="resetRecipe"><i class="bi bi-arrow-counterclockwise" aria-hidden="true"></i> Reset to defaults</button></div>
                <div class="desk-param-row first-row">
                  <label class="desk-inline-field fixed-recipe" title="H3 Image uses a distilled six-step recipe"><span>Steps</span><input value="6" readonly aria-label="Steps, fixed H3 recipe"></label>
                  <label class="desk-inline-field batch-field"><span>Batch</span><input v-model.number="draft.count" type="number" min="1" max="8" step="1" required aria-label="Batch size"></label>
                  <label class="desk-inline-field seed-field"><span>Seed</span><input v-model="draft.seed" type="number" inputmode="numeric" min="-1" max="4294967295" step="1" required aria-label="Seed"></label>
                  <button type="button" class="desk-icon-button" title="Random seed" aria-label="Random seed" @click="draft.seed = '-1'"><i class="bi bi-dice-5" aria-hidden="true"></i></button>
                  <button type="button" class="desk-icon-button" :disabled="lastSeed == null" title="Reuse last seed" aria-label="Reuse last seed" @click="draft.seed = String(lastSeed)"><i class="bi bi-recycle" aria-hidden="true"></i></button>
                </div>
                <div class="desk-param-row dimensions-row">
                  <label class="desk-inline-field"><span>Width</span><select :value="selectedSize?.width" aria-label="Image width" @change="chooseDimension('width', $event)"><option v-for="width in widthOptions" :key="width" :value="width">{{ width }}</option></select></label>
                  <button type="button" class="desk-icon-button" :disabled="!canSwap" title="Swap dimensions" aria-label="Swap dimensions" @click="swapDimensions"><i class="bi bi-arrow-left-right" aria-hidden="true"></i></button>
                  <label class="desk-inline-field"><span>Height</span><select :value="selectedSize?.height" aria-label="Image height" @change="chooseDimension('height', $event)"><option v-for="height in heightOptions" :key="height" :value="height">{{ height }}</option></select></label>
                  <label class="desk-inline-field ratio-field"><span>AR</span><select :value="selectedSize?.ratio" aria-label="Aspect ratio" @change="chooseRatio"><option>3:2</option><option>2:3</option><option>1:1</option></select></label>
                </div>
                <div class="desk-resolution"><div><label for="resolution">Overall size adjustment</label><output>{{ selectedSize?.width }} × {{ selectedSize?.height }}</output></div><input id="resolution" type="range" min="0" :max="Math.max(0, formatSizes.length - 1)" :value="sizeIndex" step="1" :aria-valuetext="`${selectedSize?.width} by ${selectedSize?.height}`" @input="scaleResolution"></div>
                <div class="desk-param-row recipe-row"><label class="desk-inline-field fixed-recipe" title="H3 Image recipe"><span>CFG</span><input value="1.0" readonly aria-label="CFG, fixed H3 recipe"></label><label class="desk-inline-field fixed-recipe" title="H3 Image recipe"><span>Sampler</span><input value="euler / simple" readonly aria-label="Sampler, fixed H3 recipe"></label></div>
              </div>
            </form>
          </section>

          <div class="desk-splitter" role="separator" aria-label="Resize prompt panel" aria-orientation="vertical" :aria-valuenow="panelWidth" aria-valuemin="330" aria-valuemax="900" tabindex="0" @pointerdown="resizePanel" @keydown.left.prevent="panelWidth = Math.max(330, panelWidth - 24)" @keydown.right.prevent="panelWidth = Math.min(900, panelWidth + 24)"></div>

          <section class="desk-result" aria-label="Generation preview">
            <div class="desk-result-toolbar"><span v-if="currentImage">{{ currentImage.width }} × {{ currentImage.height }}<template v-if="currentImage.generationTime"> · {{ duration(currentImage.generationTime) }}</template></span><div v-if="currentImage" class="desk-toolbar-actions"><button class="desk-icon-button" title="Reuse image settings" aria-label="Reuse image settings" @click="reuseImage(currentImage)"><i class="bi bi-recycle" aria-hidden="true"></i></button><a class="desk-icon-button" :href="media(currentImage, 'original', true)" download title="Download original" aria-label="Download original"><i class="bi bi-download" aria-hidden="true"></i></a><button class="desk-icon-button" title="View image" aria-label="View image" @click="openViewer(currentImage)"><i class="bi bi-arrows-fullscreen" aria-hidden="true"></i></button></div></div>
            <div class="desk-preview"><button v-if="currentImage" class="desk-preview-button" @click="openViewer(currentImage)"><img :src="media(currentImage)" :alt="currentImage.prompt || currentImage.title"></button><div v-else class="desk-empty"><i class="bi bi-image" aria-hidden="true"></i></div></div>
          </section>
        </div>

        <div v-if="showHistory" class="desk-history-drawer island"><div class="desk-section-title"><span>History · {{ jobs.length }}</span><button class="desk-icon-button" aria-label="Close history" @click="showHistory = false"><i class="bi bi-x-lg" aria-hidden="true"></i></button></div><div v-for="job in jobs.slice(0, 50)" :key="job.id" class="desk-job" :class="{ selected: job.id === currentJob?.id }"><button class="desk-job-select" @click="selectJob(job.id)"><span class="desk-job-status" :class="job.status">{{ job.status }}</span><span class="desk-job-prompt">{{ job.request.prompt }}<small>Seed {{ job.request.seed }} · {{ duration(job.elapsed) }}</small><small v-if="job.error" class="text-danger">{{ job.error }}</small></span></button><button v-if="['queued', 'running'].includes(job.status)" class="desk-icon-button" aria-label="Cancel image" @click="cancel(job)"><i class="bi bi-x-lg" aria-hidden="true"></i></button></div></div>

        <footer class="desk-action-bar island">
          <button form="generation-form" type="submit" class="btn btn-primary desk-generate" :disabled="!draft.prompt.trim() || !connected || submitting || !accepting || !referencesReady"><i class="bi bi-play-fill" aria-hidden="true"></i>{{ uploading ? 'Uploading…' : submitting ? 'Queueing…' : activeJobs.length ? `Queue (${activeJobs.length})` : draft.mode === 'edit' ? 'Generate edit' : 'Generate' }}</button>
          <button v-if="busy" class="desk-stop" :disabled="runningJob?.status === 'cancelling'" @click="cancel(runningJob!)"><i class="bi bi-stop-fill" aria-hidden="true"></i>{{ runningJob?.status === 'cancelling' ? 'Stopping…' : 'Stop' }}</button>
          <div class="desk-history-stepper"><button class="desk-icon-button" :disabled="historyIndex <= 0" title="Previous generation" aria-label="Previous generation" @click="navigateHistory(-1)"><i class="bi bi-chevron-left" aria-hidden="true"></i></button><button class="desk-history-count" title="History" @click="showHistory = !showHistory">{{ historyIndex + 1 }} / {{ history.length }}</button><button class="desk-icon-button" :disabled="historyIndex >= history.length - 1" title="Next generation" aria-label="Next generation" @click="navigateHistory(1)"><i class="bi bi-chevron-right" aria-hidden="true"></i></button></div>
          <span class="desk-action-divider"></span><span class="desk-model-status"><span class="desk-dot" :class="{ online: connected }"></span>H3 Image INT8</span>
          <div v-if="busy" class="desk-inline-progress" aria-live="polite"><GenerationProgress compact :step="runningJob?.progress.step || 0" :total-steps="runningJob?.progress.steps || 6" :phase="runningJob?.progress.phase || 'Working'" :time-elapsed="runningJob?.elapsed || 0" /></div>
          <span v-else class="desk-action-status">{{ !connected ? 'Reconnecting…' : activeJobs.length ? `${activeJobs.length} queued` : engine.online ? 'Ready' : 'Idle' }}</span>
        </footer>
      </template>

      <template v-else><header class="desk-gallery-heading"><h1>Gallery</h1><span>{{ images.length }}</span></header><DeskGallery @view="openViewer" @reuse="reuseImage($event)" @edit="editImage" /></template>
    </main>
    <ImageViewer :image="viewer" :images="viewerImages" @close="viewer = null" @view="viewer = $event" @reuse="reuseImage($event)" @edit="editImage" @reference="referenceImage" />
    <DeleteImageDialog />
    <PromptExpansionDialog @apply="applyExpandedPrompt" />
  </div>
</template>
