<script setup lang="ts">
import { locale } from '../lib/i18n.js';
import { studioText as st } from './copy.js';
import AppIcon from '../components/AppIcon.vue';
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import ImageActions from './ImageActions.vue';
import RatingInput from './shared/RatingInput.vue';
import {
  annotate,
  duration,
  media,
  referenceMedia,
  requestDelete,
  uploading,
  type ImageItem,
} from './desk';
const props = defineProps<{ image: ImageItem | null; images: ImageItem[] }>();
const emit = defineEmits<{
  close: [];
  view: [image: ImageItem];
  reuse: [image: ImageItem];
  edit: [image: ImageItem];
  reference: [image: ImageItem];
}>();
const dialog = ref<HTMLDialogElement | null>(null);
const zoom = ref(false),
  keyword = ref(''),
  copied = ref(false);
let touchX = 0,
  touchY = 0;
const index = computed(() => props.images.findIndex((i) => i.id === props.image?.id));
function navigate(step: number) {
  if (!props.images.length) return;
  const image = props.images[(index.value + step + props.images.length) % props.images.length];
  if (image) emit('view', image);
}
function keyboard(event: KeyboardEvent) {
  if ((event.target as HTMLElement).matches('input, textarea, select')) return;
  if (event.key === 'ArrowRight') navigate(1);
  if (event.key === 'ArrowLeft') navigate(-1);
}
function touchEnd(event: TouchEvent) {
  if (zoom.value) return;
  const touch = event.changedTouches[0];
  if (!touch) return;
  const dx = touch.clientX - touchX,
    dy = touch.clientY - touchY;
  if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) navigate(dx < 0 ? 1 : -1);
}
async function addKeyword() {
  if (!props.image || !keyword.value.trim()) return;
  await annotate(props.image, {
    keywords: [...new Set([...props.image.keywords, keyword.value.trim()])],
  });
  keyword.value = '';
}
async function copyPrompt() {
  if (!props.image) return;
  try {
    if (navigator.clipboard && window.isSecureContext)
      await navigator.clipboard.writeText(props.image.prompt);
    else {
      const field = document.createElement('textarea');
      field.value = props.image.prompt;
      dialog.value!.appendChild(field);
      field.select();
      const ok = document.execCommand('copy');
      field.remove();
      if (!ok) return;
    }
    copied.value = true;
  } catch {
    copied.value = false;
  }
}
watch(
  () => props.image?.id,
  async () => {
    zoom.value = false;
    keyword.value = '';
    copied.value = false;
    await nextTick();
    if (props.image && !dialog.value?.open) dialog.value?.showModal();
    if (!props.image) dialog.value?.close();
    document.body.style.overflow = props.image ? 'hidden' : '';
  }
);
onUnmounted(() => {
  document.body.style.overflow = '';
});
</script>

