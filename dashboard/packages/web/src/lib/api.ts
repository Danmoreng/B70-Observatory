import {
  MemoryRequestSchema,
  MemoryResponseSchema,
  type MemoryRequest,
  type MemoryResponse,
} from '@observatory/contracts';
import { SpeechStatusSchema, SpeechResultSchema } from '@observatory/contracts';
import {
  HistoryChangeSchema,
  MetricsHistoryQuerySchema,
  RequestListQuerySchema,
  parseMetricsHistoryResponse,
  parseRequestDetail,
  parseRequestListResponse,
  type HistoryChange,
  type MetricsHistoryQuery,
  type RequestListQuery,
  parseApiError,
  parseAuthSession,
  parseHealthPayload,
  parseStreamNotice,
  parseSystemSnapshot,
  parseVllmTelemetryPayload,
  type AuthSession,
  type HealthPayload,
  type StreamNotice,
  type SystemSnapshot,
  type VllmTelemetryPayload,
  parseAgentRunSnapshot,
  parseAgentStreamEvent,
  parseDurableTaskDetail,
  parseDurableTaskList,
  parseDurableTracePage,
  AgentProjectListSchema,
  ProjectArchitectureSchema,
  AgentProjectSchema,
  AppPreviewSchema,
  AgentRunResultSchema,
  AgentLiveChangesSchema,
  AgentTaskTelemetrySchema,
  type AgentLiveChanges,
  type AgentTaskTelemetry,
  ReleaseJobSchema,
  RegenerateTaskTitleResultSchema,
  type AgentRunSnapshot,
  type AgentStreamEvent,
  type DurableTaskDetail,
  type DurableTaskList,
  type RegenerateTaskTitleResult,
  type DurableTraceEvent,
  type DurableTracePage,
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
  type StartAgentRunRequest,
  type StartAgentReviewRequest,
  type StartAgentCorrectionRequest,
  type StartAgentConflictResolutionRequest,
  type ApiErrorCode,
  type StartReleaseRequest,
  type ActivateReleaseRequest,
  type RollbackReleaseRequest,
  type ReleaseJob,
  type SteerAgentRunRequest,
  EngineServiceStatusSchema,
  type EngineServiceAction,
  type EngineServiceStatus,
} from '@observatory/contracts';
import { t } from './i18n.js';

/**
 * Client-side access to `GET /api/health`.
 *
 * Every response is validated against the shared contracts; violations and
 * transport failures are reported as typed `HealthFetchError`s so the UI can
 * react without trusting raw JSON.
 */

export type HealthFetchErrorCode = 'network' | 'http' | 'invalid_payload';

/** Source a fetch/stream error refers to (used to attribute UI errors). */
export type HealthFetchSource = 'health' | 'telemetry' | 'system' | 'history' | 'stream' | 'agent';

export class HealthFetchError extends Error {
  constructor(
    message: string,
    readonly code: HealthFetchErrorCode,
    readonly status?: number,
    readonly source?: HealthFetchSource,
    readonly apiCode?: ApiErrorCode
  ) {
    super(message);
    this.name = 'HealthFetchError';
  }
}

export interface HealthFetchOptions {
  /** Injectable fetch implementation (defaults to the global fetch). */
  fetchImpl?: typeof fetch;
  /** Base URL of the API. Defaults to same-origin. */
  baseUrl?: string;
  /** Request timeout in milliseconds. Defaults to 5000. */
  timeoutMs?: number;
}

export const HEALTH_PATH = '/api/health';
export const EVENTS_PATH = '/api/events';
export const AGENT_PATH = '/api/agent';
export const AGENT_EVENTS_PATH = '/api/agent/events';

/**
 * Same-origin, session-protected binary route for one run-bound agent image.
 * Both IDs are validated UUIDs on the server; the route never accepts paths
 * or external URLs.
 */
export function agentImageUrl(runId: string, imageId: string): string {
  return `/api/agent/runs/${encodeURIComponent(runId)}/images/${encodeURIComponent(imageId)}`;
}

