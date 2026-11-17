import { readFile, statfs } from 'node:fs/promises';

/**
 * Read-only access to the local system sources (`/proc`, statfs).
 *
 * Every accessor is injectable (tests run against deterministic fixtures)
 * and accepts an `AbortSignal` so the collector can bound each collection
 * with a timeout and cancel in-flight reads on `stop()`. All accessors are
 * read-only and never throw: a missing or unreadable source simply yields
 * `undefined`, which the collector turns into an honest "absent" state.
 */

/** `node:fs` `statfs` fields normalized to plain non-negative numbers. */
export interface StatFsView {
  /** Size of one filesystem block in bytes. */
  bsize: number;
  /** Total data blocks in the filesystem. */
  blocks: number;
  /** Free blocks (incl. the reserved root reservation). */
  bfree: number;
  /** Free blocks available to unprivileged users. */
  bavail: number;
}

export interface SystemIo {
  /** File content, or `undefined` if absent/unreadable (or aborted). */
  readText(path: string, signal?: AbortSignal): Promise<string | undefined>;
  /** statfs view of the filesystem containing `path`, or `undefined`. */
  statFs(path: string, signal?: AbortSignal): Promise<StatFsView | undefined>;
}

/** Default IO over the real `/proc` and `node:fs statfs` (read-only). */
export const defaultSystemIo: SystemIo = {
  async readText(path: string, signal?: AbortSignal) {
    try {
      return await readFile(path, { encoding: 'utf8', signal });
    } catch (error) {
      // An explicit abort (collector timeout/stop) is re-thrown so the
      // collector can classify it as a timeout, like the vLLM collector
      // does for aborted fetches (M4A review rule).
      if (error instanceof Error && error.name === 'AbortError') throw error;
      return undefined;
    }
  },
  async statFs(path: string, signal?: AbortSignal) {
    if (signal?.aborted) {
      const abort = new Error('The operation was aborted');
      abort.name = 'AbortError';
      throw abort;
    }
    try {
      const stats = await statfs(path);
      if (signal?.aborted) {
        const abort = new Error('The operation was aborted');
        abort.name = 'AbortError';
        throw abort;
      }
      return {
        bsize: Number(stats.bsize),
        blocks: Number(stats.blocks),
        bfree: Number(stats.bfree),
        bavail: Number(stats.bavail),
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      return undefined;
    }
  },
};

const INTEGER = /^\d+$/;
/** Load averages are small decimals, e.g. `0.90`. */
const DECIMAL = /^\d+(\.\d+)?$/;

/** Jiffies totals from the aggregate `cpu` line of `/proc/stat`. */
export interface CpuJiffies {
  /** Sum of user..steal jiffies (guest time already counted in `user`). */
  total: number;
  /** `idle + iowait` jiffies. */
  idle: number;
}

/**
 * Parse the first (aggregate) line of `/proc/stat`.
 * Returns `undefined` for anything that is not a well-formed `cpu` line so
 * a truncated or foreign file can never produce a bogus counter.
 */
export function parseCpuStatLine(line: string): CpuJiffies | undefined {
  const fields = line.trim().split(/\s+/);
  if (fields.length < 5 || fields[0] !== 'cpu') return undefined;
  // user nice system idle iowait irq softirq steal (guest* excluded:
  // already included in `user`, counting them twice would distort the rate).
  const values = fields.slice(1, 9);
  let total = 0;
  for (const raw of values) {
    if (!INTEGER.test(raw)) return undefined;
    total += Number(raw);
  }
  const idle = Number(values[3] ?? 0) + Number(values[4] ?? 0);
  if (total <= 0) return undefined;
  return { total, idle };
}

/**
 * CPU utilization in percent (0–100) from two jiffies samples.
 * `undefined` whenever a rate would be misleading:
 * - first sighting (no previous sample) – `reset: false`, the caller
 *   keeps its (new) baseline;
 * - no jiffies progress at all (quiescent machine) – `reset: false`, so a
 *   steady system stays semantically silent and the next real delta is
 *   measured against the unchanged baseline;
 * - a counter going *backwards* (reboot/re-base) – `reset: true`, the
 *   caller re-baselines and no (negative/fake) rate is reported.
 */
export function cpuDeltaUtilization(
  previous: CpuJiffies | undefined,
  current: CpuJiffies
): { utilizationPercent: number | undefined; reset: boolean } {
  if (previous === undefined) {
    return { utilizationPercent: undefined, reset: false };
  }
  if (current.idle > current.total) {
    return { utilizationPercent: undefined, reset: true };
  }
  if (current.total < previous.total) {
    // Counter went backwards (reboot): re-base, report no rate for the gap.
    return { utilizationPercent: undefined, reset: true };
  }
  if (current.total === previous.total) {
    // No progress: keep the existing baseline, report nothing this tick.
    return { utilizationPercent: undefined, reset: false };
  }
  const deltaTotal = current.total - previous.total;
  const deltaIdle = current.idle - previous.idle;
  if (deltaIdle < 0 || deltaIdle > deltaTotal) {
    return { utilizationPercent: undefined, reset: true };
  }
  const utilizationPercent = Math.round(((deltaTotal - deltaIdle) / deltaTotal) * 1000) / 10;
  if (!Number.isFinite(utilizationPercent) || utilizationPercent < 0 || utilizationPercent > 100) {
    return { utilizationPercent: undefined, reset: true };
  }
  return { utilizationPercent, reset: false };
}

/** Fields of `/proc/meminfo` in kB (all optional, all validated). */
export interface MeminfoKb {
  total?: number;
  available?: number;
  free?: number;
  buffers?: number;
  cached?: number;
}

/** Parse the needed `Name: <value> kB` lines; skips anything malformed. */
export function parseMeminfo(text: string): MeminfoKb {
  const result: MeminfoKb = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9]*):\s+(\S+)\s*kB$/.exec(line);
    if (match === null) continue;
    const key = match[1];
    const raw = match[2];
    if (key === undefined || raw === undefined || !INTEGER.test(raw)) continue;
    const value = Number(raw);
    switch (key) {
      case 'MemTotal':
        result.total = value;
        break;
      case 'MemAvailable':
        result.available = value;
        break;
      case 'MemFree':
        result.free = value;
        break;
      case 'Buffers':
        result.buffers = value;
        break;
      case 'Cached':
        result.cached = value;
        break;
    }
  }
  return result;
}

