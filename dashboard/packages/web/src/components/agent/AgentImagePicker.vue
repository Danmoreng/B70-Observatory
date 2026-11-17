<script setup lang="ts">
import { onUnmounted, ref, useId } from 'vue';
import type { AgentInputImage } from '@observatory/contracts';
import { prepareInputImage } from '../../lib/input-images.js';
import { t } from '../../lib/i18n.js';
import AppIcon from '../AppIcon.vue';
import AgentImageAttachments from './AgentImageAttachments.vue';
import { useNotification } from '../../composables/useNotifications.js';
const props = defineProps<{
  modelValue: AgentInputImage[];
  disabled?: boolean;
  compact?: boolean;
  showPreviews?: boolean;
}>();
const emit = defineEmits<{
  'update:modelValue': [images: AgentInputImage[]];
  busy: [value: boolean];
}>();
const processing = ref(false);
const error = ref('');
useNotification(() => (props.compact ? error.value : ''), `image-picker-${useId()}`);
let alive = true;
onUnmounted(() => {
  alive = false;
});
async function select(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (processing.value || props.disabled || files.length === 0) return;
  error.value = '';
  if (files.length + props.modelValue.length > 4) {
    error.value = t('agent.images.limit');
    return;
  }
  processing.value = true;
  emit('busy', true);
  try {
    const additions: AgentInputImage[] = [];
    // Decode one at a time to bound memory, especially on tablets.
    for (const file of files) additions.push(await prepareInputImage(file));
    if (alive) emit('update:modelValue', [...props.modelValue, ...additions]);
  } catch (cause) {
    if (alive) error.value = cause instanceof Error ? cause.message : t('agent.images.invalid');
  } finally {
    processing.value = false;
    if (alive) emit('busy', false);
  }
}
</script>
<template>
  <div class="image-picker" :class="{ compact }">
    <label class="image-label" :title="t('agent.images.add')">
      <AppIcon v-if="compact" name="paperclip" />
      <span :class="{ 'sr-only': compact }">
        {{ processing ? t('agent.images.processing') : t('agent.images.add') }}</span
      >
      <input
        type="file"
        :class="{ 'sr-only': compact }"
        :aria-label="t('agent.images.add')"
        accept="image/png,image/jpeg,image/webp"
        multiple
        :disabled="disabled || processing || modelValue.length >= 4"
        @change="select"
      />
    </label>
    <p v-if="!compact" class="image-hint">{{ t('agent.images.hint') }}</p>
    <p v-if="error && !compact" role="alert">{{ error }}</p>
    <AgentImageAttachments
      v-if="showPreviews !== false && modelValue.length"
      :images="modelValue"
      :disabled="disabled || processing"
      :compact="compact"
      @remove="
        emit(
          'update:modelValue',
          modelValue.filter((_, i) => i !== $event)
        )
      "
    />
  </div>
</template>
<style scoped>
.image-picker.compact {
  margin: 0;
}
.compact .image-label {
  min-width: 44px;
  min-height: 44px;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 7px;
  cursor: pointer;
}
.compact .image-label:focus-within {
  outline: 2px solid var(--ok);
}
.image-picker {
  margin: 0.7rem 0;
}
.image-label {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.7rem;
}
.image-label input::file-selector-button {
  margin-right: 0.5rem;
  padding: 0.4rem 0.65rem;
  border: 1px solid #52616b;
  border-radius: 6px;
  background: #18252f;
  color: #dce6ed;
  cursor: pointer;
}
.image-label input {
  max-width: 100%;
}
.image-hint {
  font-size: 0.85rem;
  color: var(--text-muted, #9aabb8);
}
</style>
