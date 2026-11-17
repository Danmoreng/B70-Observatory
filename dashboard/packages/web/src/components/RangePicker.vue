<script setup lang="ts">
import { RANGES } from '../lib/series.js';
import { t } from '../lib/i18n.js';

defineProps<{ modelValue: number }>();
const emit = defineEmits<{ (event: 'update:modelValue', index: number): void }>();
</script>

<template>
  <div class="range-picker" role="group" :aria-label="t('range.aria')">
    <button
      v-for="(item, index) in RANGES"
      :key="item.minutes"
      type="button"
      :aria-pressed="modelValue === index"
      @click="emit('update:modelValue', index)"
    >
      {{ t(item.label) }}
    </button>
  </div>
</template>
