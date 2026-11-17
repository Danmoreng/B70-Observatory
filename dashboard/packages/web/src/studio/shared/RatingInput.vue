<script setup lang="ts">
import { studioText as st } from '../copy.js';
import AppIcon from '../../components/AppIcon.vue';
import { ref } from 'vue';

const props = defineProps<{
  modelValue: number;
  readonly?: boolean;
  size?: string; // 'sm', 'md', 'lg'
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: number): void;
}>();

const hoverValue = ref(0);

function setRating(value: number) {
  if (props.readonly) return;
  emit('update:modelValue', value === props.modelValue ? 0 : value); // Toggle off if clicking same
}

function onHover(value: number) {
  if (props.readonly) return;
  hoverValue.value = value;
}

function onLeave() {
  if (props.readonly) return;
  hoverValue.value = 0;
}
</script>

<template>
  <div class="rating-input d-inline-flex align-items-center" @mouseleave="onLeave">
    <button
      type="button"
      v-for="star in 5"
      :key="star"
      class="star"
      :aria-label="st('Rate {count} stars', { count: star })"
      :aria-pressed="modelValue >= star"
      :disabled="readonly"
      :class="[
        { active: (hoverValue || modelValue) >= star },
        { hover: hoverValue >= star },
        { readonly: readonly },
        size ? `size-${size}` : '',
      ]"
      @click="setRating(star)"
      @mouseenter="onHover(star)"
    >
      <AppIcon name="star" :filled="(hoverValue || modelValue) >= star" />
    </button>
  </div>
</template>

<style scoped>
.rating-input {
  line-height: 1;
  user-select: none;
}

.star {
  border: 0;
  background: transparent;
  color: #444; /* Inactive color */
  cursor: pointer;
  transition: color 0.1s;
  font-size: 1.2rem;
  padding: 0 1px;
}

.star.size-sm {
  font-size: 0.9rem;
}
.star.size-lg {
  font-size: 1.5rem;
}

.star.active {
  color: #ffc107; /* Bootstrap warning color */
}

.star.readonly {
  cursor: default;
}

/* Hover effect only if not readonly */
.star:not(.readonly):hover,
.star:not(.readonly).hover {
  color: #ffdb58;
}
</style>
