<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { addReference, deleteReference, draft, error, galleryReference, images, media, references, referenceMedia,
  refreshReferences, selectedReferences, uploading, uploadReferences, type ReferenceImage } from './desk'

const emit = defineEmits<{ insert: [text: string] }>()
const input = ref<HTMLInputElement | null>(null), picker = ref<HTMLDialogElement | null>(null)
const libraryTab = ref('uploads'), search = ref(''), deleteId = ref(''), pickerError = ref('')
const filteredImages = computed(() => images.value.filter(image => `${image.title} ${image.prompt}`.toLowerCase().includes(search.value.toLowerCase())))
async function chooseFiles(event: Event) {
  const field = event.target as HTMLInputElement
  await uploadReferences(Array.from(field.files || [])); field.value = ''
}
function remove(index: number) { draft.referenceIds.splice(index, 1) }
function move(index: number, direction: number) {
  const next = index + direction
  if (next < 0 || next >= draft.referenceIds.length) return
  const ids = [...draft.referenceIds]; [ids[index], ids[next]] = [ids[next], ids[index]]; draft.referenceIds = ids
}
async function openLibrary() {
  pickerError.value = ''; deleteId.value = ''
  await nextTick(); picker.value?.showModal()
  try { await refreshReferences() } catch (e) { pickerError.value = (e as Error).message }
}
function select(reference: ReferenceImage) {
  try { addReference(reference); picker.value?.close() } catch (e) { pickerError.value = (e as Error).message }
}
async function removeUpload(reference: ReferenceImage) {
  if (deleteId.value !== reference.id) { deleteId.value = reference.id; return }
  try { await deleteReference(reference); deleteId.value = '' } catch (e) { pickerError.value = (e as Error).message }
}
</script>

<template>
  <section class="desk-references" aria-label="Reference images">
    <div class="desk-reference-toolbar">
      <div class="desk-mode-switch" role="group" aria-label="Generation mode">
        <button type="button" :class="{ active: draft.mode === 'generate' }" :aria-pressed="draft.mode === 'generate'" @click="draft.mode = 'generate'">Create</button>
        <button type="button" :class="{ active: draft.mode === 'edit' }" :aria-pressed="draft.mode === 'edit'" @click="draft.mode = 'edit'">Edit</button>
      </div>
      <span class="desk-reference-count">{{ draft.referenceIds.length }} / 16</span>
      <button type="button" class="desk-text-button" :disabled="uploading || draft.referenceIds.length >= 16" @click="input?.click()"><i class="bi bi-upload" aria-hidden="true"></i>{{ uploading ? 'Uploading…' : 'Upload' }}</button>
      <button type="button" class="desk-text-button" :disabled="uploading" @click="openLibrary"><i class="bi bi-images" aria-hidden="true"></i> Choose</button>
      <input ref="input" type="file" accept="image/png,image/jpeg,image/webp,image/heic,image/heif,image/avif" multiple hidden aria-label="Upload reference images" @change="chooseFiles">
    </div>
    <div v-if="draft.referenceIds.length" class="desk-reference-strip">
      <div v-for="(reference, index) in selectedReferences" :key="draft.referenceIds[index]" class="desk-reference-card">
        <button type="button" class="desk-reference-picture" :title="reference ? `${reference.name} · ${reference.width} × ${reference.height}` : 'Missing reference — remove or upload again'" @click="emit('insert', `<Picture ${index + 1}>`)">
          <img v-if="reference" :src="referenceMedia(reference)" alt=""><span v-else class="desk-reference-missing">Unavailable</span>
          <span>Picture {{ index + 1 }}{{ draft.mode === 'edit' && index === 0 ? ' · Source' : '' }}</span>
        </button>
        <div class="desk-reference-actions"><button type="button" :disabled="index === 0" :aria-label="`Move Picture ${index + 1} earlier`" title="Move earlier" @click="move(index, -1)"><i class="bi bi-chevron-left" aria-hidden="true"></i></button><button type="button" :disabled="index === draft.referenceIds.length - 1" :aria-label="`Move Picture ${index + 1} later`" title="Move later" @click="move(index, 1)"><i class="bi bi-chevron-right" aria-hidden="true"></i></button><button type="button" :aria-label="`Remove Picture ${index + 1} from this prompt`" title="Remove from this prompt" @click="remove(index)"><i class="bi bi-x-lg" aria-hidden="true"></i></button></div>
      </div>
    </div>
    <p v-if="draft.mode === 'edit' && !draft.referenceIds.length" class="desk-reference-hint">Upload or choose the image to edit as Picture 1.</p>
    <p v-else-if="draft.referenceIds.length" class="desk-reference-hint">Use &lt;Picture 1&gt; in the prompt.{{ draft.mode === 'edit' ? ' Describe what to keep and what to change.' : ' Describe how to use each reference.' }}</p>
    <dialog ref="picker" class="desk-reference-picker" aria-label="Choose a reference image" @click="($event.target === picker) && picker?.close()">
      <header><div class="desk-mode-switch" role="group" aria-label="Image library"><button type="button" :class="{ active: libraryTab === 'uploads' }" @click="libraryTab = 'uploads'">Uploads</button><button type="button" :class="{ active: libraryTab === 'gallery' }" @click="libraryTab = 'gallery'">Gallery</button></div><button type="button" class="desk-icon-button" aria-label="Close reference picker" @click="picker?.close()"><i class="bi bi-x-lg" aria-hidden="true"></i></button></header>
      <p v-if="pickerError" class="alert alert-danger" role="alert">{{ pickerError }}</p>
      <template v-if="libraryTab === 'uploads'">
        <p class="desk-reference-hint">Selected pictures stay in this library. Used references are kept with saved jobs.</p>
        <div class="desk-reference-library"><article v-for="reference in references" :key="reference.id"><button type="button" class="desk-reference-select" :disabled="draft.referenceIds.includes(reference.id)" @click="select(reference)"><img :src="referenceMedia(reference)" :alt="reference.name" loading="lazy"><span>{{ draft.referenceIds.includes(reference.id) ? 'Selected' : reference.name }}</span></button><small>{{ reference.width }} × {{ reference.height }} · {{ reference.uses }} jobs</small><button v-if="!reference.uses" type="button" class="desk-text-button text-danger" @click="removeUpload(reference)">{{ deleteId === reference.id ? 'Delete permanently?' : 'Delete upload' }}</button><button v-if="deleteId === reference.id" type="button" class="desk-text-button" @click="deleteId = ''">Cancel</button></article></div>
        <p v-if="!references.length" class="desk-reference-hint">No uploads yet.</p>
      </template>
      <template v-else>
        <input v-model="search" class="form-control" placeholder="Search gallery…" aria-label="Search gallery for a reference" @keydown.enter.prevent>
        <div class="desk-reference-library"><article v-for="image in filteredImages" :key="image.id"><button type="button" class="desk-reference-select" :disabled="uploading" @click="galleryReference(image).then(ok => { if (ok) picker?.close(); else pickerError = error })"><img :src="media(image, 'thumb')" :alt="image.title" loading="lazy"><span>{{ image.title }}</span></button></article></div>
      </template>
    </dialog>
  </section>
</template>
