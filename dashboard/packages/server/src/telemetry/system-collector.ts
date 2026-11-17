import { cpus } from 'node:os';
import {
  SERVICE_NAME,
  SystemSnapshotSchema,
  type GpuSection,
  type HealthCheck,
  type SystemCpu,
  type SystemDisk,
  type SystemMemory,
  type SystemProcess,
  type SystemSnapshot,
  type GpuMissingField,
} from '@observatory/contracts';
import type { MetricSample } from '../db/contracts.js';
import { gpuProbeIo as defaultGpuIo, type GpuProbeIo } from './gpu-probe.js';
import { collectGpuValues } from './gpu-sources.js';
import {
  cpuDeltaUtilization,
  diskUsageFromStatfs,
  parseCpuStatLine,
  parseLoadavg,
  parseMeminfo,
  type CpuJiffies,
  type SystemIo,
  defaultSystemIo,
} from './system-io.js';

/**
 * The system/GPU collector (M4B).
 *
 * Mirrors the M4A vLLM collector deliberately:
 * - the *browser* never polls; this collector is the only producer of
 *   `event: system` frames (bounded interval, per-collection timeout);
 * - a snapshot is published only when its *semantic* content changed
 *   (quantized key) – timestamps and jitter alone never create events;
 * - a single failed collection inside the freshness window keeps the last
 *   good snapshot; after the horizon the source flips `ok → stale`; before
 *   the first success it is `error`. Recovery returns it to `ok`, which
 *   `/api/health` and the SSE stream share, so the two
 *   views can never contradict each other (M4A review rule);
 * - every derived payload is runtime-validated against the shared
 *   `SystemSnapshotSchema` before it is published or persisted;
 * - `stop()` aborts the in-flight collection and suppresses its late
 *   publication (M4A review rule).
 */

export type SystemSourceState =
  { status: 'ok' } | { status: 'stale'; message?: string } | { status: 'error'; message?: string };

export class SystemSourceError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SystemSourceError';
  }
}

export interface SystemCollectorOptions {
  /** Filesystem path for the disk figures (statfs). Default `/`. */
  diskPath?: string;
  /** Injectable `/proc`/statfs access (tests). Default: real procfs/statfs. */
  io?: SystemIo;
  /** Injectable sysfs access for the GPU values. Default: real sysfs. */
  gpuIo?: GpuProbeIo;
  /** Optional privileged GPU snapshot source (Unix-socket helper). */
  gpuSource?: (signal: AbortSignal) => Promise<GpuSection>;
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Process start time for the uptime figure. */
  startedAt?: Date;
  /** Injectable RSS source (defaults to `process.memoryUsage()`). */
  memoryUsage?: () => { rss: number };
  /** Logical processor count (defaults to `os.cpus().length`). */
  cpuCoreCount?: number;
  /** Collection interval in ms. Default 5000. */
  intervalMs?: number;
  /** Per-collection budget (ms) applied to every read. Default 2000. */
  timeoutMs?: number;
  /** Last success older than this ⇒ source is `stale`. Default 3 × interval. */
  staleAfterMs?: number;
  /** Minimum distance between two *persisted* sample batches (ms). */
  persistMinIntervalMs?: number;
  /** Persist normalized samples (called with a bounded, validated set). */
  persist?: (samples: MetricSample[]) => void;
  /** Snapshot sink; the application re-points this to the SSE hub. */
  onSnapshot?: (payload: SystemSnapshot) => void;
  /** Fired when the source state machine changes (ok/stale/error). */
  onSourceStateChange?: (state: SystemSourceState) => void;
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void;
}

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 2_000;

/** German labels for the GPU attributes, shared with the health check. */
const MISSING_GPU_LABELS: Record<GpuMissingField, string> = {
  utilization: 'Auslastung',
  vram: 'VRAM',
  temperature: 'Temperatur',
  power: 'Leistungsaufnahme',
  clock: 'Takt',
};

