<script setup lang="ts">
import type { AgentInputImage } from '@observatory/contracts';
import AgentDictation from './AgentDictation.vue';
import AgentImagePicker from './AgentImagePicker.vue';
import AgentImageAttachments from './AgentImageAttachments.vue';
import AppIcon from '../AppIcon.vue';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  removeAgentDraft,
  readAgentDraft,
  writeAgentDraft,
  type AgentInputMode,
} from '../../lib/drafts.js';
import { t } from '../../lib/i18n.js';

/**
 * The single text input of one task. It picks the existing API for sending:
 * steer while the run is active (optionally queueFollowup via the compact
 * "work afterwards" toggle), answerQuestion for an open question and
 * continueTask for a finished task. The text is cleared only after the
 * backend confirmed the action; on failure it stays in the field.
 */
const props = defineProps<{
  taskId: string;
  /** Base action chosen by the cockpit from the selected task. */
  baseMode: 'steer' | 'answer' | 'continue';
  /** True while the task's latest run is queued/starting/running. */
  isActive: boolean;
  /** The compact "work afterwards" toggle is only useful with an active run. */
  canToggleFollowup: boolean;
  /** Text of the open question, shown directly above the input in answer mode. */
  question?: string;
  queuedFollowup?: string;
  steering: boolean;
  continuing: boolean;
  cancelling: boolean;
  canPause?: boolean;
  /** Resolves true only when the backend confirmed the action. */
  onSubmit: (text: string, mode: AgentInputMode, images?: AgentInputImage[]) => Promise<boolean>;
}>();
const emit = defineEmits<{ cancel: []; pause: [] }>();

const useFollowup = ref(false);
const preparingImages = ref(false);
const dictating = ref(false);
const sendingImages = ref(false);
const imageDrafts = ref<Record<string, AgentInputImage[]>>({});
watch(
  () => props.taskId,
  () => {
    useFollowup.value = false;
  }
);
watch(
  () => props.baseMode,
  (mode) => {
    if (mode !== 'steer') useFollowup.value = false;
  }
);
watch(
  () => props.canToggleFollowup,
  (can) => {
    // Once no further follow-up can be queued, the compact toggle disappears;
    // the input must leave the follow-up mode and regain steering of the
    // active run. The taskId/mode watcher restores the steer draft again.
    if (!can) useFollowup.value = false;
  }
);

const mode = computed<AgentInputMode>(() =>
  props.baseMode === 'steer' && useFollowup.value ? 'followup' : props.baseMode
);
const imageDraftKey = computed(() => `${props.taskId}:${mode.value}`);
const images = computed({
  get: () => imageDrafts.value[imageDraftKey.value] ?? [],
  set: (value: AgentInputImage[]) => {
    imageDrafts.value[imageDraftKey.value] = value;
  },
});
watch(imageDraftKey, () => {
  preparingImages.value = false;
});
const busy = computed(() => (mode.value === 'steer' ? props.steering : props.continuing));

const maxLength = computed(() => (['steer', 'answer'].includes(mode.value) ? 16_384 : 65_536));
const placeholder = computed(() =>
  mode.value === 'steer'
    ? t('agent.steerPlaceholder')
    : mode.value === 'followup'
      ? t('agent.followupPlaceholder')
      : t('agent.continuePlaceholder')
);
const hint = computed(() => {
  switch (mode.value) {
    case 'steer':
      return t('agent.mode.steer');
    case 'followup':
      return t('agent.mode.followup');
    case 'answer':
      return t('agent.mode.answer');
    default:
      return t('agent.mode.continue');
  }
});
const buttonLabel = computed(() => {
  if (mode.value === 'steer')
    return props.steering ? t('agent.steerQueuing') : t('agent.steerSubmit');
  if (mode.value === 'followup')
    return props.continuing ? t('agent.saving') : t('agent.queueForLater');
  if (mode.value === 'answer')
    return props.continuing ? t('agent.continuationStarting') : t('agent.answerAndContinue');
  return props.continuing ? t('agent.starting') : t('agent.continue');
});

// Local draft: restored per task and mode on mount and on task/mode change,
// saved while typing, and removed only after a confirmed send.
const value = ref('');
const editor = ref<HTMLTextAreaElement>();
function resizeEditor(): void {
  if (!editor.value) return;
  editor.value.style.height = 'auto';
  editor.value.style.height = `${Math.min(132, Math.max(44, editor.value.scrollHeight))}px`;
}
watch(value, resizeEditor, { flush: 'post' });
watch(
  [() => props.taskId, mode],
  () => {
    value.value = readAgentDraft(props.taskId, mode.value) ?? '';
  },
  { immediate: true }
);
watch(value, (next) => writeAgentDraft(props.taskId, mode.value, next));