<template>
  <dialog
    ref="dialog"
    class="desk-viewer"
    :aria-label="st('Image viewer')"
    @cancel.prevent="emit('close')"
    @keydown="keyboard"
    @click="$event.target === dialog && emit('close')"
  >
    <template v-if="image">
      <header class="desk-viewer-header">
        <span>{{ index + 1 }} / {{ images.length }} · {{ image.quantization }}</span>
        <div class="d-flex gap-2">
          <button
            class="btn btn-sm btn-secondary"
            :disabled="images.length < 2"
            :aria-label="st('Previous image')"
            @click="navigate(-1)"
          >
            <AppIcon name="left" /></button
          ><button
            class="btn btn-sm btn-secondary"
            :disabled="images.length < 2"
            :aria-label="st('Next image')"
            @click="navigate(1)"
          >
            <AppIcon name="right" /></button
          ><button class="btn btn-sm btn-secondary" :aria-pressed="zoom" @click="zoom = !zoom">
            <AppIcon name="zoom" /> {{ zoom ? st('Fit') : st('Zoom') }}</button
          ><button
            class="btn btn-sm btn-secondary"
            :aria-label="st('Close image viewer')"
            @click="emit('close')"
          >
            <AppIcon name="close" />
          </button>
        </div>
      </header>
      <div class="desk-viewer-content">
        <div
          class="desk-viewer-stage"
          :class="{ zoomed: zoom }"
          @touchstart="
            touchX = $event.touches[0]!!.clientX;
            touchY = $event.touches[0]!!.clientY;
          "
          @touchend="touchEnd"
        >
          <img
            :src="media(image, zoom ? 'original' : 'preview')"
            :alt="image.prompt || image.title"
          />
        </div>
        <aside class="desk-viewer-details">
          <h2>{{ image.title }}</h2>
          <div class="desk-viewer-flags">
            <button
              class="btn btn-sm btn-secondary"
              :aria-pressed="image.favorite"
              @click="annotate(image, { favorite: !image.favorite })"
            >
              <AppIcon
                name="heart"
                :filled="image.favorite"
                :class="{ 'text-danger': image.favorite }"
              />
              {{ st('Favorite') }}</button
            ><button
              class="btn btn-sm btn-secondary"
              :aria-pressed="image.pinned"
              @click="annotate(image, { pinned: !image.pinned })"
            >
              <AppIcon name="pin" :filled="image.pinned" /> {{ st('Pin') }}
            </button>
          </div>
          <RatingInput
            :model-value="image.rating"
            @update:model-value="annotate(image, { rating: $event })"
          />
          <ImageActions
            :image="image"
            @reuse="emit('reuse', $event)"
            @edit="emit('edit', $event)"
          />
          <a class="desk-preview-download" :href="media(image, 'preview', true)" download>{{
            st('Download 1536 px preview')
          }}</a>
          <div class="desk-edit-actions">
            <button
              class="btn btn-secondary"
              :disabled="uploading"
              @click="emit('reference', image)"
            >
              <AppIcon name="plus" /> {{ st('Use as reference') }}
            </button>
          </div>
          <section v-if="image.references?.length" class="desk-saved-references">
            <h3>
              {{ image.mode === 'edit' ? st('Edit source & references') : st('Reference images') }}
            </h3>
            <div class="desk-reference-strip">
              <a
                v-for="(reference, index) in image.references"
                :key="reference.id"
                :href="referenceMedia(reference, 'image')"
                target="_blank"
                rel="noopener"
                ><img :src="referenceMedia(reference)" :alt="reference.name" /><span
                  >{{ st('Picture') }} {{ index + 1 }}</span
                ></a
              >
            </div>
          </section>
          <dl class="desk-metadata">
            <div>
              <dt>{{ st('Resolution') }}</dt>
              <dd>{{ image.width }} × {{ image.height }}</dd>
            </div>
            <div>
              <dt>{{ st('File size') }}</dt>
              <dd>{{ (image.bytes / 1048576).toFixed(1) }} {{ st('MB') }}</dd>
            </div>
            <div>
              <dt>{{ st('Seed') }}</dt>
              <dd>{{ image.seed ?? '—' }}</dd>
            </div>
            <div>
              <dt>{{ st('Recipe') }}</dt>
              <dd>{{ image.steps ?? '—' }} {{ st('steps · CFG') }} {{ image.cfg ?? '—' }}</dd>
            </div>
            <div>
              <dt>{{ st('Sampler') }}</dt>
              <dd>{{ image.sampler || '—' }} / {{ image.scheduler || '—' }}</dd>
            </div>
            <div
              v-if="image.sampler === 'lcm' && image.noiseStart != null && image.noiseEnd != null"
            >
              <dt>{{ st('Noise scaling') }}</dt>
              <dd>{{ image.noiseStart }} → {{ image.noiseEnd }}</dd>
            </div>
            <div v-if="image.generationTime">
              <dt>{{ st('Generation time') }}</dt>
              <dd>{{ duration(image.generationTime) }}</dd>
            </div>
            <div>
              <dt>{{ st('Created') }}</dt>
              <dd>
                {{
                  new Date(image.created * 1000).toLocaleString(locale === 'de' ? 'de-DE' : 'en-GB')
                }}
              </dd>
            </div>
          </dl>
          <div class="d-flex justify-content-between align-items-center">
            <h3>{{ st('Prompt') }}</h3>
            <button class="btn btn-sm btn-link" @click="copyPrompt">
              {{ copied ? st('Copied') : st('Copy') }}
            </button>
          </div>
          <p class="desk-viewer-prompt">
            {{ image.prompt || st('No prompt metadata in this image.') }}
          </p>
          <h3>{{ st('Keywords') }}</h3>
          <div class="desk-keywords">
            <button
              v-for="tag in image.keywords"
              :key="tag"
              class="btn btn-sm btn-secondary"
              :aria-label="st('Remove keyword {tag}', { tag })"
              @click="annotate(image, { keywords: image.keywords.filter((t) => t !== tag) })"
            >
              {{ tag }} ×
            </button>
          </div>
          <form class="input-group mt-2 mb-3" @submit.prevent="addKeyword">
            <input
              v-model="keyword"
              class="form-control"
              :placeholder="st('Add a keyword…')"
              maxlength="40"
              :aria-label="st('New keyword')"
            /><button
              class="btn btn-secondary"
              :disabled="!keyword.trim() || image.keywords.length >= 20"
            >
              {{ st('Add') }}
            </button>
          </form>
          <div class="d-flex gap-3 flex-wrap">
            <a v-if="image.hasWorkflow" :href="media(image, 'workflow')" download>{{
              st('Workflow JSON')
            }}</a
            ><a :href="media(image, 'settings')" download>{{ st('Image settings') }}</a
            ><a :href="media(image, 'original')" target="_blank" rel="noopener">{{
              st('Open original')
            }}</a>
          </div>
          <button class="btn btn-sm btn-outline-danger mt-3" @click="requestDelete(image)">
            <AppIcon name="trash" /> {{ st('Delete image') }}
          </button>
        </aside>
      </div>
    </template>
  </dialog>
</template>
