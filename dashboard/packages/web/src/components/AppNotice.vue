<script setup lang="ts">
defineProps<{
  kind: 'error' | 'warn' | 'notice';
  text: string;
  /** Optional stable id so surrounding widgets can reference the notice. */
  id?: string;
}>();
</script>

<template>
  <p
    :id="id"
    class="inline-error"
    :class="`notice-${kind}`"
    :role="kind === 'error' ? 'alert' : 'status'"
  >
    {{ text }}
    <slot name="action" />
  </p>
</template>
