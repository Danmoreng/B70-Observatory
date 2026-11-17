import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentRunSnapshotSchema,
  DurableTracePageSchema,
  SERVICE_NAME,
  type AgentRunSnapshot,
  type AgentStreamEvent,
} from '@observatory/contracts';
import type { AgentController, AgentListener } from '../../src/agent/manager.js';
import { RunnerAgentClient } from '../../src/agent/runner-client.js';
import type { RunnerConfig } from '../../src/runner/config.js';
import { createRunnerControlServer } from '../../src/runner/service.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function eventually(check: () => boolean): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const deadline = Date.now() + 2_000;
    const poll = (): void => {
      if (check()) resolvePromise();
      else if (Date.now() > deadline) reject(new Error('condition not reached'));
      else setTimeout(poll, 10);
    };
    poll();
  });
}

describe('RunnerAgentClient', () => {
  it('uses the strict Unix control protocol and mirrors events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b70-control-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const socketPath = join(root, 'control.sock');
    const controlToken = 'a'.repeat(64);
    const listeners = new Set<AgentListener>();
    let snapshot = AgentRunSnapshotSchema.parse({
      service: SERVICE_NAME,
      enabled: true,
      status: 'idle',
      sequence: 0,
      pendingSteering: 0,
      timeline: [],
    });
    const controller: AgentController = {
      snapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async start(input) {
        snapshot = AgentRunSnapshotSchema.parse({
          ...snapshot,
          status: 'running',
          sequence: 1,
          task: input.task,
        });
        const event: AgentStreamEvent = {
          operation: 'reset',
          sequence: 1,
          snapshot,
        };
        for (const listener of listeners) listener(event);
        return snapshot;
      },
      async startReview(input) {
        snapshot = AgentRunSnapshotSchema.parse({
          ...snapshot,
          status: 'running',
          sequence: snapshot.sequence + 1,
          task: `review ${input.resultRevision}`,
        });
        return snapshot;
      },
      async startCorrection(input) {
        snapshot = AgentRunSnapshotSchema.parse({
          ...snapshot,
          status: 'running',
          sequence: snapshot.sequence + 1,
          task: `correct ${input.findingIds.length}`,
        });
        return snapshot;
      },
      async startConflictResolution(input) {
        snapshot = AgentRunSnapshotSchema.parse({
          ...snapshot,
          status: 'running',
          sequence: snapshot.sequence + 1,
          task: `resolve ${input.resultRevision}`,
        });
        return snapshot;
      },
      async steer() {
        return snapshot;
      },
      async getDesktopFrame(runId) {
        if (runId !== '11111111-1111-4111-8111-111111111111') return undefined;
        const data = readFileSync(
          new URL('../../../runner/test/fixtures/desktop/blank.png', import.meta.url)
        );
        return { mimeType: 'image/png', data, byteLength: data.length, width: 640, height: 480 };
      },
      async getRunTrace(runId) {
        return DurableTracePageSchema.parse({ runId, items: [], hasMore: false });
      },
      async getTaskChanges(
        taskId,
        runId = '22222222-2222-4222-8222-222222222222',
        refresh = false
      ) {
        return {
          taskId,
          runId,
          capturedAt: '2026-10-29T18:00:00.000Z',
          status: 'live',
          stale: false,
          truncated: false,
          files: [{ path: 'a.ts', status: 'modified' }],
          diff: refresh ? '+manual' : '+a',
        };
      },
      async getTaskTelemetry(taskId) {
        return {
          taskId,
          totals: {
            requests: 0,
            completedRequests: 0,
            failedRequests: 0,
            usage: null,
            prefill: null,
            decode: null,
          },
          runs: [],
        };
      },
      async close() {},
    };
    const control = createRunnerControlServer(
      { controlSocket: socketPath, controlToken } as RunnerConfig,
      controller
    );
    await control.start();
    cleanups.push(() => control.close());
    const unauthorizedStatus = await new Promise<number>((resolvePromise, reject) => {
      const direct = request({ socketPath, method: 'GET', path: '/v1/snapshot' }, (response) => {
        response.resume();
        response.once('end', () => resolvePromise(response.statusCode ?? 0));
      });
      direct.once('error', reject);
      direct.end();
    });
    expect(unauthorizedStatus).toBe(401);
    const client = new RunnerAgentClient(socketPath, controlToken);
    cleanups.push(() => client.close());
    await eventually(() => client.snapshot().enabled);

    await expect(
      client.getDesktopFrame('22222222-2222-4222-8222-222222222222')
    ).resolves.toBeUndefined();
    await expect(
      client.getDesktopFrame('11111111-1111-4111-8111-111111111111')
    ).resolves.toMatchObject({ mimeType: 'image/png', width: 640, height: 480 });
    const result: AgentRunSnapshot = await client.start({ task: 'Check isolation' });
    expect(result).toMatchObject({ enabled: true, status: 'running', task: 'Check isolation' });
    await expect(
      client.getTaskChanges(
        '11111111-1111-4111-8111-111111111111',
        '33333333-3333-4333-8333-333333333333'
      )
    ).resolves.toMatchObject({ runId: '33333333-3333-4333-8333-333333333333', diff: '+a' });
    await expect(
      client.getTaskTelemetry('11111111-1111-4111-8111-111111111111')
    ).resolves.toMatchObject({
      taskId: '11111111-1111-4111-8111-111111111111',
      runs: [],
      totals: { requests: 0 },
    });
    await expect(
      client.getTaskChanges('11111111-1111-4111-8111-111111111111', undefined, true)
    ).resolves.toMatchObject({ diff: '+manual' });
    await eventually(() => client.snapshot().sequence === 1);
    await expect(
      client.getRunTrace('11111111-1111-4111-8111-111111111111', -1, 25)
    ).resolves.toMatchObject({ items: [], hasMore: false });
    await expect(
      client.startReview({
        taskId: '11111111-1111-4111-8111-111111111111',
        sourceRunId: '22222222-2222-4222-8222-222222222222',
        resultRevision: 'b'.repeat(40),
        idempotencyKey: '33333333-3333-4333-8333-333333333333',
      })
    ).resolves.toMatchObject({ task: `review ${'b'.repeat(40)}` });
    await expect(
      client.startCorrection({
        taskId: '11111111-1111-4111-8111-111111111111',
        reviewId: '44444444-4444-4444-8444-444444444444',
        findingIds: ['55555555-5555-4555-8555-555555555555'],
        idempotencyKey: '66666666-6666-4666-8666-666666666666',
      })
    ).resolves.toMatchObject({ task: 'correct 1' });
    await expect(
      client.startConflictResolution({
        taskId: '11111111-1111-4111-8111-111111111111',
        sourceRunId: '22222222-2222-4222-8222-222222222222',
        resultRevision: 'c'.repeat(40),
        expectedTaskVersion: 4,
        idempotencyKey: '77777777-7777-4777-8777-777777777777',
      })
    ).resolves.toMatchObject({ task: `resolve ${'c'.repeat(40)}` });
  });
});
