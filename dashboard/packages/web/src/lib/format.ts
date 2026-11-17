/**
 * Small formatting helpers. All durations coming from the API are whole
 * seconds; all timestamps are UTC strings rendered locally via `Intl`.
 * Number and date separators follow the active UI locale (en by default,
 * de-DE when the user switches to German).
 */
import { locale, t } from './i18n.js';

/** BCP-47 tag matching the active UI locale. */
export function uiLocale(): string {
  return locale.value === 'de' ? 'de-DE' : 'en-GB';
}

const RANKS = [
  { label: 'h', factor: 3600 },
  { label: 'min', factor: 60 },
  { label: 's', factor: 1 },
] as const;

/** Formats a whole-second duration as e.g. "3 h 04 min" or "45 s". */
export function formatUptime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return t('format.unknown');
  }
  let remaining = Math.floor(totalSeconds);
  const parts: string[] = [];
  for (const rank of RANKS) {
    const value = Math.floor(remaining / rank.factor);
    remaining -= value * rank.factor;
    if (value > 0 || parts.length > 0) {
      parts.push(`${value.toString().padStart(parts.length === 0 ? 1 : 2, '0')} ${rank.label}`);
    }
    if (parts.length > 0 && remaining === 0) {
      break;
    }
  }
  return parts.length > 0 ? parts.join(' ') : '0 s';
}

function toDateTime(value: string | number | Date | null | undefined): Date | undefined {
  if (value === null || value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function dateTimeFormatter(tag: 'clock' | 'short' | 'full'): Intl.DateTimeFormat {
  const locale = uiLocale();
  const key = `${locale}:${tag}`;
  const cached = dateFormatters.get(key);
  if (cached !== undefined) return cached;
  const options: Intl.DateTimeFormatOptions =
    tag === 'clock'
      ? { hour: '2-digit', minute: '2-digit', second: '2-digit' }
      : tag === 'short'
        ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }
        : {
            day: 'numeric',
            month: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          };
  const formatter = new Intl.DateTimeFormat(locale, options);
  dateFormatters.set(key, formatter);
  return formatter;
}

/** Formats a UTC timestamp for local display, e.g. "14:32:05". */
export function formatClock(utcTimestamp: string | number | Date | null | undefined): string {
  const date = toDateTime(utcTimestamp);
  if (date === undefined) {
    return t('format.unknown');
  }
  return dateTimeFormatter('clock').format(date);
}

/** Short local date and time, e.g. `13/09, 10:05`; `unknown` for invalid input. */
export function formatShortDateTime(value: string | number | Date | null | undefined): string {
  const date = toDateTime(value);
  if (date === undefined) return t('format.unknown');
  return dateTimeFormatter('short').format(date);
}

/** Full local date and time for table cells; `unknown` for invalid input. */
export function formatTimestamp(value: number | string | Date | null | undefined): string {
  const date = toDateTime(value);
  if (date === undefined) return t('format.unknown');
  return dateTimeFormatter('full').format(date);
}

/**
 * Elapsed time in whole seconds as a compact clock, e.g. `7:05` or
 * `1:07:05`. Returns `–` for anything that is not a finite, non-negative
 * number so a broken timestamp never renders `NaN`.
 */
export function formatRuntimeClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '–';
  const seconds = Math.floor(totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

const numberFormatters = new Map<string, Intl.NumberFormat>();

function numberFormatter(maximumFractionDigits: number): Intl.NumberFormat {
  const digits = Number.isInteger(maximumFractionDigits)
    ? Math.min(20, Math.max(0, maximumFractionDigits))
    : 2;
  const key = `${uiLocale()}:max:${digits}`;
  const cached = numberFormatters.get(key);
  if (cached !== undefined) return cached;
  const formatter = new Intl.NumberFormat(uiLocale(), { maximumFractionDigits: digits });
  numberFormatters.set(key, formatter);
  return formatter;
}

/** Number in the active locale with a bounded decimal count; `–` for anything non-finite. */
export function formatNumber(value: number | null | undefined, maximumFractionDigits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–';
  return numberFormatter(maximumFractionDigits).format(value);
}

const specialFormatters = new Map<string, Intl.NumberFormat>();

function localeNumberFormatter(name: 'integer' | 'rate' | 'percent'): Intl.NumberFormat {
  const key = `${uiLocale()}:${name}`;
  const cached = specialFormatters.get(key);
  if (cached !== undefined) return cached;
  const options =
    name === 'integer'
      ? { maximumFractionDigits: 0 }
      : name === 'rate'
        ? { maximumFractionDigits: 1 }
        : { minimumFractionDigits: 1, maximumFractionDigits: 1 };
  const formatter = new Intl.NumberFormat(uiLocale(), options);
  specialFormatters.set(key, formatter);
  return formatter;
}

/** Whole numbers in the active locale; `–` for anything that is not a number. */
export function formatInteger(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–';
  return localeNumberFormatter('integer').format(Math.round(value));
}

/** Rates in the active locale's number style, e.g. `12.5 tok/s`. */
export function formatRate(value: number | null | undefined, unit = 'tok/s'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–';
  return `${localeNumberFormatter('rate').format(value)} ${unit}`;
}

/** Ratios 0–1 as percentages in the active locale, e.g. `61.4 %`. */
export function formatPercent(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '–';
  return `${localeNumberFormatter('percent').format(ratio * 100)} %`;
}

/** Durations given in ms, rendered as whole seconds with a unit. */
export function formatMsAsSeconds(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–';
  return `${localeNumberFormatter('rate').format(value / 1000)} s`;
}

/** Fixed-point numbers in the active locale's separators, e.g. `69.4`. */
export function formatFixed(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–';
  const count = Number.isInteger(digits) ? Math.min(20, Math.max(0, digits)) : 1;
  const key = `${uiLocale()}:fixed:${count}`;
  let formatter = fixedFormatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(uiLocale(), {
      minimumFractionDigits: count,
      maximumFractionDigits: count,
    });
    fixedFormatters.set(key, formatter);
  }
  return formatter.format(value);
}

const fixedFormatters = new Map<string, Intl.NumberFormat>();

const BYTE_STEPS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

/**
 * Byte counters in binary IEC units (1 KiB = 1024 B), e.g. `12,3 GiB`.
 * `–` for anything that is not a finite, non-negative number.
 */
export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) {
    return '–';
  }
  let size = value;
  let step = 0;
  while (size >= 1024 && step < BYTE_STEPS.length - 1) {
    size /= 1024;
    step += 1;
  }
  const digits = step === 0 ? 0 : 1;
  const formatted = numberFormatter(digits).format(size);
  return `${formatted} ${BYTE_STEPS[step]}`;
}
