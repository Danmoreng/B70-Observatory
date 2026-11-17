<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: 'primary' | 'quiet' | 'text' | 'follow';
    type?: 'button' | 'submit';
    loading?: boolean;
    disabled?: boolean;
  }>(),
  {
    variant: 'quiet',
    type: 'button',
    loading: false,
    disabled: false,
  }
);
</script>

<template>
  <button
    :class="`${variant}-button`"
    :type="type"
    :disabled="disabled || loading"
    :aria-busy="loading"
  >
    <slot />
  </button>
</template>
