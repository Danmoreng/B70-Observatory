import { MemoryRequestSchema, MemoryResponseSchema } from '@observatory/contracts';
import { randomUUID } from 'node:crypto';
import {
  AgentRunSnapshotSchema,
  AgentLiveChangesSchema,
  AgentLiveChangesQuerySchema,
  AgentTaskTelemetrySchema,
  ProjectArchitectureSchema,
  MAX_AGENT_INPUT_BODY_BYTES,
  AcceptAgentRunRequestSchema,
  MergeAgentRunRequestSchema,
  AnswerAgentQuestionRequestSchema,
  CancelAgentRunRequestSchema,
  ContinueAgentTaskRequestSchema,
  QueueAgentFollowupRequestSchema,
  DurableTracePageSchema,
  SERVICE_NAME,
  StartAgentRunRequestSchema,
  StartAgentReviewRequestSchema,
  StartAgentCorrectionRequestSchema,
  StartAgentConflictResolutionRequestSchema,
  StartReleaseRequestSchema,
  ActivateReleaseRequestSchema,
  RollbackReleaseRequestSchema,
  RegisterAgentProjectRequestSchema,
  CreateAgentProjectRequestSchema,
  StartAppPreviewRequestSchema,
  SteerAgentRunRequestSchema,
  type AgentRunSnapshot,
  type AgentStreamEvent,
} from '@observatory/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { AgentControlError, type AgentController } from './manager.js';

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
} as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * State served when agent execution is disabled by configuration. No runner
 * client exists in this process, so no connection state and no safety-check
 * progress may be implied; the text says exactly what is true.
 */
function disabledSnapshot(): AgentRunSnapshot {
  return AgentRunSnapshotSchema.parse({
    service: SERVICE_NAME,
    enabled: false,
    status: 'disabled',
    sequence: 0,
    pendingSteering: 0,
    reason: 'Agent execution is disabled by configuration; no isolated runner is configured.',
    timeline: [],
  });
}

