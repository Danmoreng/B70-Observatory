import { describe, expect, it, vi } from 'vitest';
import {
  AgentRunSnapshotSchema,
  DurableTaskDetailSchema,
  DurableTaskListSchema,
  DurableTracePageSchema,
  SERVICE_NAME,
  parseApiError,
  type AgentRunSnapshot,
} from '@observatory/contracts';
import { buildApp, type AppOptions } from '../../src/app.js';
import { AgentControlError, type AgentController } from '../../src/agent/manager.js';
import { architectureFromFiles } from '../../src/runner/architecture.js';
import { loadServerConfig } from '../../src/config.js';

const snapshot: AgentRunSnapshot = AgentRunSnapshotSchema.parse({
  service: SERVICE_NAME,
  enabled: true,
  status: 'idle',
  sequence: 0,
  provider: 'b70-vllm',
  model: 'Qwen3.8-27B',
  thinkingLevel: 'medium',
  pendingSteering: 0,
  timeline: [],
});

function appOptions(overrides: Partial<AppOptions> = {}): AppOptions {
  return {
    version: 'test',
    config: loadServerConfig(),
    loggerLevel: 'silent',
    ...overrides,
  };
}

describe('Agent Cockpit routes', () => {
  it('serves only task/run-bound change image previews, rejecting invalid references and forwarding missing files', async () => {
    const taskId = '11111111-1111-4111-8111-111111111111',
      runId = '22222222-2222-4222-8222-222222222222';
    const data = Buffer.from('webp fixture');
    const getTaskChangeImage = vi.fn(async (_task: string, _run: string, path: string) => {
      if (path === 'missing.png')
        throw new AgentControlError('not_found', 'Not part of this result.');
      return {
        mimeType: 'image/webp' as const,
        data,
        byteLength: data.length,
        width: 800,
        height: 1200,
      };
    });
    const app = buildApp(
      appOptions({
        agent: {
          snapshot: () => snapshot,
          subscribe: () => () => {},
          start: vi.fn(async () => snapshot),
          steer: vi.fn(async () => snapshot),
          close: vi.fn(async () => {}),
          getTaskChangeImage,
        },
      })
    );
    try {
      expect(
        (
          await app.inject(
            '/api/agent/tasks/invalid/change-image?runId=' + runId + '&path=hero.png'
          )
        ).statusCode
      ).toBe(400);
      expect(
        (await app.inject('/api/agent/tasks/' + taskId + '/change-image?path=hero.png')).statusCode
      ).toBe(400);
      expect(getTaskChangeImage).not.toHaveBeenCalled();
      const query = new URLSearchParams({ runId, path: 'assets/hero image.png' });
      const response = await app.inject('/api/agent/tasks/' + taskId + '/change-image?' + query);
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(data);
      expect(response.headers['content-type']).toContain('image/webp');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(getTaskChangeImage).toHaveBeenCalledWith(taskId, runId, 'assets/hero image.png');
      expect(
        (
          await app.inject(
            '/api/agent/tasks/' +
              taskId +
              '/change-image?' +
              new URLSearchParams({ runId, path: 'missing.png' })
          )
        ).statusCode
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
  it('serves only run-bound observer images, with no caching or desktop input endpoint', async () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const data = Buffer.from('image fixture');
    const getDesktopFrame = vi.fn(async (id: string) =>
      id === runId
        ? { mimeType: 'image/png' as const, data, byteLength: data.length, width: 640, height: 480 }
        : undefined
    );
    const controller: AgentController = {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      start: vi.fn(async () => snapshot),
      steer: vi.fn(async () => snapshot),
      close: vi.fn(async () => {}),
      getDesktopFrame,
    };
    const app = buildApp(appOptions({ agent: controller }));
    try {
      expect((await app.inject('/api/agent/runs/invalid/desktop')).statusCode).toBe(400);
      expect(getDesktopFrame).not.toHaveBeenCalled();
      const response = await app.inject(`/api/agent/runs/${runId}/desktop`);
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(data);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(
        (await app.inject('/api/agent/runs/22222222-2222-4222-8222-222222222222/desktop'))
          .statusCode
      ).toBe(204);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/agent/runs/${runId}/desktop`,
            payload: { action: 'click' },
          })
        ).statusCode
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
  it('serves validated map data only for a valid registered project selection', async () => {
    const projectId = '10000000-0000-4000-8000-000000000001';
    const map = architectureFromFiles(projectId, 'Example', 'a'.repeat(40), ['src/app.ts']);
    const getProjectArchitecture = vi.fn(async (id: string) => {
      if (id !== projectId) throw new AgentControlError('not_found', 'Unknown project');
      return map;
    });
    const controller: AgentController = {
      snapshot: () => snapshot,
      subscribe: () => () => undefined,
      start: vi.fn(async () => snapshot),
      steer: vi.fn(async () => snapshot),
      getProjectArchitecture,
      close: vi.fn(async () => undefined),
    };
    const app = buildApp(appOptions({ agent: controller }));
    expect(
      (await app.inject({ method: 'GET', url: '/api/agent/projects/invalid/architecture' }))
        .statusCode
    ).toBe(400);
    expect(getProjectArchitecture).not.toHaveBeenCalled();
    const response = await app.inject({
      method: 'GET',
      url: `/api/agent/projects/${projectId}/architecture`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(map);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/agent/projects/10000000-0000-4000-8000-000000000002/architecture',
        })
      ).statusCode
    ).toBe(404);
    await app.close();
  });

  it('reports the feature as disabled without starting any process', async () => {
    const app = buildApp(appOptions());
    const response = await app.inject({ method: 'GET', url: '/api/agent' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(AgentRunSnapshotSchema.parse(response.json())).toMatchObject({
      enabled: false,
      status: 'disabled',
      reason: expect.stringContaining('isolated runner'),
      timeline: [],
    });

    const start = await app.inject({
      method: 'POST',
      url: '/api/agent/runs',
      payload: { task: 'test' },
    });
    expect(start.statusCode).toBe(503);
    expect(parseApiError(start.json()).error.code).toBe('service_unavailable');
    await app.close();
  });

  it('validates task input and delegates only normalized messages', async () => {
    const runId = '22222222-2222-4222-8222-222222222222';
    const controller: AgentController = {
      snapshot: () => snapshot,
      subscribe: () => () => undefined,
      start: vi.fn(async () => snapshot),
      startReview: vi.fn(async () => snapshot),
      startCorrection: vi.fn(async () => snapshot),
      startConflictResolution: vi.fn(async () => snapshot),
      steer: vi.fn(async () => snapshot),
      cancel: vi.fn(async () => snapshot),
      pause: vi.fn(async () => snapshot),
      close: vi.fn(async () => undefined),
    };
    const app = buildApp(appOptions({ agent: controller }));

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/agent/runs',
      payload: { task: '   ', executable: '/bin/sh' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(controller.start).not.toHaveBeenCalled();

    const valid = await app.inject({
      method: 'POST',
      url: `/api/agent/runs/${runId}/steer`,
      payload: {
        runId,
        expectedRunVersion: 2,
        expectedTaskVersion: 3,
        message: '  Check the race first.  ',
        idempotencyKey: '44444444-4444-4444-8444-444444444444',
      },
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.headers['cache-control']).toBe('no-store');
    expect(controller.steer).toHaveBeenCalledWith(
      expect.objectContaining({ runId, message: 'Check the race first.' })
    );
    const legacy = await app.inject({
      method: 'POST',
      url: '/api/agent/steer',
      payload: { message: 'wrong target' },
    });
    expect(legacy.statusCode).toBe(410);
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/agent/runs/${runId}/cancel`,
      payload: {
        runId,
        expectedRunVersion: 2,
        expectedTaskVersion: 3,
        idempotencyKey: '55555555-5555-4555-8555-555555555555',
      },
    });
    const paused = await app.inject({
      method: 'POST',
      url: `/api/agent/runs/${runId}/pause`,
      payload: {
        runId,
        expectedRunVersion: 2,
        expectedTaskVersion: 3,
        idempotencyKey: '55555555-5555-4555-8555-555555555555',
      },
    });
    expect(paused.statusCode).toBe(200);
    expect(controller.pause).toHaveBeenCalledWith(expect.objectContaining({ runId }));
    const wrongPause = await app.inject({
      method: 'POST',
      url: `/api/agent/runs/${runId}/pause`,
      payload: {
        runId: '11111111-1111-4111-8111-111111111111',
        expectedRunVersion: 2,
        expectedTaskVersion: 3,
        idempotencyKey: '55555555-5555-4555-8555-555555555555',
      },
    });
    expect(wrongPause.statusCode).toBe(400);
    expect(cancelled.statusCode).toBe(200);
    expect(controller.cancel).toHaveBeenCalledWith(expect.objectContaining({ runId }));
    const taskId = '11111111-1111-4111-8111-111111111111';
    const review = await app.inject({
      method: 'POST',
      url: `/api/agent/tasks/${taskId}/reviews`,
      payload: {
        taskId,
        sourceRunId: runId,
        resultRevision: 'a'.repeat(40),
        idempotencyKey: '66666666-6666-4666-8666-666666666666',
      },
    });
    expect(review.statusCode).toBe(200);
    expect(controller.startReview).toHaveBeenCalledWith(expect.objectContaining({ taskId }));
    const correction = await app.inject({
      method: 'POST',
      url: `/api/agent/tasks/${taskId}/corrections`,
      payload: {
        taskId,
        reviewId: '77777777-7777-4777-8777-777777777777',
        findingIds: ['88888888-8888-4888-8888-888888888888'],
        idempotencyKey: '99999999-9999-4999-8999-999999999999',
      },
    });
    expect(correction.statusCode).toBe(200);
    expect(controller.startCorrection).toHaveBeenCalledWith(expect.objectContaining({ taskId }));
    const conflictResolution = await app.inject({
      method: 'POST',
      url: `/api/agent/tasks/${taskId}/conflict-resolutions`,
      payload: {
        taskId,
        sourceRunId: runId,
        resultRevision: 'a'.repeat(40),
        expectedTaskVersion: 4,
        idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    });
    expect(conflictResolution.statusCode).toBe(200);
    expect(controller.startConflictResolution).toHaveBeenCalledWith(
      expect.objectContaining({ taskId, sourceRunId: runId })
    );
    await app.close();
    expect(controller.close).toHaveBeenCalledOnce();
  });

  it('exposes durable task history only through bounded task routes', async () => {
    const taskId = '11111111-1111-4111-8111-111111111111';
    const run = {
      id: '22222222-2222-4222-8222-222222222222',
      taskId,
      turnId: '33333333-3333-4333-8333-333333333333',
      status: 'completed' as const,
      version: 3,
      profileId: 'coding-default-v1',
      baseRevision: 'a'.repeat(40),
      checkStatus: 'not_run' as const,
      createdAt: '2026-09-13T12:00:00.000Z',
      finishedAt: '2026-09-13T12:01:00.000Z',
    };
    const list = DurableTaskListSchema.parse({
      items: [
        {
          id: taskId,
          title: 'Persistierter Lauf',
          projectId: '44444444-4444-4444-8444-444444444444',
          projectName: 'Testprojekt',
          status: 'open',
          version: 3,
          createdAt: '2026-09-13T12:00:00.000Z',
          updatedAt: '2026-09-13T12:01:00.000Z',
          latestRun: run,
        },
      ],
    });
    const detail = DurableTaskDetailSchema.parse({
      task: list.items[0],
      runs: [run],
      messages: [],
      traceEventCount: 7,
    });
    const trace = DurableTracePageSchema.parse({
      runId: run.id,
      items: [],
      hasMore: false,
    });
    const controller: AgentController = {
      snapshot: () => snapshot,
      subscribe: () => () => undefined,
      start: vi.fn(async () => snapshot),
      steer: vi.fn(async () => snapshot),
      listTasks: vi.fn(async () => list),
      getTask: vi.fn(async () => detail),
      getRunTrace: vi.fn(async () => trace),
      deleteTask: vi.fn(async () => true),
      close: vi.fn(async () => undefined),
    };
    const app = buildApp(appOptions({ agent: controller }));

    expect((await app.inject({ method: 'GET', url: '/api/agent/tasks' })).json()).toEqual(list);
    expect((await app.inject({ method: 'GET', url: `/api/agent/tasks/${taskId}` })).json()).toEqual(
      detail
    );
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/agent/tasks/${taskId}` })).json()
    ).toEqual({ deleted: true });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/agent/runs/${run.id}/trace?afterSequence=4&limit=25`,
        })
      ).json()
    ).toEqual(trace);
    expect(controller.getRunTrace).toHaveBeenCalledWith(run.id, 4, 25);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/agent/runs/${run.id}/trace?limit=251`,
        })
      ).statusCode
    ).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/api/agent/tasks/not-a-uuid' })).statusCode
    ).toBe(400);
    await app.close();
  });
});
