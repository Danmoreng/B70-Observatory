import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { AgentRunSnapshotSchema, SERVICE_NAME } from '@observatory/contracts';
import { registerAgentRoutes } from '../../src/agent/routes.js';
import { AgentControlError, type AgentController } from '../../src/agent/manager.js';
const taskId = '10000000-0000-4000-8000-000000000001';
const runId = '20000000-0000-4000-8000-000000000001';
const snapshot = AgentRunSnapshotSchema.parse({
  service: SERVICE_NAME,
  enabled: false,
  status: 'disabled',
  sequence: 0,
  pendingSteering: 0,
  timeline: [],
});
const sample = {
  taskId,
  runId,
  capturedAt: '2026-10-29T18:00:00.000Z',
  status: 'live' as const,
  stale: false,
  truncated: false,
  files: [{ path: 'a.ts', status: 'modified' as const }],
  diff: '+a',
};
const totals = {
  requests: 0,
  completedRequests: 0,
  failedRequests: 0,
  usage: null,
  prefill: null,
  decode: null,
};
function fixture(overrides: Partial<AgentController> = {}) {
  const app = Fastify();
  registerAgentRoutes(app, {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    start: async () => snapshot,
    steer: async () => snapshot,
    close: async () => {},
    ...overrides,
  });
  return app;
}
describe('bounded changes and telemetry routes', () => {
  it('validates task/run IDs, passes the exact run through and disables HTTP caching', async () => {
    const getTaskChanges = vi.fn(async () => sample);
    const app = fixture({ getTaskChanges });
    try {
      const response = await app.inject(`/api/agent/tasks/${taskId}/changes?runId=${runId}`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(sample);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(getTaskChanges).toHaveBeenCalledWith(taskId, runId, false);
      for (const path of [
        `/api/agent/tasks/not-an-id/changes`,
        `/api/agent/tasks/${taskId}/changes?runId=bad`,
        `/api/agent/tasks/${taskId}/changes?path=/etc/passwd`,
        `/api/agent/tasks/${taskId}/changes?refresh=true`,
      ])
        expect((await app.inject(path)).statusCode).toBe(400);
      expect(getTaskChanges).toHaveBeenCalledTimes(1);
      expect(
        (await app.inject(`/api/agent/tasks/${taskId}/changes?runId=${runId}&refresh=1`)).statusCode
      ).toBe(200);
      expect(getTaskChanges).toHaveBeenLastCalledWith(taskId, runId, true);
    } finally {
      await app.close();
    }
  });
  it('returns honest unavailable and unknown-run errors', async () => {
    const unavailable = fixture();
    try {
      expect((await unavailable.inject(`/api/agent/tasks/${taskId}/changes`)).statusCode).toBe(503);
    } finally {
      await unavailable.close();
    }
    const missing = fixture({
      getTaskChanges: async () => {
        throw new AgentControlError('not_found', 'Run does not belong to this task.');
      },
    });
    try {
      expect(
        (await missing.inject(`/api/agent/tasks/${taskId}/changes?runId=${runId}`)).statusCode
      ).toBe(404);
    } finally {
      await missing.close();
    }
  });
  it('serves bounded task-scoped telemetry without retrieving the trace', async () => {
    const getTask = vi.fn();
    const getTaskTelemetry = vi.fn(async () => ({ taskId, totals, runs: [{ runId, totals }] }));
    const app = fixture({ getTask, getTaskTelemetry });
    try {
      const response = await app.inject(`/api/agent/tasks/${taskId}/telemetry`);
      expect(response.statusCode).toBe(200);
      expect(response.json().runs[0].runId).toBe(runId);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(getTask).not.toHaveBeenCalled();
      expect(getTaskTelemetry).toHaveBeenCalledWith(taskId);
      expect((await app.inject('/api/agent/tasks/bad/telemetry')).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
