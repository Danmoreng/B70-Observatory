import { ref } from 'vue';
import { translations, type LocaleCode, type TranslationKey } from './translations.js';

/**
 * Minimal built-in i18n for the dashboard. English is the default; German is
 * a full mirror. The choice is persisted in `localStorage` and the reactive
 * `locale` ref drives every template that renders through `t()`, so a switch
 * re-renders the whole UI without a reload.
 */
export type Locale = LocaleCode;

export const LOCALES: { code: Locale; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
];

const STORAGE_KEY = 'observatory.locale';

function readStoredLocale(): Locale {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    return stored === 'de' || stored === 'en' ? stored : 'en';
  } catch {
    // Storage can be unavailable (private mode, SSR, tests); fall back to
    // the default.
    return 'en';
  }
}

export const locale = ref<Locale>(readStoredLocale());

export function setLocale(next: Locale): void {
  if (next !== 'en' && next !== 'de') return;
  locale.value = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, next);
  } catch {
    // Persistence is best-effort; the switch still applies for this session.
  }
}

/**
 * Translate `key` into the active locale. Unknown keys fall back to English
 * and, as a last resort, to the key itself so a missing entry never renders
 * as `undefined`. `{placeholders}` are replaced from `vars`.
 */
export function t(key: TranslationKey, vars?: Record<string, string | number>): string {
  const message = translations[locale.value][key] ?? translations.en[key] ?? key;
  if (vars === undefined) return message;
  return message.replace(/\{(\w+)\}/g, (match, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : match
  );
}

/** Convenience bundle for components: `const { locale, setLocale, t } = useI18n();` */
export function useI18n() {
  return { locale, setLocale, t };
}
