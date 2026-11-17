import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readGpuHelperSnapshot } from '../../src/telemetry/gpu-helper-client.js';

let server: Server | undefined;
let directory: string | undefined;

async function listen(body: string, status = 200): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), 'observatory-gpu-helper-'));
  const socketPath = join(directory, 'gpu.sock');
  server = createServer((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(socketPath, resolve);
  });
  return socketPath;
}

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  if (directory !== undefined) {
    await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

describe('GPU helper Unix-socket client', () => {
  it('accepts a runtime-valid snapshot', async () => {
    const socketPath = await listen(
      JSON.stringify({
        available: true,
        card: 'card0',
        values: { utilizationPercent: 42, powerWatts: 73.5 },
        missing: ['vram'],
      })
    );

    await expect(readGpuHelperSnapshot(socketPath, new AbortController().signal)).resolves.toEqual({
      available: true,
      card: 'card0',
      values: { utilizationPercent: 42, powerWatts: 73.5 },
      missing: ['vram'],
    });
  });

  it('rejects invalid and oversized responses', async () => {
    let socketPath = await listen('{"available":"yes"}');
    await expect(readGpuHelperSnapshot(socketPath, new AbortController().signal)).rejects.toThrow(
      'Datenvertrag'
    );
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    directory = undefined;

    socketPath = await listen('x'.repeat(17 * 1024));
    await expect(readGpuHelperSnapshot(socketPath, new AbortController().signal)).rejects.toThrow(
      'zu gro'
    );
  });
});
