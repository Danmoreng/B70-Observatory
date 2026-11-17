import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadServerConfig } from '../../src/config.js';
import { hashOpaqueToken } from '../../src/auth/crypto.js';
import { AuthSessionRepository } from '../../src/db/auth-sessions.js';
import { GpuScheduler } from '../../src/engine/gpu-scheduler.js';
import { ImageJobs } from '../../src/engine/image-jobs.js';
import { newTempDb } from '../helpers.js';
import { comfyFixture } from './image-fixture.js';

it('protects image submissions, job metadata and downloads with the existing gateway credential', async () => {
  const root = await mkdtemp(join(tmpdir(), 'b70-image-auth-')),
    temp = newTempDb(),
    token = 'test-image-auth-credential';
  await writeFile(join(root, 'index.html'), '<title>test</title>');
  const config = loadServerConfig({
    OBSERVATORY_MODE: 'lan',
    OBSERVATORY_BROWSER_AUTH_MODE: 'none',
    OBSERVATORY_GATEWAY_TOKEN_HASH: hashOpaqueToken(token),
  });
  const gpu = new GpuScheduler({ image: async () => {}, text: async () => {} }),
    fake = comfyFixture();
  const jobs = new ImageJobs(join(root, 'images'), gpu, fake.engine);
  const app = buildApp({
    version: 'test',
    config,
    loggerLevel: 'silent',
    imageJobs: jobs,
    webRoot: root,
    auth: {
      mode: 'lan',
      browserAuthMode: 'none',
      gatewayTokenHash: config.gatewayTokenHash,
      sessions: new AuthSessionRepository(temp.db),
      sessionDays: 30,
      cookieSecure: false,
    },
  });
  try {
    for (const url of [
      '/v1/image-jobs/gpu',
      '/v1/image-batches/' + 'a'.repeat(64),
      '/v1/image-jobs/' + 'a'.repeat(32),
      '/v1/image-jobs/' + 'a'.repeat(32) + '/original',
    ])
      expect((await app.inject({ url })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/v1/image-jobs', payload: { prompt: 'test' } }))
        .statusCode
    ).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/v1/image-batches', payload: {} })).statusCode
    ).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/v1/image-batches/cancel', payload: {} }))
        .statusCode
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/image-jobs',
          headers: { authorization: 'Bearer ' + token },
          payload: { key: 'a'.repeat(64), prompt: 'test', workflow: {} },
        })
      ).statusCode
    ).toBe(400);
    expect(fake.state.submissions).toBe(0);
    expect(
      (
        await app.inject({
          url: '/v1/image-jobs/gpu',
          headers: { authorization: 'Bearer ' + token },
        })
      ).json().phase
    ).toBe('text');
  } finally {
    await app.close();
    await jobs.close();
    temp.close();
    await rm(root, { recursive: true, force: true });
  }
});