/** Fields of `/proc/loadavg` (`<l1> <l5> <l15> <running>/<total> ...`). */
export interface LoadavgFields {
  load1?: number;
  load5?: number;
  load15?: number;
  /** Currently runnable processes. */
  running?: number;
  /** Total processes/tasks. */
  total?: number;
}

export function parseLoadavg(text: string): LoadavgFields {
  const fields = text.trim().split(/\s+/);
  const decimal = (raw: string | undefined): number | undefined =>
    raw !== undefined && DECIMAL.test(raw) ? Number(raw) : undefined;
  const integer = (raw: string | undefined): number | undefined =>
    raw !== undefined && INTEGER.test(raw) ? Number(raw) : undefined;
  // Format: `<l1> <l5> <l15> <running>/<total> <pid> ...` – the process
  // counters live in the fourth field (`running/total`).
  const split = fields[3]?.split('/') ?? [];
  return {
    load1: decimal(fields[0]),
    load5: decimal(fields[1]),
    load15: decimal(fields[2]),
    running: integer(split[0]),
    total: split.length === 2 ? integer(split[1]) : undefined,
  };
}

/** `df`-style disk usage derived from a statfs view. */
export interface DiskUsage {
  totalBytes: number;
  /** Capacity minus free blocks (reserved blocks count as used, like `df`). */
  usedBytes: number;
  /** Blocks available to unprivileged users. */
  freeBytes: number;
  usagePercent: number;
}

/**
 * Convert a statfs view to byte counters and a `df`-compatible usage
 * percent. Returns `undefined` for degenerate inputs (zero block size or
 * total) instead of emitting `NaN`/division-by-zero values.
 */
export function diskUsageFromStatfs(view: StatFsView): DiskUsage | undefined {
  const { bsize, blocks, bfree, bavail } = view;
  if (![bsize, blocks, bfree, bavail].every((value) => Number.isFinite(value) && value >= 0)) {
    return undefined;
  }
  if (bsize <= 0 || blocks <= 0) return undefined;
  if (bavail > bfree) return undefined; // inconsistent statfs view
  const totalBytes = bsize * blocks;
  const usedBytes = bsize * (blocks - bfree);
  const freeBytes = bsize * bavail;
  if (usedBytes < 0 || freeBytes < 0 || totalBytes <= 0) return undefined;
  const capacity = usedBytes + freeBytes;
  const usagePercent = capacity > 0 ? (usedBytes / capacity) * 100 : 0;
  if (!Number.isFinite(usagePercent) || usagePercent < 0 || usagePercent > 100) return undefined;
  return {
    totalBytes,
    usedBytes,
    freeBytes,
    usagePercent: Math.round(usagePercent * 10) / 10,
  };
}
