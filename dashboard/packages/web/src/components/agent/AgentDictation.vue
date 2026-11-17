<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useId } from 'vue';
import { fetchSpeechStatus, transcribeSpeech } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import AppIcon from '../AppIcon.vue';
import { useNotification } from '../../composables/useNotifications.js';

const props = defineProps<{ disabled?: boolean; compact?: boolean }>();
const emit = defineEmits<{ transcript: [text: string]; busy: [value: boolean] }>();
const available = ref(false);
const phase = ref<'idle' | 'permission' | 'recording' | 'transcribing'>('idle');
const error = ref('');
useNotification(() => (props.compact ? error.value : ''), `dictation-${useId()}`);
const secure = globalThis.isSecureContext === true;
const supported =
  !!globalThis.navigator?.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
const canRecord = computed(() => secure && supported && available.value);
const label = computed(() =>
  t(
    phase.value === 'recording'
      ? 'speech.stop'
      : phase.value === 'transcribing'
        ? 'speech.transcribing'
        : phase.value === 'permission'
          ? 'speech.permission'
          : 'speech.start'
  )
);
const unavailableReason = computed(() =>
  !secure
    ? t('speech.httpsRequired')
    : !supported
      ? t('speech.unsupported')
      : !available.value
        ? t('speech.unavailable')
        : ''
);
let recorder: MediaRecorder | undefined;
let stream: MediaStream | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let chunks: Blob[] = [];
let bytes = 0;
let generation = 0;
let request: AbortController | undefined;
function releaseMic(): void {
  clearTimeout(timer);
  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;
}
function reset(): void {
  releaseMic();
  phase.value = 'idle';
  emit('busy', false);
}
async function finish(current: number): Promise<void> {
  releaseMic();
  if (current !== generation) return;
  if (error.value) {
    reset();
    return;
  }
  phase.value = 'transcribing';
  request = new AbortController();
  try {
    const audio = new Blob(chunks, { type: recorder?.mimeType ?? 'audio/mp4' });
    if (audio.size === 0) throw new Error(t('speech.empty'));
    const text = await transcribeSpeech(audio, request.signal);
    if (current !== generation) return;
    if (text.trim()) emit('transcript', text.trim());
    else error.value = t('speech.empty');
  } catch {
    if (current === generation) error.value = t('speech.failed');
  } finally {
    if (current === generation) reset();
  }
}
async function toggle(): Promise<void> {
  if (phase.value === 'recording') {
    recorder?.stop();
    return;
  }
  if (phase.value !== 'idle' || !canRecord.value || props.disabled) return;
  const current = ++generation;
  phase.value = 'permission';
  error.value = '';
  emit('busy', true);
  try {
    const acquired = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (current !== generation) {
      acquired.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = acquired;
    const mimeType = [
      'audio/mp4',
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
    ].find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('Unsupported recording format');
    recorder = new MediaRecorder(acquired, { mimeType });
    chunks = [];
    bytes = 0;
    recorder.ondataavailable = (event) => {
      bytes += event.data.size;
      if (bytes > 8 * 1024 * 1024) {
        error.value = t('speech.tooLarge');
        if (recorder?.state === 'recording') recorder.stop();
      } else chunks.push(event.data);
    };
    recorder.onstop = () => {
      void finish(current);
    };
    recorder.onerror = () => {
      error.value = t('speech.failed');
      if (recorder?.state === 'recording') recorder.stop();
      reset();
    };
    recorder.start(1000);
    phase.value = 'recording';
    timer = setTimeout(() => {
      if (recorder?.state === 'recording') recorder.stop();
    }, 119_000);
  } catch {
    if (current === generation) {
      error.value = t('speech.permissionFailed');
      reset();
    }
  }
}
onMounted(async () => {
  const current = generation;
  try {
    const status = await fetchSpeechStatus();
    if (current === generation) available.value = status.available;
  } catch {
    /* Keep an honest unavailable state without interrupting typing. */
  }
});
onUnmounted(() => {
  generation++;
  request?.abort();
  if (recorder?.state === 'recording') {
    recorder.onstop = null;
    recorder.stop();
  }
  chunks = [];
  releaseMic();
  emit('busy', false);
});
</script>

<template>
  <div class="agent-dictation" :class="{ compact }" :title="unavailableReason || label">
    <button
      class="quiet-button"
      type="button"
      :disabled="phase !== 'recording' && (disabled || !canRecord || phase !== 'idle')"
      :aria-pressed="phase === 'recording'"
      :aria-label="unavailableReason ? `${label}: ${unavailableReason}` : label"
      @click="toggle"
    >
      <AppIcon v-if="compact" :name="phase === 'recording' ? 'stop' : 'microphone'" />
      <span :class="{ 'sr-only': compact }">{{ label }}</span>
    </button>
    <span
      v-if="phase === 'recording'"
      class="dictation-recording"
      :class="{ 'sr-only': compact }"
      role="status"
      >{{ t('speech.recording') }}</span
    >
    <small v-else-if="unavailableReason && !compact">{{ unavailableReason }}</small>
    <small v-else-if="phase === 'idle' && !compact">{{ t('speech.hint') }}</small>
    <p v-if="error && !compact" role="alert" class="error-text">{{ error }}</p>
  </div>
</template>

<style scoped>
.agent-dictation {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem;
  min-width: 0;
  margin-block: 0.5rem;
}
.agent-dictation.compact {
  margin: 0;
  flex-wrap: nowrap;
}
.compact button {
  width: 44px;
  padding: 0;
  display: grid;
  place-items: center;
}
.compact button[aria-pressed='true'] {
  color: var(--error);
  box-shadow: inset 0 0 0 1px currentColor;
}
.agent-dictation small {
  color: var(--dim);
  overflow-wrap: anywhere;
}
.agent-dictation button {
  min-height: 44px;
}
.dictation-recording {
  color: var(--error);
}
</style>
