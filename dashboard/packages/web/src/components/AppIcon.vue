<script setup lang="ts">
const paths = {
  check: ['m4 12 5 5L20 6'],
  close: ['m6 6 12 12M18 6 6 18'],
  sparkles: ['m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5L12 2Z'],
  undo: ['M3 10h10a6 6 0 0 1 0 12', 'm7 5-5 5 5 5'],
  redo: ['M21 10H11a6 6 0 0 0 0 12', 'm17 5 5 5-5 5'],
  expand: ['M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5'],
  shrink: ['M3 8h5V3M21 8h-5V3M8 21v-5H3M16 21v-5h5'],
  dice: [
    'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z',
    'M7 7h.01M17 7h.01M12 12h.01M7 17h.01M17 17h.01',
  ],
  reuse: ['M20 7a9 9 0 1 0 1 9', 'M20 2v6h-6'],
  swap: ['M3 7h18m-4-4 4 4-4 4M21 17H3m4-4-4 4 4 4'],
  download: ['M12 3v12m-5-5 5 5 5-5', 'M4 16v5h16v-5'],
  upload: ['M12 16V4m-5 5 5-5 5 5', 'M4 17v4h16v-4'],
  edit: ['m15 4 5 5L8 21H3v-5L15 4Z', 'm13 6 5 5'],
  plus: ['M12 4v16M4 12h16'],
  zoom: ['M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z', 'm15 15 6 6M7 10h6M10 7v6'],
  search: ['M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z', 'm15 15 6 6'],
  heart: ['M20 5a5 5 0 0 0-8 1 5 5 0 0 0-8-1c-5 6 3 11 8 16 5-5 13-10 8-16Z'],
  pin: ['m8 3 8 0-1 5 4 5H5l4-5-1-5Z', 'M12 13v9'],
  star: ['m12 2 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1 3-6Z'],
  play: ['m8 4 12 8-12 8V4Z'],
  clock: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', 'M12 7v6h4'],
  trash: ['M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7'],
  copy: ['M8 8h13v13H8Z', 'M16 8V3H3v13h5'],
  home: ['M3 10 12 3l9 7v10H3V10Z', 'M9 20v-7h6v7'],
  tasks: ['M3 4h18v16H3Z', 'm7 8 4 4-4 4', 'M13 16h4'],
  folder: ['M3 7V5h6l2 3h10v12H3V7Z'],
  studio: ['M14 5H3v16h16V10', 'm3 16 5-5 5 5 3-3 3 3', 'M18 1v6M15 4h6'],
  gallery: ['M7 3h14v14', 'M3 7h14v14H3Z', 'm3 17 4-4 4 4 3-3 3 3'],
  computer: ['M3 4h18v13H3Z', 'M8 21h8M12 17v4'],
  memory: ['M4 6c0-4 16-4 16 0s-16 4-16 0Z', 'M4 6v6c0 4 16 4 16 0V6', 'M4 12v6c0 4 16 4 16 0v-6'],
  settings: [
    'm9 3-1 3-3 1-2 3 2 2-1 3 2 3 3-1 3 2 3-2 3 1 2-3-1-3 2-2-2-3-3-1-1-3H9Z',
    'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  ],
  left: ['m14 6-6 6 6 6'],
  right: ['m10 6 6 6-6 6'],
  logout: ['M9 3H3v18h6', 'M8 12h13m-5-5 5 5-5 5'],
  microphone: [
    'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5Z',
    'M5 10v2a7 7 0 0 0 14 0v-2',
    'M12 19v3M8 22h8',
  ],
  paperclip: ['m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2', 'm5 16 10-10'],
  pause: ['M7 4v16M17 4v16'],
  stop: ['M6 6h12v12H6Z'],
  afterwards: ['M4 7h10a6 6 0 0 1 0 12H9', 'm8 3-4 4 4 4'],
  send: ['M12 20V4M5 11l7-7 7 7'],
} as const;
defineProps<{ name: keyof typeof paths; filled?: boolean }>();
</script>
<template>
  <svg
    class="app-icon"
    viewBox="0 0 24 24"
    :fill="filled ? 'currentColor' : 'none'"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path v-for="(path, index) in paths[name]" :key="index" :d="path" />
  </svg>
</template>
<style scoped>
.app-icon {
  display: block;
  width: 20px;
  height: 20px;
  flex: none;
}
</style>
