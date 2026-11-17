<script setup lang="ts">
import { t } from '../lib/i18n.js';

defineProps<{ version: string; uptime: string; scope?: string }>();
</script>

<template>
  <footer class="meta">
    <span
      >Local AI B70 Observatory<template v-if="scope"> · {{ scope }}</template></span
    >
    <span>{{ t('footer.uptime', { version, uptime }) }}</span>
  </footer>
</template>
