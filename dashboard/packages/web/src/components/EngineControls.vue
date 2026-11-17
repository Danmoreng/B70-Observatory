<script setup lang="ts">
import { engineMode } from '../composables/useEngineMode.js';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { EngineServiceAction, EngineServiceStatus } from '@observatory/contracts';
import { changeEngineService, fetchEngineService } from '../lib/api.js';
import { t } from '../lib/i18n.js';
import { useNotification } from '../composables/useNotifications.js';

const status = ref<EngineServiceStatus>();
const error = ref('');
useNotification(error, 'engine-service');
const pending = ref(false);
const gpuBusy = computed(() => {
  const gpu = status.value?.gpu;
  return (
    !!gpu &&
    (gpu.phase !== 'text' || gpu.activeText > 0 || gpu.waitingImages > 0 || gpu.waitingText > 0)
  );
});
let timer: ReturnType<typeof setInterval> | undefined;
let disposed = false;
let revision = 0;

async function refresh(): Promise<void> {
  if (pending.value) return;
  const currentRevision = revision;
  try {
    const current = await fetchEngineService();
    if (!disposed && currentRevision === revision) {
      status.value = current;
      error.value = '';
    }
  } catch (cause) {
    if (!disposed && currentRevision === revision)
      error.value = cause instanceof Error ? cause.message : t('engine.unavailable');
  }
}

async function act(action: EngineServiceAction): Promise<void> {
  if (pending.value || gpuBusy.value) return;
  if (
    (action === 'stop' || action === 'restart') &&
    !globalThis.confirm(t(action === 'stop' ? 'engine.confirmStop' : 'engine.confirmRestart'))
  )
    return;
  revision++;
  pending.value = true;
  error.value = '';
  try {
    status.value = await changeEngineService(action);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('engine.actionFailed');
  } finally {
    pending.value = false;
  }
}

onMounted(() => {
  void refresh();
  timer = setInterval(() => {
    if (!document.hidden) void refresh();
  }, 5000);
  document.addEventListener('visibilitychange', refresh);
});
onUnmounted(() => {
  disposed = true;
  if (timer) clearInterval(timer);
  document.removeEventListener('visibilitychange', refresh);
});
</script>

<template>
  <section class="engine-controls panel" :aria-label="t('engine.title')">
    <div class="engine-controls-heading">
      <div>
        <h3>{{ t('engine.title') }}</h3>
      </div>
      <p class="engine-state" role="status">
        {{ status ? t(`engine.state.${status.activeState}`) : t('engine.loading') }}
      </p>
    </div>
    <p v-if="status?.gpu" class="engine-state" role="status">
      {{ t(`engine.gpu.${status.gpu.phase}`) }} · {{ t('engine.gpu.active') }}:
      {{ status.gpu.activeText }} · {{ t('engine.gpu.waiting') }}: {{ status.gpu.waitingText }}
    </p>
    <div class="engine-actions">
      <button
        class="quiet-button"
        type="button"
        :disabled="
          engineMode.mode === 'studio' ||
          pending ||
          gpuBusy ||
          !status ||
          (status.activeState !== 'inactive' && status.activeState !== 'failed')
        "
        @click="act('start')"
      >
        {{ t('engine.start') }}
      </button>
      <button
        class="quiet-button"
        type="button"
        :disabled="
          engineMode.mode === 'studio' ||
          pending ||
          gpuBusy ||
          !status ||
          (status.activeState !== 'active' && status.activeState !== 'activating')
        "
        @click="act('stop')"
      >
        {{ t('engine.stop') }}
      </button>
      <button
        class="quiet-button"
        type="button"
        :disabled="
          engineMode.mode === 'studio' ||
          pending ||
          gpuBusy ||
          !status ||
          status.activeState !== 'active'
        "
        @click="act('restart')"
      >
        {{ t('engine.restart') }}
      </button>
      <button
        class="quiet-button engine-autostart"
        type="button"
        :aria-pressed="status?.autostart ?? false"
        :disabled="engineMode.mode === 'studio' || pending || gpuBusy || !status"
        @click="act(status?.autostart ? 'disable' : 'enable')"
      >
        {{ t('engine.autostart') }}:
        {{ status ? t(status.autostart ? 'engine.on' : 'engine.off') : '–' }}
      </button>
    </div>
  </section>
</template>
