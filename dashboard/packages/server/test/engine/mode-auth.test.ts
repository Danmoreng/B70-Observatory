import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadServerConfig } from '../../src/config.js';
import { RequestRepository } from '../../src/db/index.js';
import { AuthSessionRepository } from '../../src/db/auth-sessions.js';
import { hashOpaqueToken } from '../../src/auth/crypto.js';
import { GpuScheduler } from '../../src/engine/gpu-scheduler.js';
import { EngineModes } from '../../src/engine/mode-controller.js';
import { policy } from '../../src/engine/mode.js';
import type { AgentController } from '../../src/agent/manager.js';
import { newTempDb } from '../helpers.js';

it('blocks runner inference in studio but authenticates private enhancement requests and still guards mode changes by origin', async () => {
  let count = 0;
  const upstream = createServer((request, response) => {
    count++;
    request.resume();
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      response.end('{"choices":[]}');
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const temp = newTempDb(),
    token = 'trusted-runner',
    internalToken = 'private-studio-enhance';
  await writeFile(join(temp.dir, 'index.html'), '<title>test</title>');
  const config = loadServerConfig({
    OBSERVATORY_MODE: 'lan',
    OBSERVATORY_BROWSER_AUTH_MODE: 'none',
    OBSERVATORY_GATEWAY_TOKEN_HASH: hashOpaqueToken(token),
    OBSERVATORY_UPSTREAM_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
  });
  const engines = { image: async () => {}, text: async () => {} },
    gpu = new GpuScheduler(engines);
  const modes = new EngineModes(
    { engineMode: async () => policy('studio') } as AgentController,
    gpu
  );
  await modes.load();
  const app = buildApp({
    version: 'test',
    config,
    webRoot: temp.dir,
    loggerLevel: 'silent',
    engineModes: modes,
    gateway: {
      config,
      requests: new RequestRepository(temp.db),
      gpu,
      engineModes: modes,
      internalStudioToken: internalToken,
    },
    auth: {
      mode: 'lan',
      browserAuthMode: 'none',
      gatewayTokenHash: config.gatewayTokenHash,
      internalGatewayToken: internalToken,
      sessions: new AuthSessionRepository(temp.db),
      sessionDays: 30,
      cookieSecure: false,
    },
  });
  const call = (credential: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer ' + credential },
      payload: { model: 'test', messages: [], stream: false },
    });
  try {
    expect((await call('forged')).statusCode).toBe(401);
    expect((await call(token)).statusCode).toBe(409);
    expect(count).toBe(0);
    expect((await call(internalToken)).statusCode).toBe(200);
    expect(count).toBe(1);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/engine/mode',
          headers: { origin: 'https://outside.invalid' },
          payload: { mode: 'text' },
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/studio/api/jobs',
          headers: { origin: 'https://outside.invalid' },
          payload: { prompt: 'test' },
        })
      ).statusCode
    ).toBe(403);
  } finally {
    await app.close();
    await gpu.close();
    temp.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
