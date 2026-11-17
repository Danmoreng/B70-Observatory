<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue';
import { t } from '../lib/i18n.js';

const props = defineProps<{ title: string; busy?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
let previousFocus: HTMLElement | null = null;
onMounted(async () => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  await nextTick();
  if (typeof dialog.value?.showModal === 'function') dialog.value.showModal();
  else dialog.value?.setAttribute('open', '');
});
onUnmounted(() => previousFocus?.focus());
</script>

<template>
  <dialog
    ref="dialog"
    class="app-dialog"
    :aria-label="title"
    @cancel.prevent="!props.busy && emit('close')"
  >
    <header class="app-dialog-heading">
      <h3>{{ title }}</h3>
      <button type="button" class="quiet-button" :disabled="busy" @click="emit('close')">
        {{ t('dialog.close') }}
      </button>
    </header>
    <div class="app-dialog-body"><slot /></div>
  </dialog>
</template>

<style scoped>
.app-dialog {
  box-sizing: border-box;
  width: min(44rem, calc(100vw - 2rem));
  max-width: calc(100vw - 2rem);
  max-height: calc(100dvh - 2rem);
  margin: auto;
  padding: 0;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 14px;
  color: var(--text);
  background: var(--panel);
}
.app-dialog::backdrop {
  background: rgb(0 0 0 / 65%);
}
.app-dialog-heading {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
.app-dialog-heading h3 {
  margin: 0;
}
.app-dialog-body {
  min-width: 0;
  padding: 1.25rem;
}
.app-dialog-body :deep(input),
.app-dialog-body :deep(select),
.app-dialog-body :deep(textarea) {
  box-sizing: border-box;
  min-width: 0;
  width: 100%;
  max-width: 100%;
  font-size: 16px;
}
.app-dialog-body :deep(input[type='file']) {
  overflow: hidden;
}
@media (max-width: 600px) {
  .app-dialog {
    width: calc(100vw - 1rem);
    max-width: calc(100vw - 1rem);
    max-height: calc(100dvh - 1rem);
  }
  .app-dialog-body {
    padding: 1rem;
  }
}
</style>