async function engineServiceRequest(action?: EngineServiceAction): Promise<EngineServiceStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch('/api/engine/service', {
      method: action === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(action === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(action === undefined ? {} : { body: JSON.stringify({ action }) }),
    });
    if (!response.ok) {
      let message = t('engine.actionFailed');
      try {
        message = parseApiError(await response.json()).error.message;
      } catch {
        /* Keep fallback. */
      }
      throw new HealthFetchError(message, 'http', response.status);
    }
    try {
      return EngineServiceStatusSchema.parse(await response.json());
    } catch {
      throw new HealthFetchError(t('api.invalidPayload'), 'invalid_payload');
    }
  } catch (error) {
    if (error instanceof HealthFetchError) throw error;
    throw new HealthFetchError(t('engine.unavailable'), 'network');
  } finally {
    clearTimeout(timer);
  }
}

export function fetchEngineService(): Promise<EngineServiceStatus> {
  return engineServiceRequest();
}

export function changeEngineService(action: EngineServiceAction): Promise<EngineServiceStatus> {
  return engineServiceRequest(action);
}

export async function fetchHealth(options: HealthFetchOptions = {}): Promise<HealthPayload> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${options.baseUrl ?? ''}${HEALTH_PATH}`, {
      signal: controller.signal,
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });

    if (!response.ok) {
      let detail = '';
      try {
        const body = parseApiError(await response.json());
        detail = ` – ${body.error.message}`;
      } catch {
        // Non-contract error body: fall back to the bare status code.
      }
      throw new HealthFetchError(
        `Keine Verbindung zum Backend (HTTP ${response.status}${detail})`,
        'http',
        response.status
      );
    }

    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new HealthFetchError(
        'Keine Verbindung zum Backend (Antwort ist kein JSON-Dokument)',
        'invalid_payload'
      );
    }
    try {
      return parseHealthPayload(data);
    } catch {
      throw new HealthFetchError(
        'Keine Verbindung zum Backend (Antwort verletzt das API-Vertragsschema)',
        'invalid_payload'
      );
    }
  } catch (error) {
    if (error instanceof HealthFetchError) {
      throw error;
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new HealthFetchError(t('api.timeout', { ms: timeoutMs }), 'network');
    }
    throw new HealthFetchError(t('api.network'), 'network');
  } finally {
    clearTimeout(timer);
  }
}

export class AuthFetchError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'AuthFetchError';
  }
}

async function performAuthRequest(
  path: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<AuthSession> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
      ...init,
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...init.headers },
    });
  } catch {
    throw new AuthFetchError(t('auth.unreachable'));
  }
  if (!response.ok) {
    let message: string;
    if (response.status === 401) {
      message = t('auth.badPassword');
    } else if (response.status === 429) {
      message = t('auth.tooManyAttempts');
    } else {
      message = t('auth.signInFailed');
      try {
        message = parseApiError(await response.json()).error.message;
      } catch {
        // Keep the safe local fallback for non-contract responses.
      }
    }
    throw new AuthFetchError(message, response.status);
  }
  try {
    return parseAuthSession(await response.json());
  } catch {
    throw new AuthFetchError(t('auth.invalidResponse'));
  }
}

async function authRequest(
  path: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<AuthSession> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    return await performAuthRequest(path, { ...init, signal: controller.signal }, fetchImpl);
  } finally {
    clearTimeout(timer);
  }
}

export function fetchAuthSession(fetchImpl?: typeof fetch): Promise<AuthSession> {
  return authRequest('/api/auth/session', {}, fetchImpl);
}

export function login(password: string, fetchImpl?: typeof fetch): Promise<AuthSession> {
  return authRequest(
    '/api/auth/login',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    },
    fetchImpl
  );
}

export function logout(fetchImpl?: typeof fetch): Promise<AuthSession> {
  return authRequest('/api/auth/logout', { method: 'POST' }, fetchImpl);
}

export interface HealthSubscriptionHandlers {
  onHealth: (payload: HealthPayload) => void;
  /**
   * M4A: vLLM telemetry snapshots arrive as a second named event on the
   * same authenticated stream (initial snapshot on connect, then only
   * semantic changes). The browser still performs no polling.
   */
  onTelemetry?: (payload: VllmTelemetryPayload) => void;
  /**
   * M4B: system & GPU snapshots arrive as a third named event on the same
   * authenticated stream (initial snapshot on connect, then only semantic
   * changes). The browser still performs no polling.
   */
  onSystem?: (payload: SystemSnapshot) => void;
  onHistory?: (payload: HistoryChange) => void;
  /**
   * M5C: first data frame of a (re)connected stream. `resync` – the server
   * could not continue from the client's `Last-Event-ID` and sends fresh
   * current snapshots; `replay` – buffered missed events are re-sent, with
   * `types` listing which event kinds the replay contains so the UI can
   * keep un-missed sources current. Always arrives before any data frame.
   */
  onStream?: (notice: StreamNotice) => void;
  onOpen?: () => void;
  onError?: (error: HealthFetchError) => void;
}

/**
 * Subscribe to the shared authenticated event stream: named `health`,
 * `telemetry` and `system` events. EventSource handles reconnects and sends
 * the same-origin session cookie; no recurring HTTP fetch is involved.
 */
export function subscribeHealth(
  handlers: HealthSubscriptionHandlers,
  createEventSource: (url: string, init: EventSourceInit) => EventSource = (url, init) =>
    new EventSource(url, init)
): () => void {
  const source = createEventSource(EVENTS_PATH, { withCredentials: true });
  function listen<T>(
    name: 'health' | 'telemetry' | 'system' | 'history' | 'stream',
    parse: (value: unknown) => T,
    handler?: (value: T) => void
  ): void {
    source.addEventListener(name, (event) => {
      let payload: T;
      try {
        payload = parse(JSON.parse((event as MessageEvent<string>).data));
      } catch {
        handlers.onError?.(
          new HealthFetchError(
            'Live-Antwort verletzt das API-Vertragsschema.',
            'invalid_payload',
            undefined,
            name
          )
        );
        return;
      }
      handler?.(payload);
    });
  }
  listen('health', parseHealthPayload, handlers.onHealth);
  listen('telemetry', parseVllmTelemetryPayload, handlers.onTelemetry);
  listen('system', parseSystemSnapshot, handlers.onSystem);
  listen('history', (value) => HistoryChangeSchema.parse(value), handlers.onHistory);
  listen('stream', parseStreamNotice, handlers.onStream);
  source.onopen = () => handlers.onOpen?.();
  source.onerror = () =>
    handlers.onError?.(new HealthFetchError(t('api.streamReconnecting'), 'network'));
  return () => source.close();
}

/** Read-only historical API; cancellation prevents old selections from winning races. */
export async function fetchData<T>(
  path: string,
  parse: (value: unknown) => T,
  signal?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 8000);
  try {
    const response = await fetch(path, {
      signal: controller.signal,
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    if (!response.ok)
      throw new HealthFetchError(
        response.status === 401
          ? t('auth.expiredShort')
          : t('api.loadFailedHttp', { status: response.status }),
        'http',
        response.status
      );
    try {
      return parse(await response.json());
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new HealthFetchError(t('api.invalidPayload'), 'invalid_payload');
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof HealthFetchError) throw error;
    throw new HealthFetchError(t('api.loadFailedRetry'), 'network');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function queryString(query: object): string {
  return new URLSearchParams(
    Object.entries(query)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)])
  ).toString();
}

export function fetchMetricHistory(query: MetricsHistoryQuery, signal?: AbortSignal) {
  const valid = MetricsHistoryQuerySchema.parse(query);
  return fetchData(
    '/api/metrics/history?' + queryString(valid),
    (value) => {
      const result = parseMetricsHistoryResponse(value);
      if (result.series !== valid.series || result.bucketSeconds !== valid.bucketSeconds)
        throw new Error('History response does not match query');
      return result;
    },
    signal
  );
}

export function fetchRequests(query: RequestListQuery, signal?: AbortSignal) {
  return fetchData(
    '/api/requests?' + queryString(RequestListQuerySchema.parse(query)),
    parseRequestListResponse,
    signal
  );
}

export function fetchRequestDetail(id: string, signal?: AbortSignal) {
  // Reuse the UUID boundary from the shared query contract.
  const valid = RequestListQuerySchema.parse({ id });
  return fetchData(
    '/api/requests/' + encodeURIComponent(valid.id!),
    (value) => {
      const detail = parseRequestDetail(value);
      if (detail.id !== valid.id) throw new Error('Request detail does not match query');
      return detail;
    },
    signal
  );
}

async function agentRequest(
  path: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<AgentRunSnapshot> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchImpl(path, {
      ...init,
      signal: controller.signal,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
    });
    if (!response.ok) {
      let message = `Agent Cockpit request failed (HTTP ${response.status}).`;
      let apiCode: ApiErrorCode | undefined;
      try {
        const parsed = parseApiError(await response.json()).error;
        message = parsed.message;
        apiCode = parsed.code;
      } catch {
        // Keep the local, content-free fallback.
      }
      throw new HealthFetchError(message, 'http', response.status, 'agent', apiCode);
    }
    try {
      return parseAgentRunSnapshot(await response.json());
    } catch {
      throw new HealthFetchError(
        'Agent Cockpit received an invalid server response.',
        'invalid_payload',
        undefined,
        'agent'
      );
    }
  } catch (error) {
    if (error instanceof HealthFetchError) throw error;
    throw new HealthFetchError('Agent Cockpit is not reachable.', 'network', undefined, 'agent');
  } finally {
    clearTimeout(timer);
  }
}

export function fetchAgent(fetchImpl?: typeof fetch): Promise<AgentRunSnapshot> {
  return agentRequest(AGENT_PATH, {}, fetchImpl);
}

async function agentDataRequest<T>(
  path: string,
  parse: (value: unknown) => T,
  init: RequestInit = {},
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<T> {
  try {
    const response = await fetchImpl(path, {
      ...init,
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...init.headers },
    });
    if (!response.ok) {
      let message = `Agent task request failed (HTTP ${response.status}).`;
      let apiCode: ApiErrorCode | undefined;
      try {
        const parsed = parseApiError(await response.json()).error;
        message = parsed.message;
        apiCode = parsed.code;
      } catch {
        // Keep the bounded local fallback.
      }
      throw new HealthFetchError(message, 'http', response.status, 'agent', apiCode);
    }
    return parse(await response.json());
  } catch (error) {
    if (error instanceof HealthFetchError) throw error;
    throw new HealthFetchError('Task history is not reachable.', 'network', undefined, 'agent');
  }
}

export function fetchAgentTasks(fetchImpl?: typeof fetch): Promise<DurableTaskList> {
  return agentDataRequest('/api/agent/tasks', parseDurableTaskList, {}, fetchImpl);
}

export function fetchAgentProjects(fetchImpl?: typeof fetch): Promise<AgentProject[]> {
  return agentDataRequest(
    '/api/agent/projects',
    (value) => AgentProjectListSchema.parse(value).items,
    {},
    fetchImpl
  );
}

export function createAgentProject(
  input: CreateAgentProjectRequest,
  fetchImpl?: typeof fetch
): Promise<AgentProject> {
  return agentDataRequest(
    '/api/agent/projects/create',
    (value) => AgentProjectSchema.parse(value),
    {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'content-type': 'application/json' },
    },
    fetchImpl
  );
}

export function fetchAppPreview(projectId: string, fetchImpl?: typeof fetch): Promise<AppPreview> {
  return agentDataRequest(
    `/api/agent/projects/${encodeURIComponent(projectId)}/app`,
    (value) => AppPreviewSchema.parse(value),
    {},
    fetchImpl
  );
}

export function startAppPreview(
  input: StartAppPreviewRequest,
  fetchImpl?: typeof fetch
): Promise<AppPreview> {
  return agentDataRequest(
    `/api/agent/projects/${encodeURIComponent(input.projectId)}/app`,
    (value) => AppPreviewSchema.parse(value),
    {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'content-type': 'application/json' },
    },
    fetchImpl
  );
}

export function stopAppPreview(projectId: string, fetchImpl?: typeof fetch): Promise<AppPreview> {
  return agentDataRequest(
    `/api/agent/projects/${encodeURIComponent(projectId)}/app`,
    (value) => AppPreviewSchema.parse(value),
    { method: 'DELETE' },
    fetchImpl
  );
}

export function registerAgentProject(
  input: RegisterAgentProjectRequest,
  fetchImpl?: typeof fetch
): Promise<AgentProject> {
  return agentDataRequest(
    '/api/agent/projects',
    (value) => AgentProjectSchema.parse(value),
    {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'content-type': 'application/json' },
    },
    fetchImpl
  );
}

export function continueAgentTask(
  input: ContinueAgentTaskRequest,
  fetchImpl?: typeof fetch
): Promise<AgentRunSnapshot> {
  return agentRequest(
    `/api/agent/tasks/${encodeURIComponent(input.taskId)}/continue`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
    fetchImpl
  );
}

export function startAgentReview(
  input: StartAgentReviewRequest,
  fetchImpl?: typeof fetch
): Promise<AgentRunSnapshot> {
  return agentRequest(
    `/api/agent/tasks/${encodeURIComponent(input.taskId)}/reviews`,
    { method: 'POST', body: JSON.stringify(input) },
    fetchImpl
  );
}

export function startAgentCorrection(
  input: StartAgentCorrectionRequest,
  fetchImpl?: typeof fetch
): Promise<AgentRunSnapshot> {
  return agentRequest(
    `/api/agent/tasks/${encodeURIComponent(input.taskId)}/corrections`,
    { method: 'POST', body: JSON.stringify(input) },
    fetchImpl
  );
}

export function startAgentConflictResolution(
  input: StartAgentConflictResolutionRequest,
  fetchImpl?: typeof fetch
): Promise<AgentRunSnapshot> {
  return agentRequest(
    `/api/agent/tasks/${encodeURIComponent(input.taskId)}/conflict-resolutions`,
    { method: 'POST', body: JSON.stringify(input) },
    fetchImpl
  );
}

export function queueAgentFollowup(
  input: QueueAgentFollowupRequest,
  fetchImpl?: typeof fetch
): Promise<{ queued: true }> {
  return agentDataRequest(
    `/api/agent/tasks/${encodeURIComponent(input.taskId)}/follow-up`,
    (value) => {
      if ((value as { queued?: unknown }).queued !== true)
        throw new Error('Invalid follow-up response.');
      return { queued: true as const };
    },
    {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'content-type': 'application/json' },
    },
    fetchImpl
  );
}

export function answerAgentQuestion(
  input: AnswerAgentQuestionRequest,
  fetchImpl?: typeof fetch
): Promise<AgentRunSnapshot> {
  return agentRequest(
    `/api/agent/tasks/${encodeURIComponent(input.taskId)}/answer`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
    fetchImpl
  );
}

export function fetchAgentRunResult(
  runId: string,
  fetchImpl?: typeof fetch
): Promise<AgentRunResult> {
  return agentDataRequest(
    `/api/agent/runs/${encodeURIComponent(runId)}/result`,
    (value) => AgentRunResultSchema.parse(value),
    {},
    fetchImpl
  );
}

export function acceptAgentRunResult(
  input: AcceptAgentRunRequest,
  fetchImpl?: typeof fetch
): Promise<AgentRunResult> {
  return agentDataRequest(
    `/api/agent/runs/${encodeURIComponent(input.runId)}/accept`,
    (value) => AgentRunResultSchema.parse(value),
    {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'content-type': 'application/json' },
    },
    fetchImpl
  );
}

export function mergeAgentRunResult(
  input: MergeAgentRunRequest,
  fetchImpl?: typeof fetch
): Promise<AgentRunResult> {
  return agentDataRequest(
    `/api/agent/runs/${encodeURIComponent(input.runId)}/merge`,
    (value) => AgentRunResultSchema.parse(value),
    {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'content-type': 'application/json' },
    },
    fetchImpl
  );
}

export function startReleaseBuild(
  input: StartReleaseRequest,
  fetchImpl?: typeof fetch
): Promise<ReleaseJob> {
  return agentDataRequest(
    `/api/agent/tasks/${encodeURIComponent(input.taskId)}/releases`,
    (value) => ReleaseJobSchema.parse(value),
    {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'content-type': 'application/json' },
    },
    fetchImpl
  );
}

export function activateRelease(
  input: ActivateReleaseRequest,
  fetchImpl?: typeof fetch
): Promise<ReleaseJob> {
  return agentDataRequest(
    `/api/agent/tasks/${encodeURIComponent(input.taskId)}/releases/${encodeURIComponent(input.releaseId)}/activate`,
    (value) => ReleaseJobSchema.parse(value),
    {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'content-type': 'application/json' },
    },
    fetchImpl
  );
}

export async function rollbackRelease(
  input: RollbackReleaseRequest,
  fetchImpl?: typeof fetch
): Promise<{ accepted: true }> {
  return agentDataRequest(
    `/api/agent/tasks/${encodeURIComponent(input.taskId)}/releases/rollback`,
    (value) => {
      if (
        typeof value !== 'object' ||
        value === null ||
        !('accepted' in value) ||
        value.accepted !== true
      ) {
        throw new Error('Invalid rollback response.');
      }
      return { accepted: true as const };
    },
    {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'content-type': 'application/json' },
    },
    fetchImpl
  );
}

export function fetchAgentTask(
  taskId: string,
  fetchImpl?: typeof fetch
): Promise<DurableTaskDetail> {
  return agentDataRequest(
    `/api/agent/tasks/${encodeURIComponent(taskId)}`,
    parseDurableTaskDetail,
    {},
    fetchImpl
  );
}

export function fetchAgentRunTrace(
  runId: string,
  afterSequence = -1,
  limit = 100,
  fetchImpl?: typeof fetch
): Promise<DurableTracePage> {
  const query = new URLSearchParams({
    afterSequence: String(afterSequence),
    limit: String(limit),
  });
  return agentDataRequest(
    `/api/agent/runs/${encodeURIComponent(runId)}/trace?${query}`,
    parseDurableTracePage,
    {},
    fetchImpl
  );
}

export interface TraceCollectionOptions {
  /**
   * First sequence to request. `-1` (the default) collects the complete
   * trace; any other value starts incrementally after that sequence.
   */
  afterSequence?: number;
  /** Page size sent to the API. Defaults to 250, the largest page the contract allows. */
  limit?: number;
  /**
   * With `true` a stalled cursor throws instead of ending the collection
   * silently. Used by the full JSON export, which must never deliver a
   * truncated trace; incremental catch-up stops safely instead.
   */
  failOnStalledCursor?: boolean;
}

/**
 * Single cursor-pagination walk over `fetchAgentRunTrace`, shared by the
 * full trace export and the incremental task-detail catch-up. The cursor
 * always moves strictly forward; a page that does not advance it ends the
 * collection (or throws, for complete collections).
 */
export async function collectAgentRunTrace(
  runId: string,
  options: TraceCollectionOptions = {}
): Promise<DurableTraceEvent[]> {
  const limit = options.limit ?? 250;
  const failOnStalledCursor = options.failOnStalledCursor ?? false;
  let cursor = options.afterSequence ?? -1;
  const events: DurableTraceEvent[] = [];
  for (;;) {
    const page = await fetchAgentRunTrace(runId, cursor, limit);
    events.push(...page.items);
    if (!page.hasMore) return events;
    const next = page.nextAfterSequence;
    if (next === undefined || next <= cursor) {
      if (failOnStalledCursor) throw new Error('Trace cursor did not advance.');
      return events;
    }
    cursor = next;
  }
}

export async function deleteAgentTask(
  taskId: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<boolean> {
  const result = await agentDataRequest(
    `/api/agent/tasks/${encodeURIComponent(taskId)}`,
    (value) => value as { deleted?: unknown },
    { method: 'DELETE' },
    fetchImpl
  );
  return result.deleted === true;
}

export function regenerateAgentTaskTitle(
  taskId: string,
  fetchImpl?: typeof fetch
): Promise<RegenerateTaskTitleResult> {
  return agentDataRequest(
    `/api/agent/tasks/${encodeURIComponent(taskId)}/titles/regenerate`,
    (value) => RegenerateTaskTitleResultSchema.parse(value),
    { method: 'POST' },
    fetchImpl
  );
}

export function startAgentRun(
  input: StartAgentRunRequest,
  fetchImpl?: typeof fetch
): Promise<AgentRunSnapshot> {
  return agentRequest(
    '/api/agent/runs',
    { method: 'POST', body: JSON.stringify(input) },
    fetchImpl
  );
}

export async function steerAgentRun(
  input: SteerAgentRunRequest,
  fetchImpl?: typeof fetch
): Promise<AgentRunSnapshot> {
  try {
    return await agentRequest(
      `/api/agent/runs/${encodeURIComponent(input.runId)}/steer`,
      { method: 'POST', body: JSON.stringify(input) },
      fetchImpl
    );
  } catch (error) {
    // One-release rolling-upgrade bridge: the running pre-M6.3 server may
    // already serve freshly built assets before its process is restarted.
    // A new M6.3 server has this route and returns 410 on the legacy path, so
    // an actually stale/unknown run can never be silently redirected.
    if (!(error instanceof HealthFetchError) || error.status !== 404) throw error;
    return await agentRequest(
      '/api/agent/steer',
      { method: 'POST', body: JSON.stringify({ message: input.message }) },
      fetchImpl
    );
  }
}

export function cancelAgentRun(
  input: CancelAgentRunRequest,
  fetchImpl?: typeof fetch
): Promise<AgentRunSnapshot> {
  return agentRequest(
    `/api/agent/runs/${encodeURIComponent(input.runId)}/cancel`,
    { method: 'POST', body: JSON.stringify(input) },
    fetchImpl
  );
}

export interface AgentSubscriptionHandlers {
  onSnapshot: (snapshot: AgentRunSnapshot) => void;
  onEvent: (event: AgentStreamEvent) => void;
  onOpen?: () => void;
  onError?: (error: HealthFetchError) => void;
}

/** Dedicated content-bearing stream; opened only while the cockpit page is mounted. */
export function subscribeAgent(
  handlers: AgentSubscriptionHandlers,
  createEventSource: (url: string, init: EventSourceInit) => EventSource = (url, init) =>
    new EventSource(url, init)
): () => void {
  const source = createEventSource(AGENT_EVENTS_PATH, { withCredentials: true });
  source.addEventListener('agent_snapshot', (event) => {
    try {
      handlers.onSnapshot(parseAgentRunSnapshot(JSON.parse((event as MessageEvent<string>).data)));
    } catch {
      handlers.onError?.(
        new HealthFetchError(
          'Agent snapshot violates the API contract.',
          'invalid_payload',
          undefined,
          'agent'
        )
      );
    }
  });
  source.addEventListener('agent_event', (event) => {
    try {
      handlers.onEvent(parseAgentStreamEvent(JSON.parse((event as MessageEvent<string>).data)));
    } catch {
      handlers.onError?.(
        new HealthFetchError(
          'Agent event violates the API contract.',
          'invalid_payload',
          undefined,
          'agent'
        )
      );
    }
  });
  source.onopen = () => handlers.onOpen?.();
  source.onerror = () =>
    handlers.onError?.(
      new HealthFetchError(
        'Agent live connection interrupted; reconnecting.',
        'network',
        undefined,
        'agent'
      )
    );
  return () => source.close();
}

export async function fetchSpeechStatus() {
  const response = await fetch('/api/speech/status', { credentials: 'same-origin' });
  if (!response.ok) throw new Error('Speech status unavailable');
  return SpeechStatusSchema.parse(await response.json());
}

export async function transcribeSpeech(audio: Blob, signal: AbortSignal): Promise<string> {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read audio'));
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(audio);
  });
  const timeout = AbortSignal.timeout(115_000);
  const response = await fetch('/api/speech/transcribe', {
    method: 'POST',
    credentials: 'same-origin',
    signal: AbortSignal.any([signal, timeout]),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data, mimeType: audio.type.split(';')[0], language: 'de-DE' }),
  });
  if (!response.ok) throw new Error('Transcription failed');
  return SpeechResultSchema.parse(await response.json()).text;
}

export function pauseAgentRun(input: CancelAgentRunRequest): Promise<AgentRunSnapshot> {
  return agentRequest(`/api/agent/runs/${encodeURIComponent(input.runId)}/pause`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function fetchProjectArchitecture(projectId: string) {
  return agentDataRequest(
    `/api/agent/projects/${encodeURIComponent(projectId)}/architecture`,
    (value) => ProjectArchitectureSchema.parse(value),
    {}
  );
}

export function fetchAgentLiveChanges(
  taskId: string,
  runId: string,
  signal?: AbortSignal,
  refresh = false
): Promise<AgentLiveChanges> {
  return agentDataRequest(
    `/api/agent/tasks/${encodeURIComponent(taskId)}/changes?${new URLSearchParams({ runId, ...(refresh ? { refresh: '1' } : {}) })}`,
    (value) => AgentLiveChangesSchema.parse(value),
    { signal }
  );
}
export function fetchAgentTaskTelemetry(
  taskId: string,
  signal?: AbortSignal
): Promise<AgentTaskTelemetry> {
  return agentDataRequest(
    `/api/agent/tasks/${encodeURIComponent(taskId)}/telemetry`,
    (value) => AgentTaskTelemetrySchema.parse(value),
    { signal }
  );
}

export function memoryRequest(
  input: MemoryRequest,
  fetchImpl?: typeof fetch
): Promise<MemoryResponse> {
  return agentDataRequest(
    '/api/agent/memory',
    (value) => MemoryResponseSchema.parse(value),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(MemoryRequestSchema.parse(input)),
    },
    fetchImpl
  );
}
