import { describe, expect, it, vi } from 'vitest';
import { parseSystemSnapshot, type SystemSnapshot } from '@observatory/contracts';
import { MetricSampleSchema } from '../../src/db/contracts.js';
import { SystemCollector, type SystemSourceState } from '../../src/telemetry/system-collector.js';
import {
  buildGpuFixture,
  cpuStatLine,
  createFakeSystemSources,
  loadavgLine,
  meminfoLines,
  type FakeSystemSources,
} from './system-fixtures.js';

const T0 = Date.parse('2025-01-01T10:00:00.000Z');

const STAT_1 = cpuStatLine(100, 20, 50, 700, 30);
const LOAD_1 = loadavgLine(0.9, 0.45, 0.22, 2, 1138);
const MEM_1 = meminfoLines(33_000_000, 24_000_000, 20_000_000);
// total 1480, idle 910 → delta to STAT_1 (total 900, idle 730):
// busy 400 of 580 → 69.0 %
const STAT_2 = cpuStatLine(400, 20, 150, 900, 10);
// Delta from STAT_2: total +400, idle +250 => 37.5 % busy.
const STAT_3 = cpuStatLine(500, 20, 200, 1_160, 0);
const STAT_RESET = cpuStatLine(10, 0, 5, 50);

interface Harness {
  collector: SystemCollector;
  sources: FakeSystemSources;
  snapshots: SystemSnapshot[];
  stateChanges: SystemSourceState[];
  persist: ReturnType<typeof vi.fn>;
  setNow: (ms: number) => void;
  loseSystemSources(): void;
  restoreSystemSources(): void;
}

function harness(persistMinIntervalMs = 0): Harness {
  let nowMs = T0;
  const sources = createFakeSystemSources(
    buildGpuFixture([
      {
        name: 'card0',
        driver: 'xe',
        temperaturesMdegC: [69_000, 80_000],
      },
    ])
  );
  sources.setProc('/proc/stat', STAT_1);
  sources.setProc('/proc/loadavg', LOAD_1);
  sources.setProc('/proc/meminfo', MEM_1);

  const snapshots: SystemSnapshot[] = [];
  const stateChanges: SystemSourceState[] = [];
  const persist = vi.fn();

  const collector = new SystemCollector({
    diskPath: '/',
    io: sources.systemIo,
    gpuIo: sources.gpuIo,
    now: () => new Date(nowMs),
    startedAt: new Date(T0 - 3_600_000),
    memoryUsage: () => ({ rss: 120_000_000 }),
    cpuCoreCount: 12,
    intervalMs: 5_000,
    timeoutMs: 200,
    staleAfterMs: 15_000,
    persistMinIntervalMs,
    persist: (samples) => {
      for (const sample of samples) MetricSampleSchema.parse(sample);
      persist(samples);
    },
    onSnapshot: (payload) => snapshots.push(payload),
    onSourceStateChange: (state) => stateChanges.push(state),
    log: () => undefined,
  });

  return {
    collector,
    sources,
    snapshots,
    stateChanges,
    persist,
    setNow: (ms) => {
      nowMs = ms;
    },
    loseSystemSources: () => {
      sources.setProc('/proc/stat', undefined);
      sources.setProc('/proc/meminfo', undefined);
      sources.setProc('/proc/loadavg', undefined);
      sources.setStatFs(undefined);
    },
    restoreSystemSources: () => {
      sources.setProc('/proc/stat', STAT_2);
      sources.setProc('/proc/loadavg', LOAD_1);
      sources.setProc('/proc/meminfo', MEM_1);
      sources.setStatFs({ bsize: 4096, blocks: 1_000_000, bfree: 400_000, bavail: 390_000 });
    },
  };
}

