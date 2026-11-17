<script setup lang="ts">
import { ref } from 'vue';
import type { AgentInputImage } from '@observatory/contracts';
import { t } from '../../lib/i18n.js';
defineProps<{ images: AgentInputImage[]; disabled?: boolean; compact?: boolean }>();
const emit = defineEmits<{ remove: [index: number] }>();
const enlarged = ref<AgentInputImage>();
const viewer = ref<HTMLDialogElement>();
function open(image: AgentInputImage): void {
  enlarged.value = image;
  viewer.value?.showModal();
}
</script>
<template>
  <div class="image-attachments" :class="{ compact }">
    <ul class="image-previews">
      <li v-for="(image, index) in images" :key="index">
        <button class="image-open" type="button" :aria-label="image.label" @click="open(image)">
          <img :src="`data:${image.mimeType};base64,${image.data}`" :alt="image.label" />
        </button>
        <span>{{ image.label }}</span>
        <button
          type="button"
          class="quiet-button"
          :disabled="disabled"
          :aria-label="t('agent.images.remove', { name: image.label })"
          @click="emit('remove', index)"
        >
          {{ t('agent.images.removeButton') }}
        </button>
      </li>
    </ul>
    <dialog
      ref="viewer"
      :aria-label="enlarged?.label"
      @click="$event.target === viewer && viewer?.close()"
    >
      <button type="button" :aria-label="t('agent.images.close')" @click="viewer?.close()">
        {{ t('agent.images.close') }}
      </button>
      <img
        v-if="enlarged"
        :src="`data:${enlarged.mimeType};base64,${enlarged.data}`"
        :alt="enlarged.label"
      />
    </dialog>
  </div>
</template>
<style scoped>
dialog {
  max-width: 95vw;
  max-height: 95vh;
  padding: 1rem;
  background: var(--panel);
  color: var(--text);
}
dialog img {
  display: block;
  max-width: 85vw;
  max-height: 80vh;
  object-fit: contain;
}
.image-open {
  padding: 0;
  background: transparent;
  border: 0;
  cursor: zoom-in;
}
.image-previews {
  display: flex;
  flex-wrap: wrap;
  gap: 0.8rem;
  list-style: none;
  padding: 0;
  margin: 8px 0 0;
}
.image-previews li {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  width: 150px;
  overflow-wrap: anywhere;
}
.image-previews img {
  width: 150px;
  height: 110px;
  object-fit: contain;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.compact .image-previews li {
  width: 88px;
}
.compact .image-previews img {
  width: 88px;
  height: 64px;
}
</style>
