import { EnginePolicy, type EngineMode } from '../engine/mode.js';
import {
  MemoryRequestSchema,
  MemoryResponseSchema,
  type MemoryRequest,
  type MemoryResponse,
} from '@observatory/contracts';
import { request, type ClientRequest, type IncomingMessage } from 'node:http';
import {
  AgentRunSnapshotSchema,
  AgentLiveChangesSchema,
  AgentTaskTelemetrySchema,
  reduceAgentTimeline,
  AgentStreamEventSchema,
  AgentProjectListSchema,
  ProjectArchitectureSchema,
  AgentProjectSchema,
  AppPreviewSchema,
  AgentRunResultSchema,
  ReleaseJobSchema,
  DurableTaskDetailSchema,
  DurableTaskListSchema,
  DurableTracePageSchema,
  RegenerateTaskTitleResultSchema,
  SERVICE_NAME,
  type CancelAgentRunRequest,
  type ContinueAgentTaskRequest,
  type QueueAgentFollowupRequest,
  type AnswerAgentQuestionRequest,
  type AcceptAgentRunRequest,
  type MergeAgentRunRequest,
  type RegisterAgentProjectRequest,
  type AgentProject,
  type CreateAgentProjectRequest,
  type StartAppPreviewRequest,
  type AppPreview,
  type AgentRunResult,
  type AgentRunSnapshot,
  type AgentLiveChanges,
  type AgentTaskTelemetry,
  type DurableTaskDetail,
  type DurableTaskList,
  type DurableTracePage,
  type RegenerateTaskTitleResult,
  type StartAgentRunRequest,
  type StartAgentReviewRequest,
  type StartAgentCorrectionRequest,
  type StartAgentConflictResolutionRequest,
  type StartReleaseRequest,
  type ActivateReleaseRequest,
  type RollbackReleaseRequest,
  type ReleaseJob,
  type SteerAgentRunRequest,
} from '@observatory/contracts';
import {
  AgentControlError,
  type AgentController,
  type AgentListener,
  type AgentRunImagePayload,
} from './manager.js';

import { validateAgentImage } from '@observatory/runner';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * State used while the configured runner's control endpoint is not
 * reachable. The status is deliberately distinct from `disabled`: the
 * configuration requested a runner, so the UI must not report that agent
 * execution is switched off. An open transport connection alone never
 * upgrades this state – only a snapshot delivered by the runner does.
 */
