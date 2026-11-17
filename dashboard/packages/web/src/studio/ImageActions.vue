<script setup lang="ts">
import AppIcon from '../components/AppIcon.vue';
import { media, uploading, type ImageItem } from './desk.js';
import { studioText as st } from './copy.js';
defineProps<{ image: ImageItem; compact?: boolean; iconsOnly?: boolean }>();
const emit = defineEmits<{ reuse: [image: ImageItem]; edit: [image: ImageItem] }>();
</script>
<template>
  <div class="desk-image-actions" :class="{ compact, 'icons-only': iconsOnly }">
    <button
      type="button"
      class="btn btn-sm btn-secondary"
      data-image-action="reuse"
      :title="st('Reuse prompt & settings')"
      :aria-label="st('Reuse prompt & settings')"
      @click="emit('reuse', image)"
    >
      <AppIcon name="reuse" /><span v-if="!iconsOnly">{{ st('Reuse') }}</span>
    </button>
    <button
      type="button"
      class="btn btn-sm btn-secondary"
      data-image-action="edit"
      :disabled="uploading"
      :title="st('Edit image')"
      :aria-label="st('Edit image')"
      @click="emit('edit', image)"
    >
      <AppIcon name="edit" /><span v-if="!iconsOnly && !compact">{{ st('Edit') }}</span>
    </button>
    <a
      class="btn btn-sm btn-secondary"
      data-image-action="download"
      :href="media(image, 'original', true)"
      download
      :title="st('Download original')"
      :aria-label="st('Download original')"
      ><AppIcon name="download" /><span v-if="!iconsOnly && !compact">{{ st('Download') }}</span></a
    >
  </div>
</template>
<style scoped>
.desk-image-actions {
  display: flex;
  gap: 5px;
  align-items: center;
  flex-wrap: wrap;
}
.desk-image-actions .btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 36px;
  font-size: 12px;
  padding: 6px 8px;
}
.icons-only .btn {
  width: 34px;
  min-height: 34px;
  padding: 5px;
}
.compact {
  flex-wrap: nowrap;
}
</style>
