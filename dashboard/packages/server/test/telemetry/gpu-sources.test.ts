import { describe, expect, it } from 'vitest';
import {
  buildGpuFixture,
  createFakeSystemSources,
  type GpuFixtureCard,
} from './system-fixtures.js';
import { collectGpuValues } from '../../src/telemetry/gpu-sources.js';

const FULL_CARD: GpuFixtureCard = {
  name: 'card0',
  driver: 'xe',
  temperaturesMdegC: [69_000, 80_500, 71_000],
  powerMicrowatts: 42_350_000,
  gpuBusyPercent: 77,
  vramUsedBytes: 24_000_000_000,
  vramTotalBytes: 32_000_000_000,
  freqHz: 2_400_000_000,
};

/** Exact shape of this machine: xe hwmon with temperatures + energy only. */
const THIS_MACHINE_CARD: GpuFixtureCard = {
  name: 'card0',
  driver: 'xe',
  temperaturesMdegC: [69_000, 80_000, 51_000],
};

const AMD_CARD: GpuFixtureCard = {
  name: 'card1',
  driver: 'amdgpu',
  temperaturesMdegC: [45_000],
  powerMicrowatts: 10_000_000,
  gpuBusyPercent: 33,
};

describe('collectGpuValues (M4B, read-only sysfs source)', () => {
  it('reports an honest "not available" when no xe card exists', async () => {
    const sources = createFakeSystemSources(buildGpuFixture([AMD_CARD]));
    const gpu = await collectGpuValues(sources.gpuIo);
    expect(gpu.available).toBe(false);
    if (!gpu.available) {
      expect(gpu.reason).toContain('xe');
      expect(gpu.reason.length).toBeLessThanOrEqual(256);
    }
  });

  it('reads a complete interface with documented units', async () => {
    const sources = createFakeSystemSources(buildGpuFixture([FULL_CARD]));
    const gpu = await collectGpuValues(sources.gpuIo);
    expect(gpu).toEqual({
      available: true,
      card: 'card0',
      values: {
        utilizationPercent: 77,
        vramUsedBytes: 24_000_000_000,
        vramTotalBytes: 32_000_000_000,
        temperatureC: 80.5, // max over temp*_input, millidegrees → degrees
        powerWatts: 42.35, // power1_input microwatts → watts
        clockMhz: 2400, // freq*_input hertz → MHz
      },
    });
  });

  it('exposes exactly the values this machine offers (temperatures only) and lists the rest as missing', async () => {
    const sources = createFakeSystemSources(buildGpuFixture([AMD_CARD, THIS_MACHINE_CARD]));
    const gpu = await collectGpuValues(sources.gpuIo);
    expect(gpu.available).toBe(true);
    if (gpu.available) {
      expect(gpu.card).toBe('card0');
      expect(gpu.values).toEqual({ temperatureC: 80 });
      expect(gpu.missing).toEqual(['utilization', 'vram', 'power', 'clock']);
    }
  });

  it('treats non-numeric file content as "not exposed"', async () => {
    const sources = createFakeSystemSources(
      buildGpuFixture([
        {
          ...FULL_CARD,
          corruptedFile: { path: 'gpu_busy_percent', content: 'unavailable' },
        },
      ])
    );
    const gpu = await collectGpuValues(sources.gpuIo);
    expect(gpu.available).toBe(true);
    if (gpu.available) {
      expect(gpu.values.utilizationPercent).toBeUndefined();
      expect(gpu.missing).toEqual(['utilization']);
    }
  });

  it('treats out-of-range values as "not exposed" (busy percent > 100)', async () => {
    const fixture = buildGpuFixture([{ ...FULL_CARD }]);
    fixture.files.set('/sys/class/drm/card0/device/gpu_busy_percent', '250');
    const gpu = await collectGpuValues({
      listDirectory: async (path) => fixture.dirs.get(path),
      readFile: async (path) => fixture.files.get(path),
    });
    expect(gpu.available).toBe(true);
    if (gpu.available) {
      expect(gpu.values.utilizationPercent).toBeUndefined();
      expect(gpu.missing).toContain('utilization');
    }
  });

  it('reports "not available" when a xe card exposes no readable value', async () => {
    const fixture = buildGpuFixture([{ name: 'card0', driver: 'xe', withoutHwmon: true }]);
    const gpu = await collectGpuValues({
      listDirectory: async (path) => fixture.dirs.get(path),
      readFile: async (path) => fixture.files.get(path),
    });
    expect(gpu.available).toBe(false);
    if (!gpu.available) expect(gpu.reason).toContain('keine einheitenklaren Werte');
  });

  it('never rejects when /sys/class/drm is unreadable', async () => {
    const gpu = await collectGpuValues({
      listDirectory: async () => undefined,
      readFile: async () => undefined,
    });
    expect(gpu.available).toBe(false);
    if (!gpu.available) expect(gpu.reason.length).toBeGreaterThan(0);
  });

  it('isolates a non-abort GPU value read failure from the system collector', async () => {
    const sources = createFakeSystemSources(buildGpuFixture([FULL_CARD]));
    const gpu = await collectGpuValues({
      listDirectory: sources.gpuIo.listDirectory,
      readFile: async (path, signal) => {
        if (path.endsWith('/temp2_input')) throw new Error('fixture read failure');
        return sources.gpuIo.readFile(path, signal);
      },
    });
    expect(gpu).toEqual({
      available: false,
      reason: expect.stringContaining('GPU-Werteschnittstelle nicht lesbar'),
    });
  });

  it('propagates an aborted signal so the collector can classify timeout/stop', async () => {
    const controller = new AbortController();
    const sources = createFakeSystemSources(buildGpuFixture([FULL_CARD]));
    const promise = collectGpuValues(sources.gpuIo, controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});
