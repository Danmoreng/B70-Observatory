import { createServer, type Socket } from 'node:net';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { AgentRunSnapshotSchema, SERVICE_NAME, parseApiError } from '@observatory/contracts';
import { RunnerAgentClient } from '../../src/agent/runner-client.js';
import { buildApp, type AppOptions } from '../../src/app.js';
import { loadServerConfig } from '../../src/config.js';

function appOptions(agent?: AppOptions['agent']): AppOptions {
  return {
    version: 'test',
    config: loadServerConfig(),
    loggerLevel: 'silent',
    ...(agent === undefined ? {} : { agent }),
  };
}

function eventually(check: () => boolean, deadlineMs = 3_000): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const deadline = Date.now() + deadlineMs;
    const poll = (): void => {
      if (check()) resolvePromise();
      else if (Date.now() > deadline) reject(new Error('condition not reached'));
      else setTimeout(poll, 10);
    };
    poll();
  });
}

describe('agent availability distinction (configuration vs. runner)', () => {
  it('reports status "disabled" with configuration wording when no runner client exists', async () => {
    const app = buildApp(appOptions());
    try {
      const response = await app.inject({ method: 'GET', url: '/api/agent' });
      expect(response.statusCode).toBe(200);
      const snapshot = AgentRunSnapshotSchema.parse(response.json());
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe('disabled');
      const reason = snapshot.reason;
      expect(reason).toBeDefined();
      // The wording must describe the actual condition: a configuration
      // decision, not pending safety checks or a running-but-locked runner.
      expect(reason).toContain('disabled by configuration');
      expect(reason).toContain('isolated runner');
      expect(reason?.toLowerCase()).not.toContain('safety');
    } finally {
      await app.close();
    }
  });

  it('reports status "unreachable" for a configured runner without claiming health from an open stream', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b70-runner-availability-'));
    const socketPath = join(root, 'control.sock');
    // The fake runner answers the control channel but never a snapshot: the
    // event stream can open while the runner must stay "unreachable".
    let snapshotHits = 0;
    const openEventSockets: Socket[] = [];
    const server = createServer((socket) => {
      let buffered = '';
      socket.on('data', (chunk: Buffer) => {
        buffered += chunk.toString('utf8');
        const headerEnd = buffered.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const requestLine = buffered.slice(0, buffered.indexOf('\r\n'));
        if (requestLine.startsWith('GET /v1/events')) {
          openEventSockets.push(socket);
          socket.write(
            'HTTP/1.1 200 OK\r\ncontent-type: text/event-stream; charset=utf-8\r\nconnection: keep-alive\r\n\r\n'
          );
        } else {
          snapshotHits += 1;
          const body = JSON.stringify({
            error: { code: 'unavailable', message: 'no snapshot yet' },
          });
          socket.write(
            `HTTP/1.1 404 Not Found\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`
          );
          socket.end();
        }
        buffered = '';
      });
    });
    server.listen(socketPath);
    const client = new RunnerAgentClient(socketPath, 'a'.repeat(64));
    const cleanup = async (): Promise<void> => {
      await client.close();
      await new Promise((resolveClose) => server.close(resolveClose));
      for (const socket of openEventSockets) socket.destroy();
      await rm(root, { recursive: true, force: true });
    };

    try {
      // The constructed client already reports the precise state.
      const initial = client.snapshot();
      expect(initial.status).toBe('unreachable');
      expect(initial.enabled).toBe(false);
      expect(initial.reason).toContain('unreachable');
      expect(initial.reason?.toLowerCase()).not.toContain('safety');

      // The refresh failed (404) and the event stream opened: an open
      // transport must not be interpreted as runner health.
      await eventually(() => snapshotHits > 0);
      await eventually(() => openEventSockets.length > 0);
      await new Promise((resolveSettle) => setTimeout(resolveSettle, 50));
      expect(client.snapshot().status).toBe('unreachable');
      expect(client.snapshot().enabled).toBe(false);

      // Only a snapshot delivered by the runner changes the state.
      const healthy = AgentRunSnapshotSchema.parse({
        service: SERVICE_NAME,
        enabled: true,
        status: 'idle',
        sequence: 7,
        pendingSteering: 0,
        timeline: [],
      });
      openEventSockets[0]?.write(`event: snapshot\ndata: ${JSON.stringify(healthy)}\n\n`);
      await eventually(() => client.snapshot().status === 'idle');
      expect(client.snapshot().enabled).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('serves the "unreachable" state through the API and rejects control actions with 503', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b70-runner-api-'));
    // A socket path with no listener: connection attempts fail immediately.
    const socketPath = join(root, 'absent.sock');
    if (existsSync(socketPath)) await unlink(socketPath);
    const client = new RunnerAgentClient(socketPath, 'b'.repeat(64));
    const app = buildApp(appOptions(client));
    try {
      const snapshot = await app.inject({ method: 'GET', url: '/api/agent' });
      expect(snapshot.statusCode).toBe(200);
      expect(AgentRunSnapshotSchema.parse(snapshot.json())).toMatchObject({
        enabled: false,
        status: 'unreachable',
      });
      const start = await app.inject({
        method: 'POST',
        url: '/api/agent/runs',
        payload: { task: 'Check availability' },
      });
      expect(start.statusCode).toBe(503);
      expect(parseApiError(start.json()).error.code).toBe('service_unavailable');
    } finally {
      await app.close();
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