describe('SystemCollector', () => {
  it('persists unchanged system observations and never persists stale copies (R3)', async () => {
    const h = harness(60_000);
    for (const elapsed of [0, 5_000, 60_000, 120_000]) {
      h.setNow(T0 + elapsed);
      await h.collector.collectOnce();
    }
    expect(h.persist).toHaveBeenCalledTimes(3);
    expect(h.snapshots).toHaveLength(1);
    expect(h.collector.latestSnapshot?.timestamp).toBe(new Date(T0 + 120_000).toISOString());
    h.setNow(T0 + 180_000);
    h.loseSystemSources();
    await h.collector.collectOnce();
    expect(h.collector.latestSnapshot?.sourceStatus).toBe('stale');
    expect(h.persist).toHaveBeenCalledTimes(3);
  });

  it('publishes one contract-valid snapshot on the first collection (no utilization yet)', async () => {
    const h = harness();
    await h.collector.collectOnce();

    expect(h.snapshots).toHaveLength(1);
    const payload = parseSystemSnapshot(h.snapshots[0]);
    expect(payload.sourceStatus).toBe('ok');
    // First measurement: the jiffies delta does not exist yet – honest '–'.
    expect(payload.cpu?.coreCount).toBe(12);
    expect(payload.cpu?.utilizationPercent).toBeUndefined();
    expect(payload.cpu?.load1).toBe(0.9);
    expect(payload.memory).toMatchObject({
      totalBytes: 33_000_000 * 1024,
      usedBytes: (33_000_000 - 24_000_000) * 1024,
      availableBytes: 24_000_000 * 1024,
    });
    expect(payload.memory?.usagePercent).toBeCloseTo(27.3, 1);
    expect(payload.disk?.path).toBe('/');
    expect(payload.disk?.totalBytes).toBe(4096 * 1_000_000);
    expect(payload.process?.count).toBe(1138);
    expect(payload.process?.observatoryRssBytes).toBe(120_000_000);
    expect(payload.process?.uptimeSeconds).toBe(3600);
    expect(payload.gpu).toEqual({
      available: true,
      card: 'card0',
      values: { temperatureC: 80 },
      missing: ['utilization', 'vram', 'power', 'clock'],
    });
    expect(h.stateChanges).toEqual([{ status: 'ok' }]);
    expect(h.collector.healthCheck()).toEqual({ name: 'system', status: 'ok' });
  });

  it('derives the CPU utilization from the jiffies delta on the second collection', async () => {
    const h = harness();
    await h.collector.collectOnce();
    h.sources.setProc('/proc/stat', STAT_2);
    h.setNow(T0 + 5_000);
    await h.collector.collectOnce();

    expect(h.snapshots).toHaveLength(2);
    expect(h.snapshots[1]?.cpu?.utilizationPercent).toBeCloseTo(69, 1);
  });

  it('advances the CPU baseline after each real delta instead of averaging since startup', async () => {
    const h = harness();
    await h.collector.collectOnce();
    h.sources.setProc('/proc/stat', STAT_2);
    h.setNow(T0 + 5_000);
    await h.collector.collectOnce();
    h.sources.setProc('/proc/stat', STAT_3);
    h.setNow(T0 + 10_000);
    await h.collector.collectOnce();

    expect(h.snapshots.at(-1)?.cpu?.utilizationPercent).toBe(37.5);
  });

  it('stays silent while nothing changes (semantic dedup, no churn on a quiet machine)', async () => {
    const h = harness();
    await h.collector.collectOnce();
    h.setNow(T0 + 5_000); // same stat line → no jiffies progress
    await h.collector.collectOnce();
    expect(h.snapshots).toHaveLength(1);
    expect(h.collector.sourceState()).toEqual({ status: 'ok' });
  });

  it('re-bases the CPU window on a counter reset and reports no rate for that tick', async () => {
    const h = harness();
    await h.collector.collectOnce();
    h.sources.setProc('/proc/stat', STAT_2);
    h.setNow(T0 + 5_000);
    await h.collector.collectOnce(); // utilization now defined
    expect(h.snapshots[1]?.cpu?.utilizationPercent).not.toBeUndefined();

    h.sources.setProc('/proc/stat', STAT_RESET); // total went backwards
    h.setNow(T0 + 10_000);
    await h.collector.collectOnce();
    expect(h.snapshots[2]?.cpu?.utilizationPercent).toBeUndefined();
    expect(h.collector.sourceState().status).toBe('ok'); // still a success
  });

  it('reports an unreachable/unreadable source before any success', async () => {
    const h = harness();
    h.loseSystemSources();
    await h.collector.collectOnce();

    expect(h.snapshots).toHaveLength(1);
    expect(h.snapshots[0]?.sourceStatus).toBe('error');
    expect(h.snapshots[0]?.sourceMessage).toContain('Systemquellen nicht lesbar');
    expect(h.snapshots[0]?.cpu).toBeUndefined();
    expect(h.snapshots[0]?.memory).toBeUndefined();
    expect(h.collector.healthCheck().status).toBe('error');
    expect(h.collector.gpuHealthCheck().status).toBe('error');
    expect(h.stateChanges).toEqual([{ status: 'error', message: expect.any(String) }]);
  });

  it('keeps a fresh last-known-good snapshot on one transient failure (SSE/health consistency)', async () => {
    const h = harness();
    await h.collector.collectOnce();
    h.setNow(T0 + 5_000); // inside staleAfterMs (15 s)
    h.loseSystemSources();
    await h.collector.collectOnce();

    expect(h.snapshots).toHaveLength(1); // no spurious event
    expect(h.collector.sourceState().status).toBe('ok');
    expect(h.collector.healthCheck().status).toBe('ok');
    expect(h.stateChanges).toEqual([{ status: 'ok' }]);
  });

  it('marks the source stale after the horizon, keeping the last values and timestamp', async () => {
    const h = harness();
    await h.collector.collectOnce();
    const firstTimestamp = h.snapshots[0]?.timestamp;
    h.setNow(T0 + 20_000); // 20 s > staleAfterMs (15 s)
    h.loseSystemSources();
    await h.collector.collectOnce();

    expect(h.snapshots).toHaveLength(2);
    const stale = h.snapshots[1];
    expect(stale?.sourceStatus).toBe('stale');
    expect(stale?.sourceMessage).toContain('Systemquellen nicht lesbar');
    expect(stale?.cpu).toEqual(h.snapshots[0]?.cpu); // last values survive
    expect(stale?.timestamp).toBe(firstTimestamp); // last success, not "now"
    expect(h.collector.healthCheck().status).toBe('degraded');
    expect(h.stateChanges.map((state) => state.status)).toEqual(['ok', 'stale']);
  });

  it('recovers from stale back to ok on the next successful collection', async () => {
    const h = harness();
    await h.collector.collectOnce();
    h.setNow(T0 + 20_000);
    h.loseSystemSources();
    await h.collector.collectOnce();
    expect(h.collector.sourceState().status).toBe('stale');

    h.setNow(T0 + 25_000);
    h.restoreSystemSources();
    await h.collector.collectOnce();
    expect(h.collector.sourceState().status).toBe('ok');
    expect(h.collector.healthCheck()).toEqual({ name: 'system', status: 'ok' });
    expect(h.stateChanges.map((state) => state.status)).toEqual(['ok', 'stale', 'ok']);
  });

  it('classifies a timed-out collection with the configured budget', async () => {
    const h = harness();
    await h.collector.collectOnce(); // first success
    h.setNow(T0 + 20_000); // beyond the stale horizon → failure becomes visible
    h.sources.hangUntilAbort();
    await h.collector.collectOnce(); // 200 ms budget in the harness
    h.sources.unhang();

    expect(h.snapshots[1]?.sourceStatus).toBe('stale');
    expect(h.snapshots[1]?.sourceMessage).toContain('timeout nach 200 ms');
  });

  it('classifies the timeout before the first success as an error', async () => {
    const h = harness();
    h.loseSystemSources();
    h.sources.hangUntilAbort();
    await h.collector.collectOnce();
    expect(h.snapshots[0]?.sourceStatus).toBe('error');
    expect(h.snapshots[0]?.sourceMessage).toContain('timeout');
  });

  it('persists bounded samples and throttles repeated batches', async () => {
    const h = harness(60_000);
    await h.collector.collectOnce();
    expect(h.persist).toHaveBeenCalledTimes(1);
    const samples = h.persist.mock.calls[0]?.[0] as Array<{
      source: string;
      name: string;
      unit: string;
    }>;
    const names = samples.map((sample) => sample.name);
    expect(names).toContain('system.cpu_load1');
    expect(names).toContain('system.memory_usage_percent');
    expect(names).toContain('system.disk_usage_percent');
    expect(names).toContain('system.processes');
    expect(names).toContain('gpu.temperature_c');
    expect(samples.find((sample) => sample.name === 'gpu.temperature_c')).toMatchObject({
      source: 'gpu',
      unit: 'celsius',
      value: 80,
    });

    // A semantic change inside the throttle window: SSE still sees it …
    h.sources.setProc('/proc/loadavg', loadavgLine(3.2, 0.45, 0.22, 2, 1138));
    h.setNow(T0 + 5_000);
    await h.collector.collectOnce();
    expect(h.snapshots).toHaveLength(2);
    // … but the database does not.
    expect(h.persist).toHaveBeenCalledTimes(1);

    h.setNow(T0 + 70_000);
    h.sources.setProc('/proc/loadavg', loadavgLine(5.1, 0.45, 0.22, 2, 1138));
    await h.collector.collectOnce();
    expect(h.persist).toHaveBeenCalledTimes(2);
  });

  it('keeps publishing when persistence throws', async () => {
    const h = harness();
    await h.collector.collectOnce();
    h.persist.mockImplementation(() => {
      throw new Error('database locked');
    });
    h.sources.setProc('/proc/loadavg', loadavgLine(3.2, 0.45, 0.22, 2, 1138));
    h.setNow(T0 + 5_000);
    await h.collector.collectOnce();
    expect(h.snapshots).toHaveLength(2);
  });

  it('runs the interval loop on start() and stops it on stop()', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const sources = createFakeSystemSources(
      buildGpuFixture([{ name: 'card0', driver: 'xe', temperaturesMdegC: [69_000] }])
    );
    sources.setProc('/proc/stat', STAT_1);
    sources.setProc('/proc/loadavg', LOAD_1);
    sources.setProc('/proc/meminfo', MEM_1);
    let reads = 0;
    const countingIo = {
      readText: async (path: string, signal?: AbortSignal) => {
        reads += 1;
        return sources.systemIo.readText(path, signal);
      },
      statFs: async (path: string, signal?: AbortSignal) => sources.systemIo.statFs(path, signal),
    };
    const collector = new SystemCollector({
      io: countingIo,
      gpuIo: sources.gpuIo,
      now: () => new Date(),
      intervalMs: 5_000,
      timeoutMs: 200,
      log: () => undefined,
    });
    collector.start();
    expect(reads).toBeGreaterThan(0); // immediate first collection
    const afterFirst = reads;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toBeGreaterThan(afterFirst); // interval loop ran
    collector.stop();
    const afterStop = reads;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads).toBe(afterStop); // timer cleaned up
    vi.useRealTimers();
  });

  it('aborts and suppresses an in-flight collection when stopped (M4A rule)', async () => {
    const h = harness();
    h.loseSystemSources();
    h.sources.hangUntilAbort();

    let aborted = false;
    const originalRead = h.sources.systemIo.readText;
    h.sources.systemIo.readText = async (path, signal) => {
      signal?.addEventListener('abort', () => {
        aborted = true;
      });
      return originalRead(path, signal);
    };
    const collect = h.collector.collectOnce();
    h.collector.stop();
    h.sources.unhang();
    await collect;

    expect(aborted).toBe(true);
    expect(h.snapshots).toHaveLength(0); // nothing published after stop
    expect(h.stateChanges).toHaveLength(0);
  });

  it('derives the gpu health check from availability and partial exposure', async () => {
    const h = harness();
    await h.collector.collectOnce();
    const gpu = h.collector.gpuHealthCheck();
    expect(gpu.name).toBe('gpu');
    expect(gpu.status).toBe('degraded'); // temperatures only on this machine
    expect(gpu.message).toContain('Auslastung');
    expect(gpu.message).toContain('VRAM');
  });
});
