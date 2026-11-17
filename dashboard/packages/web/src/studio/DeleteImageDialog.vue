<script setup lang="ts">
import { studioText as st } from './copy.js';
import { nextTick, ref, watch } from 'vue';
import { confirmDelete, deleteError, deleteTarget, deletingImage, media } from './desk';
import { useNotification } from '../composables/useNotifications.js';
useNotification(deleteError, 'studio-delete');
const dialog = ref<HTMLDialogElement | null>(null);
watch(
  () => deleteTarget.value?.id,
  async () => {
    await nextTick();
    if (deleteTarget.value && !dialog.value?.open) dialog.value?.showModal();
    else if (!deleteTarget.value) dialog.value?.close();
  }
);
function cancel() {
  if (!deletingImage.value) deleteTarget.value = null;
}
</script>

<template>
  <dialog
    ref="dialog"
    class="desk-delete-dialog"
    aria-labelledby="delete-heading"
    aria-describedby="delete-description"
    @cancel.prevent="cancel"
  >
    <template v-if="deleteTarget">
      <h2 id="delete-heading">{{ st('Delete image permanently?') }}</h2>
      <img
        :src="media(deleteTarget, 'thumb')"
        :alt="st('Selected image')"
        class="desk-delete-preview"
      />
      <p id="delete-description">
        {{
          st(
            'Original, preview, prompt, workflow, history and cached encoding will be removed. This cannot be undone.'
          )
        }}
      </p>
      <p class="desk-muted">
        {{
          st(
            'Separate reference copies remain in Choose → Uploads. Remove unused uploads there separately.'
          )
        }}
      </p>
      <div class="d-flex gap-2 justify-content-end">
        <button class="btn btn-secondary" autofocus :disabled="deletingImage" @click="cancel">
          {{ st('Cancel') }}</button
        ><button class="btn btn-danger" :disabled="deletingImage" @click="confirmDelete">
          {{ deletingImage ? st('Deleting…') : st('Delete permanently') }}
        </button>
      </div>
    </template>
  </dialog>
</template>
