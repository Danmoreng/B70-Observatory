<script setup lang="ts">
import { computed } from 'vue';
import type { HealthCheck } from '@observatory/contracts';
import { t } from '../lib/i18n.js';
import type { TranslationKey } from '../lib/translations.js';

const props = defineProps<{ check: HealthCheck }>();
const names: Record<string, TranslationKey> = {
  server: 'check.server',
  gateway: 'check.gateway',
  database: 'check.database',
  vllm: 'check.vllm',
  system: 'check.system',
  gpu: 'check.gpu',
};

const statusLabel = computed(() =>
  props.check.status === 'ok'
    ? t('check.ok')
    : props.check.status === 'degraded'
      ? t('check.degraded')
      : t('check.fault')
);
const checkName = computed(() => {
  const key = names[props.check.name];
  return key !== undefined ? t(key) : props.check.name;
});
</script>

<template>
  <li class="check" :class="check.status">
    <span class="dot" aria-hidden="true"></span>
    <span class="check-name">{{ checkName }}</span>
    <span class="check-status">{{ statusLabel }}</span>
    <span v-if="check.message !== undefined" class="check-message">{{ check.message }}</span>
  </li>
</template>
