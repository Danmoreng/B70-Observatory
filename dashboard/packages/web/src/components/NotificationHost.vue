<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import { dismissNotification, notifications } from '../composables/useNotifications.js';
import { t } from '../lib/i18n.js';
const host = ref<HTMLElement>();
async function updateLayer() {
  await nextTick();
  const element = host.value;
  if (!element?.showPopover) return;
  // Native dialogs are in the browser's top layer, above ordinary z-index.
  // Reopening this nonmodal popover keeps dismissible errors visible there too.
  element.hidePopover();
  if (notifications.value.length) element.showPopover();
}
watch(notifications, updateLayer);
onMounted(updateLayer);
</script>
<template>
  <Teleport to="body">
    <aside
      ref="host"
      class="notification-stack"
      popover="manual"
      :aria-label="t('notifications.label')"
      aria-live="polite"
      :data-empty="notifications.length === 0"
    >
      <section
        v-for="item in notifications"
        :key="item.id"
        class="notification-card"
        :class="`notification-${item.kind}`"
        :role="item.kind === 'error' ? 'alert' : 'status'"
      >
        <p>{{ item.text }}</p>
        <button
          type="button"
          class="notification-close"
          :aria-label="t('notifications.dismiss')"
          @click="dismissNotification(item.id)"
        >
          ×
        </button>
      </section>
    </aside>
  </Teleport>
</template>
