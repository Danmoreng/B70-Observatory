import { describe, expect, it } from 'vitest';
import { formatInteger, formatMsAsSeconds, formatPercent, formatRate } from '../src/lib/format.js';

describe('M4A value formatters (honest placeholders, no invented numbers)', () => {
  it('formatInteger renders de-DE integers and a dash for missing values', () => {
    expect(formatInteger(12)).toBe('12');
    expect(formatInteger(1_234)).toBe('1,234');
    expect(formatInteger(undefined)).toBe('–');
    expect(formatInteger(null)).toBe('–');
    expect(formatInteger(Number.NaN)).toBe('–');
  });

  it('formatRate keeps one decimal and appends the unit', () => {
    expect(formatRate(24)).toBe('24 tok/s');
    expect(formatRate(12.5)).toBe('12.5 tok/s');
    expect(formatRate(undefined, ' req/s')).toBe('–');
  });

  it('formatPercent converts 0–1 ratios to de-DE percentages with one decimal', () => {
    expect(formatPercent(1)).toBe('100.0 %');
    expect(formatPercent(0.625)).toBe('62.5 %');
    expect(formatPercent(0.8)).toBe('80.0 %');
    expect(formatPercent(undefined)).toBe('–');
  });

  it('formatMsAsSeconds renders whole-precision seconds', () => {
    expect(formatMsAsSeconds(3500)).toBe('3.5 s');
    expect(formatMsAsSeconds(210)).toBe('0.2 s');
    expect(formatMsAsSeconds(undefined)).toBe('–');
  });
});
