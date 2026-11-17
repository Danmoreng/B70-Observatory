import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it } from 'vitest';
import NotificationHost from '../src/components/NotificationHost.vue';
import { notifications, notify } from '../src/composables/useNotifications.js';
afterEach(() => {
  notifications.value = [];
  document.body.innerHTML = '';
});
it('shows errors in a separate dismissible container and deduplicates repeated failures', async () => {
  const view = mount(NotificationHost, { attachTo: document.body });
  notify('gallery', 'Connection interrupted', 'warn');
  notify('gallery', 'Connection interrupted', 'warn');
  await flushPromises();
  expect(document.querySelectorAll('.notification-card')).toHaveLength(1);
  expect(document.querySelector('.notification-stack')?.parentElement).toBe(document.body);
  (document.querySelector('.notification-close') as HTMLButtonElement).click();
  await flushPromises();
  expect(document.querySelectorAll('.notification-card')).toHaveLength(0);
  view.unmount();
});
