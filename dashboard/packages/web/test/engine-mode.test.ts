import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import EngineModeSwitcher from '../src/components/EngineModeSwitcher.vue';
import { engineMode, refreshEngineMode } from '../src/composables/useEngineMode.js';
import { notifications } from '../src/composables/useNotifications.js';
import { locale } from '../src/lib/i18n.js';
afterEach(() => {
  vi.unstubAllGlobals();
  locale.value = 'en';
});
it('shows the global mode, posts selection, and keeps the selected mode on a refused switch', async () => {
  locale.value = 'de';
  let mode = 'hybrid',
    refused = false;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      if (refused)
        return Response.json({ error: { message: 'Pause agents first' } }, { status: 409 });
      mode = JSON.parse(String(init.body)).mode;
    }
    return Response.json({
      mode,
      changing: false,
      agentsAllowed: mode !== 'studio',
      imageTools: mode === 'hybrid',
      available: true,
    });
  });
  vi.stubGlobal('fetch', fetcher);
  await refreshEngineMode();
  const view = mount(EngineModeSwitcher);
  try {
    await flushPromises();
    expect(view.findAll('.mode-card strong').map((b) => b.text())).toEqual([
      'Text',
      'HybridAktiv',
      'Bildstudio',
    ]);
    await view.get('input[value=studio]').setValue();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    await view.get('form').trigger('submit');
    await flushPromises();
    expect(engineMode.value).toMatchObject({
      mode: 'studio',
      agentsAllowed: false,
      imageTools: false,
    });
    expect(fetcher.mock.calls.some(([, init]) => init?.body === '{"mode":"studio"}')).toBe(true);
    refused = true;
    await view.get('input[value=text]').setValue();
    await view.get('form').trigger('submit');
    await flushPromises();
    expect(notifications.value.find((item) => item.id === 'engine-mode')?.text).toContain(
      'Pause agents first'
    );
    expect(view.find('[role="alert"]').exists()).toBe(false);
    expect(engineMode.value.mode).toBe('studio');
    expect(view.findAll('.mode-card')[2]!.find('small').text()).toBe('Aktiv');
  } finally {
    view.unmount();
  }
});
