import { describe, expect, it } from 'vitest';
import {
  formatClock,
  formatNumber,
  formatRuntimeClock,
  formatShortDateTime,
  formatTimestamp,
  formatUptime,
} from '../src/lib/format';

describe('formatUptime', () => {
  it('formats whole seconds, minutes and hours with fixed units', () => {
    expect(formatUptime(0)).toBe('0 s');
    expect(formatUptime(5)).toBe('5 s');
    expect(formatUptime(59)).toBe('59 s');
    expect(formatUptime(60)).toBe('1 min');
    expect(formatUptime(3600)).toBe('1 h');
    expect(formatUptime(90061)).toBe('25 h 01 min 01 s');
  });

  it('reports invalid input instead of rendering NaN', () => {
    expect(formatUptime(-10)).toBe('unknown');
    expect(formatUptime(Number.NaN)).toBe('unknown');
  });
});

describe('formatClock', () => {
  it('renders a two-digit clock time for UTC input', () => {
    expect(formatClock('2025-01-01T10:00:00.000Z')).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('reports unparseable input as unknown', () => {
    expect(formatClock('definitely not a date')).toBe('unknown');
  });
});

describe('formatShortDateTime', () => {
  it('renders a short en-GB date with two-digit local time', () => {
    expect(formatShortDateTime(new Date(2026, 8, 13, 10, 5))).toBe('13/09, 10:05');
  });

  it('reports unparseable or missing input as unknown', () => {
    expect(formatShortDateTime('definitely not a date')).toBe('unknown');
    expect(formatShortDateTime(undefined)).toBe('unknown');
  });
});

describe('formatTimestamp', () => {
  it('renders the full local date and time', () => {
    expect(formatTimestamp(new Date(2026, 8, 13, 10, 5))).toBe('13/09/2026, 10:05:00');
  });

  it('reports unparseable or missing input as unknown', () => {
    expect(formatTimestamp('definitely not a date')).toBe('unknown');
    expect(formatTimestamp(Number.NaN)).toBe('unknown');
    expect(formatTimestamp(undefined)).toBe('unknown');
  });
});

describe('formatNumber', () => {
  it('formats with en-GB separators and a bounded decimal count', () => {
    expect(formatNumber(1234.567)).toBe('1,234.57');
    expect(formatNumber(42)).toBe('42');
    expect(formatNumber(1.25, 1)).toBe('1.3');
    expect(formatNumber(1.234, Number.NaN)).toBe('1.23');
  });

  it('reports non-finite input with a dash', () => {
    expect(formatNumber(undefined)).toBe('–');
    expect(formatNumber(Number.NaN)).toBe('–');
  });
});

describe('formatRuntimeClock', () => {
  it('renders minutes and seconds, adding a hours part beyond one hour', () => {
    expect(formatRuntimeClock(0)).toBe('0:00');
    expect(formatRuntimeClock(425)).toBe('7:05');
    expect(formatRuntimeClock(3600 + 7 * 60 + 5)).toBe('1:07:05');
  });

  it('reports non-finite or negative input with a dash instead of NaN', () => {
    expect(formatRuntimeClock(Number.NaN)).toBe('–');
    expect(formatRuntimeClock(-5)).toBe('–');
  });
});