/**
 * Semantic change key for the system snapshot. Deliberately coarser than
 * the raw values: utilization is quantized to 1 %, load averages to 0.1,
 * byte counters to whole MiB and the process count to steps of five, so a
 * busy system does not emit an event per scrape. Any real change (a
 * sustained level shift, a status flip, GPU availability) still does.
 */
export function systemSemanticKey(payload: SystemSnapshot): string {
  const q = (value: number | undefined, digits: number): number | undefined =>
    value === undefined ? undefined : Math.round(value * 10 ** digits) / 10 ** digits;
  const mib = (value: number | undefined): number | undefined =>
    value === undefined ? undefined : Math.round(value / 2 ** 20);
  return JSON.stringify({
    s: payload.sourceStatus,
    m: payload.sourceMessage ?? '',
    cpu:
      payload.cpu === undefined
        ? undefined
        : { u: q(payload.cpu.utilizationPercent, 0), l1: q(payload.cpu.load1, 1) },
    mem:
      payload.memory === undefined
        ? undefined
        : { p: q(payload.memory.usagePercent, 1), u: mib(payload.memory.usedBytes) },
    disk:
      payload.disk === undefined
        ? undefined
        : {
            path: payload.disk.path,
            p: q(payload.disk.usagePercent, 1),
            u: mib(payload.disk.usedBytes),
          },
    proc:
      payload.process === undefined
        ? undefined
        : {
            c:
              payload.process.count === undefined
                ? undefined
                : Math.round(payload.process.count / 5) * 5,
            rss: mib(payload.process.observatoryRssBytes),
          },
    gpu:
      payload.gpu.available === false
        ? { a: false, r: payload.gpu.reason }
        : {
            a: true,
            card: payload.gpu.card,
            v: {
              u:
                payload.gpu.values.utilizationPercent === undefined
                  ? undefined
                  : Math.round(payload.gpu.values.utilizationPercent),
              v: mib(payload.gpu.values.vramUsedBytes),
              t: q(payload.gpu.values.temperatureC, 1),
              p: q(payload.gpu.values.powerWatts, 2),
              f:
                payload.gpu.values.clockMhz === undefined
                  ? undefined
                  : Math.round(payload.gpu.values.clockMhz),
            },
            m: payload.gpu.missing?.join(','),
          },
  });
}

/** Bounded, unit-explicit metric samples persisted for one snapshot. */
export function systemSamplesFromPayload(payload: SystemSnapshot): MetricSample[] {
  const samples: MetricSample[] = [];
  const add = (
    source: 'system' | 'gpu',
    name: string,
    value: number | undefined,
    unit: string
  ): void => {
    if (value !== undefined && Number.isFinite(value) && value >= 0) {
      samples.push({ source, name, value, unit, atUtc: payload.timestamp });
    }
  };
  const cpu = payload.cpu;
  add('system', 'system.cpu_utilization_percent', cpu?.utilizationPercent, 'percent');
  add('system', 'system.cpu_load1', cpu?.load1, 'count');
  add('system', 'system.cpu_load5', cpu?.load5, 'count');
  add('system', 'system.cpu_load15', cpu?.load15, 'count');
  const memory = payload.memory;
  add('system', 'system.memory_total_bytes', memory?.totalBytes, 'bytes');
  add('system', 'system.memory_used_bytes', memory?.usedBytes, 'bytes');
  add('system', 'system.memory_available_bytes', memory?.availableBytes, 'bytes');
  add('system', 'system.memory_usage_percent', memory?.usagePercent, 'percent');
  const disk = payload.disk;
  add('system', 'system.disk_total_bytes', disk?.totalBytes, 'bytes');
  add('system', 'system.disk_used_bytes', disk?.usedBytes, 'bytes');
  add('system', 'system.disk_free_bytes', disk?.freeBytes, 'bytes');
  add('system', 'system.disk_usage_percent', disk?.usagePercent, 'percent');
  add('system', 'system.processes', payload.process?.count, 'count');
  add('system', 'system.processes_running', payload.process?.running, 'count');
  add('system', 'system.observatory_rss_bytes', payload.process?.observatoryRssBytes, 'bytes');
  if (payload.gpu.available) {
    const values = payload.gpu.values;
    add('gpu', 'gpu.utilization_percent', values.utilizationPercent, 'percent');
    add('gpu', 'gpu.vram_used_bytes', values.vramUsedBytes, 'bytes');
    add('gpu', 'gpu.vram_total_bytes', values.vramTotalBytes, 'bytes');
    add('gpu', 'gpu.temperature_c', values.temperatureC, 'celsius');
    add('gpu', 'gpu.power_watts', values.powerWatts, 'watts');
    add('gpu', 'gpu.clock_mhz', values.clockMhz, 'megahertz');
  }
  return samples;
}

