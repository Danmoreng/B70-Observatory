import { readdir, readFile } from 'node:fs/promises';
import type { GpuAvailability } from '@observatory/contracts';

/**
 * Read-only probe for a usable Intel GPU interface on this machine.
 *
 * Design decision (M4A): a GPU value is only reported when the local
 * interface provides it *reliably and with unambiguous units*. The probe
 * therefore requires the complete set
 *
 * - `gpu_busy_percent`  – GPU utilization, percent (0–100)
 * - `power1_input`      – power draw, microwatts (Linux hwmon ABI)
 * - `temp*_input`       – temperature, millidegrees Celsius (hwmon convention)
 * - `mem_info_vram_used`– VRAM in use, bytes
 *
 * on a card driven by the Intel `xe` driver, and inspects nothing else. It
 * never opens a DRM device, never talks to the GPU and never blocks: any
 * read failure simply yields `{ available: false, reason }`.
 */

const DRM_BASE = '/sys/class/drm';

export type GpuAttributePath = 'utilization' | 'power' | 'temperature' | 'vram';

const REQUIRED_ATTRIBUTES: Record<GpuAttributePath, string> = {
  utilization: 'gpu_busy_percent',
  power: 'power1_input',
  temperature: 'temp1_input',
  vram: 'mem_info_vram_used',
};

/**
 * Filesystem abstraction so tests run without touching the real sysfs.
 * The optional `AbortSignal` lets the collector bound every read and cancel
 * an in-flight collection on `stop()` (M4A review correction, extended in M4B).
 */
export interface GpuProbeIo {
  /** Directory entries of `dir` (or `undefined` if the directory is absent/unreadable). */
  listDirectory(path: string, signal?: AbortSignal): Promise<string[] | undefined>;
  /** File content (or `undefined` if the file is absent/unreadable). */
  readFile(path: string, signal?: AbortSignal): Promise<string | undefined>;
}

const defaultIo: GpuProbeIo = {
  async listDirectory(path: string, signal?: AbortSignal) {
    // `readdir` does not accept an AbortSignal in this Node typings set; the
    // signal is honored as a pre/post check (fast local syscall only).
    if (signal?.aborted) return undefined;
    try {
      const entries = await readdir(path);
      if (signal?.aborted) return undefined;
      return entries;
    } catch {
      return undefined;
    }
  },
  async readFile(path: string, signal?: AbortSignal) {
    try {
      return await readFile(path, { encoding: 'utf8', signal });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      return undefined;
    }
  },
};

/** Default probe IO over the real sysfs (read-only). */
export const gpuProbeIo: GpuProbeIo = defaultIo;

export interface IntelCard {
  cardName: string;
  deviceDir: string;
  hwmonDir: string | undefined;
}

/**
 * Discover all DRM cards driven by the Intel `xe` driver (read-only).
 * Shared with the M4B live GPU adapter, which reads per-scan values from the
 * same well-known locations.
 */
export async function findIntelXeCards(io: GpuProbeIo, signal?: AbortSignal): Promise<IntelCard[]> {
  const entries = await io.listDirectory(DRM_BASE, signal);
  if (entries === undefined) {
    throw new Error(`${DRM_BASE} is not readable`);
  }
  const cards: IntelCard[] = [];
  for (const cardName of entries) {
    if (!/^card\d+$/.test(cardName)) continue;
    const base = `${DRM_BASE}/${cardName}/device`;
    const uevent = await io.readFile(`${base}/uevent`, signal);
    if (uevent === undefined || !/^(DRIVER=xe)\r?\n/m.test(uevent)) continue;
    const hwmons = (await io.listDirectory(`${base}/hwmon`, signal)) ?? [];
    const hwmonDir = hwmons
      .filter((entry) => /^hwmon\d+$/.test(entry))
      .map((entry) => `${base}/hwmon/${entry}`)
      .sort()[0];
    cards.push({ cardName, deviceDir: base, hwmonDir });
  }
  return cards;
}

function missingAttributes(attributes: Record<GpuAttributePath, boolean>): string[] {
  const labels: Record<GpuAttributePath, string> = {
    utilization: 'Auslastung (gpu_busy_percent)',
    power: 'Leistungsaufnahme (power1_input)',
    temperature: 'Temperatur (temp*_input)',
    vram: 'VRAM-Nutzung (mem_info_vram_used)',
  };
  return (Object.keys(attributes) as GpuAttributePath[])
    .filter((key) => !attributes[key])
    .map((key) => labels[key]);
}

/**
 * Probe once (read-only). Never rejects: any problem is reported as an
 * honest `available: false` with a concrete, bounded reason.
 */
export async function probeIntelGpu(io: GpuProbeIo = defaultIo): Promise<GpuAvailability> {
  const unavailable = (reason: string): GpuAvailability => ({
    available: false,
    reason: reason.length > 256 ? `${reason.slice(0, 253)}…` : reason,
  });

  try {
    const cards = await findIntelXeCards(io);
    if (cards.length === 0) {
      return unavailable(
        'Kein Intel-GPU unter /sys/class/drm gefunden (kein Treiber „xe“) – GPU-Werte bleiben ausgeblendet'
      );
    }
    for (const card of cards) {
      if (card.hwmonDir === undefined) continue;
      const name = card.hwmonDir.split('/').at(-1) as string;
      const label = await io.readFile(`${card.hwmonDir}/name`);
      if (label !== undefined && !/^xe\r?$/.test(label.trim())) continue;
      const attributes = {} as Record<GpuAttributePath, boolean>;
      for (const key of Object.keys(REQUIRED_ATTRIBUTES) as GpuAttributePath[]) {
        const attribute = REQUIRED_ATTRIBUTES[key];
        const content = await io.readFile(`${card.hwmonDir}/${attribute}`);
        attributes[key] =
          content !== undefined &&
          content.trim().length > 0 &&
          /^-?\d+(\.\d+)?$/.test(content.trim());
      }
      const missing = missingAttributes(attributes);
      if (missing.length === 0) {
        return { available: true };
      }
      return unavailable(
        `Intel-GPU ${card.cardName} (${name}) liefert über sysfs/hwmon keine vollständigen, einheitenklaren Werte – fehlen: ${missing.join(', ')}`
      );
    }
    return unavailable(
      'Intel-GPU (Treiber „xe“) gefunden, aber ohne hwmon-Schnittstelle – GPU-Werte bleiben ausgeblendet'
    );
  } catch (error) {
    return unavailable(
      `GPU-Probe fehlgeschlagen (${(error as Error).message}) – GPU-Werte bleiben ausgeblendet`
    );
  }
}
