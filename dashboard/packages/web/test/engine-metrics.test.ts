import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import EngineMetricsPanel from '../src/components/EngineMetricsPanel.vue';
import SettingsPage from '../src/components/SettingsPage.vue';
import WorkbenchBreadcrumb from '../src/components/WorkbenchBreadcrumb.vue';
import { engineMode } from '../src/composables/useEngineMode.js';
import { locale } from '../src/lib/i18n.js';
afterEach(() => {
  vi.unstubAllGlobals();
  locale.value = 'en';
});
it('keeps engine switches exclusively in settings, outside the common navigation', () => {
  engineMode.value = {
    available: true,
    changing: false,
    mode: 'studio',
    agentsAllowed: false,
    imageTools: false,
  };
  const header = mount(WorkbenchBreadcrumb),
    settings = mount(SettingsPage, { global: { stubs: { EngineControls: true } } });
  expect(header.find('.engine-modes').exists()).toBe(false);
  expect(settings.find('.engine-modes').exists()).toBe(true);
  header.unmount();
  settings.unmount();
});
it('shows actual engine readiness, Comfy memory, queues and sampling steps', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        sampledAt: new Date().toISOString(),
        phase: 'image',
        textReady: false,
        imageReady: true,
        activeText: 0,
        waitingText: 1,
        waitingImages: 2,
        imageQueue: { running: 1, pending: 0 },
        imageMemory: {
          ramFree: 1024 ** 3,
          ramTotal: 32 * 1024 ** 3,
          devices: [{ name: 'Intel Arc', vramFree: 12 * 1024 ** 3, vramTotal: 32 * 1024 ** 3 }],
        },
        jobs: [
          {
            id: 'abcd1234',
            source: 'studio',
            status: 'running',
            phase: 'Generating image',
            step: 3,
            steps: 6,
            elapsedSeconds: 42,
          },
        ],
      })
    )
  );
  const view = mount(EngineMetricsPanel, {
    slots: { default: '<section class="statistics-fixture">Resource cards</section>' },
  });
  await flushPromises();
  const order = [...view.element.children].map((element) => element.className);
  expect(order).toEqual(['engine-status-strip', 'statistics-fixture', 'engine-metrics panel']);
  expect(view.text()).toContain('Qwen 27B · off');
  expect(view.text()).toContain('H3 Image INT8 · ready');
  expect(view.get('progress').attributes()).toMatchObject({ value: '3', max: '6' });
  expect(view.text()).toContain('42.0 s');
  expect(view.text()).toContain('20 GiB / 32 GiB');
  view.unmount();
});
