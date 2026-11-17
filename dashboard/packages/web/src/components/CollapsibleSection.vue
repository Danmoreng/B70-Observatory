<script setup lang="ts">
defineProps<{ open: boolean; title: string; note?: string }>();
const emit = defineEmits<{ (event: 'update:open', open: boolean): void }>();
</script>

<template>
  <details :open="open" @toggle="emit('update:open', ($event.target as HTMLDetailsElement).open)">
    <summary>
      <span>{{ title }}</span>
      <span v-if="note" class="summary-note">{{ note }}</span>
    </summary>
    <div class="detail-content">
      <slot />
    </div>
  </details>
</template>
