import { afterEach, describe, expect, it } from 'vitest';
import { locale, setLocale, t } from '../src/lib/i18n.js';

describe('dashboard locale', () => {
  afterEach(() => {
    setLocale('en');
    localStorage.clear();
  });

  it('uses English by default and switches the reactive catalog to German', () => {
    expect(locale.value).toBe('en');
    expect(t('sidebar.tasks')).toBe('Tasks');

    setLocale('de');

    expect(locale.value).toBe('de');
    expect(t('sidebar.tasks')).toBe('Aufgaben');
  });

  it('persists the selected locale and interpolates values', () => {
    setLocale('de');

    expect(localStorage.getItem('observatory.locale')).toBe('de');
    expect(t('agent.changedFiles', { count: 3 })).toBe('3 geänderte Datei(en)');
  });
});
