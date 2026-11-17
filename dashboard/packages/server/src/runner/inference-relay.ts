import { chmod, mkdir, rm } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { InferenceRequestTelemetry } from '@observatory/contracts';
import { resolveRequestId } from '../gateway/headers.js';
import {
  createInferenceTelemetryObserver,
  readEngineWait,
  type ObservedInferenceTelemetry,
} from './inference-telemetry.js';

const ENDPOINT = '/v1/chat/completions';
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS = 30 * 60_000;

export interface InferenceRelayOptions {
  socketPath: string;
  upstreamUrl: URL;
  /** Host-owned gateway credential. Never forward a sandbox run capability. */
  upstreamToken?: string;
  upstreamIdleTimeoutMs?: number;
}

export interface InferenceRelay {
  start(): Promise<void>;
  close(): Promise<void>;
  register(token: string, onTelemetry?: (sample: InferenceRequestTelemetry) => void): void;
  revoke(token: string): void;
}

function safeResponseHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const name of ['content-type', 'cache-control', 'x-request-id'] as const) {
    const value = headers[name];
    if (typeof value === 'string' || Array.isArray(value)) result[name] = value;
  }
  return result;
}

export function createInferenceRelay(options: InferenceRelayOptions): InferenceRelay {
  const idleTimeoutMs = options.upstreamIdleTimeoutMs ?? DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS;
  if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 1 || idleTimeoutMs > 3_600_000) {
    throw new Error('invalid inference idle timeout');
  }
  const tokens = new Set<string>();
  const telemetryObservers = new Map<string, (sample: InferenceRequestTelemetry) => void>();
  let active = 0;
  const queue: Array<{ token: string; start: () => void; cancel: () => void }> = [];
  const requests = new Map<string, Set<import('node:http').ClientRequest>>();
  const release = (): void => {
    active--;
    const next = queue.shift();
    next?.start();
  };
  const upstreamEndpoint = new URL(ENDPOINT, options.upstreamUrl);
  const requestFunction = upstreamEndpoint.protocol === 'https:' ? httpsRequest : httpRequest;
  const server = createServer((incoming, outgoing) => {
    const authorization = incoming.headers.authorization;
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (incoming.method !== 'POST' || incoming.url !== ENDPOINT || !tokens.has(token)) {
      outgoing.writeHead(tokens.has(token) ? 404 : 401, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      outgoing.end('{"error":{"message":"inference relay rejected request"}}');
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    incoming.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) incoming.destroy();
      else chunks.push(chunk);
    });
    incoming.once('end', () => {
      if (received > MAX_BODY_BYTES) {
        if (!outgoing.headersSent) outgoing.writeHead(413);
        outgoing.end();
        return;
      }
      const begin = (): void => {
        if (outgoing.destroyed || !tokens.has(token)) {
          queue.shift()?.start();
          return;
        }
        active++;
        // A capability is bound to one run by its registrant. Queued time is
        // excluded, and only this request's upstream response supplies rates.
        const onTelemetry = telemetryObservers.get(token);
        let requestId: string = randomUUID();
        const startedAt = new Date().toISOString();
        const started = performance.now();
        let telemetryReported = false;
        let engineWaitMs: number | undefined;
        const reportTelemetry = (
          completed: boolean,
          observed?: ObservedInferenceTelemetry
        ): void => {
          if (telemetryReported) return;
          telemetryReported = true;
          if (!onTelemetry) return;
          try {
            onTelemetry({
              requestId,
              startedAt,
              finishedAt: new Date().toISOString(),
              durationMs: Math.max(0, performance.now() - started),
              ...(engineWaitMs === undefined ? {} : { engineWaitMs }),
              outcome: completed ? 'completed' : 'failed',
              usage: completed ? (observed?.usage ?? null) : null,
              prefill: completed ? (observed?.prefill ?? null) : null,
              decode: completed ? (observed?.decode ?? null) : null,
            });
          } catch {
            // Telemetry persistence is observational and must never interrupt
            // delivery, cancellation, queue release or model backpressure.
          }
        };
        const upstream = requestFunction(
          upstreamEndpoint,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'content-length': String(received),
              'x-request-id': requestId,
              'x-observatory-origin': 'pi',
              ...(options.upstreamToken
                ? { authorization: `Bearer ${options.upstreamToken}` }
                : {}),
            },
          },
          (response) => {
            engineWaitMs = readEngineWait(
              typeof response.headers['x-observatory-engine-wait-ms'] === 'string'
                ? response.headers['x-observatory-engine-wait-ms']
                : undefined
            );
            const gatewayId = resolveRequestId(response.headers['x-request-id']);
            if (gatewayId.supplied) requestId = gatewayId.id;
            outgoing.writeHead(response.statusCode ?? 502, safeResponseHeaders(response.headers));
            const observer = createInferenceTelemetryObserver(
              String(response.headers['content-type'] ?? '')
            );
            let responseBytes = 0;
            response.on('data', (chunk: Buffer) => {
              responseBytes += chunk.length;
              if (responseBytes > MAX_RESPONSE_BYTES) {
                reportTelemetry(false);
                response.destroy();
                outgoing.destroy();
              } else {
                if (onTelemetry) observer.push(chunk);
                if (!outgoing.write(chunk)) {
                  response.pause();
                  outgoing.once('drain', () => response.resume());
                }
              }
            });
            response.once('end', () => {
              const observed = onTelemetry ? observer.finish() : undefined;
              const status = response.statusCode ?? 502;
              reportTelemetry(
                response.complete && status >= 200 && status < 300 && observed?.complete === true,
                observed
              );
              outgoing.end();
            });
            response.once('error', () => {
              reportTelemetry(false);
              outgoing.destroy();
            });
          }
        );
        let released = false;
        upstream.once('close', () => {
          reportTelemetry(false);
          requests.get(token)?.delete(upstream);
          if (!released) {
            released = true;
            release();
          }
        });
        const tracked = requests.get(token) ?? new Set<import('node:http').ClientRequest>();
        tracked.add(upstream);
        requests.set(token, tracked);
        outgoing.once('close', () => {
          if (!outgoing.writableFinished) reportTelemetry(false);
          upstream.destroy();
        });
        // Large cold prefills and memory-admitted queues can be silent for
        // minutes. Task cancellation/revocation still aborts immediately.
        upstream.setTimeout(idleTimeoutMs, () => upstream.destroy());
        upstream.once('error', () => {
          reportTelemetry(false);
          if (!outgoing.headersSent) {
            outgoing.writeHead(502, { 'content-type': 'application/json' });
            outgoing.end('{"error":{"message":"local inference unavailable"}}');
          } else {
            outgoing.destroy();
          }
        });
        upstream.end(Buffer.concat(chunks));
      };
      if (active < 4) begin();
      else if (queue.length >= 16) {
        outgoing.writeHead(429);
        outgoing.end('Model request queue is full');
      } else {
        const entry = { token, start: begin, cancel: () => outgoing.destroy() };
        queue.push(entry);
        outgoing.once('close', () => {
          const index = queue.indexOf(entry);
          if (index >= 0) queue.splice(index, 1);
        });
      }
    });
  });

  return {
    async start(): Promise<void> {
      await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });
      await rm(options.socketPath, { force: true });
      await new Promise<void>((resolvePromise, reject) => {
        server.once('error', reject);
        server.listen(options.socketPath, () => {
          server.off('error', reject);
          resolvePromise();
        });
      });
      // Parent directory is private and mounted directly into the sandbox.
      // The mapped nobody UID therefore needs socket-level connect permission.
      await chmod(options.socketPath, 0o666);
    },
    async close(): Promise<void> {
      for (const token of tokens) this.revoke(token);
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      await rm(options.socketPath, { force: true });
    },
    register(token: string, onTelemetry?: (sample: InferenceRequestTelemetry) => void): void {
      if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('invalid inference capability');
      tokens.add(token);
      if (onTelemetry) telemetryObservers.set(token, onTelemetry);
      else telemetryObservers.delete(token);
    },
    revoke(token: string): void {
      tokens.delete(token);
      telemetryObservers.delete(token);
      for (const entry of queue.filter((entry) => entry.token === token)) {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        entry.cancel();
      }
      for (const request of requests.get(token) ?? []) request.destroy();
      requests.delete(token);
    },
  };
}
