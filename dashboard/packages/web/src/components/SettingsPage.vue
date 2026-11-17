<script setup lang="ts">
import EngineModeSwitcher from './EngineModeSwitcher.vue';
import EngineControls from './EngineControls.vue';
import LocaleSwitcher from './LocaleSwitcher.vue';
import { density } from '../composables/useAppearance.js';
import { t } from '../lib/i18n.js';
</script>
<template>
  <section class="settings-page">
    <h1>{{ t('settings.title') }}</h1>
    <section class="panel settings-operation">
      <h2>{{ t('settings.operation') }}</h2>
      <h3>{{ t('mode.title') }}</h3>
      <EngineModeSwitcher /><EngineControls />
    </section>
    <section class="panel settings-appearance">
      <h2>{{ t('settings.appearance') }}</h2>
      <div class="settings-preference">
        <span>{{ t('locale.label') }}</span
        ><LocaleSwitcher />
      </div>
      <label class="settings-preference"
        ><span>{{ t('settings.density') }}</span
        ><select v-model="density">
          <option value="standard">{{ t('settings.standard') }}</option>
          <option value="compact">{{ t('settings.compact') }}</option>
        </select></label
      >
    </section>
  </section>
</template>
<style scoped>
.settings-page {
  display: grid;
  gap: 16px;
  max-width: 1100px;
}
.settings-page h1 {
  margin: 0;
}
.settings-page h2 {
  font-size: 17px;
  margin: 0 0 14px;
}
.settings-page h3 {
  font-size: 13px;
  color: var(--dim);
}
.settings-operation :deep(.engine-controls) {
  margin-top: 18px;
  padding: 14px 0 0;
  border: 0;
  border-top: 1px solid var(--border);
  border-radius: 0;
}
.settings-preference {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 8px 0;
  max-width: 540px;
}
.settings-preference select {
  min-width: 180px;
}
</style>