function frame(name: 'agent_snapshot' | 'agent_event', payload: unknown, id: string): string {
  return `id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function sendControlError(reply: FastifyReply, error: unknown): void {
  if (!(error instanceof AgentControlError)) {
    reply
      .status(500)
      .send({ error: { code: 'internal_error', message: 'Internal server error.' } });
    return;
  }
  const status =
    error.code === 'busy' || error.code === 'conflict' || error.code === 'merge_conflict'
      ? 409
      : error.code === 'not_found'
        ? 404
        : error.code === 'not_running' || error.code === 'protocol'
          ? 400
          : 503;
  reply.status(status).send({
    error: {
      code: status === 503 ? 'service_unavailable' : error.code,
      message: error.message.slice(0, 512),
    },
  });
}

/** Authenticated, same-origin control and run-bound live stream. */
export function registerAgentRoutes(app: FastifyInstance, agent?: AgentController): void {
  const snapshot = (): AgentRunSnapshot => agent?.snapshot() ?? disabledSnapshot();
  const generation = randomUUID();
  let cursor = 0;
  const replay: Array<{ cursor: number; event: AgentStreamEvent }> = [];
  const streams = new Set<{
    writeEvent: (event: AgentStreamEvent, eventCursor: number) => void;
  }>();
  const journalUnsubscribe = agent?.subscribe((event) => {
    const eventCursor = ++cursor;
    replay.push({ cursor: eventCursor, event });
    if (replay.length > 512) replay.shift();
    for (const stream of [...streams]) stream.writeEvent(event, eventCursor);
  });
  app.addHook('onClose', async () => journalUnsubscribe?.());

  app.get<{ Params: { id: string } }>('/api/agent/memory/:id/image', async (request, reply) => {
    if (!UUID_PATTERN.test(request.params.id) || !agent?.memoryCall) return reply.code(404).send();
    try {
      const result = MemoryResponseSchema.parse(
        await agent.memoryCall({ operation: 'image', id: request.params.id })
      );
      if (!result.image) return reply.code(404).send();
      return reply
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .type(result.image.mimeType)
        .send(Buffer.from(result.image.data, 'base64'));
    } catch (error) {
      return reply
        .code(error instanceof AgentControlError && error.code === 'not_found' ? 404 : 503)
        .send({ error: { code: 'unavailable', message: 'Memory image unavailable.' } });
    }
  });
  app.post('/api/agent/memory', { bodyLimit: 65536 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const input = MemoryRequestSchema.safeParse(request.body);
    if (!input.success)
      return reply
        .status(400)
        .send({ error: { code: 'invalid_request', message: 'Invalid memory request.' } });
    if (!agent?.memoryCall)
      return reply
        .status(503)
        .send({ error: { code: 'service_unavailable', message: 'Memory is unavailable.' } });
    try {
      return MemoryResponseSchema.parse(await agent.memoryCall(input.data));
    } catch (error) {
      sendControlError(reply, error);
    }
  });

  app.get('/api/agent', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return snapshot();
  });

  app.get('/api/agent/recent-work', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!agent?.recentWork)
      return reply.code(503).send({
        error: { code: 'service_unavailable', message: 'Recent work is unavailable.' },
      });
    try {
      return await agent.recentWork();
    } catch (error) {
      sendControlError(reply, error);
    }
  });

  app.get('/api/agent/tasks', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    if (agent?.listTasks === undefined) {
      reply.status(503).send({
        error: { code: 'service_unavailable', message: 'Task history is unavailable.' },
      });
      return;
    }
    try {
      return await agent.listTasks();
    } catch (error) {
      sendControlError(reply, error);
    }
  });

  app.get<{ Params: { taskId: string } }>(
    '/api/agent/tasks/:taskId/changes',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const query = AgentLiveChangesQuerySchema.safeParse(request.query);
      if (!UUID_PATTERN.test(request.params.taskId) || !query.success)
        return reply
          .status(400)
          .send({ error: { code: 'bad_request', message: 'Invalid task or run selection.' } });
      try {
        if (agent?.getTaskChanges === undefined)
          throw new AgentControlError('unavailable', 'Workspace previews are unavailable.');
        return AgentLiveChangesSchema.parse(
          await agent.getTaskChanges(
            request.params.taskId,
            query.data.runId,
            query.data.refresh === '1'
          )
        );
      } catch (error) {
        sendControlError(reply, error);
      }
    }
  );

  app.get<{ Params: { taskId: string } }>(
    '/api/agent/tasks/:taskId/telemetry',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      if (!UUID_PATTERN.test(request.params.taskId))
        return reply
          .status(400)
          .send({ error: { code: 'bad_request', message: 'Invalid task ID.' } });
      try {
        if (agent?.getTaskTelemetry === undefined)
          throw new AgentControlError('unavailable', 'Task telemetry is unavailable.');
        return AgentTaskTelemetrySchema.parse(await agent.getTaskTelemetry(request.params.taskId));
      } catch (error) {
        sendControlError(reply, error);
      }
    }
  );

  app.get('/api/agent/projects', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    if (agent?.listProjects === undefined) {
      reply.status(503).send({
        error: { code: 'service_unavailable', message: 'Project registry is unavailable.' },
      });
      return;
    }
    try {
      return { items: await agent.listProjects() };
    } catch (error) {
      sendControlError(reply, error);
    }
  });

  app.get<{ Params: { projectId: string } }>(
    '/api/agent/projects/:projectId/architecture',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      if (!UUID_PATTERN.test(request.params.projectId))
        return reply
          .status(400)
          .send({ error: { code: 'bad_request', message: 'Invalid project ID.' } });
      try {
        if (agent?.getProjectArchitecture === undefined)
          throw new AgentControlError('unavailable', 'Project maps are unavailable.');
        return ProjectArchitectureSchema.parse(
          await agent.getProjectArchitecture(request.params.projectId)
        );
      } catch (error) {
        sendControlError(reply, error);
      }
    }
  );

  app.post('/api/agent/projects/create', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const parsed = CreateAgentProjectRequestSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.status(400).send({
        error: { code: 'bad_request', message: 'Invalid new project or public GitHub URL.' },
      });
    if (agent?.createProject === undefined)
      return reply
        .status(503)
        .send({ error: { code: 'service_unavailable', message: 'Project creation unavailable.' } });
    try {
      return await agent.createProject(parsed.data);
    } catch (error) {
      sendControlError(reply, error);
    }
  });

  app.route<{ Params: { projectId: string } }>({
    method: ['GET', 'POST', 'DELETE'],
    url: '/api/agent/projects/:projectId/app',
    handler: async (request, reply) => {
      reply.header('cache-control', 'no-store');
      if (!UUID_PATTERN.test(request.params.projectId))
        return reply
          .status(400)
          .send({ error: { code: 'bad_request', message: 'Invalid project ID.' } });
      try {
        if (request.method === 'GET' && agent?.getAppPreview !== undefined)
          return await agent.getAppPreview(request.params.projectId);
        if (request.method === 'DELETE' && agent?.stopAppPreview !== undefined)
          return await agent.stopAppPreview(request.params.projectId);
        if (request.method === 'POST' && agent?.startAppPreview !== undefined) {
          const parsed = StartAppPreviewRequestSchema.safeParse(request.body);
          if (!parsed.success || parsed.data.projectId !== request.params.projectId)
            return reply
              .status(400)
              .send({ error: { code: 'bad_request', message: 'Invalid app version selection.' } });
          return await agent.startAppPreview(parsed.data);
        }
        throw new AgentControlError('unavailable', 'App runtime unavailable.');
      } catch (error) {
        sendControlError(reply, error);
      }
    },
  });

  app.post('/api/agent/projects', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const parsed = RegisterAgentProjectRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply
        .status(400)
        .send({ error: { code: 'bad_request', message: 'Invalid project configuration.' } });
      return;
    }
    if (agent?.registerProject === undefined) {
      reply.status(503).send({
        error: { code: 'service_unavailable', message: 'Project registry is unavailable.' },
      });
      return;
    }
    try {
      return await agent.registerProject(parsed.data);
    } catch (error) {
      sendControlError(reply, error);
    }
  });

  app.get<{ Params: { taskId: string } }>('/api/agent/tasks/:taskId', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!UUID_PATTERN.test(request.params.taskId)) {
      reply.status(400).send({ error: { code: 'bad_request', message: 'Invalid task ID.' } });
      return;
    }
    if (agent?.getTask === undefined) {
      reply.status(503).send({
        error: { code: 'service_unavailable', message: 'Task history is unavailable.' },
      });
      return;
    }
    try {
      return await agent.getTask(request.params.taskId);
    } catch (error) {
      sendControlError(reply, error);
    }
  });

  app.post<{ Params: { taskId: string } }>(
    '/api/agent/tasks/:taskId/titles/regenerate',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      if (!UUID_PATTERN.test(request.params.taskId)) {
        reply.status(400).send({ error: { code: 'bad_request', message: 'Invalid task ID.' } });
        return;
      }
      if (agent?.regenerateTaskTitle === undefined) {
        reply.status(503).send({
          error: { code: 'service_unavailable', message: 'Task history is unavailable.' },
        });
        return;
      }
      try {
        return await agent.regenerateTaskTitle(request.params.taskId);
      } catch (error) {
        sendControlError(reply, error);
      }
    }
  );

  app.delete<{ Params: { taskId: string } }>('/api/agent/tasks/:taskId', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!UUID_PATTERN.test(request.params.taskId)) {
      reply.status(400).send({ error: { code: 'bad_request', message: 'Invalid task ID.' } });
      return;
    }
    if (agent?.deleteTask === undefined) {
      reply.status(503).send({
        error: { code: 'service_unavailable', message: 'Task history is unavailable.' },
      });
      return;
    }
    try {
      const deleted = await agent.deleteTask(request.params.taskId);
      if (!deleted) {
        reply.status(404).send({ error: { code: 'not_found', message: 'Task not found.' } });
        return;
      }
      return { deleted: true };
    } catch (error) {
      sendControlError(reply, error);
    }
  });

  app.get<{
    Params: { runId: string };
    Querystring: { afterSequence?: string; limit?: string };
  }>('/api/agent/runs/:runId/trace', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!UUID_PATTERN.test(request.params.runId)) {
      reply.status(400).send({ error: { code: 'bad_request', message: 'Invalid run ID.' } });
      return;
    }
    const afterSequence = Number(request.query.afterSequence ?? '-1');
    const limit = Number(request.query.limit ?? '100');
    if (!Number.isInteger(afterSequence) || afterSequence < -1) {
      reply.status(400).send({ error: { code: 'bad_request', message: 'Invalid trace cursor.' } });
      return;
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 250) {
      reply
        .status(400)
        .send({ error: { code: 'bad_request', message: 'Invalid trace page size.' } });
      return;
    }
    if (agent?.getRunTrace === undefined) {
      reply.status(503).send({
        error: { code: 'service_unavailable', message: 'Run trace is unavailable.' },
      });
      return;
    }
    try {
      return DurableTracePageSchema.parse(
        await agent.getRunTrace(request.params.runId, afterSequence, limit)
      );
    } catch (error) {
      sendControlError(reply, error);
    }
  });

  app.get('/api/agent/events', (request, reply) => {
    reply.hijack();
    request.raw.socket.setKeepAlive(true, 30_000);
    reply.raw.writeHead(200, SSE_HEADERS);
    reply.raw.write('retry: 3000\n\n');

    let blocked = false;
    let needsSnapshot = false;
    const write = (value: string): void => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      if (blocked) {
        needsSnapshot = true;
        return;
      }
      blocked = !reply.raw.write(value);
    };
    const writeSnapshot = (): void => {
      const value = snapshot();
      write(frame('agent_snapshot', value, `${generation}:${cursor}`));
    };
    const stream = {
      writeEvent: (event: AgentStreamEvent, eventCursor: number): void => {
        write(frame('agent_event', event, `${generation}:${eventCursor}`));
      },
    };
    streams.add(stream);
    const lastId = request.headers['last-event-id'];
    const [requestedGeneration, requestedCursorText] =
      typeof lastId === 'string' ? lastId.split(':') : ['', ''];
    const requestedCursor = Number(requestedCursorText);
    const oldestCursor = replay[0]?.cursor ?? cursor + 1;
    if (
      requestedGeneration === generation &&
      Number.isInteger(requestedCursor) &&
      requestedCursor >= oldestCursor - 1 &&
      requestedCursor <= cursor
    ) {
      for (const entry of replay) {
        if (entry.cursor > requestedCursor) stream.writeEvent(entry.event, entry.cursor);
      }
    } else {
      writeSnapshot();
    }

    const onDrain = (): void => {
      blocked = false;
      if (needsSnapshot) {
        needsSnapshot = false;
        writeSnapshot();
      }
    };
    reply.raw.on('drain', onDrain);
    const keepAlive = setInterval(() => {
      if (!blocked && !reply.raw.destroyed && !reply.raw.writableEnded) {
        blocked = !reply.raw.write(': keepalive\n\n');
      }
    }, 15_000);
    keepAlive.unref();
    request.raw.once('close', () => {
      clearInterval(keepAlive);
      reply.raw.off('drain', onDrain);
      streams.delete(stream);
    });
  });

  app.post('/api/agent/runs', { bodyLimit: MAX_AGENT_INPUT_BODY_BYTES }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const parsed = StartAgentRunRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400).send({
        error: {
          code: 'bad_request',
          message: 'A non-empty task and an optional name are required.',
        },
      });
      return;
    }
    if (agent === undefined) {
      reply.status(503).send({
        error: { code: 'service_unavailable', message: disabledSnapshot().reason },
      });
      return;
    }
    try {
      return await agent.start(parsed.data);
    } catch (error) {
      sendControlError(reply, error);
    }
  });

  app.post<{ Params: { taskId: string } }>(
    '/api/agent/tasks/:taskId/continue',
    { bodyLimit: MAX_AGENT_INPUT_BODY_BYTES },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const parsed = ContinueAgentTaskRequestSchema.safeParse(request.body);
      if (!parsed.success || parsed.data.taskId !== request.params.taskId) {
        reply
          .status(400)
          .send({ error: { code: 'bad_request', message: 'Invalid task continuation.' } });
        return;
      }
      if (agent?.continueTask === undefined) {
        reply.status(503).send({
          error: { code: 'service_unavailable', message: 'Task continuation unavailable.' },
        });
        return;
      }
      try {
        return await agent.continueTask(parsed.data);
      } catch (error) {
        sendControlError(reply, error);
      }
    }
  );

  app.post<{ Params: { taskId: string; releaseId: string } }>(
    '/api/agent/tasks/:taskId/releases/:releaseId/activate',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const parsed = ActivateReleaseRequestSchema.safeParse(request.body);
      if (
        !parsed.success ||
        parsed.data.taskId !== request.params.taskId ||
        parsed.data.releaseId !== request.params.releaseId
      ) {
        reply.status(400).send({
          error: { code: 'bad_request', message: 'Invalid release activation selection.' },
        });
        return;
      }
      if (agent?.activateRelease === undefined) {
        reply.status(503).send({
          error: { code: 'service_unavailable', message: 'Release activation unavailable.' },
        });
        return;
      }
      try {
        reply.status(202);
        return await agent.activateRelease(parsed.data);
      } catch (error) {
        sendControlError(reply, error);
      }
    }
  );

  app.post<{ Params: { taskId: string } }>(
    '/api/agent/tasks/:taskId/releases/rollback',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const parsed = RollbackReleaseRequestSchema.safeParse(request.body);
      if (!parsed.success || parsed.data.taskId !== request.params.taskId) {
        reply.status(400).send({
          error: { code: 'bad_request', message: 'Invalid release rollback selection.' },
        });
        return;
      }
      if (agent?.rollbackRelease === undefined) {
        reply.status(503).send({
          error: { code: 'service_unavailable', message: 'Release rollback unavailable.' },
        });
        return;
      }
      try {
        reply.status(202);
        return await agent.rollbackRelease(parsed.data);
      } catch (error) {
        sendControlError(reply, error);
      }
    }
  );

  app.post<{ Params: { taskId: string } }>(
    '/api/agent/tasks/:taskId/reviews',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const parsed = StartAgentReviewRequestSchema.safeParse(request.body);
      if (!parsed.success || parsed.data.taskId !== request.params.taskId) {
        reply
          .status(400)
          .send({ error: { code: 'bad_request', message: 'Invalid review request.' } });
        return;
      }
      if (agent?.startReview === undefined) {
        reply.status(503).send({
          error: { code: 'service_unavailable', message: 'Independent reviews unavailable.' },
        });
        return;
      }
      try {
        return await agent.startReview(parsed.data);
      } catch (error) {
        sendControlError(reply, error);
      }
    }
  );

  app.post<{ Params: { taskId: string } }>(
    '/api/agent/tasks/:taskId/corrections',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const parsed = StartAgentCorrectionRequestSchema.safeParse(request.body);
      if (!parsed.success || parsed.data.taskId !== request.params.taskId) {
        reply
          .status(400)
          .send({ error: { code: 'bad_request', message: 'Invalid correction request.' } });
        return;
      }
      if (agent?.startCorrection === undefined) {
        reply.status(503).send({
          error: { code: 'service_unavailable', message: 'Review corrections unavailable.' },
        });
        return;
      }
      try {
        return await agent.startCorrection(parsed.data);
      } catch (error) {
        sendControlError(reply, error);
      }
    }
  );

  app.post<{ Params: { taskId: string } }>(
    '/api/agent/tasks/:taskId/conflict-resolutions',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const parsed = StartAgentConflictResolutionRequestSchema.safeParse(request.body);
      if (!parsed.success || parsed.data.taskId !== request.params.taskId) {
        reply.status(400).send({
          error: { code: 'bad_request', message: 'Invalid conflict resolution request.' },
        });
        return;
      }
      if (agent?.startConflictResolution === undefined) {
        reply.status(503).send({
          error: { code: 'service_unavailable', message: 'Conflict resolution unavailable.' },
        });
        return;
      }
      try {
        return await agent.startConflictResolution(parsed.data);
      } catch (error) {
        sendControlError(reply, error);
      }
    }
  );

  app.post<{ Params: { taskId: string } }>(
    '/api/agent/tasks/:taskId/follow-up',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const parsed = QueueAgentFollowupRequestSchema.safeParse(request.body);
      if (!parsed.success || parsed.data.taskId !== request.params.taskId) {
        reply
          .status(400)
          .send({ error: { code: 'bad_request', message: 'Invalid queued follow-up.' } });
        return;
      }
      if (agent?.queueFollowup === undefined) {
        reply.status(503).send({
          error: { code: 'service_unavailable', message: 'Follow-up queue unavailable.' },
        });
        return;
      }
      try {
        return await agent.queueFollowup(parsed.data);
      } catch (error) {
        sendControlError(reply, error);
      }
    }
  );

  app.post<{ Params: { taskId: string } }>(
    '/api/agent/tasks/:taskId/answer',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const parsed = AnswerAgentQuestionRequestSchema.safeParse(request.body);
      if (!parsed.success || parsed.data.taskId !== request.params.taskId) {
        reply
          .status(400)
          .send({ error: { code: 'bad_request', message: 'Invalid question answer.' } });
        return;
      }
      if (agent?.answerQuestion === undefined) {
        reply.status(503).send({
          error: { code: 'service_unavailable', message: 'Question answering unavailable.' },
        });
        return;
      }
      try {
        return await agent.answerQuestion(parsed.data);
      } catch (error) {
        sendControlError(reply, error);
      }
    }
  );

  app.get<{ Params: { runId: string } }>(
    '/api/agent/runs/:runId/result',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      if (!UUID_PATTERN.test(request.params.runId)) {
        reply.status(400).send({ error: { code: 'bad_request', message: 'Invalid run ID.' } });
        return;
      }
      if (agent?.getRunResult === undefined) {
        reply
          .status(503)
          .send({ error: { code: 'service_unavailable', message: 'Run result unavailable.' } });
        return;
      }
      try {
        return await agent.getRunResult(request.params.runId);
      } catch (error) {
        sendControlError(reply, error);
      }
    }
  );

  app.get<{ Params: { runId: string } }>(
    '/api/agent/runs/:runId/desktop',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      reply.header('x-content-type-options', 'nosniff');
      if (!UUID_PATTERN.test(request.params.runId))
        return reply
          .status(400)
          .send({ error: { code: 'bad_request', message: 'Invalid run reference.' } });
      try {
        const image = await agent?.getDesktopFrame?.(request.params.runId);
        if (!image) return reply.status(204).send();
        reply.header('content-type', image.mimeType);
        return reply.send(image.data);
      } catch (error) {
        sendControlError(reply, error);
      }
    }
  );

  app.get<{ Params: { taskId: string }; Querystring: { runId?: string; path?: string } }>(
    '/api/agent/tasks/:taskId/change-image',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      reply.header('x-content-type-options', 'nosniff');
      if (
        !UUID_PATTERN.test(request.params.taskId) ||
        !UUID_PATTERN.test(request.query.runId ?? '') ||
        typeof request.query.path !== 'string' ||
        request.query.path.length > 1024
      )
        return reply
          .code(400)
          .send({ error: { code: 'bad_request', message: 'Invalid image selection.' } });
      if (!agent?.getTaskChangeImage)
        return reply
          .code(503)
          .send({ error: { code: 'service_unavailable', message: 'Image preview unavailable.' } });
      try {
        const image = await agent.getTaskChangeImage(
          request.params.taskId,
          request.query.runId!,
          request.query.path
        );
        return reply.type('image/webp').send(image.data);
      } catch (error) {
        sendControlError(reply, error);
      }
    }
  );

  app.get<{ Params: { runId: string; imageId: string } }>(
    '/api/agent/runs/:runId/images/:imageId',
    async (request, reply) => {
      if (!UUID_PATTERN.test(request.params.runId) || !UUID_PATTERN.test(request.params.imageId)) {
        reply
          .status(400)
          .send({ error: { code: 'bad_request', message: 'Invalid image reference.' } });
        return;
      }
      if (agent?.getRunImage === undefined) {
        reply
          .status(503)
          .send({ error: { code: 'service_unavailable', message: 'Run images are unavailable.' } });
        return;
      }
      try {
        const image = await agent.getRunImage(request.params.runId, request.params.imageId);
        const extension =
          image.mimeType === 'image/jpeg'
            ? 'jpg'
            : image.mimeType === 'image/webp'
              ? 'webp'
              : 'png';
        const labelPart = (image.label ?? '')
          .normalize('NFKD')
          .replace(/[^a-zA-Z0-9._-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 40);
        const filename =
          labelPart === ''
            ? `agent-image-${request.params.imageId.slice(0, 8)}.${extension}`
            : `${labelPart}.${extension}`;
        reply.header('content-type', image.mimeType);
        reply.header('content-length', image.byteLength);
        reply.header('content-disposition', `inline; filename="${filename}"`);
        reply.header('cache-control', 'no-store');
        reply.header('x-content-type-options', 'nosniff');
        return reply.send(image.data);
      } catch (error) {
        sendControlError(reply, error);
      }
    }
  );

  app.post<{ Params: { runId: string } }>(
    '/api/agent/runs/:runId/accept',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const parsed = AcceptAgentRunRequestSchema.safeParse(request.body);
      if (!parsed.success || parsed.data.runId !== request.params.runId) {
        reply
          .status(400)
          .send({ error: { code: 'bad_request', message: 'Invalid result selection.' } });
        return;
      }
      if (agent?.acceptRunResult === undefined) {
        reply
          .status(503)
          .send({ error: { code: 'service_unavailable', message: 'Run acceptance unavailable.' } });
        return;
      }
      try {
        return await agent.acceptRunResult(parsed.data);
      } catch (error) {
        sendControlError(reply, error);
      }
    }
  );

  app.post<{ Params: { runId: string } }>(
    '/api/agent/runs/:runId/merge',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const parsed = MergeAgentRunRequestSchema.safeParse(request.body);
      if (!parsed.success || parsed.data.runId !== request.params.runId) {
        reply
          .status(400)
          .send({ error: { code: 'bad_request', message: 'Invalid result selection.' } });
        return;
      }
      if (agent?.mergeRunResult === undefined) {
        reply
          .status(503)
          .send({ error: { code: 'service_unavailable', message: 'Run merge unavailable.' } });
        return;
      }
      try {
        return await agent.mergeRunResult(parsed.data);
      } catch (error) {
        sendControlError(reply, error);
      }
    }
  );

  app.post<{ Params: { taskId: string } }>(
    '/api/agent/tasks/:taskId/releases',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const parsed = StartReleaseRequestSchema.safeParse(request.body);
      if (!parsed.success || parsed.data.taskId !== request.params.taskId) {
        reply
          .status(400)
          .send({ error: { code: 'bad_request', message: 'Invalid release selection.' } });
        return;
      }
      if (agent?.startRelease === undefined) {
        reply.status(503).send({
          error: { code: 'service_unavailable', message: 'Release builds unavailable.' },
        });
        return;
      }
      try {
        return await agent.startRelease(parsed.data);
      } catch (error) {
        sendControlError(reply, error);
      }
    }
  );

  app.post<{ Params: { runId: string } }>(
    '/api/agent/runs/:runId/steer',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const parsed = SteerAgentRunRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.status(400).send({
          error: { code: 'bad_request', message: 'A non-empty steering message is required.' },
        });
        return;
      }
      if (parsed.data.runId !== request.params.runId) {
        reply.status(409).send({ error: { code: 'conflict', message: 'Run ID mismatch.' } });
        return;
      }
      if (agent === undefined) {
        reply.status(503).send({
          error: { code: 'service_unavailable', message: disabledSnapshot().reason },
        });
        return;
      }
      try {
        return await agent.steer(parsed.data);
      } catch (error) {
        sendControlError(reply, error);
      }
    }
  );

  app.post<{ Params: { runId: string } }>(
    '/api/agent/runs/:runId/pause',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const parsed = CancelAgentRunRequestSchema.safeParse(request.body);
      if (!parsed.success || parsed.data.runId !== request.params.runId)
        return reply
          .code(400)
          .send({ error: { code: 'bad_request', message: 'Invalid pause request.' } });
      if (!agent?.pause)
        return reply
          .code(503)
          .send({ error: { code: 'service_unavailable', message: 'Pause is unavailable.' } });
      try {
        return await agent.pause(parsed.data);
      } catch (error) {
        sendControlError(reply, error);
      }
    }
  );

  app.post<{ Params: { runId: string } }>(
    '/api/agent/runs/:runId/cancel',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const parsed = CancelAgentRunRequestSchema.safeParse(request.body);
      if (!parsed.success || parsed.data.runId !== request.params.runId) {
        reply
          .status(400)
          .send({ error: { code: 'bad_request', message: 'Invalid cancellation.' } });
        return;
      }
      if (agent?.cancel === undefined) {
        reply.status(503).send({
          error: { code: 'service_unavailable', message: 'Run cancellation is unavailable.' },
        });
        return;
      }
      try {
        return await agent.cancel(parsed.data);
      } catch (error) {
        sendControlError(reply, error);
      }
    }
  );

  app.post('/api/agent/steer', async (_request, reply) => {
    reply.status(410).send({
      error: { code: 'conflict', message: 'Use the selected run-specific endpoint.' },
    });
  });
}
