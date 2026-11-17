import type { GpuProbeIo } from '../../src/telemetry/gpu-probe.js';
import type { StatFsView, SystemIo } from '../../src/telemetry/system-io.js';

/**
 * Deterministic fake of the read-only system sources (`/proc`, statfs,
 * GPU sysfs). Files live in a map; directories are explicit entries so
 * tests can simulate "missing file", "unreadable directory" and "later
 * appearing interface" scenarios without touching the real sysfs.
 */

export interface GpuFixtureCard {
  /** DRM card name, e.g. `card0`. */
  name: string;
  /** Driver for the uevent file: `xe` or e.g. `amdgpu` (ignored cards). */
  driver: string;
  /** hwmon temperature sensors in millidegrees Celsius. */
  temperaturesMdegC?: number[];
  /** hwmon `power1_input` in microwatts (absent when `undefined`). */
  powerMicrowatts?: number;
  /** DRM `gpu_busy_percent` (absent when `undefined`). */
  gpuBusyPercent?: number;
  /** DRM `mem_info_vram_used` in bytes. */
  vramUsedBytes?: number;
  /** DRM `mem_info_vram_total` in bytes. */
  vramTotalBytes?: number;
  /** hwmon `freq*_input` in hertz. */
  freqHz?: number;
  /** Render a file with this (non-numeric) content instead of a number. */
  corruptedFile?: { path: 'gpu_busy_percent' | 'temp2_input' | 'power1_input'; content: string };
  /** No hwmon directory at all under device/. */
  withoutHwmon?: boolean;
}

export interface GpuFixture {
  files: Map<string, string>;
  dirs: Map<string, string[]>;
}

/** Build the file/directory maps for the given DRM cards. */
export function buildGpuFixture(cards: GpuFixtureCard[]): GpuFixture {
  const files = new Map<string, string>();
  const dirs = new Map<string, string[]>();

  const addDir = (dir: string, entry: string): void => {
    const entries = dirs.get(dir) ?? [];
    if (!entries.includes(entry)) entries.push(entry);
    dirs.set(dir, entries.sort());
  };

  const setFile = (dir: string, fileName: string, content: string): void => {
    addDir(dir, fileName);
    files.set(`${dir}/${fileName}`, content);
  };

  for (const card of cards) {
    const cardDir = `/sys/class/drm/${card.name}`;
    addDir('/sys/class/drm', card.name);
    const deviceDir = `${cardDir}/device`;
    addDir(cardDir, 'device');
    setFile(deviceDir, 'uevent', `DRIVER=${card.driver}\nPCI_ID=8086:E223\n`);

    if (card.withoutHwmon) continue;
    const hwmonDir = `${deviceDir}/hwmon/hwmon2`;
    addDir(deviceDir, 'hwmon');
    addDir(`${deviceDir}/hwmon`, 'hwmon2');
    setFile(hwmonDir, 'name', 'xe');

    const temperatures = card.temperaturesMdegC ?? [69_000, 74_000];
    temperatures.forEach((value, index) => {
      const sensor = `temp${index + 2}_input`;
      if (card.corruptedFile?.path === 'temp2_input' && index === 0) {
        setFile(hwmonDir, sensor, card.corruptedFile.content);
      } else {
        setFile(hwmonDir, sensor, String(value));
      }
      setFile(hwmonDir, `temp${index + 2}_label`, 'pkg');
    });

    if (card.powerMicrowatts !== undefined) {
      const content =
        card.corruptedFile?.path === 'power1_input'
          ? card.corruptedFile.content
          : String(card.powerMicrowatts);
      setFile(hwmonDir, 'power1_input', content);
      setFile(hwmonDir, 'power1_label', 'card');
    }
    if (card.freqHz !== undefined) {
      setFile(hwmonDir, 'freq1_input', String(card.freqHz));
      setFile(hwmonDir, 'freq1_label', 'gt0');
    }
    // Cumulative energy counter: present on this machine, deliberately NOT
    // part of the value contract (no instantaneous unit).
    setFile(hwmonDir, 'energy1_input', '333309436706');
    setFile(hwmonDir, 'energy1_label', 'card');

    if (card.gpuBusyPercent !== undefined) {
      const content =
        card.corruptedFile?.path === 'gpu_busy_percent'
          ? card.corruptedFile.content
          : String(card.gpuBusyPercent);
      setFile(deviceDir, 'gpu_busy_percent', content);
    }
    if (card.vramUsedBytes !== undefined) {
      setFile(deviceDir, 'mem_info_vram_used', String(card.vramUsedBytes));
    }
    if (card.vramTotalBytes !== undefined) {
      setFile(deviceDir, 'mem_info_vram_total', String(card.vramTotalBytes));
    }
  }

  return { files, dirs };
}

