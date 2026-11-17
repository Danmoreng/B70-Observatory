<script setup lang="ts">
import { computed } from 'vue';
import { renderAgentMarkdown } from '../lib/markdown.js';

const props = defineProps<{ text: string }>();
const rendered = computed(() => renderAgentMarkdown(props.text));
</script>

<template>
  <!-- Rendered HTML is produced from html-disabled Markdown and sanitized at this final sink. -->
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div class="timeline-markdown" v-html="rendered"></div>
</template>
