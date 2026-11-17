import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  parseApiError,
  parseHealthPayload,
  parseVllmTelemetryPayload,
} from '@observatory/contracts';
import { buildApp, type AppOptions } from '../../src/app.js';
import { loadServerConfig } from '../../src/config.js';
import { AuthSessionRepository, MetricRepository } from '../../src/db/index.js';
import { VllmCollector } from '../../src/telemetry/collector.js';
import { newTempDb } from '../helpers.js';
import {
  prometheusFixture,
  startMockPrometheus,
  type MockPrometheus,
  type TelemetryFixtureValues,
} from './fixtures.js';

const GPU = { available: false as const, reason: 'Integrationstest: GPU ausgeblendet' };

const fixtureBase: TelemetryFixtureValues = {
  running: 2,
  waiting: 0,
  kv: 0.25,
  promptTokens: 1_000,
  generationTokens: 100,
  prefixQueries: 500,
  prefixHits: 300,
  mtpDraft: 100,
  mtpAccepted: 80,
  successStop: 1,
};

/** Read the SSE stream until the predicate matches or the deadline passes. */
async function readSseUntil(
  url: string,
  until: (accumulated: string) => boolean,
  timeoutMs = 4000
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

function countTelemetryEvents(stream: string): number {
  return (stream.match(/event: telemetry/g) ?? []).length;
}

function sseFrames(accumulated: string): Array<{ event: string; data: string }> {
  const frames: Array<{ event: string; data: string }> = [];
  for (const block of accumulated.split('\n\n')) {
    const lines = block.split('\n');
    const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
    const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
    if (event !== undefined && data !== undefined) frames.push({ event, data });
  }
  return frames;
}

describe('telemetry end-to-end (real loopback sockets, mock vLLM source)', () => {
  let temp: ReturnType<typeof newTempDb>;
  let mock: MockPrometheus;
  let port: number;
  let close: () => Promise<void> = async () => undefined;
  let collector: VllmCollector;
  let metricsRepo: MetricRepository;
  let webDir: string;

  beforeAll(async () => {
    temp = newTempDb();
    mock = await startMockPrometheus(prometheusFixture(fixtureBase));
    metricsRepo = new MetricRepository(temp.db);
    collector = new VllmCollector({
      metricsUrl: mock.url,
      gpu: GPU,
      intervalMs: 50,
      timeoutMs: 2000,
      persist: (samples) => {
        metricsRepo.insertMany(samples);
      },
      log: () => undefined,
    });
    webDir = mkdtempSync(join(tmpdir(), 'observatory-webroot-'));
    writeFileSync(join(webDir, 'index.html'), '<html></html>');

    const options: AppOptions = {
      version: 'telemetry-integration',
      config: loadServerConfig({ OBSERVATORY_HOST: '127.0.0.1' }),
      loggerLevel: 'silent',
      database: temp.db,
      telemetry: { collector },
    };
    const app = buildApp(options);
    await app.listen({ host: '127.0.0.1', port: 0 });
    port = (app.server.address() as AddressInfo).port;
    close = () => app.close();
    collector.start();
  });

  afterAll(async () => {
    collector.stop();
    await close();
    await mock.close();
    temp.close();
    rmSync(webDir, { recursive: true, force: true });
  });

  it('sends an initial health AND telemetry snapshot on one SSE connection', async () => {
    const stream = await readSseUntil(`http://127.0.0.1:${port}/api/events`, (s) =>
      s.includes('event: telemetry')
    );
    expect(stream).toContain('event: health');
    expect(stream).toContain('event: telemetry');

    const telemetryFrame = sseFrames(stream).find((frame) => frame.event === 'telemetry');
    const payload = parseVllmTelemetryPayload(JSON.parse(telemetryFrame?.data ?? '{}'));
    expect(payload.sourceStatus).toBe('ok');
    expect(payload.model).toBe('Qwen3.8-27B');
    expect(payload.requests).toEqual({ running: 2, waiting: 0 });
    expect(payload.gpu).toEqual(GPU);
  });

  it('publishes a new telemetry event when the upstream state changes semantically', async () => {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
      signal: controller.signal,
      headers: { accept: 'text/event-stream' },
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('SSE body missing');
    const decoder = new TextDecoder();
    let stream = '';
    try {
      // 1) receive the initial snapshot on this connection …
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('SSE stream closed early');
        stream += decoder.decode(chunk.value, { stream: true });
        if (sseFrames(stream).some((f) => f.event === 'telemetry')) break;
      }
      // 2) … then change the upstream value: exactly this change must be
      //    broadcast as an additional telemetry frame.
      mock.setBody(prometheusFixture({ ...fixtureBase, running: 7, kv: 0.34 }));
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('SSE stream closed early');
        stream += decoder.decode(chunk.value, { stream: true });
        const telemetryFrames = sseFrames(stream).filter((f) => f.event === 'telemetry');
        const last = telemetryFrames[telemetryFrames.length - 1];
        if (last !== undefined && last.data.includes('"running":7')) break;
        expect(telemetryFrames.length).toBeLessThanOrEqual(1); // no unrelated churn
      }
      const telemetryFrames = sseFrames(stream).filter((f) => f.event === 'telemetry');
      expect(telemetryFrames.length).toBeGreaterThanOrEqual(2);
    } finally {
      clearTimeout(deadline);
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
  });

  it('stays quiet while the upstream values do not change', async () => {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
        signal: controller.signal,
        headers: { accept: 'text/event-stream' },
      });
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error('SSE body missing');
      const decoder = new TextDecoder();
      let received = '';
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          received += decoder.decode(chunk.value, { stream: true });
          // Only a spurious second telemetry frame ends the wait early.
          if (countTelemetryEvents(received) > 1) break;
        }
      } catch (error) {
        if (!(error instanceof Error) || !error.name.startsWith('Abort')) throw error;
      }
      await reader.cancel().catch(() => undefined);
      // Exactly the initial snapshot – no scrape churn, no value change.
      expect(countTelemetryEvents(received)).toBe(1);
    } finally {
      clearTimeout(deadline);
      controller.abort();
    }
  });

  it('reports vllm and gpu in the health checks and keeps the source reachable', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = parseHealthPayload(await response.json());
    const vllm = body.checks.find((check) => check.name === 'vllm');
    const gpu = body.checks.find((check) => check.name === 'gpu');
    expect(vllm?.status).toBe('ok');
    expect(gpu?.status).toBe('degraded');
    expect(gpu?.message).toBe(GPU.reason);
  });

  it('persists bounded metric samples through the existing M2 repository', async () => {
    // The collector has been running with a 50 ms interval; wait until the
    // first batch (and only then) shows up in SQLite.
    const deadline = Date.now() + 3000;
    let rows = metricsRepo.query({ source: 'vllm' });
    while (rows.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      rows = metricsRepo.query({ source: 'vllm' });
    }
    expect(rows.length).toBeGreaterThan(0);
    const names = new Set(rows.map((row) => row.name));
    expect(names).toContain('vllm.requests_running');
    expect(names).toContain('vllm.kv_cache_usage_percent');
    for (const row of rows) {
      expect(['count', 'percent', 'tokens_per_second', 'ratio', 'ms']).toContain(row.unit);
      expect(row.value).toBeTypeOf('number');
    }
  });

  it('requires a valid browser session in LAN mode for the SSE stream', async () => {
    const passwordHash = `scrypt$16384$8$1$${'a'.repeat(22)}$${'a'.repeat(86)}`;
    const lanWebDir = mkdtempSync(join(tmpdir(), 'observatory-webroot-lan-'));
    writeFileSync(join(lanWebDir, 'index.html'), '<html></html>');
    const lanConfig = loadServerConfig({
      OBSERVATORY_MODE: 'lan',
      OBSERVATORY_HOST: '127.0.0.1',
      OBSERVATORY_PASSWORD_HASH: passwordHash,
      OBSERVATORY_GATEWAY_TOKEN_HASH: 'a'.repeat(64),
    });
    const lanApp = buildApp({
      version: 'telemetry-lan',
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
      telemetry: { collector },
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
      await lanApp.close();
      rmSync(lanWebDir, { recursive: true, force: true });
    }
  });
});