// While the backend is deciding, the user may switch tasks, switch the mode
// or keep typing. A late confirmation must therefore only clear the text and
// remove the draft when the exact sent version is still visible in this
// input; anything else (other tasks, other modes, edited drafts) is left
// untouched. A second submit is ignored until the first one settles.
let sending = false;
async function submit(): Promise<void> {
  const text = value.value;
  if (text.trim() === '' || busy.value || sending || preparingImages.value || dictating.value)
    return;
  const activeMode = mode.value;
  const activeTask = props.taskId;
  const sentImages = images.value;
  const sentImageKey = imageDraftKey.value;
  sending = true;
  sendingImages.value = true;
  try {
    let confirmed = false;
    try {
      confirmed = await props.onSubmit(
        text,
        activeMode,
        ...(activeMode === 'continue' && sentImages.length > 0 ? [sentImages] : [])
      );
    } catch {
      // A rejected send keeps the text and the draft and must not surface
      // as an unhandled rejection.
    }
    if (!confirmed) return;
    if (imageDrafts.value[sentImageKey] === sentImages) delete imageDrafts.value[sentImageKey];
    if (props.taskId === activeTask && mode.value === activeMode && value.value === text) {
      value.value = '';
    }
    if (readAgentDraft(activeTask, activeMode) === text) {
      removeAgentDraft(activeTask, activeMode);
    }
  } finally {
    sending = false;
    sendingImages.value = false;
  }
}

// On touch devices the input is sticky at the bottom of the page. When the
// virtual keyboard opens (visual viewport shrinks), fall back to normal
// in-flow positioning so the focused field is never hidden behind the
// keyboard; the listener is removed on unmount.
const keyboardOpen = ref(false);
let visualViewport: VisualViewport | null = null;
function updateKeyboardState(): void {
  const viewport = globalThis.visualViewport;
  keyboardOpen.value =
    viewport !== null && viewport !== undefined && viewport.height < window.innerHeight - 64;
}
onMounted(() => {
  resizeEditor();
  window.addEventListener('resize', resizeEditor);
  visualViewport = globalThis.visualViewport ?? null;
  if (visualViewport === null) return;
  updateKeyboardState();
  visualViewport.addEventListener('resize', updateKeyboardState);
  visualViewport.addEventListener('scroll', updateKeyboardState);
});
onUnmounted(() => {
  window.removeEventListener('resize', resizeEditor);
  visualViewport?.removeEventListener('resize', updateKeyboardState);
  visualViewport?.removeEventListener('scroll', updateKeyboardState);
});
</script>

<template>
  <form
    class="panel task-input"
    :class="{ 'keyboard-static': keyboardOpen }"
    @submit.prevent="submit"
  >
    <p id="task-input-hint" class="task-input-hint sr-only" role="note">{{ hint }}</p>
    <p v-if="queuedFollowup" class="queue-note">
      {{ t('agent.alreadyQueued') }}: {{ queuedFollowup }}
    </p>
    <p v-if="mode === 'answer' && question" class="task-question">{{ question }}</p>
    <div class="input-compose">
      <label class="sr-only" for="task-input">{{ t('agent.task') }}</label>
      <textarea
        id="task-input"
        ref="editor"
        v-model="value"
        rows="1"
        :maxlength="maxLength"
        :placeholder="placeholder"
        aria-describedby="task-input-hint"
      ></textarea>

      <div class="task-input-actions">
        <AgentDictation
          :key="imageDraftKey"
          compact
          :disabled="busy || sendingImages"
          @busy="dictating = $event"
          @transcript="value = [value.trimEnd(), $event].filter(Boolean).join(' ')"
        />
        <AgentImagePicker
          v-if="mode === 'continue'"
          :key="imageDraftKey"
          v-model="images"
          :show-previews="false"
          compact
          :disabled="busy || sendingImages"
          @busy="preparingImages = $event"
        />

        <button
          v-if="canToggleFollowup"
          class="text-button composer-followup"
          type="button"
          :aria-pressed="useFollowup"
          :title="t('agent.afterwards')"
          @click="useFollowup = !useFollowup"
        >
          <AppIcon name="afterwards" /><span class="sr-only">{{ t('agent.afterwards') }}</span>
        </button>
        <button
          v-if="isActive && canPause"
          type="button"
          class="text-button pause-button"
          :disabled="cancelling"
          :title="t('agent.pause')"
          @click="emit('pause')"
        >
          <AppIcon name="pause" /><span class="sr-only">{{ t('agent.pause') }}</span>
        </button>
        <button
          v-if="isActive"
          class="text-button stop-button"
          type="button"
          :disabled="cancelling"
          :title="cancelling ? t('agent.cancelling') : t('agent.stopRun')"
          @click="emit('cancel')"
        >
          <AppIcon name="stop" /><span class="sr-only">{{
            cancelling ? t('agent.cancelling') : t('agent.stopRun')
          }}</span>
        </button>
        <button
          class="primary-button composer-send"
          type="submit"
          :title="buttonLabel"
          :disabled="busy || dictating || preparingImages || sendingImages || value.trim() === ''"
        >
          <span class="sr-only">{{ buttonLabel }}</span>
          <AppIcon name="send" />
        </button>
      </div>
    </div>
    <AgentImageAttachments
      v-if="mode === 'continue' && images.length"
      :images="images"
      compact
      :disabled="busy || sendingImages || preparingImages"
      @remove="images = images.filter((_, index) => index !== $event)"
    />
  </form>
</template>
