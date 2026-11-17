<script setup lang="ts">
import { LOCALES, locale, setLocale, t } from '../lib/i18n.js';
</script>

<template>
  <div class="locale-switcher" role="group" :aria-label="t('locale.label')">
    <button
      v-for="option in LOCALES"
      :key="option.code"
      type="button"
      class="locale-button"
      :aria-pressed="locale === option.code"
      :title="option.label"
      @click="setLocale(option.code)"
    >
      {{ option.code.toUpperCase() }}
    </button>
  </div>
</template>
