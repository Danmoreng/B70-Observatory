import { mount } from '@vue/test-utils';
import { afterEach, expect, it } from 'vitest';
import AppSidebar from '../src/components/AppSidebar.vue';
import { timelineTitle } from '../src/lib/labels.js';
import { timelineToolOutput } from '../src/lib/timeline.js';
import { setLocale } from '../src/lib/i18n.js';
import type { AgentTimelineItem } from '@observatory/contracts';
afterEach(() => setLocale('en'));
it('uses actual SVG icons with accessible names for all main navigation destinations', () => {
  const wrapper = mount(AppSidebar, {
    props: {
      page: 'agent',
      collapsed: true,
      connection: 'connected',
      sync: 'none',
      loginRequired: false,
      signingOut: false,
    },
  });
  const links = wrapper.findAll('nav').at(0)!.findAll('a');
  expect(links).toHaveLength(8);
  for (const link of links) {
    expect(link.find('svg path').exists()).toBe(true);
    expect(link.attributes('aria-label')).toBeTruthy();
    expect(link.find('svg').attributes('aria-hidden')).toBe('true');
  }
  expect(links[1]!.attributes('aria-current')).toBe('page');
  expect(wrapper.find('.locale-switcher').exists()).toBe(false);
  wrapper.unmount();
});
it('translates known generated headings on locale changes while preserving authored titles', () => {
  const heading = { kind: 'task' as const, title: 'Deine Nachricht' };
  expect(timelineTitle(heading)).toBe('Your message');
  expect(timelineTitle({ kind: 'compaction', title: 'Kontext wird komprimiert' })).toBe(
    'Compacting context'
  );
  setLocale('de');
  expect(timelineTitle(heading)).toBe('Deine Nachricht');
  setLocale('en');
  expect(timelineTitle({ kind: 'task', title: 'Meine wichtige Aufgabe' })).toBe(
    'Meine wichtige Aufgabe'
  );
  expect(timelineTitle({ kind: 'assistant', title: 'Kontext komprimiert' })).toBe(
    'Kontext komprimiert'
  );
});
it('removes only legacy browser screenshot boilerplate and never diagnostics or DOM reports', () => {
  const text =
    'Seite neu geladen.\nAktueller Screenshot: 1440×900. Dasselbe Bild wird im Transkript angezeigt.';
  const item = {
    kind: 'tool',
    toolName: 'browser_action',
    state: 'complete',
    outputText: text,
    images: [{}],
  } as AgentTimelineItem;
  expect(timelineToolOutput(item)).toBe('');
  expect(timelineToolOutput({ ...item, state: 'error' })).toBe(text);
  expect(timelineToolOutput({ ...item, images: undefined })).toBe(text);
  expect(timelineToolOutput({ ...item, toolName: 'bash' })).toBe(text);
  expect(
    timelineToolOutput({
      ...item,
      toolName: 'browser_inspect',
      outputText:
        'DOM: Seite neu geladen.\nAktueller Screenshot: 1440×900. Dasselbe Bild wird im Transkript angezeigt.',
    })
  ).toBe('DOM: Seite neu geladen.');
  expect(item.outputText).toBe(text);
  expect(
    timelineToolOutput({
      ...item,
      toolName: 'browser_open',
      outputText: 'Vorschau geöffnet (chromium): http://127.0.0.1:3000 · Titel: Meine Seite.',
    })
  ).toBe(
    JSON.stringify({ browser: 'chromium', url: 'http://127.0.0.1:3000', title: 'Meine Seite' })
  );
  expect(
    timelineToolOutput({
      ...item,
      toolName: 'browser_screenshot',
      outputText: 'Screenshot „Vorschau" · 820×1180 PNG · 18 KiB. Bild an Agenten zurückgegeben.',
    })
  ).toBe('');
  expect(
    timelineToolOutput({
      ...item,
      toolName: 'browser_screenshot',
      outputText:
        'Screenshot „Vorschau" · 820×8192 PNG · 18 KiB · Höhe auf 8192 px begrenzt. Bild an Agenten zurückgegeben.',
    })
  ).toBe('Screenshot height limited to 8192 px.');
});
