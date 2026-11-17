import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  parseApiError,
  parseHealthPayload,
  parseSystemSnapshot,
  parseVllmTelemetryPayload,
} from '@observatory/contracts';
import { buildApp, type AppOptions } from '../../src/app.js';
import { loadServerConfig } from '../../src/config.js';
import { AuthSessionRepository, MetricRepository } from '../../src/db/index.js';
import { VllmCollector } from '../../src/telemetry/collector.js';
import { SystemCollector } from '../../src/telemetry/system-collector.js';
import { newTempDb } from '../helpers.js';
import {
  prometheusFixture,
  startMockPrometheus,
  type MockPrometheus,
  type TelemetryFixtureValues,
} from './fixtures.js';
import {
  buildGpuFixture,
  cpuStatLine,
  createFakeSystemSources,
  loadavgLine,
  meminfoLines,
  type FakeSystemSources,
} from './system-fixtures.js';

const GPU = { available: false as const, reason: 'Integrationstest: GPU ausgeblendet' };

const fixtureBase: TelemetryFixtureValues = { running: 2, waiting: 0, kv: 0.25 };

/** Read the SSE stream until the predicate matches or the deadline passes. */
async function readSseUntil(
  url: string,
  until: (accumulated: string) => boolean,
  timeoutMs = 5000
): Promise<string> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'text/event-stream' },
    });
    if (response.status !== 200) throw new Error(`SSE status ${response.status}`);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('SSE body missing');
    const decoder = new TextDecoder();
    let received = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value, { stream: true });
      if (until(received)) break;
    }
    return received;
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
}

function frames(accumulated: string): Array<{ event: string; data: string }> {
  const result: Array<{ event: string; data: string }> = [];
  for (const block of accumulated.split('\n\n')) {
    const lines = block.split('\n');
    const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
    const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
    if (event !== undefined && data !== undefined) result.push({ event, data });
  }
  return result;
}

function countEvents(accumulated: string, name: string): number {
  return (accumulated.match(new RegExp(`event: ${name}`, 'g')) ?? []).length;
}

