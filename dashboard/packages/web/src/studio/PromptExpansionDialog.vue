<script setup lang="ts">
import { studioText as st, studioLabel } from './copy.js';
import { computed, nextTick, ref, watch } from 'vue';
import { useNotification } from '../composables/useNotifications.js';
import {
  discardingExpansion,
  discardExpansion,
  duration,
  expansion,
  expansionConfig,
  expansionError,
  expansionId,
  sizes,
  type Job,
} from './desk';

const emit = defineEmits<{ apply: [prompt: string, request: Job['request'], sizeId: string] }>();
useNotification(() => expansion.value?.error || expansionError.value, 'studio-expansion');
const dialog = ref<HTMLDialogElement | null>(null),
  candidate = ref(''),
  useRatio = ref(false);
const ready = computed(() => expansion.value?.status === 'completed');
const pending = computed(
  () => !expansion.value || ['queued', 'running', 'cancelling'].includes(expansion.value.status)
);
const suggestedSize = computed(() => {
  const job = expansion.value;
  if (!job?.result.ratio) return undefined;
  const options = sizes.value.filter((size) => size.ratio === job.result.ratio);
  return (
    options.find(
      (size) =>
        size.id.split('-').slice(1).join('-') === job.request.sizeId.split('-').slice(1).join('-')
    ) ||
    options.find((size) => size.id.endsWith('-8')) ||
    options[0]
  );
});
watch(
  expansionId,
  async (id) => {
    await nextTick();
    if (id && !dialog.value?.open) dialog.value?.showModal();
    else if (!id) dialog.value?.close();
  },
  { immediate: true }
);
watch(
  () => `${expansion.value?.id}/${expansion.value?.status}`,
  () => {
    if (ready.value) {
      candidate.value = expansion.value?.result.prompt || '';
      useRatio.value = false;
    }
  }
);
async function apply() {
  if (!ready.value || !candidate.value.trim() || candidate.value.length > 12000 || !expansion.value)
    return;
  const text = candidate.value.trim(),
    request = expansion.value.request;
  const sizeId = useRatio.value && suggestedSize.value ? suggestedSize.value.id : request.sizeId;
  emit('apply', text, request, sizeId);
  await discardExpansion();
}
</script>

<template>
  <dialog
    ref="dialog"
    class="desk-expansion-dialog"
    aria-labelledby="expansion-heading"
    @cancel.prevent="discardExpansion()"
  >
    <header>
      <h2 id="expansion-heading">{{ st('Enhance prompt') }}</h2>
      <span class="desk-muted">{{ st('Local ·') }} {{ expansionConfig.model }}</span>
    </header>
    <div v-if="pending" class="desk-expansion-progress" role="status" aria-live="polite">
      <span class="spinner-border spinner-border-sm" aria-hidden="true"></span
      ><span>{{
        expansion?.status === 'queued'
          ? st('Waiting for the image engine…')
          : studioLabel(expansion?.progress.phase || 'Preparing prompt expansion…')
      }}</span
      ><small v-if="expansion?.elapsed">{{ duration(expansion.elapsed) }}</small>
    </div>
    <template v-if="ready">
      <label for="expanded-prompt">{{ st('Expanded prompt') }}</label>
      <textarea
        id="expanded-prompt"
        v-model="candidate"
        class="form-control"
        maxlength="12000"
        spellcheck="false"
      ></textarea>
      <div v-if="expansion?.result.ratio" class="desk-expansion-ratio">
        <span>{{ st('Suggested ratio:') }} {{ expansion.result.ratio }}</span
        ><label v-if="suggestedSize"
          ><input v-model="useRatio" type="checkbox" /> {{ st('Use suggestion') }}</label
        ><small v-else>{{ st('Current format will be kept.') }}</small>
      </div>
      <details>
        <summary>{{ st('Original prompt') }}</summary>
        <p>{{ expansion?.request.prompt }}</p>
      </details>
      <details>
        <summary>{{ st('Details ·') }} {{ duration(expansion?.elapsed || 0) }}</summary>
        <p>{{ expansion?.result.report }}</p>
      </details>
    </template>
    <footer>
      <button
        type="button"
        class="btn btn-secondary"
        :disabled="discardingExpansion"
        autofocus
        @click="discardExpansion()"
      >
        {{ discardingExpansion ? st('Closing…') : pending ? st('Cancel') : st('Discard') }}</button
      ><button
        v-if="ready"
        type="button"
        class="btn btn-primary"
        :disabled="discardingExpansion || !candidate.trim()"
        @click="apply"
      >
        {{ st('Use prompt') }}
      </button>
    </footer>
  </dialog>
</template>