interface CpuBaseline extends CpuJiffies {
  atMs: number;
}

export class SystemCollector {
  readonly state: { lastSuccessAtMs?: number; cpu?: CpuBaseline };
  /** Snapshot sink; the application wires this to the SSE hub. */
  onSnapshot: ((payload: SystemSnapshot) => void) | undefined;
  /** Optional test seam (called in addition to `onSnapshot`). */
  onSnapshotObserved?: (payload: SystemSnapshot) => void;

  private readonly io: SystemIo;
  private readonly gpuIo: GpuProbeIo;
  private readonly gpuSource: (signal: AbortSignal) => Promise<GpuSection>;
  private readonly nowImpl: () => Date;
  private readonly diskPath: string;
  private readonly startedAtMs: number;
  private readonly memoryUsageImpl: () => { rss: number };
  private readonly cpuCoreCount: number;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly staleAfterMs: number;
  private readonly persistMinIntervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private activeController: AbortController | undefined;
  private inFlight = false;
  private latest: SystemSnapshot | undefined;
  private lastKey: string | undefined;
  private lastStateKey: string | undefined;
  private lastFailureMessage: string | undefined;
  private lastPersistAtMs = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: SystemCollectorOptions) {
    this.onSnapshot = options.onSnapshot;
    this.io = options.io ?? defaultSystemIo;
    this.gpuIo = options.gpuIo ?? (defaultGpuIo as GpuProbeIo);
    this.gpuSource = options.gpuSource ?? ((signal) => collectGpuValues(this.gpuIo, signal));
    this.nowImpl = options.now ?? (() => new Date());
    this.diskPath = options.diskPath ?? '/';
    this.startedAtMs = (options.startedAt ?? new Date()).getTime();
    this.memoryUsageImpl =
      options.memoryUsage ??
      (() => {
        const usage = process.memoryUsage();
        return { rss: usage.rss };
      });
    this.cpuCoreCount = options.cpuCoreCount ?? cpuCoreCountOfSystem();
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.staleAfterMs = options.staleAfterMs ?? this.intervalMs * 3;
    this.persistMinIntervalMs = options.persistMinIntervalMs ?? 60_000;
    this.state = {};
  }

  /** Start the collection loop (immediate first collection, then interval). */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.collectOnce();
    }, this.intervalMs);
    this.timer.unref();
    void this.collectOnce();
  }

  /** Stop the loop and abort (and suppress) any in-flight collection. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const controller = this.activeController;
    this.activeController = undefined;
    controller?.abort();
  }

  get latestSnapshot(): SystemSnapshot | undefined {
    return this.latest;
  }

  /** Current source state derived from the last success/failure. */
  sourceState(): SystemSourceState {
    const nowMs = this.nowImpl().getTime();
    if (this.state.lastSuccessAtMs === undefined) {
      return {
        status: 'error',
        message: this.lastFailureMessage ?? 'Noch keine erfolgreiche Erfassung des Systemzustands',
      };
    }
    if (nowMs - this.state.lastSuccessAtMs > this.staleAfterMs) {
      return { status: 'stale', message: this.lastFailureMessage };
    }
    return { status: 'ok' };
  }

  /** Health-check entry for `GET /api/health` (worst-case, honest). */
  healthCheck(): HealthCheck {
    const state = this.sourceState();
    if (state.status === 'ok') return { name: 'system', status: 'ok' };
    if (state.status === 'stale') {
      return {
        name: 'system',
        status: 'degraded',
        message: truncate(
          state.message !== undefined
            ? `Systemzustand veraltet: ${state.message}`
            : 'Systemzustand veraltet (letzte Erfassung verpasst)'
        ),
      };
    }
    return {
      name: 'system',
      status: 'error',
      message: truncate(`Systemzustand nicht verfügbar: ${state.message ?? 'unbekannter Fehler'}`),
    };
  }

  /**
   * GPU health check. The GPU figures ride on the system source: if that
   * source is stale/error the GPU view is stale/error too; if it is ok the
   * honest probe result decides (`available: false` ⇒ degraded with the
   * concrete reason, never a fabricated value).
   */
  gpuHealthCheck(): HealthCheck {
    const state = this.sourceState();
    if (state.status === 'error') {
      return {
        name: 'gpu',
        status: 'error',
        message: truncate(
          `GPU-Zustand nicht zuverlässig: ${state.message ?? 'Systemquelle fehlgeschlagen'}`
        ),
      };
    }
    if (state.status === 'stale') {
      return {
        name: 'gpu',
        status: 'degraded',
        message:
          state.message !== undefined
            ? truncate(`GPU-Werte veraltet: ${state.message}`)
            : 'GPU-Werte veraltet (letzte Erfassung verpasst)',
      };
    }
    const gpu = this.latest?.gpu;
    if (gpu === undefined) {
      return {
        name: 'gpu',
        status: 'degraded',
        message: 'GPU-Zustand wurde noch nicht erfasst',
      };
    }
    if (!gpu.available) {
      return { name: 'gpu', status: 'degraded', message: gpu.reason };
    }
    const missing = (gpu.missing ?? []).map((field) => MISSING_GPU_LABELS[field]).join(', ');
    if (missing !== '') {
      return {
        name: 'gpu',
        status: 'degraded',
        message: truncate(`GPU teilsichtbar (nicht verfügbar: ${missing})`),
      };
    }
    return { name: 'gpu', status: 'ok', message: `Schnittstelle ${gpu.card ?? 'xe'} lesbar` };
  }

  /**
   * Perform one collection. Never throws: read failures and contract
   * violations are classified and recorded as source failures.
   */
  async collectOnce(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    const controller = new AbortController();
    this.activeController = controller;
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref();
    try {
      const candidate = await this.gather(controller.signal);
      if (controller.signal.aborted) {
        throw new SystemSourceError('timeout', `timeout nach ${this.timeoutMs} ms`);
      }
      // stop() invalidates the active collection; a signal consumer may
      // have resolved anyway, so re-check before publishing (M4A rule).
      if (this.activeController !== controller) return;
      const validated = SystemSnapshotSchema.safeParse(candidate);
      if (!validated.success) {
        throw new SystemSourceError('invalid', 'Systemwerte außerhalb des Datenvertrags');
      }
      this.state.lastSuccessAtMs = this.nowImpl().getTime();
      this.lastFailureMessage = undefined;
      this.applySnapshot(validated.data, true);
    } catch (error) {
      if (this.activeController !== controller) return;
      const failure =
        error instanceof SystemSourceError
          ? error
          : controller.signal.aborted
            ? new SystemSourceError('timeout', `timeout nach ${this.timeoutMs} ms`)
            : new SystemSourceError('unreachable', 'Systemquellen nicht erreichbar');
      this.lastFailureMessage =
        failure.code === 'unreachable'
          ? 'Systemquellen nicht erreichbar (interne Fehlerquelle)'
          : failure.message;
      this.options.log?.('warn', 'system telemetry source unavailable', {
        code: failure.code,
      });
      // A failed collection still publishes: the payload keeps the last
      // values but the status flips (error before any success, stale
      // afterwards). A single missed collection inside the freshness
      // window must not contradict the still-fresh last-known-good
      // snapshot in either the SSE stream or /api/health (M4A rule).
      const base = this.latest;
      const sourceState = this.sourceState();
      if (base !== undefined && sourceState.status === 'ok') return;
      const payload: SystemSnapshot =
        base === undefined
          ? {
              service: SERVICE_NAME,
              sourceStatus: 'error',
              sourceMessage: truncate(failure.message),
              timestamp: this.nowImpl().toISOString(),
              gpu: await this.gpuSectionSafe(controller.signal),
            }
          : {
              ...base,
              sourceStatus: sourceState.status,
              sourceMessage: truncate(failure.message),
            };
      this.applySnapshot(payload);
    } finally {
      clearTimeout(timeout);
      if (this.activeController === controller) this.activeController = undefined;
      this.inFlight = false;
    }
  }

  /**
   * Assemble one ok-snapshot from the read-only sources. Throws
   * `SystemSourceError` when no externally sourced section (cpu, memory,
   * disk) could be read at all – an empty snapshot would be a lie.
   */
  private async gather(signal: AbortSignal): Promise<SystemSnapshot> {
    const nowMs = this.nowImpl().getTime();
    const loadavgText = await this.io.readText('/proc/loadavg', signal);
    const loadavg = loadavgText === undefined ? {} : parseLoadavg(loadavgText);

    // CPU: jiffies deltas for the utilization rate (first measurement is
    // honestly `undefined`), load averages available from the first read.
    let cpu: SystemCpu | undefined;
    const statText = await this.io.readText('/proc/stat', signal);
    if (statText !== undefined) {
      const jiffies = parseCpuStatLine(statText.split('\n', 1)[0] ?? '');
      if (jiffies !== undefined) {
        const baseline = this.state.cpu;
        const delta = cpuDeltaUtilization(baseline, jiffies);
        const utilizationPercent =
          delta.utilizationPercent ??
          (!delta.reset && baseline !== undefined && baseline.total === jiffies.total
            ? this.latest?.cpu?.utilizationPercent
            : undefined);
        // Advance the baseline only on real progress (or a re-baseline);
        // a quiescent machine keeps the old window, so the next delta is
        // measured across the whole quiet stretch – no churn, no reset.
        if (delta.reset || baseline === undefined || delta.utilizationPercent !== undefined) {
          this.state.cpu = { ...jiffies, atMs: nowMs };
        }
        cpu = {
          coreCount: this.cpuCoreCount,
          ...(utilizationPercent !== undefined ? { utilizationPercent } : {}),
          ...(loadavg.load1 !== undefined ? { load1: loadavg.load1 } : {}),
          ...(loadavg.load5 !== undefined ? { load5: loadavg.load5 } : {}),
          ...(loadavg.load15 !== undefined ? { load15: loadavg.load15 } : {}),
        };
      }
    }

    // RAM: `/proc/meminfo` (kB → bytes). `used` follows the `free(1)`
    // convention: total minus available.
    let memory: SystemMemory | undefined;
    const meminfoText = await this.io.readText('/proc/meminfo', signal);
    if (meminfoText !== undefined) {
      const mem = parseMeminfo(meminfoText);
      if (mem.total !== undefined && mem.total > 0) {
        const totalBytes = mem.total * 1024;
        const availableKb =
          mem.available ??
          (mem.free !== undefined && mem.buffers !== undefined && mem.cached !== undefined
            ? mem.free + mem.buffers + mem.cached
            : mem.free);
        const availableBytes = availableKb !== undefined ? availableKb * 1024 : undefined;
        const usedBytes = availableBytes !== undefined ? totalBytes - availableBytes : undefined;
        memory = {
          totalBytes,
          ...(usedBytes !== undefined ? { usedBytes } : {}),
          ...(availableBytes !== undefined ? { availableBytes } : {}),
          ...(usedBytes !== undefined && totalBytes > 0
            ? { usagePercent: Math.round((usedBytes / totalBytes) * 1000) / 10 }
            : {}),
        };
      }
    }

    // Disk: statfs on the configured path (`df` semantics).
    let disk: SystemDisk | undefined;
    const view = await this.io.statFs(this.diskPath, signal);
    if (view !== undefined) {
      const usage = diskUsageFromStatfs(view);
      if (usage !== undefined) {
        disk = { path: this.diskPath, ...usage };
      }
    }

    // Process/service state: kernel process counters plus the observatory
    // process itself (RSS, uptime) – no child process is ever started.
    const processSection: SystemProcess = {
      ...(loadavg.total !== undefined ? { count: loadavg.total } : {}),
      ...(loadavg.running !== undefined ? { running: loadavg.running } : {}),
      observatoryRssBytes: this.memoryUsageImpl().rss,
      uptimeSeconds: Math.max(0, Math.floor((nowMs - this.startedAtMs) / 1000)),
    };

    // GPU: per-scan values from the xe interfaces (honest partiality).
    const gpu = await this.gpuSource(signal);

    if (cpu === undefined && memory === undefined && disk === undefined) {
      throw new SystemSourceError(
        'unavailable',
        'Systemquellen nicht lesbar (/proc/stat, /proc/meminfo, statfs)'
      );
    }

    return {
      service: SERVICE_NAME,
      sourceStatus: 'ok',
      timestamp: new Date(nowMs).toISOString(),
      ...(cpu !== undefined ? { cpu } : {}),
      ...(memory !== undefined ? { memory } : {}),
      ...(disk !== undefined ? { disk } : {}),
      ...(cpu !== undefined || memory !== undefined || disk !== undefined
        ? { process: processSection }
        : {}),
      gpu,
    };
  }

  /** GPU section for an error payload without ever throwing. */
  private async gpuSectionSafe(signal: AbortSignal): Promise<GpuSection> {
    try {
      return await this.gpuSource(signal);
    } catch {
      return {
        available: false,
        reason: 'GPU-Zustand konnte im Fehlerfall nicht ermittelt werden',
      };
    }
  }

  /** Deduplicate live events; persist fresh observations on their own cadence. */
  private applySnapshot(payload: SystemSnapshot, fresh = false): void {
    const previousState = this.lastStateKey;
    const nextState = JSON.stringify(this.sourceState());
    this.lastStateKey = nextState;
    if (previousState !== nextState) {
      this.options.onSourceStateChange?.(this.sourceState());
    }

    const key = systemSemanticKey(payload);
    const changed = this.latest === undefined || key !== this.lastKey;
    this.latest = payload;
    this.lastKey = key;

    if (changed) {
      this.onSnapshot?.(payload);
      this.onSnapshotObserved?.(payload);
    }

    if (fresh && this.options.persist !== undefined) {
      const nowMs = this.nowImpl().getTime();
      if (nowMs - this.lastPersistAtMs >= this.persistMinIntervalMs) {
        const samples = systemSamplesFromPayload(payload);
        if (samples.length > 0) {
          this.lastPersistAtMs = nowMs;
          try {
            this.options.persist(samples);
          } catch (error) {
            // Persistence is best effort: a healthy telemetry path must not
            // be broken by a database problem (project brief §4).
            this.options.log?.('warn', 'persisting system samples failed', {
              detail: (error as Error).message,
              count: samples.length,
            });
          }
        }
      }
    }
  }
}

function cpuCoreCountOfSystem(): number {
  try {
    return Math.max(1, cpus().length);
  } catch {
    return 1;
  }
}

function truncate(value: string): string {
  return value.length <= 256 ? value : `${value.slice(0, 253)}…`;
}