export interface FakeSystemSources {
  systemIo: SystemIo;
  gpuIo: GpuProbeIo;
  /** Mutate/inspect the fake sources between collections. */
  files: Map<string, string>;
  dirs: Map<string, string[]>;
  setProc(
    path: '/proc/stat' | '/proc/loadavg' | '/proc/meminfo',
    content: string | undefined
  ): void;
  setStatFs(view: StatFsView | undefined): void;
  /** Make the next (or ongoing) reads hang until the signal aborts. */
  hangUntilAbort(): void;
  unhang(): void;
}

/** Create one fake IO pair backed by explicit file/directory maps. */
export function createFakeSystemSources(fixture: GpuFixture): FakeSystemSources {
  const files = fixture.files;
  const dirs = fixture.dirs;
  let statFsView: StatFsView | undefined = {
    bsize: 4096,
    blocks: 1_000_000,
    bfree: 400_000,
    bavail: 390_000,
  };
  let hanging = false;

  const waitAbort = (signal: AbortSignal | undefined): Promise<void> =>
    new Promise((resolve) => {
      if (!hanging || signal === undefined) {
        resolve();
        return;
      }
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener('abort', () => resolve(), { once: true });
    });

  const abort = (): never => {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
  };

  return {
    files,
    dirs,
    setProc: (path, content) => {
      if (content === undefined) files.delete(path);
      else files.set(path, content);
    },
    setStatFs: (view) => {
      statFsView = view;
    },
    hangUntilAbort: () => {
      hanging = true;
    },
    unhang: () => {
      hanging = false;
    },
    systemIo: {
      async readText(path: string, signal?: AbortSignal) {
        await waitAbort(signal);
        if (signal?.aborted) abort();
        return files.get(path);
      },
      async statFs(_path: string, signal?: AbortSignal) {
        await waitAbort(signal);
        if (signal?.aborted) abort();
        return statFsView;
      },
    },
    gpuIo: {
      async listDirectory(path: string, signal?: AbortSignal) {
        await waitAbort(signal);
        if (signal?.aborted) abort();
        return dirs.get(path);
      },
      async readFile(path: string, signal?: AbortSignal) {
        await waitAbort(signal);
        if (signal?.aborted) abort();
        return files.get(path);
      },
    },
  };
}

/** A realistic `/proc/stat` aggregate line. */
export function cpuStatLine(
  user: number,
  nice: number,
  system: number,
  idle: number,
  iowait = 0,
  irq = 0,
  softirq = 0,
  steal = 0
): string {
  const parts = [user, nice, system, idle, iowait, irq, softirq, steal].map(String);
  return `cpu  ${parts.join(' ')} 0 0\n`;
}

export function meminfoLines(totalKb: number, availableKb: number, freeKb?: number): string {
  const lines = [
    `MemTotal:       ${totalKb} kB`,
    `MemFree:        ${freeKb ?? availableKb - 1_000} kB`,
    `MemAvailable:   ${availableKb} kB`,
    `Buffers:        5000 kB`,
    `Cached:         10000 kB`,
    `SwapTotal:      0 kB`,
  ];
  return `${lines.join('\n')}\n`;
}

export function loadavgLine(
  load1: number,
  load5: number,
  load15: number,
  running: number,
  total: number
): string {
  return `${load1} ${load5} ${load15} ${running}/${total} 12345\n`;
}