describe('system collector end-to-end (real loopback sockets, fake /proc + mock vLLM)', () => {
  let temp: ReturnType<typeof newTempDb>;
  let mock: MockPrometheus;
  let port: number;
  let close: () => Promise<void> = async () => undefined;
  let sources: FakeSystemSources;
  let webDir: string;

  const initialStat = cpuStatLine(100, 20, 50, 700, 30);
  const initialLoad = loadavgLine(0.9, 0.45, 0.22, 2, 1138);
  const initialMem = meminfoLines(33_000_000, 24_000_000, 20_000_000);

  beforeAll(async () => {
    temp = newTempDb();
    mock = await startMockPrometheus(prometheusFixture(fixtureBase));
    sources = createFakeSystemSources(
      buildGpuFixture([{ name: 'card0', driver: 'xe', temperaturesMdegC: [69_000, 80_000] }])
    );
    sources.setProc('/proc/stat', initialStat);
    sources.setProc('/proc/loadavg', initialLoad);
    sources.setProc('/proc/meminfo', initialMem);

    const metricsRepo = new MetricRepository(temp.db);
    const collector = new VllmCollector({
      metricsUrl: mock.url,
      gpu: GPU,
      intervalMs: 40,
      timeoutMs: 2000,
      persist: (samples) => {
        metricsRepo.insertMany(samples);
      },
      log: () => undefined,
    });
    const systemCollector = new SystemCollector({
      diskPath: '/',
      io: sources.systemIo,
      gpuIo: sources.gpuIo,
      memoryUsage: () => ({ rss: 128 * 2 ** 20 }),
      intervalMs: 40,
      timeoutMs: 2000,
      persist: (samples) => {
        metricsRepo.insertMany(samples);
      },
      log: () => undefined,
    });

    webDir = mkdtempSync(join(tmpdir(), 'observatory-webroot-sys-'));
    writeFileSync(join(webDir, 'index.html'), '<html></html>');

    const options: AppOptions = {
      version: 'system-integration',
      config: loadServerConfig({ OBSERVATORY_HOST: '127.0.0.1' }),
      loggerLevel: 'silent',
      database: temp.db,
      telemetry: { collector },
      system: { collector: systemCollector },
    };
    const app = buildApp(options);
    await app.listen({ host: '127.0.0.1', port: 0 });
    port = (app.server.address() as AddressInfo).port;
    close = () => app.close();
    collector.start();
    systemCollector.start();
  });

  afterAll(async () => {
    await close();
    await mock.close();
    temp.close();
    rmSync(webDir, { recursive: true, force: true });
  });

  it('sends initial health, telemetry AND system snapshots on one SSE connection', async () => {
    const stream = await readSseUntil(`http://127.0.0.1:${port}/api/events`, (s) =>
      s.includes('event: system')
    );
    expect(stream).toContain('event: health');
    expect(stream).toContain('event: telemetry');

    const systemFrames = frames(stream).filter((frame) => frame.event === 'system');
    expect(systemFrames.length).toBe(1); // initial snapshot only
    const payload = parseSystemSnapshot(JSON.parse(systemFrames[0]?.data ?? '{}'));
    expect(payload.sourceStatus).toBe('ok');
    expect(payload.cpu?.utilizationPercent).toBeUndefined(); // first measurement
    expect(payload.memory?.totalBytes).toBe(33_000_000 * 1024);
    expect(payload.disk?.path).toBe('/');
    expect(payload.gpu.available).toBe(true);
  });

  it('publishes a new system frame when a CPU delta changes the semantic key', async () => {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
        signal: controller.signal,
        headers: { accept: 'text/event-stream' },
      });
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error('SSE body missing');
      const decoder = new TextDecoder();
      let stream = '';
      // 1) initial snapshot on this (fresh) connection …
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('SSE stream closed early');
        stream += decoder.decode(chunk.value, { stream: true });
        if (frames(stream).some((f) => f.event === 'system')) break;
      }
      // 2) … then move the jiffies counter: this semantic change must
      //    arrive as exactly one additional system frame.
      sources.setProc('/proc/stat', cpuStatLine(400, 20, 150, 900, 10));
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('SSE stream closed early');
        stream += decoder.decode(chunk.value, { stream: true });
        const systemFrames = frames(stream).filter((f) => f.event === 'system');
        if (
          systemFrames.length >= 2 &&
          systemFrames.at(-1)?.data.includes('"utilizationPercent"')
        ) {
          break;
        }
        if (systemFrames.length > 2) throw new Error('too many system frames');
      }
      await reader.cancel().catch(() => undefined);
    } finally {
      clearTimeout(deadline);
      controller.abort();
    }
  });

  it('stays quiet on the system stream while nothing changes', async () => {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 350);
    let stream = '';
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
        signal: controller.signal,
        headers: { accept: 'text/event-stream' },
      });
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error('SSE body missing');
      const decoder = new TextDecoder();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        stream += decoder.decode(chunk.value, { stream: true });
      }
    } catch (error) {
      if (!(error instanceof Error) || !error.name.startsWith('Abort')) throw error;
    } finally {
      clearTimeout(deadline);
      controller.abort();
    }
    // Keep the connection open across several 40 ms collection intervals.
    // Only the initial current snapshot may be delivered.
    expect(countEvents(stream, 'system')).toBe(1);
  });

  it('reports system and gpu checks in /api/health with honest states', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = parseHealthPayload(await response.json());
    const vllm = body.checks.find((check) => check.name === 'vllm');
    const system = body.checks.find((check) => check.name === 'system');
    const gpu = body.checks.find((check) => check.name === 'gpu');
    expect(vllm?.status).toBe('ok');
    expect(system?.status).toBe('ok');
    expect(gpu?.status).toBe('degraded'); // this-machine-like card: temperatures only
    expect(gpu?.message).toContain('Auslastung');
    expect(gpu?.message).toContain('VRAM');
  });

  it('persists bounded system and gpu samples through the M2 repository', async () => {
    const metricsRepo = new MetricRepository(temp.db);
    const deadline = Date.now() + 3000;
    let rows = metricsRepo.query({ source: 'system' });
    let gpuRows = metricsRepo.query({ source: 'gpu' });
    while ((rows.length === 0 || gpuRows.length === 0) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      rows = metricsRepo.query({ source: 'system' });
      gpuRows = metricsRepo.query({ source: 'gpu' });
    }
    expect(rows.length).toBeGreaterThan(0);
    expect(gpuRows.length).toBeGreaterThan(0);
    const systemNames = new Set(rows.map((row) => row.name));
    expect(systemNames).toContain('system.memory_usage_percent');
    expect(systemNames).toContain('system.disk_usage_percent');
    expect(systemNames).toContain('system.processes');
    const gpuNames = new Set(gpuRows.map((row) => row.name));
    expect(gpuNames).toContain('gpu.temperature_c');
    const gpuRow = gpuRows.find((row) => row.name === 'gpu.temperature_c');
    expect(gpuRow?.unit).toBe('celsius');
    for (const row of [...rows, ...gpuRows]) {
      expect(row.value).toBeTypeOf('number');
      expect(Number.isFinite(row.value)).toBe(true);
    }
  });

  it('keeps the vLLM payload untouched (M4A contract) on the shared stream', async () => {
    const stream = await readSseUntil(`http://127.0.0.1:${port}/api/events`, (s) =>
      s.includes('event: telemetry')
    );
    const telemetryFrames = frames(stream).filter((f) => f.event === 'telemetry');
    expect(telemetryFrames.length).toBeGreaterThanOrEqual(1);
    const payload = parseVllmTelemetryPayload(JSON.parse(telemetryFrames.at(-1)?.data ?? '{}'));
    expect(payload.service).toBe('local-ai-b70-observatory');
    expect(payload.gpu).toEqual(GPU); // M4A probe result stays in the vLLM payload
  });

  it('requires a valid browser session in LAN mode for the shared SSE stream', async () => {
    const passwordHash = `scrypt$16384$8$1$${'a'.repeat(22)}$${'a'.repeat(86)}`;
    const lanWebDir = mkdtempSync(join(tmpdir(), 'observatory-webroot-lan-sys-'));
    writeFileSync(join(lanWebDir, 'index.html'), '<html></html>');
    const lanConfig = loadServerConfig({
      OBSERVATORY_MODE: 'lan',
      OBSERVATORY_HOST: '127.0.0.1',
      OBSERVATORY_PASSWORD_HASH: passwordHash,
      OBSERVATORY_GATEWAY_TOKEN_HASH: 'a'.repeat(64),
    });
    const lanSources = createFakeSystemSources(
      buildGpuFixture([{ name: 'card0', driver: 'xe', temperaturesMdegC: [69_000] }])
    );
    const lanSystem = new SystemCollector({
      io: lanSources.systemIo,
      gpuIo: lanSources.gpuIo,
      memoryUsage: () => ({ rss: 128 * 2 ** 20 }),
      intervalMs: 40,
      timeoutMs: 2000,
      log: () => undefined,
    });
    const lanApp = buildApp({
      version: 'system-lan',
      config: lanConfig,
      loggerLevel: 'silent',
      database: temp.db,
      auth: {
        mode: 'lan',
        passwordHash,
        gatewayTokenHash: 'a'.repeat(64),
        sessions: new AuthSessionRepository(temp.db),
        sessionDays: 30,
        cookieSecure: false,
      },
      system: { collector: lanSystem },
      webRoot: lanWebDir,
    });
    await lanApp.listen({ host: '127.0.0.1', port: 0 });
    const lanPort = (lanApp.server.address() as AddressInfo).port;
    try {
      const response = await fetch(`http://127.0.0.1:${lanPort}/api/events`, {
        headers: { accept: 'text/event-stream' },
      });
      expect(response.status).toBe(401);
      expect(parseApiError(await response.json()).error.code).toBe('unauthorized');
    } finally {
      lanSystem.stop();
      await lanApp.close();
      rmSync(lanWebDir, { recursive: true, force: true });
    }
  });
});
