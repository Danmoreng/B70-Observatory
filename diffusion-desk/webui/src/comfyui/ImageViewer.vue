<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import RatingInput from '../components/RatingInput.vue'
import { annotate, duration, media, referenceMedia, requestDelete, uploading, type ImageItem } from './desk'
const props = defineProps<{ image: ImageItem | null; images: ImageItem[] }>()
const emit = defineEmits<{ close: []; view: [image: ImageItem]; reuse: [image: ImageItem]; edit: [image: ImageItem]; reference: [image: ImageItem] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const zoom = ref(false), keyword = ref(''), copied = ref(false)
let touchX = 0, touchY = 0
const index = computed(() => props.images.findIndex(i => i.id === props.image?.id))
function navigate(step: number) {
  if (!props.images.length) return
  emit('view', props.images[(index.value + step + props.images.length) % props.images.length])
}
function keyboard(event: KeyboardEvent) {
  if ((event.target as HTMLElement).matches('input, textarea, select')) return
  if (event.key === 'ArrowRight') navigate(1)
  if (event.key === 'ArrowLeft') navigate(-1)
}
function touchEnd(event: TouchEvent) {
  if (zoom.value) return
  const dx = event.changedTouches[0].clientX - touchX, dy = event.changedTouches[0].clientY - touchY
  if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) navigate(dx < 0 ? 1 : -1)
}
async function addKeyword() {
  if (!props.image || !keyword.value.trim()) return
  await annotate(props.image, { keywords: [...new Set([...props.image.keywords, keyword.value.trim()])] })
  keyword.value = ''
}
async function copyPrompt() {
  if (!props.image) return
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(props.image.prompt)
    else {
      const field = document.createElement('textarea'); field.value = props.image.prompt
      dialog.value!.appendChild(field); field.select(); const ok = document.execCommand('copy'); field.remove()
      if (!ok) return
    }
    copied.value = true
  } catch { copied.value = false }
}
watch(() => props.image?.id, async () => {
  zoom.value = false; keyword.value = ''; copied.value = false
  await nextTick()
  if (props.image && !dialog.value?.open) dialog.value?.showModal()
  if (!props.image) dialog.value?.close()
  document.body.style.overflow = props.image ? 'hidden' : ''
})
onUnmounted(() => { document.body.style.overflow = '' })
</script>

