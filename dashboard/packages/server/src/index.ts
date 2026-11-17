import { randomBytes } from 'node:crypto';
import { EngineModes } from './engine/mode-controller.js';
import { createStudio } from './engine/studio.js';
import { isAbsolute, resolve, dirname, join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import { buildApp, closeWithDrainTimeout } from './app.js';
import { ConfigError, loadServerConfig } from './config.js';
import { closeDatabase, DatabaseError, openDatabase } from './db/database.js';
import {
  AuthSessionRepository,
  MetricRepository,
  RequestRepository,
  ServiceEventRepository,
} from './db/index.js';
import { VllmCollector } from './telemetry/collector.js';
import { gpuProbeIo, probeIntelGpu } from './telemetry/gpu-probe.js';
import { SystemCollector } from './telemetry/system-collector.js';
import { readGpuHelperSnapshot } from './telemetry/gpu-helper-client.js';
import { collectGpuValues } from './telemetry/gpu-sources.js';
import { RunnerAgentClient } from './agent/runner-client.js';
import { createSpeechTranscriber } from './speech/service.js';
import { createEngineServiceController } from './engine/service.js';
import { GpuScheduler } from './engine/gpu-scheduler.js';
import { createGpuSwitch } from './engine/switcher.js';
import { ComfyImages } from './engine/comfy-images.js';
import { ImageJobs } from './engine/image-jobs.js';
import { createEngineMetrics } from './engine/metrics.js';

/**
 * Entry point: validates the environment, opens the SQLite database
 * (WAL, foreign keys, versioned migrations) and binds the API to
 * loopback only.
 */
export async function main(): Promise<void> {
  const config = loadServerConfig(process.env);
  const startedAt = new Date();

  const dbPath = isAbsolute(config.dbPath) ? config.dbPath : resolve(process.cwd(), config.dbPath);
  const db = openDatabase({ path: dbPath, busyTimeoutMs: config.dbBusyTimeoutMs });
  const requests = new RequestRepository(db);
  const serviceEvents = new ServiceEventRepository(db);
  const sessions = new AuthSessionRepository(db);
  const engines = config.imageJobsRoot
    ? createGpuSwitch(config.upstreamUrl, config.comfyUrl)
    : undefined;
  const gpuScheduler = engines ? new GpuScheduler(engines) : undefined;
  const imageJobs =
    config.imageJobsRoot && gpuScheduler
      ? new ImageJobs(
          config.imageJobsRoot,
          gpuScheduler,
          new ComfyImages(config.comfyUrl),
          () => engineModes?.allowsAgentImages() ?? false
        )
      : undefined;
  // Restore the image barrier before accepting any new model requests.

  const metrics = new MetricRepository(db);
  const webRoot = isAbsolute(config.webRoot)
    ? config.webRoot
    : resolve(process.cwd(), config.webRoot);
  const agent =
    config.agentExecutionMode === 'isolated'
      ? new RunnerAgentClient(config.agentRunnerSocket, config.agentRunnerToken!)
      : undefined;

  const engineModes = gpuScheduler && engines ? new EngineModes(agent, gpuScheduler) : undefined;
  await engineModes?.load();
  await engines?.assertOwnership?.();
  const internalStudioToken = randomBytes(32).toString('hex');
  const studio =
    config.studioComfyRoot && gpuScheduler && engineModes && config.imageJobsRoot
      ? await createStudio({
          runtimeRoot:
            config.studioRuntimeRoot ?? resolve(dirname(process.argv[1]!), 'runtime/studio'),
          comfyRoot: config.studioComfyRoot,
          stateDir: config.studioStateRoot ?? join(config.imageJobsRoot, 'studio'),
          comfyUrl: config.comfyUrl,
          gatewayUrl: `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`,
          internalToken: internalStudioToken,
          model: () => engineModes.model(),
          modes: engineModes,
          gpu: gpuScheduler,
          imageJobs,
        })
      : undefined;
  // Install persisted image barriers before opening the listener.
  imageJobs?.start();
  if (gpuScheduler && engines && engineModes && !gpuScheduler.busy) {
    // Install a startup barrier immediately, but keep the HTTP UI available while
    // a cold engine warms. Recovered image work already owns its own barrier.
    void gpuScheduler
      .changeMode(engineModes.status().mode === 'studio')
      .catch((error) =>
        console.error('[observatory] Engine mode startup failed:', (error as Error).message)
      );
  }

  // Read-only Intel-GPU interface probe (M4A) for the vLLM telemetry
  // payload: it never touches the GPU itself, never blocks startup. The
  // live per-scan GPU values are gathered by the system collector (M4B),
  // which re-checks the same interfaces on every collection – a later
  // hwmon expansion therefore shows up without a restart.
  const gpu = await probeIntelGpu();
  if (gpu.available) {
    console.log('[observatory] Intel-GPU interface available – live values are collected per scan');
  } else {
    console.log(`[observatory] GPU probe: ${gpu.reason}`);
  }

  // Server-side system collection (M4B): bounded interval + timeout over
  // the local read-only sources (/proc, statfs, GPU sysfs). The browser
  // never polls – it only receives semantically changed snapshots over the
  // authenticated SSE stream.
  const systemCollector = new SystemCollector({
    diskPath: config.diskPath,
    startedAt,
    intervalMs: config.systemIntervalMs,
    timeoutMs: config.systemTimeoutMs,
    persistMinIntervalMs: config.systemPersistMinIntervalMs,
    gpuSource: async (signal) => {
      try {
        return await readGpuHelperSnapshot(config.gpuHelperSocket, signal);
      } catch {
        return collectGpuValues(gpuProbeIo, signal);
      }
    },
    persist: (samples) => {
      metrics.insertMany(samples);
    },
    log: (level, message, meta) => {
      const suffix =
        meta !== undefined && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
      console[level === 'info' ? 'log' : level](`[observatory:system] ${message}${suffix}`);
    },
  });
  const collector = new VllmCollector({
    metricsUrl: config.metricsUrl,
    gpu,
    intervalMs: config.metricsIntervalMs,
    timeoutMs: config.metricsTimeoutMs,
    persistMinIntervalMs: config.telemetryPersistMinIntervalMs,
    persist: (samples) => {
      metrics.insertMany(samples);
    },
    log: (level, message, meta) => {
      const suffix =
        meta !== undefined && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
      console[level === 'info' ? 'log' : level](`[observatory:telemetry] ${message}${suffix}`);
    },
  });

  const app = buildApp({
    engineMetrics: engineModes
      ? createEngineMetrics({
          textUrl: config.upstreamUrl,
          comfyUrl: config.comfyUrl,
          modes: engineModes,
          jobs: () => [...(imageJobs?.metrics() ?? []), ...(studio?.metrics() ?? [])],
        })
      : undefined,
    version: pkg.version,
    config,
    startedAt,
    database: db,
    gateway: { config, requests, gpu: gpuScheduler, engineModes, internalStudioToken },
    imageJobs,
    engineModes,
    studio,
    // Read-only historical API (M5A) reuses the same repositories; the
    // endpoints are pure reads and share the /api session protection.
    history: { requests, metrics },
    auth: {
      mode: config.mode,
      passwordHash: config.passwordHash,
      gatewayTokenHash: config.gatewayTokenHash,
      internalGatewayToken: studio ? internalStudioToken : undefined,
      gatewayAuthMode: config.gatewayAuthMode,
      browserAuthMode: config.browserAuthMode,
      sessions,
      sessionDays: config.sessionDays,
      cookieSecure: config.cookieSecure,
      releaseHealthToken: config.releaseHealthToken,
    },
    telemetry: { collector },
    system: { collector: systemCollector },
    agent,
    speech:
      config.speechExecutable && config.speechModel
        ? createSpeechTranscriber(config.speechExecutable, config.speechModel)
        : undefined,
    engineService:
      config.mode === 'lan'
        ? createEngineServiceController(
            undefined,
            gpuScheduler,
            () => engineModes?.status().mode !== 'studio'
          )
        : undefined,
    webRoot: config.mode === 'lan' ? webRoot : undefined,
  });

  // Lifecycle bookkeeping (M2 domain): the gateway is an observable
  // service of its own. Telemetry failures never prevent startup.
  try {
    serviceEvents.insert({
      service: 'gateway',
      severity: 'info',
      type: 'started',
      atUtc: startedAt.toISOString(),
    });
  } catch {
    // best effort
  }

  const shutdown = async (signal: string): Promise<void> => {
    imageJobs?.stop();
    await studio?.close();
    app.log.info({ signal }, 'shutting down');
    try {
      serviceEvents.insert({
        service: 'gateway',
        severity: 'info',
        type: 'stopped',
        atUtc: new Date().toISOString(),
      });
    } catch {
      // best effort – shutdown must proceed
    }
    // Live SSE connections never finish on their own; draining them would
    // hang the stop forever (and block restarts). Give connections a short
    // grace period, then exit – clients reconnect and re-synchronise (M5C).
    await closeWithDrainTimeout(app, 3000);
    await agent?.close();
    closeDatabase(db);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  studio?.start();
  collector.start();
  systemCollector.start();
  app.log.info(
    {
      port: config.port,
      host: config.host,
      retentionDays: config.retentionDays,
      upstreamUrl: config.upstreamUrl,
      metricsUrl: config.metricsUrl,
      metricsIntervalMs: config.metricsIntervalMs,
      mode: config.mode,
      agentCockpit: config.agentExecutionMode,
      webRoot: config.mode === 'lan' ? webRoot : undefined,
    },
    'Local AI B70 Observatory API + gateway started'
  );
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`[observatory] ${error.message}`);
    process.exit(2);
  }
  if (error instanceof DatabaseError) {
    console.error(`[observatory] database unavailable: ${error.message}`);
    process.exit(1);
  }
  console.error('[observatory] failed to start:', error);
  process.exit(1);
});