function unavailableSnapshot(): AgentRunSnapshot {
  return AgentRunSnapshotSchema.parse({
    service: SERVICE_NAME,
    enabled: false,
    status: 'unreachable',
    sequence: 0,
    pendingSteering: 0,
    reason: 'The configured isolated runner is unreachable.',
    timeline: [],
  });
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

export class RunnerAgentClient implements AgentController {
  private current = unavailableSnapshot();
  private readonly listeners = new Set<AgentListener>();
  private streamRequest: ClientRequest | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(
    private readonly socketPath: string,
    private readonly controlToken: string
  ) {
    this.connectEvents();
    void this.refresh();
  }

  async engineMode(mode?: EngineMode) {
    return EnginePolicy.parse(
      await this.jsonRequest(mode ? 'POST' : 'GET', '/v1/engine-mode', mode ? { mode } : undefined)
    );
  }

  snapshot(): AgentRunSnapshot {
    return this.current;
  }

  subscribe(listener: AgentListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async memoryCall(input: MemoryRequest): Promise<MemoryResponse> {
    return MemoryResponseSchema.parse(
      await this.jsonRequest('POST', '/v1/memory', MemoryRequestSchema.parse(input), 100000)
    );
  }

  async start(input: StartAgentRunRequest): Promise<AgentRunSnapshot> {
    return await this.command('/v1/start', input);
  }

  async startReview(input: StartAgentReviewRequest): Promise<AgentRunSnapshot> {
    return await this.command(`/v1/tasks/${encodeURIComponent(input.taskId)}/reviews`, input);
  }

  async startCorrection(input: StartAgentCorrectionRequest): Promise<AgentRunSnapshot> {
    return await this.command(`/v1/tasks/${encodeURIComponent(input.taskId)}/corrections`, input);
  }

  async startConflictResolution(
    input: StartAgentConflictResolutionRequest
  ): Promise<AgentRunSnapshot> {
    return await this.command(
      `/v1/tasks/${encodeURIComponent(input.taskId)}/conflict-resolutions`,
      input
    );
  }

  async continueTask(input: ContinueAgentTaskRequest): Promise<AgentRunSnapshot> {
    return await this.command(`/v1/tasks/${encodeURIComponent(input.taskId)}/continue`, input);
  }

  async queueFollowup(input: QueueAgentFollowupRequest): Promise<{ queued: true }> {
    const value = (await this.jsonRequest(
      'POST',
      `/v1/tasks/${encodeURIComponent(input.taskId)}/follow-up`,
      input
    )) as { queued?: unknown };
    if (value.queued !== true) {
      throw new AgentControlError('protocol', 'Runner returned an invalid follow-up response.');
    }
    return { queued: true };
  }

  async answerQuestion(input: AnswerAgentQuestionRequest): Promise<AgentRunSnapshot> {
    return await this.command(`/v1/tasks/${encodeURIComponent(input.taskId)}/answer`, input);
  }

  async steer(input: SteerAgentRunRequest): Promise<AgentRunSnapshot> {
    return await this.command(`/v1/runs/${encodeURIComponent(input.runId)}/steer`, input);
  }

  async pause(input: CancelAgentRunRequest): Promise<AgentRunSnapshot> {
    return await this.command(`/v1/runs/${encodeURIComponent(input.runId)}/pause`, input);
  }

  async cancel(input: CancelAgentRunRequest): Promise<AgentRunSnapshot> {
    return await this.command(`/v1/runs/${encodeURIComponent(input.runId)}/cancel`, input);
  }

  async listTasks(): Promise<DurableTaskList> {
    return DurableTaskListSchema.parse(await this.jsonRequest('GET', '/v1/tasks'));
  }

  async getTask(taskId: string): Promise<DurableTaskDetail> {
    return DurableTaskDetailSchema.parse(
      await this.jsonRequest('GET', `/v1/tasks/${encodeURIComponent(taskId)}`)
    );
  }

  async getTaskChanges(taskId: string, runId?: string, refresh = false): Promise<AgentLiveChanges> {
    const params = new URLSearchParams({
      ...(runId === undefined ? {} : { runId }),
      ...(refresh ? { refresh: '1' } : {}),
    });
    const query = params.size ? `?${params}` : '';
    return AgentLiveChangesSchema.parse(
      await this.jsonRequest('GET', `/v1/tasks/${encodeURIComponent(taskId)}/changes${query}`)
    );
  }

  async getTaskTelemetry(taskId: string): Promise<AgentTaskTelemetry> {
    return AgentTaskTelemetrySchema.parse(
      await this.jsonRequest('GET', `/v1/tasks/${encodeURIComponent(taskId)}/telemetry`)
    );
  }

  async regenerateTaskTitle(taskId: string): Promise<RegenerateTaskTitleResult> {
    // Title generation is a model round trip that may need the full title
    // budget, so this single command may outlive the default control timeout.
    return RegenerateTaskTitleResultSchema.parse(
      await this.jsonRequest(
        'POST',
        `/v1/tasks/${encodeURIComponent(taskId)}/titles/regenerate`,
        undefined,
        30_000
      )
    );
  }

  async getRunTrace(runId: string, afterSequence = -1, limit = 100): Promise<DurableTracePage> {
    const query = new URLSearchParams({
      afterSequence: String(afterSequence),
      limit: String(limit),
    });
    return DurableTracePageSchema.parse(
      await this.jsonRequest('GET', `/v1/runs/${encodeURIComponent(runId)}/trace?${query}`)
    );
  }

  async deleteTask(taskId: string): Promise<boolean> {
    const value = (await this.jsonRequest('DELETE', `/v1/tasks/${encodeURIComponent(taskId)}`)) as {
      deleted?: unknown;
    };
    return value.deleted === true;
  }

  async getProjectArchitecture(projectId: string) {
    return ProjectArchitectureSchema.parse(
      await this.jsonRequest('GET', `/v1/projects/${encodeURIComponent(projectId)}/architecture`)
    );
  }

  async listProjects(): Promise<AgentProject[]> {
    return AgentProjectListSchema.parse(await this.jsonRequest('GET', '/v1/projects')).items;
  }

  async createProject(input: CreateAgentProjectRequest): Promise<AgentProject> {
    return AgentProjectSchema.parse(
      await this.jsonRequest('POST', '/v1/projects/create', input, 150_000)
    );
  }

  async getAppPreview(projectId: string): Promise<AppPreview> {
    return AppPreviewSchema.parse(
      await this.jsonRequest('GET', `/v1/projects/${encodeURIComponent(projectId)}/app`)
    );
  }

  async startAppPreview(input: StartAppPreviewRequest): Promise<AppPreview> {
    return AppPreviewSchema.parse(
      await this.jsonRequest(
        'POST',
        `/v1/projects/${encodeURIComponent(input.projectId)}/app`,
        input,
        900_000
      )
    );
  }

  async stopAppPreview(projectId: string): Promise<AppPreview> {
    return AppPreviewSchema.parse(
      await this.jsonRequest(
        'DELETE',
        `/v1/projects/${encodeURIComponent(projectId)}/app`,
        undefined,
        30_000
      )
    );
  }

  async registerProject(input: RegisterAgentProjectRequest): Promise<AgentProject> {
    return AgentProjectSchema.parse(await this.jsonRequest('POST', '/v1/projects', input));
  }

  async getRunResult(runId: string): Promise<AgentRunResult> {
    return AgentRunResultSchema.parse(
      await this.jsonRequest('GET', `/v1/runs/${encodeURIComponent(runId)}/result`)
    );
  }

  async getDesktopFrame(runId: string): Promise<AgentRunImagePayload | undefined> {
    const value: unknown = await this.jsonRequest(
      'GET',
      `/v1/runs/${encodeURIComponent(runId)}/desktop`,
      undefined,
      15_000
    );
    if (value === null) return undefined;
    if (
      !value ||
      typeof value !== 'object' ||
      !('mimeType' in value) ||
      value.mimeType !== 'image/png' ||
      !('dataBase64' in value) ||
      typeof value.dataBase64 !== 'string' ||
      value.dataBase64.length > 2_800_000
    )
      throw new AgentControlError('protocol', 'Invalid desktop frame.');
    const data = Buffer.from(value.dataBase64, 'base64');
    const valid = validateAgentImage('image/png', data);
    if (!valid.ok || valid.height > 1200)
      throw new AgentControlError('protocol', 'Invalid desktop image.');
    return {
      mimeType: 'image/png',
      data,
      byteLength: data.length,
      width: valid.width,
      height: valid.height,
    };
  }

  async getTaskChangeImage(
    taskId: string,
    runId: string,
    path: string
  ): Promise<AgentRunImagePayload> {
    const query = new URLSearchParams({ runId, path });
    const value = (await this.jsonRequest(
      'GET',
      '/v1/tasks/' + encodeURIComponent(taskId) + '/change-image?' + query
    )) as Record<string, unknown>;
    const data = Buffer.from(
      typeof value.dataBase64 === 'string' ? value.dataBase64 : '',
      'base64'
    );
    const valid = validateAgentImage('image/webp', data);
    if (
      value.mimeType !== 'image/webp' ||
      !valid.ok ||
      value.byteLength !== data.length ||
      data.length > 1024 * 1024
    )
      throw new AgentControlError('protocol', 'Invalid change image response.');
    return {
      mimeType: 'image/webp',
      data,
      byteLength: data.length,
      width: valid.width,
      height: valid.height,
    };
  }

  async getRunImage(runId: string, imageId: string): Promise<AgentRunImagePayload> {
    const value = (await this.jsonRequest(
      'GET',
      `/v1/runs/${encodeURIComponent(runId)}/images/${encodeURIComponent(imageId)}`
    )) as Record<string, unknown>;
    if (
      typeof value.mimeType !== 'string' ||
      ['image/png', 'image/jpeg', 'image/webp'].includes(value.mimeType) === false ||
      typeof value.dataBase64 !== 'string' ||
      typeof value.byteLength !== 'number'
    ) {
      throw new AgentControlError('protocol', 'Runner returned an invalid image response.');
    }
    const data = Buffer.from(value.dataBase64, 'base64');
    if (data.length !== value.byteLength || data.length > 2 * 1024 * 1024) {
      throw new AgentControlError('protocol', 'Runner returned an invalid image payload.');
    }
    return {
      mimeType: value.mimeType as AgentRunImagePayload['mimeType'],
      data,
      byteLength: data.length,
      width: Number(value.width) || 0,
      height: Number(value.height) || 0,
      ...(typeof value.label === 'string' ? { label: value.label.slice(0, 128) } : {}),
    };
  }

  async acceptRunResult(input: AcceptAgentRunRequest): Promise<AgentRunResult> {
    return AgentRunResultSchema.parse(
      await this.jsonRequest('POST', `/v1/runs/${encodeURIComponent(input.runId)}/accept`, input)
    );
  }

  async mergeRunResult(input: MergeAgentRunRequest): Promise<AgentRunResult> {
    return AgentRunResultSchema.parse(
      await this.jsonRequest('POST', `/v1/runs/${encodeURIComponent(input.runId)}/merge`, input)
    );
  }

  async startRelease(input: StartReleaseRequest): Promise<ReleaseJob> {
    return ReleaseJobSchema.parse(
      await this.jsonRequest(
        'POST',
        `/v1/tasks/${encodeURIComponent(input.taskId)}/releases`,
        input
      )
    );
  }

  async activateRelease(input: ActivateReleaseRequest): Promise<ReleaseJob> {
    return ReleaseJobSchema.parse(
      await this.jsonRequest(
        'POST',
        `/v1/tasks/${encodeURIComponent(input.taskId)}/releases/${encodeURIComponent(input.releaseId)}/activate`,
        input
      )
    );
  }

  async rollbackRelease(input: RollbackReleaseRequest): Promise<{ accepted: true }> {
    const value = (await this.jsonRequest(
      'POST',
      `/v1/tasks/${encodeURIComponent(input.taskId)}/releases/rollback`,
      input
    )) as { accepted?: unknown };
    if (value.accepted !== true) {
      throw new AgentControlError('protocol', 'Runner returned an invalid rollback response.');
    }
    return { accepted: true };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.streamRequest?.destroy();
    this.listeners.clear();
  }

  private async refresh(): Promise<void> {
    try {
      const value = await this.jsonRequest('GET', '/v1/snapshot');
      this.applySnapshot(AgentRunSnapshotSchema.parse(value));
    } catch {
      this.applyUnavailable();
    }
  }

  private async command(path: string, body: unknown): Promise<AgentRunSnapshot> {
    try {
      const value = await this.jsonRequest('POST', path, body);
      const snapshot = AgentRunSnapshotSchema.parse(value);
      this.applySnapshot(snapshot);
      return snapshot;
    } catch (error) {
      if (error instanceof AgentControlError) throw error;
      this.applyUnavailable();
      throw new AgentControlError('unavailable', 'The configured isolated runner is unreachable.');
    }
  }

  private jsonRequest(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    timeoutMs = 15_000
  ): Promise<unknown> {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise<unknown>((resolvePromise, reject) => {
      const client = request(
        {
          socketPath: this.socketPath,
          method,
          path,
          headers:
            encoded === undefined
              ? { authorization: `Bearer ${this.controlToken}` }
              : {
                  authorization: `Bearer ${this.controlToken}`,
                  'content-type': 'application/json',
                  'content-length': String(encoded.length),
                },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_RESPONSE_BYTES)
              response.destroy(new Error('runner response too large'));
            else chunks.push(chunk);
          });
          response.once('error', reject);
          response.once('end', () => {
            let value: unknown;
            try {
              value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              reject(new Error('invalid runner response'));
              return;
            }
            if ((response.statusCode ?? 500) >= 400) {
              const envelope = value as ErrorEnvelope;
              const rawCode = envelope.error?.code;
              const code = [
                'busy',
                'not_running',
                'not_found',
                'conflict',
                'merge_conflict',
                'protocol',
                'unavailable',
              ].includes(rawCode ?? '')
                ? (rawCode as AgentControlError['code'])
                : 'unavailable';
              reject(
                new AgentControlError(code, envelope.error?.message ?? 'Runner rejected request.')
              );
            } else resolvePromise(value);
          });
        }
      );
      client.setTimeout(timeoutMs, () => client.destroy(new Error('runner request timed out')));
      client.once('error', reject);
      client.end(encoded);
    });
  }

  private connectEvents(): void {
    if (this.closed) return;
    const client = request(
      {
        socketPath: this.socketPath,
        method: 'GET',
        path: '/v1/events',
        headers: { authorization: `Bearer ${this.controlToken}` },
      },
      (response) => this.consumeEvents(response)
    );
    this.streamRequest = client;
    client.once('error', () => {
      this.applyUnavailable();
      this.scheduleReconnect();
    });
    client.end();
  }

  private consumeEvents(response: IncomingMessage): void {
    if (response.statusCode !== 200) {
      response.resume();
      this.scheduleReconnect();
      return;
    }
    response.setEncoding('utf8');
    let buffer = '';
    response.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_RESPONSE_BYTES) {
        response.destroy();
        return;
      }
      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary === -1) break;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        this.consumeFrame(frame);
      }
    });
    response.once('error', () => this.scheduleReconnect());
    response.once('end', () => this.scheduleReconnect());
  }

  private consumeFrame(frame: string): void {
    const eventName = frame
      .split('\n')
      .find((line) => line.startsWith('event: '))
      ?.slice(7);
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6))
      .join('\n');
    if (data === '') return;
    try {
      const value: unknown = JSON.parse(data);
      if (eventName === 'snapshot') this.applySnapshot(AgentRunSnapshotSchema.parse(value));
      else if (eventName === 'event') {
        const event = AgentStreamEventSchema.parse(value);
        const eventRunId =
          event.runId ??
          (event.operation === 'reset'
            ? event.snapshot.runId
            : event.operation === 'state'
              ? event.state.runId
              : undefined);
        const appliesToCurrent =
          eventRunId === undefined ||
          this.current.runId === undefined ||
          eventRunId === this.current.runId;
        if (event.operation === 'reset' && appliesToCurrent) this.current = event.snapshot;
        else if (event.operation === 'state' && appliesToCurrent) {
          this.current = AgentRunSnapshotSchema.parse({
            ...event.state,
            activeRuns: event.state.activeRuns ?? this.current.activeRuns,
            maxActiveRuns: event.state.maxActiveRuns ?? this.current.maxActiveRuns,
            timeline: this.current.timeline,
          });
        } else if (appliesToCurrent) {
          this.current = AgentRunSnapshotSchema.parse({
            ...this.current,
            sequence: event.sequence,
            timeline: reduceAgentTimeline(this.current.timeline, event),
          });
        }
        for (const listener of [...this.listeners]) listener(event);
      }
    } catch {
      this.streamRequest?.destroy();
    }
  }

  private applySnapshot(snapshot: AgentRunSnapshot): void {
    this.current = snapshot;
    const event = AgentStreamEventSchema.parse({
      operation: 'reset',
      sequence: snapshot.sequence,
      snapshot,
    });
    for (const listener of [...this.listeners]) listener(event);
  }

  private applyUnavailable(): void {
    if (this.closed) return;
    const snapshot = unavailableSnapshot();
    if (!this.current.enabled && this.current.reason === snapshot.reason) return;
    this.applySnapshot(snapshot);
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== undefined) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectEvents();
      void this.refresh();
    }, 1_000);
    this.reconnectTimer.unref();
  }
}
