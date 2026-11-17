import type { GpuMissingField, GpuSection, GpuValues } from '@observatory/contracts';
import { findIntelXeCards, type GpuProbeIo } from './gpu-probe.js';

/**
 * Live Intel-GPU values from the well-known, read-only Linux interfaces
 * (M4B). This is the "adapter strategy" the milestone allows: one small,
 * injectable source implementation over sysfs, structured so that future
 * sources (e.g. a vendor CLI) can be added without touching the collector.
 *
 * Where each value lives and in which unit (documented Linux conventions):
 *
 * | field          | location                                  | sysfs unit         |
 * | -------------- | ----------------------------------------- | ------------------ |
 * | `gpu_busy_percent` | `/sys/class/drm/cardN/device/` (DRM) | percent (0–100)  |
 * | `mem_info_vram_used` / `_total` | same DRM device dir      | bytes              |
 * | `power1_input` | `/sys/class/drm/cardN/device/hwmon/hwmonN/` | microwatts   |
 * | `temp*_input`  | same hwmon directory                       | millidegrees °C  |
 * | `freq*_input`  | same hwmon directory (when present)        | hertz            |
 *
 * Honesty rule: a field is only reported when the interface actually
 * exposes it with a finite, in-range value. Anything else stays absent and
 * surfaces in `missing`, so the dashboard can render an explicit
 * "nicht verfügbar" instead of a fabricated zero. No DRM device is opened,
 * no ioctl is issued and no child process is spawned.
 */

/** Ordered fields, used both for `missing` and for the UI hint text. */
export const GPU_VALUE_FIELDS = ['utilization', 'vram', 'temperature', 'power', 'clock'] as const;
export type GpuValueField = (typeof GPU_VALUE_FIELDS)[number];

const INTEGER = /^\d+$/;

const readValue = async (
  io: GpuProbeIo,
  path: string,
  signal?: AbortSignal
): Promise<number | undefined> => {
  const content = await io.readFile(path, signal);
  if (content === undefined) return undefined;
  const trimmed = content.trim();
  if (!INTEGER.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
};

const round = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const truncate = (value: string): string =>
  value.length <= 256 ? value : `${value.slice(0, 253)}…`;

/**
 * Collect the currently available values from the first readable `xe` card.
 * Never rejects: every failure is reported as an honest `available: false`
 * with a bounded, secret-free reason (M4A rule, now per-field granularity).
 */
export async function collectGpuValues(io: GpuProbeIo, signal?: AbortSignal): Promise<GpuSection> {
  const unavailable = (reason: string): GpuSection => ({
    available: false,
    reason: truncate(reason),
  });

  let cards;
  try {
    cards = await findIntelXeCards(io, signal);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return unavailable(
      `GPU-Schnittstelle nicht lesbar (${(error as Error).message}) – GPU-Werte bleiben ausgeblendet`
    );
  }
  if (cards.length === 0) {
    return unavailable(
      'Kein Intel-GPU (Treiber „xe“) unter /sys/class/drm gefunden – GPU-Werte bleiben ausgeblendet'
    );
  }

  try {
    for (const card of cards) {
      const values: GpuValues = {};
      const missing: GpuMissingField[] = [...GPU_VALUE_FIELDS];
      const markPresent = (field: GpuValueField): void => {
        const index = missing.indexOf(field);
        if (index >= 0) missing.splice(index, 1);
      };

      // Temperature: max over all hwmon `temp*_input` sensors (millidegrees C).
      if (card.hwmonDir !== undefined) {
        const entries = (await io.listDirectory(card.hwmonDir, signal)) ?? [];
        const sensorPaths = entries
          .filter((entry) => /^temp\d+_input$/.test(entry))
          .map((entry) => `${card.hwmonDir}/${entry}`);
        const readings = (
          await Promise.all(sensorPaths.map((path) => readValue(io, path, signal)))
        ).filter((value): value is number => value !== undefined);
        if (readings.length > 0) {
          values.temperatureC = round(Math.max(...readings) / 1000, 1);
          markPresent('temperature');
        }

        // Linux hwmon ABI: `power*_input` is expressed in microwatts.
        const powerMicrowatts = await readValue(io, `${card.hwmonDir}/power1_input`, signal);
        if (powerMicrowatts !== undefined) {
          values.powerWatts = round(powerMicrowatts / 1_000_000, 2);
          markPresent('power');
        }

        // Linux hwmon ABI: `freq*_input` is expressed in hertz.
        const freqPaths = entries
          .filter((entry) => /^freq\d+_input$/.test(entry))
          .map((entry) => `${card.hwmonDir}/${entry}`);
        const freqs = (
          await Promise.all(freqPaths.map((path) => readValue(io, path, signal)))
        ).filter((value): value is number => value !== undefined);
        if (freqs.length > 0) {
          values.clockMhz = Math.max(...freqs) / 1_000_000;
          markPresent('clock');
        }
      }

      // Utilization & VRAM live on the DRM device node (newer xe kernels),
      // with hwmon as fallback for kernels that expose them there.
      const utilization =
        (await readValue(io, `${card.deviceDir}/gpu_busy_percent`, signal)) ??
        (card.hwmonDir !== undefined
          ? await readValue(io, `${card.hwmonDir}/gpu_busy_percent`, signal)
          : undefined);
      if (utilization !== undefined && utilization <= 100) {
        values.utilizationPercent = utilization;
        markPresent('utilization');
      }
      const vramUsed =
        (await readValue(io, `${card.deviceDir}/mem_info_vram_used`, signal)) ??
        (card.hwmonDir !== undefined
          ? await readValue(io, `${card.hwmonDir}/mem_info_vram_used`, signal)
          : undefined);
      if (vramUsed !== undefined) values.vramUsedBytes = vramUsed;
      const vramTotal =
        (await readValue(io, `${card.deviceDir}/mem_info_vram_total`, signal)) ??
        (card.hwmonDir !== undefined
          ? await readValue(io, `${card.hwmonDir}/mem_info_vram_total`, signal)
          : undefined);
      if (vramTotal !== undefined) values.vramTotalBytes = vramTotal;
      if (vramUsed !== undefined && vramTotal !== undefined) markPresent('vram');

      const hwmonName = card.hwmonDir !== undefined ? ` (${card.hwmonDir.split('/').at(-1)})` : '';
      if (Object.keys(values).length === 0) {
        return unavailable(
          `Intel-GPU ${card.cardName}${hwmonName} liefert über die bekannten sysfs-Pfade keine einheitenklaren Werte (gpu_busy_percent, mem_info_vram_*, power1_input, temp*_input fehlen)`
        );
      }
      return {
        available: true,
        card: card.cardName,
        values,
        ...(missing.length > 0 ? { missing } : {}),
      };
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return unavailable(
      `GPU-Werteschnittstelle nicht lesbar (${(error as Error).message}) – GPU-Werte bleiben ausgeblendet`
    );
  }

  return unavailable(
    'Intel-GPU (Treiber „xe“) gefunden, aber ohne lesbare Werteschnittstelle – GPU-Werte bleiben ausgeblendet'
  );
}
