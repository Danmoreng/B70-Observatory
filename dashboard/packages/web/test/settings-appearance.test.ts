import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, expect, it } from 'vitest';
import SettingsPage from '../src/components/SettingsPage.vue';
import { density } from '../src/composables/useAppearance.js';
import { setLocale } from '../src/lib/i18n.js';
afterEach(() => {
  density.value = 'standard';
  setLocale('en');
  localStorage.clear();
});
it('centralizes locale and persistent density separately from engine operation', async () => {
  const view = mount(SettingsPage, {
    global: { stubs: { EngineControls: true, EngineModeSwitcher: true } },
  });
  expect(view.find('.settings-operation .locale-switcher').exists()).toBe(false);
  await view.get('.settings-appearance .locale-switcher button:last-child').trigger('click');
  expect(view.get('h1').text()).toBe('Einstellungen');
  await view.get('.settings-appearance select').setValue('compact');
  await flushPromises();
  expect(document.documentElement.dataset.density).toBe('compact');
  expect(localStorage.getItem('observatory.density')).toBe('compact');
  expect(view.get('.settings-operation h2').text()).toBe('Engine-Betrieb');
  view.unmount();
});
