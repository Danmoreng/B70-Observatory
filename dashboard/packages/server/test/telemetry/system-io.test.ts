import { describe, expect, it } from 'vitest';
import {
  cpuDeltaUtilization,
  diskUsageFromStatfs,
  parseCpuStatLine,
  parseLoadavg,
  parseMeminfo,
  type StatFsView,
} from '../../src/telemetry/system-io.js';

describe('parseCpuStatLine', () => {
  it('sums user..steal and uses idle+iowait as the idle share', () => {
    const jiffies = parseCpuStatLine('cpu  100 20 50 700 30 5 7 2 100 100');
    // guest (100) + guest_nice (100) must be excluded (already in user).
    expect(jiffies).toEqual({ total: 914, idle: 730 });
  });

  it('works with a minimal 4-field line (idle only)', () => {
    expect(parseCpuStatLine('cpu  10 5 3 92')).toEqual({ total: 110, idle: 92 });
  });

  it('rejects non-cpu lines, short lines and non-numeric fields', () => {
    expect(parseCpuStatLine('cpu0  10 5 3 92')).toBeUndefined();
    expect(parseCpuStatLine('cpu 10 5')).toBeUndefined();
    expect(parseCpuStatLine('cpu 10 5 3 92 NaN 0 0 0')).toBeUndefined();
    expect(parseCpuStatLine('cpu 10 5 3 92 -1 0 0 0')).toBeUndefined();
    expect(parseCpuStatLine('')).toBeUndefined();
  });
});

describe('cpuDeltaUtilization', () => {
  it('returns undefined for the first measurement (honestly: no rate yet)', () => {
    const result = cpuDeltaUtilization(undefined, { total: 100, idle: 90 });
    expect(result).toEqual({ utilizationPercent: undefined, reset: false });
  });

  it('computes 100 % busy from deltas and clamps to the valid range', () => {
    const previous = { total: 1_000, idle: 900 };
    expect(cpuDeltaUtilization(previous, { total: 2_000, idle: 900 }).utilizationPercent).toBe(100);
    expect(cpuDeltaUtilization(previous, { total: 1_500, idle: 1_400 }).utilizationPercent).toBe(0);
    expect(cpuDeltaUtilization(previous, { total: 1_500, idle: 1_200 }).utilizationPercent).toBe(
      40
    );
  });

  it('reports no rate and keeps the baseline when no jiffies progress happened', () => {
    const previous = { total: 1_000, idle: 900 };
    expect(cpuDeltaUtilization(previous, { total: 1_000, idle: 900 })).toEqual({
      utilizationPercent: undefined,
      reset: false,
    });
  });

  it('re-bases and reports no rate when a counter goes backwards', () => {
    const previous = { total: 5_000, idle: 4_000 };
    expect(cpuDeltaUtilization(previous, { total: 100, idle: 90 })).toEqual({
      utilizationPercent: undefined,
      reset: true,
    });
  });

  it('reports no rate when the idle delta exceeds the total delta', () => {
    expect(cpuDeltaUtilization({ total: 100, idle: 50 }, { total: 110, idle: 65 })).toEqual({
      utilizationPercent: undefined,
      reset: true,
    });
  });
});

describe('parseMeminfo', () => {
  it('extracts the needed kB fields and skips foreign/malformed lines', () => {
    const text = [
      'MemTotal:       31695012 kB',
      'MemFree:         5000000 kB',
      'MemAvailable:   22361904 kB',
      'Buffers:        5000 kB',
      'Cached:         10000 kB',
      'HugePages_Total:       0', // no kB suffix → ignored
      'Broken:       abc kB', // non-numeric → ignored
      'MemFree:       not-a-number kB', // malformed → ignored (keeps old value)
    ].join('\n');
    expect(parseMeminfo(text)).toEqual({
      total: 31_695_012,
      available: 22_361_904,
      free: 5_000_000,
      buffers: 5000,
      cached: 10_000,
    });
  });

  it('returns an empty object for empty input', () => {
    expect(parseMeminfo('')).toEqual({});
  });
});

describe('parseLoadavg', () => {
  it('parses the six leading fields', () => {
    expect(parseLoadavg('0.90 0.45 0.22 2/1138 12345\n')).toEqual({
      load1: 0.9,
      load5: 0.45,
      load15: 0.22,
      running: 2,
      total: 1138,
    });
  });

  it('leaves fields undefined for malformed content', () => {
    expect(parseLoadavg('')).toEqual({});
    const result = parseLoadavg('NaN 0.45 0.22 2/1138');
    expect(result.load1).toBeUndefined();
    expect(result.load5).toBe(0.45);
  });
});

describe('diskUsageFromStatfs', () => {
  it('computes df-style usage in bytes', () => {
    const view: StatFsView = { bsize: 4096, blocks: 1_000, bfree: 400, bavail: 390 };
    expect(diskUsageFromStatfs(view)).toEqual({
      totalBytes: 4_096_000,
      usedBytes: 2_457_600, // (blocks - bfree) * bsize
      freeBytes: 1_597_440, // bavail * bsize
      usagePercent: 60.6, // 600 / (600 + 390), df convention
    });
  });

  it('rejects degenerate views instead of emitting NaN', () => {
    expect(diskUsageFromStatfs({ bsize: 0, blocks: 10, bfree: 5, bavail: 5 })).toBeUndefined();
    expect(diskUsageFromStatfs({ bsize: 4096, blocks: 0, bfree: 0, bavail: 0 })).toBeUndefined();
    expect(diskUsageFromStatfs({ bsize: 4096, blocks: 10, bfree: 1, bavail: 5 })).toBeUndefined();
    expect(
      diskUsageFromStatfs({ bsize: Number.NaN, blocks: 10, bfree: 5, bavail: 5 })
    ).toBeUndefined();
  });

  it('handles a full filesystem (no free blocks) as 100 %, never NaN', () => {
    const view: StatFsView = { bsize: 4096, blocks: 100, bfree: 0, bavail: 0 };
    const usage = diskUsageFromStatfs(view);
    expect(usage?.usagePercent).toBe(100);
  });
});
