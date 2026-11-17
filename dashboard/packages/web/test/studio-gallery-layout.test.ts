import { mount } from '@vue/test-utils';
import { afterEach, expect, it } from 'vitest';
import DeskGallery from '../src/studio/DeskGallery.vue';
import { studioText, studioLabel } from '../src/studio/copy.js';
import { setLocale } from '../src/lib/i18n.js';
afterEach(() => {
  setLocale('en');
  history.replaceState({}, '', '/');
});
it('removes pair comparison including old query links while keeping sorting and all filters', () => {
  history.replaceState({}, '', '/?sort=pair');
  setLocale('de');
  const view = mount(DeskGallery);
  expect(view.findAll('option[value=pair]')).toHaveLength(0);
  expect((view.get('[aria-label="Bilder sortieren"]').element as HTMLSelectElement).value).toBe(
    'newest'
  );
  expect(view.findAll('.desk-gallery-filters select')).toHaveLength(5);
  expect(view.get('[type=search]').attributes('placeholder')).toContain('Schlagwörter');
  expect(view.find('.pair-view').exists()).toBe(false);
  expect(view.find('.bi').exists()).toBe(false);
  view.unmount();
});
it('translates framework phases but preserves user-authored prompt and metadata text', () => {
  setLocale('de');
  expect(studioLabel('Generating image')).toBe('Bild wird generiert');
  expect(studioText('Delete {title} permanently', { title: 'Mein Bild' })).toBe(
    'Mein Bild endgültig löschen'
  );
  expect(studioLabel('Mein frei gewählter Titel')).toBe('Mein frei gewählter Titel');
  setLocale('en');
  expect(studioText('Image width')).toBe('Image width');
});