<template>
  <dialog ref="dialog" class="desk-viewer" aria-label="Image viewer" @cancel.prevent="emit('close')" @keydown="keyboard" @click="($event.target === dialog) && emit('close')">
    <template v-if="image">
      <header class="desk-viewer-header"><span>{{ index + 1 }} / {{ images.length }} · {{ image.quantization }}</span><div class="d-flex gap-2"><button class="btn btn-sm btn-secondary" :disabled="images.length < 2" aria-label="Previous image" @click="navigate(-1)"><i class="bi bi-chevron-left" aria-hidden="true"></i></button><button class="btn btn-sm btn-secondary" :disabled="images.length < 2" aria-label="Next image" @click="navigate(1)"><i class="bi bi-chevron-right" aria-hidden="true"></i></button><button class="btn btn-sm btn-secondary" :aria-pressed="zoom" @click="zoom = !zoom"><i class="bi bi-zoom-in" aria-hidden="true"></i> {{ zoom ? 'Fit' : 'Zoom' }}</button><button class="btn btn-sm btn-secondary" aria-label="Close image viewer" @click="emit('close')"><i class="bi bi-x-lg" aria-hidden="true"></i></button></div></header>
      <div class="desk-viewer-content"><div class="desk-viewer-stage" :class="{ zoomed: zoom }" @touchstart="touchX = $event.touches[0].clientX; touchY = $event.touches[0].clientY" @touchend="touchEnd"><img :src="media(image, zoom ? 'original' : 'preview')" :alt="image.prompt || image.title"></div>
        <aside class="desk-viewer-details"><h2>{{ image.title }}</h2><div class="desk-viewer-flags"><button class="btn btn-sm btn-secondary" :aria-pressed="image.favorite" @click="annotate(image, { favorite: !image.favorite })"><i class="bi" :class="image.favorite ? 'bi-heart-fill text-danger' : 'bi-heart'" aria-hidden="true"></i> Favorite</button><button class="btn btn-sm btn-secondary" :aria-pressed="image.pinned" @click="annotate(image, { pinned: !image.pinned })"><i class="bi" :class="image.pinned ? 'bi-pin-angle-fill' : 'bi-pin-angle'" aria-hidden="true"></i> Pin</button></div><RatingInput :model-value="image.rating" @update:model-value="annotate(image, { rating: $event })" />
          <div class="desk-downloads"><a :href="media(image, 'original', true)" class="btn btn-primary" download><i class="bi bi-download" aria-hidden="true"></i> Download original</a><a :href="media(image, 'preview', true)" class="btn btn-secondary" download>Download 1536 px preview</a><button class="btn btn-secondary" @click="emit('reuse', image)"><i class="bi bi-arrow-repeat" aria-hidden="true"></i> Reuse prompt & settings</button></div>
          <div class="desk-edit-actions"><button class="btn btn-secondary" :disabled="uploading" @click="emit('edit', image)"><i class="bi bi-pencil-square" aria-hidden="true"></i> Edit image</button><button class="btn btn-secondary" :disabled="uploading" @click="emit('reference', image)"><i class="bi bi-plus-square" aria-hidden="true"></i> Use as reference</button></div>
          <section v-if="image.references?.length" class="desk-saved-references"><h3>{{ image.mode === 'edit' ? 'Edit source & references' : 'Reference images' }}</h3><div class="desk-reference-strip"><a v-for="(reference, index) in image.references" :key="reference.id" :href="referenceMedia(reference, 'image')" target="_blank" rel="noopener"><img :src="referenceMedia(reference)" :alt="reference.name"><span>Picture {{ index + 1 }}</span></a></div></section>
          <dl class="desk-metadata"><div><dt>Resolution</dt><dd>{{ image.width }} × {{ image.height }}</dd></div><div><dt>File size</dt><dd>{{ (image.bytes / 1048576).toFixed(1) }} MB</dd></div><div><dt>Seed</dt><dd>{{ image.seed ?? '—' }}</dd></div><div><dt>Recipe</dt><dd>{{ image.steps ?? '—' }} steps · CFG {{ image.cfg ?? '—' }}</dd></div><div><dt>Sampler</dt><dd>{{ image.sampler || '—' }} / {{ image.scheduler || '—' }}</dd></div><div v-if="image.generationTime"><dt>Generation time</dt><dd>{{ duration(image.generationTime) }}</dd></div><div><dt>Created</dt><dd>{{ new Date(image.created * 1000).toLocaleString() }}</dd></div></dl>
          <div class="d-flex justify-content-between align-items-center"><h3>Prompt</h3><button class="btn btn-sm btn-link" @click="copyPrompt">{{ copied ? 'Copied' : 'Copy' }}</button></div><p class="desk-viewer-prompt">{{ image.prompt || 'No prompt metadata in this image.' }}</p>
          <h3>Keywords</h3><div class="desk-keywords"><button v-for="tag in image.keywords" :key="tag" class="btn btn-sm btn-secondary" :aria-label="`Remove keyword ${tag}`" @click="annotate(image, { keywords: image.keywords.filter(t => t !== tag) })">{{ tag }} ×</button></div><form class="input-group mt-2 mb-3" @submit.prevent="addKeyword"><input v-model="keyword" class="form-control" placeholder="Add a keyword…" maxlength="40" aria-label="New keyword"><button class="btn btn-secondary" :disabled="!keyword.trim() || image.keywords.length >= 20">Add</button></form>
          <div class="d-flex gap-3 flex-wrap"><a v-if="image.hasWorkflow" :href="media(image, 'workflow')" download>Workflow JSON</a><a :href="media(image, 'settings')" download>Image settings</a><a :href="media(image, 'original')" target="_blank" rel="noopener">Open original</a></div>
          <button class="btn btn-sm btn-outline-danger mt-3" @click="requestDelete(image)"><i class="bi bi-trash" aria-hidden="true"></i> Delete image</button>
        </aside>
      </div>
    </template>
  </dialog>
</template>
