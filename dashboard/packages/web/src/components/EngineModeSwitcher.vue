<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { EngineMode } from '@observatory/contracts';
import {
  engineMode,
  setEngineMode,
  setTextRecipe,
  settingMode,
  modeError,
} from '../composables/useEngineMode.js';
import { t } from '../lib/i18n.js';
import { useNotification } from '../composables/useNotifications.js';
import AppIcon from './AppIcon.vue';
useNotification(modeError, 'engine-mode');
const selected = ref<EngineMode>(engineMode.value.mode);
const busy = computed(() => settingMode.value || engineMode.value.changing);
watch(
  () => engineMode.value.mode,
  (mode) => {
    selected.value = mode;
  }
);
async function chooseModel(event: Event) {
  const select = event.target as HTMLSelectElement;
  const recipe = engineMode.value.models?.find((model) => model === select.value);
  if (recipe) await setTextRecipe(recipe);
  select.value = engineMode.value.model ?? '';
}
async function apply() {
  if (!busy.value && selected.value !== engineMode.value.mode) await setEngineMode(selected.value);
}
</script>
<template>
  <form v-if="engineMode.models?.length" class="engine-mode-control" @submit.prevent>
    <label for="text-recipe"
      ><strong>{{ t('mode.model') }}</strong></label
    >
    <select
      id="text-recipe"
      :value="engineMode.model"
      :disabled="busy || !engineMode.agentsAllowed"
      @change="chooseModel"
    >
      <option v-for="model in engineMode.models" :key="model" :value="model">
        {{
          model === 'inkling2-mini-exl3-b70'
            ? 'Inkling 2 Mini · EXL3 / DSpark'
            : 'Qwen3.8-27B · EXL3 / MTP'
        }}
      </option>
    </select>
    <span v-if="busy" role="status">{{ t('mode.switching') }}</span>
  </form>
  <form v-if="engineMode.available" class="engine-mode-control" @submit.prevent="apply">
    <div
      class="engine-modes mode-cards"
      role="radiogroup"
      :aria-label="t('mode.title')"
      :aria-busy="busy"
    >
      <label
        v-for="mode in ['text', 'hybrid', 'studio'] as const"
        :key="mode"
        class="mode-card"
        :class="{ selected: selected === mode }"
      >
        <input v-model="selected" type="radio" name="engine-mode" :value="mode" :disabled="busy" />
        <span
          ><strong
            >{{ t(`mode.${mode}`)
            }}<small v-if="engineMode.mode === mode">{{ t('settings.active') }}</small></strong
          ><span>{{ t(`mode.${mode}Hint`) }}</span></span
        >
      </label>
    </div>
    <div class="mode-apply-row">
      <span v-if="busy" class="dim" role="status">{{ t('mode.switching') }}</span
      ><button
        class="primary-button"
        type="submit"
        :disabled="busy || selected === engineMode.mode"
      >
        <AppIcon name="check" /> {{ t('settings.applyMode') }}
      </button>
    </div>
  </form>
</template>
<style scoped>
.engine-mode-control {
  display: grid;
  gap: 12px;
}
.mode-cards {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.mode-card {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  cursor: pointer;
  min-width: 0;
}
.mode-card.selected {
  border-color: var(--accent);
  background: var(--raised);
}
.mode-card input {
  margin: 4px 0 0;
  min-height: 0;
  accent-color: var(--accent);
}
.mode-card strong {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
  align-items: center;
}
.mode-card strong small {
  font-size: 10px;
  color: var(--ok);
  font-weight: normal;
}
.mode-card span > span {
  display: block;
  font-size: 11px;
  color: var(--dim);
  margin-top: 5px;
  line-height: 1.5;
}
.mode-apply-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
}
.mode-apply-row button {
  display: flex;
  align-items: center;
  gap: 6px;
}
@media (max-width: 700px) {
  .mode-cards {
    grid-template-columns: 1fr;
  }
}
</style>
