import { reduceAgentTimeline } from '@observatory/contracts';
import { onMounted, onUnmounted, ref, type Ref } from 'vue';
import { t } from '../lib/i18n.js';
import type {
  AgentRunSnapshot,
  AgentInputImage,
  AgentStreamEvent,
  DurableTaskDetail,
  DurableTaskList,
  DurableTraceEvent,
  AgentProject,
  AgentRunResult,
  ReleaseJob,
  StartAgentRunRequest,
  StartAgentReviewRequest,
  StartAgentCorrectionRequest,
  StartAgentConflictResolutionRequest,
} from '@observatory/contracts';
import {
  deleteAgentTask,
  cancelAgentRun,
  pauseAgentRun,
  continueAgentTask,
  queueAgentFollowup,
  answerAgentQuestion,
  acceptAgentRunResult,
  mergeAgentRunResult,
  fetchAgentProjects,
  fetchAgent,
  fetchAgentTask,
  collectAgentRunTrace,
  fetchAgentTasks,
  startAgentRun,
  startAgentReview,
  startAgentCorrection,
  startAgentConflictResolution,
  startReleaseBuild,
  activateRelease,
  rollbackRelease,
  steerAgentRun,
  subscribeAgent,
  HealthFetchError,
} from '../lib/api.js';
import { createUuid } from '../lib/uuid.js';
import { clearAgentDrafts } from '../lib/drafts.js';

export type AgentConnection = 'connecting' | 'connected' | 'disconnected';
export type AgentStreamSignal = 'open' | 'snapshot' | 'transport_error' | 'schema_error';

export interface AgentStreamState {
  connection: AgentConnection;
  issue?: { kind: 'transport' | 'schema'; message: string };
}

const MAX_CACHED_TASK_DETAILS = 30;
const taskDetailCache = new Map<string, DurableTaskDetail>();
let taskListCache: DurableTaskList = { items: [], activeTaskIds: [] };

/**
 * Key of the cross-component task-detail cache. The scope is always
 * `undefined` for now; the composite shape is already in place so a later
 * project-scope id can be passed in without touching the cache machinery.
 */
export function taskDetailKey(scopeId: string | undefined, taskId: string): string {
  return scopeId === undefined ? taskId : `${scopeId}:${taskId}`;
}

function rememberTaskDetail(taskId: string, detail: DurableTaskDetail): void {
  const key = taskDetailKey(undefined, taskId);
  // Re-inserting moves the entry to the most-recently-used end.
  taskDetailCache.delete(key);
  taskDetailCache.set(key, detail);
  // Bound the cache: evict the least recently used details beyond the limit.
  while (taskDetailCache.size > MAX_CACHED_TASK_DETAILS) {
    const oldest = taskDetailCache.keys().next().value;
    if (oldest === undefined) break;
    taskDetailCache.delete(oldest);
  }
}

export function clearAgentCockpitCache(): void {
  taskDetailCache.clear();
  taskListCache = { items: [], activeTaskIds: [] };
  // Signing out must also drop the locally kept input drafts of this browser.
  clearAgentDrafts();
}

export function reduceAgentStreamState(
  current: AgentStreamState,
  signal: AgentStreamSignal,
  message = ''
): AgentStreamState {
  if (signal === 'snapshot') return { connection: 'connected' };
  if (signal === 'open') return { ...current, connection: 'connected' };
  if (signal === 'transport_error') {
    return { connection: 'disconnected', issue: { kind: 'transport', message } };
  }
  return { ...current, issue: { kind: 'schema', message } };
}

/** Pure reducer shared by the live client and tests. */
export function reduceAgentSnapshot(
  current: AgentRunSnapshot,
  event: AgentStreamEvent
): AgentRunSnapshot {
  // A reset starts a new authoritative run/generation whose local sequence
  // can legitimately be lower than the previously displayed run.
  if (event.operation === 'reset') return event.snapshot;
  if (event.sequence <= current.sequence) return current;
  if (event.operation === 'state') {
    return {
      ...event.state,
      activeRuns: event.state.activeRuns ?? current.activeRuns,
      maxActiveRuns: event.state.maxActiveRuns ?? current.maxActiveRuns,
      timeline: current.timeline,
    };
  }
  return {
    ...current,
    sequence: event.sequence,
    timeline: reduceAgentTimeline(current.timeline, event),
  };
}

/** Reconcile HTTP reads while allowing an SSE snapshot to reset after restart. */
export function reconcileAgentSnapshot(
  current: AgentRunSnapshot | undefined,
  next: AgentRunSnapshot,
  authoritative = false
): AgentRunSnapshot {
  if (authoritative || current === undefined || next.sequence >= current.sequence) return next;
  return current;
}

export function appendTaskTrace(
  detail: DurableTaskDetail,
  events: readonly DurableTraceEvent[]
): DurableTaskDetail {
  let latestSnapshot = detail.latestSnapshot;
  if (latestSnapshot === undefined || events.length === 0) return detail;
  for (const item of events) latestSnapshot = reduceAgentSnapshot(latestSnapshot!, item.event);
  return {
    ...detail,
    latestSnapshot,
    traceEventCount: detail.traceEventCount + events.length,
  };
}

/**
 * Reconcile two HTTP detail reads of the same task: an older reply must not
 * roll back a run snapshot that a newer reply or the stream already advanced.
 * Different runs are distinct generations and the incoming read wins.
 */
export function settleTaskDetail(
  existing: DurableTaskDetail | undefined,
  incoming: DurableTaskDetail
): DurableTaskDetail {
  if (existing === undefined || existing.task.id !== incoming.task.id) return incoming;
  const current = existing.latestSnapshot;
  const next = incoming.latestSnapshot;
  if (
    current !== undefined &&
    next !== undefined &&
    current.runId === next.runId &&
    next.sequence < current.sequence
  ) {
    return { ...incoming, latestSnapshot: current };
  }
  return incoming;
}

function displayError(error: unknown): string {
  if (error instanceof HealthFetchError) return error.message;
  return t('agent.actionFailed');
}

export interface AgentCockpitState {
  snapshot: Ref<AgentRunSnapshot | undefined>;
  connection: Ref<AgentConnection>;
  error: Ref<string>;
  streamIssue: Ref<AgentStreamState['issue']>;
  submitting: Ref<boolean>;
  steering: Ref<boolean>;
  cancelling: Ref<boolean>;
  continuing: Ref<boolean>;
  accepting: Ref<boolean>;
  merging: Ref<boolean>;
  reviewing: Ref<boolean>;
  correcting: Ref<boolean>;
  resolving: Ref<boolean>;
  conflictedRunId: Ref<string | undefined>;
  releasing: Ref<boolean>;
  deploying: Ref<boolean>;
  projects: Ref<AgentProject[]>;
  tasks: Ref<DurableTaskList>;
  selectedTaskId: Ref<string | undefined>;
  selectedTask: Ref<DurableTaskDetail | undefined>;
  tasksLoading: Ref<boolean>;
  start: (input: StartAgentRunRequest) => Promise<boolean>;
  steer: (message: string) => Promise<boolean>;
  cancel: () => Promise<boolean>;
  pause: () => Promise<boolean>;
  continueTask: (message: string, images?: AgentInputImage[]) => Promise<boolean>;
  queueFollowup: (message: string) => Promise<boolean>;
  answerQuestion: (answer: string) => Promise<boolean>;
  acceptResult: (result: AgentRunResult) => Promise<boolean>;
  mergeResult: (result: AgentRunResult) => Promise<boolean>;
  startReview: (
    input: Omit<StartAgentReviewRequest, 'taskId' | 'idempotencyKey'>
  ) => Promise<boolean>;
  startCorrection: (
    input: Omit<StartAgentCorrectionRequest, 'taskId' | 'idempotencyKey'>
  ) => Promise<boolean>;
  resolveConflict: (result: AgentRunResult) => Promise<boolean>;
  startRelease: (result: AgentRunResult) => Promise<boolean>;
  activateRelease: (release: ReleaseJob) => Promise<boolean>;
  rollbackRelease: () => Promise<boolean>;
  refreshProjects: () => Promise<void>;
  selectTask: (taskId: string) => Promise<void>;
  showTaskList: () => void;
  removeTask: (taskId: string) => Promise<boolean>;
  refreshTasks: (runId?: string) => Promise<void>;
  reconnect: () => void;
}

export function useAgentCockpit(): AgentCockpitState {
  const snapshot = ref<AgentRunSnapshot>();
  const connection = ref<AgentConnection>('connecting');
  const error = ref('');
  const streamIssue = ref<AgentStreamState['issue']>();
  const submitting = ref(false);
  const steering = ref(false);
  const cancelling = ref(false);
  const continuing = ref(false);
  const accepting = ref(false);
  const merging = ref(false);
  const reviewing = ref(false);
  const correcting = ref(false);
  const resolving = ref(false);
  const conflictedRunId = ref<string>();
  const releasing = ref(false);
  const deploying = ref(false);
  const projects = ref<AgentProject[]>([]);
  const tasks = ref<DurableTaskList>(taskListCache);
  const selectedTaskId = ref<string>();
  const selectedTask = ref<DurableTaskDetail>();
  const tasksLoading = ref(false);
  let taskRequest = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let taskRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  // Lifecycle/selection/request generations. A user navigation or unmount
  // invalidates every pending read; in-flight backend mutations may finish
  // but must not revive the left view or repopulate shared state.
  let disposed = false;
  let selectionGeneration = 0;
  let listGeneration = 0;

  const hasPendingDelivery = (detail: DurableTaskDetail | undefined): boolean =>
    detail !== undefined &&
    ['queued', 'starting', 'running'].includes(detail.task.latestRun.status) &&
    detail.steering.some(
      (entry) => entry.confirmedAt === undefined && entry.status !== 'cancelled'
    );

  const scheduleTaskRefresh = (): void => {
    if (disposed) return;
    if (taskRefreshTimer !== undefined) clearTimeout(taskRefreshTimer);
    const pending =
      selectedTask.value?.task.latestRun.status === 'queued' ||
      selectedTask.value?.releases.some((release) =>
        ['queued', 'building', 'activating'].includes(release.status)
      ) ||
      selectedTask.value?.deployment?.status === 'activating' ||
      hasPendingDelivery(selectedTask.value);
    if (!pending || selectedTaskId.value === undefined) {
      taskRefreshTimer = undefined;
      return;
    }
    taskRefreshTimer = setTimeout(() => {
      taskRefreshTimer = undefined;
      if (!disposed) void refreshTasks();
    }, 1_000);
  };

  const applyStreamSignal = (signal: AgentStreamSignal, message = ''): void => {
    if (disposed) return;
    const next = reduceAgentStreamState(
      { connection: connection.value, issue: streamIssue.value },
      signal,
      message
    );
    connection.value = next.connection;
    streamIssue.value = next.issue;
  };

  const applySnapshot = (next: AgentRunSnapshot, authoritative = false): void => {
    if (disposed) return;
    snapshot.value = reconcileAgentSnapshot(snapshot.value, next, authoritative);
    updateCachedRunSnapshot(next, authoritative);
  };

  /**
   * Keep the per-run detail cache in step with the global snapshot: the same
   * sequence reconciliation applies to the global snapshot and to each
   * cached run, so a stale HTTP answer cannot roll back a cached run that the
   * stream already advanced. Authoritative sources (SSE snapshots, resets)
   * still replace unconditionally.
   */
  const updateCachedRunSnapshot = (next: AgentRunSnapshot, authoritative = false): void => {
    if (next.runId === undefined) return;
    for (const [taskId, detail] of taskDetailCache) {
      if (detail.task.latestRun.id !== next.runId) continue;
      const reconciled = reconcileAgentSnapshot(detail.latestSnapshot, next, authoritative);
      if (reconciled === detail.latestSnapshot) continue;
      const updated = { ...detail, latestSnapshot: reconciled };
      taskDetailCache.set(taskId, updated);
      if (selectedTaskId.value === taskId) selectedTask.value = updated;
      break;
    }
  };

  const reconnect = (): void => {
    if (disposed) return;
    unsubscribe?.();
    connection.value = 'connecting';
    streamIssue.value = undefined;
    error.value = '';
    unsubscribe = subscribeAgent({
      // A stream snapshot is authoritative, including after a server restart
      // where the new in-memory manager legitimately begins again at seq 0.
      onSnapshot: (next) => {
        applySnapshot(next, true);
        applyStreamSignal('snapshot');
        void refreshTasks();
      },
      onEvent: (event) => {
        const eventRunId =
          event.runId ??
          (event.operation === 'reset'
            ? event.snapshot.runId
            : event.operation === 'state'
              ? event.state.runId
              : undefined);
        if (eventRunId !== undefined) {
          const cached = [...taskDetailCache.values()].find(
            (detail) => detail.task.latestRun.id === eventRunId
          );
          const current =
            snapshot.value?.runId === eventRunId ? snapshot.value : cached?.latestSnapshot;
          if (current !== undefined || event.operation === 'reset') {
            const next =
              event.operation === 'reset' ? event.snapshot : reduceAgentSnapshot(current!, event);
            updateCachedRunSnapshot(next, true);
            if (!disposed && snapshot.value?.runId === eventRunId) snapshot.value = next;
          }
        }
        if (
          (event.operation === 'state' || event.operation === 'reset') &&
          refreshTimer === undefined
        ) {
          refreshTimer = setTimeout(() => {
            refreshTimer = undefined;
            if (!disposed) void refreshTasks();
          }, 150);
        }
      },
      onOpen: () => {
        applyStreamSignal('open');
      },
      onError: (cause) => {
        applyStreamSignal(
          cause.code === 'invalid_payload' ? 'schema_error' : 'transport_error',
          cause.message
        );
      },
    });
  };

  /**
   * Load the detail for `taskId` without touching the selection generation.
   * Only writes the visible detail when this request is still the current
   * one and the user is still on this task; a switch to an uncached task
   * drops the previous task's detail so no stale detail stays actionable.
   */
  const loadTaskDetail = async (taskId: string): Promise<void> => {
    if (disposed) return;
    const request = ++taskRequest;
    const cached = taskDetailCache.get(taskDetailKey(undefined, taskId));
    if (cached !== undefined) {
      selectedTask.value = cached;
    } else if (selectedTask.value?.task.id !== taskId) {
      selectedTask.value = undefined;
    }
    tasksLoading.value = cached === undefined;
    try {
      const summary = tasks.value.items.find((item) => item.id === taskId);
      const metadataChanged =
        cached === undefined ||
        summary === undefined ||
        cached.task.version !== summary.version ||
        cached.task.latestRun.version !== summary.latestRun.version ||
        // Delivery confirmation does not change the task/run versions. Refresh
        // this short-lived ledger until its entries are confirmed or cancelled.
        hasPendingDelivery(cached);
      let detail = metadataChanged ? await fetchAgentTask(taskId) : cached;
      const mayHaveAdvanced = ['queued', 'starting', 'running'].includes(
        summary?.latestRun.status ?? ''
      );
      if (!metadataChanged && mayHaveAdvanced && detail.latestSnapshot !== undefined) {
        detail = appendTaskTrace(
          detail,
          await collectAgentRunTrace(detail.task.latestRun.id, {
            afterSequence: detail.latestSnapshot.sequence,
          })
        );
      }
      if (disposed) return;
      // Reconcile against the best already-known detail before publishing, so
      // an older overlapping read cannot regress the shared cache or the
      // visible detail of the run.
      const settled = settleTaskDetail(
        taskDetailCache.get(taskDetailKey(undefined, taskId)),
        detail
      );
      rememberTaskDetail(taskId, settled);
      if (selectedTaskId.value === taskId) {
        selectedTask.value = settled;
        if (request === taskRequest) scheduleTaskRefresh();
      }
    } catch (cause) {
      if (!disposed && request === taskRequest) error.value = displayError(cause);
    } finally {
      if (!disposed && request === taskRequest) tasksLoading.value = false;
    }
  };

  /** User navigation: a new selection generation invalidates older reads. */
  const selectTask = async (taskId: string): Promise<void> => {
    selectionGeneration += 1;
    selectedTaskId.value = taskId;
    await loadTaskDetail(taskId);
  };

  /**
   * Re-run the detail read for the current selection (for example after a
   * refresh or a completed mutation). Deliberately does not start a new
   * selection generation: this is a refresh, not a user navigation.
   */
  const reselectTask = async (taskId: string): Promise<void> => {
    selectedTaskId.value = taskId;
    await loadTaskDetail(taskId);
  };

  /**
   * Settle a mutation that originated from `taskId`: when the user is still
   * on that task, refresh its visible detail; when the user has navigated
   * away, only keep the origin task's cache fresh. The visible selection is
   * never stolen back from the user's newer navigation.
   */
  const settleMutationOrigin = async (taskId: string): Promise<void> => {
    if (disposed) return;
    if (selectedTaskId.value === taskId) {
      await reselectTask(taskId);
      return;
    }
    try {
      const fresh = await fetchAgentTask(taskId);
      if (!disposed) rememberTaskDetail(taskId, fresh);
    } catch {
      // The refreshed task list already reflects the durable state.
    }
  };

  const showTaskList = (): void => {
    taskRequest += 1;
    selectionGeneration += 1;
    selectedTaskId.value = undefined;
    selectedTask.value = undefined;
  };

  const refreshTasks = async (): Promise<void> => {
    if (disposed) return;
    const generation = ++listGeneration;
    try {
      const next = await fetchAgentTasks();
      // Only the newest request may publish the list; an older overlapping
      // answer must not overwrite the shared list cache or clear a selection
      // that a newer list has already validated.
      if (disposed || generation !== listGeneration) return;
      taskListCache = next;
      tasks.value = next;
      const selectedStillExists = next.items.some((item) => item.id === selectedTaskId.value);
      if (!selectedStillExists && selectedTaskId.value !== undefined) {
        showTaskList();
        return;
      }
      const preferred = selectedTaskId.value;
      if (preferred !== undefined) await reselectTask(preferred);
    } catch {
      // Runner availability is already represented by the main snapshot.
    }
  };

  const refreshProjects = async (): Promise<void> => {
    try {
      const next = await fetchAgentProjects();
      if (!disposed) projects.value = next;
    } catch {
      // Main runner state already communicates availability. Keep navigation usable.
    }
  };

  onMounted(() => {
    void fetchAgent()
      .then((next) => applySnapshot(next))
      .catch((cause) => {
        if (!disposed) error.value = displayError(cause);
      });
    reconnect();
    void refreshProjects();
    void refreshTasks();
  });
  onUnmounted(() => {
    disposed = true;
    unsubscribe?.();
    unsubscribe = undefined;
    if (refreshTimer !== undefined) {
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
    if (taskRefreshTimer !== undefined) {
      clearTimeout(taskRefreshTimer);
      taskRefreshTimer = undefined;
    }
    // Invalidate every in-flight read so a late reply cannot write the
    // shared cache, touch the refs or schedule timers/polling anymore.
    taskRequest += 1;
    listGeneration += 1;
    selectionGeneration += 1;
  });

  const start = async (input: StartAgentRunRequest): Promise<boolean> => {
    submitting.value = true;
    error.value = '';
    // Only an explicit new-task start may navigate to the created task, and
    // only while the user has not navigated elsewhere in the meantime.
    const generationAtStart = selectionGeneration;
    try {
      // The successful start response identifies the newly created run. Its
      // sequence starts fresh and must replace the older completed run.
      const started = await startAgentRun({
        ...input,
        idempotencyKey: input.idempotencyKey ?? createUuid(),
      });
      applySnapshot(started, true);
      await refreshTasks();
      const startedTask = tasks.value.items.find((item) => item.latestRun.id === started.runId);
      if (startedTask !== undefined && generationAtStart === selectionGeneration) {
        await selectTask(startedTask.id);
      }
      return true;
    } catch (cause) {
      if (generationAtStart === selectionGeneration) error.value = displayError(cause);
      return false;
    } finally {
      submitting.value = false;
    }
  };

  const removeTask = async (taskId: string): Promise<boolean> => {
    error.value = '';
    try {
      if (!(await deleteAgentTask(taskId))) return false;
      if (disposed) return true;
      taskDetailCache.delete(taskId);
      if (selectedTaskId.value === taskId) {
        selectedTaskId.value = undefined;
        selectedTask.value = undefined;
      }
      await refreshTasks();
      return true;
    } catch (cause) {
      if (!disposed) error.value = displayError(cause);
      return false;
    }
  };

  const steer = async (message: string): Promise<boolean> => {
    // Only act on a detail that matches the current selection; a detail of
    // another (still loading or abandoned) task must never supply run IDs
    // and versions for a mutation.
    const detail = selectedTask.value;
    if (detail === undefined || detail.task.id !== selectedTaskId.value) return false;
    const taskId = detail.task.id;
    steering.value = true;
    error.value = '';
    try {
      const run = detail.task.latestRun;
      const next = await steerAgentRun({
        runId: run.id,
        expectedRunVersion: run.version,
        expectedTaskVersion: detail.task.version,
        message,
        idempotencyKey: createUuid(),
      });
      applySnapshot(next, snapshot.value?.runId !== next.runId);
      await settleMutationOrigin(taskId);
      return true;
    } catch (cause) {
      if (selectedTaskId.value === taskId) error.value = displayError(cause);
      return false;
    } finally {
      steering.value = false;
    }
  };

  const pause = async (): Promise<boolean> => {
    const detail = selectedTask.value;
    if (detail === undefined || detail.task.id !== selectedTaskId.value) return false;
    const taskId = detail.task.id;
    cancelling.value = true;
    error.value = '';
    try {
      const fresh = await fetchAgentTask(taskId);
      if (disposed) return false;
      const next = await pauseAgentRun({
        runId: fresh.task.latestRun.id,
        expectedRunVersion: fresh.task.latestRun.version,
        expectedTaskVersion: fresh.task.version,
        idempotencyKey: createUuid(),
      });
      applySnapshot(next, snapshot.value?.runId !== next.runId);
      await refreshTasks();
      await settleMutationOrigin(taskId);
      return true;
    } catch (cause) {
      if (selectedTaskId.value === taskId) error.value = displayError(cause);
      return false;
    } finally {
      cancelling.value = false;
    }
  };

  const cancel = async (): Promise<boolean> => {
    const detail = selectedTask.value;
    if (detail === undefined || detail.task.id !== selectedTaskId.value) return false;
    const taskId = detail.task.id;
    cancelling.value = true;
    error.value = '';
    try {
      const run = detail.task.latestRun;
      const next = await cancelAgentRun({
        runId: run.id,
        expectedRunVersion: run.version,
        expectedTaskVersion: detail.task.version,
        idempotencyKey: createUuid(),
      });
      applySnapshot(next, snapshot.value?.runId !== next.runId);
      await refreshTasks();
      await settleMutationOrigin(taskId);
      return true;
    } catch (cause) {
      if (selectedTaskId.value === taskId) error.value = displayError(cause);
      return false;
    } finally {
      cancelling.value = false;
    }
  };

  const continueTask = async (message: string, images?: AgentInputImage[]): Promise<boolean> => {
    const detail = selectedTask.value;
    if (detail === undefined || detail.task.id !== selectedTaskId.value) return false;
    const taskId = detail.task.id;
    continuing.value = true;
    error.value = '';
    try {
      const next = await continueAgentTask({
        taskId,
        message,
        ...(images === undefined || images.length === 0 ? {} : { images }),
        idempotencyKey: createUuid(),
      });
      applySnapshot(next, true);
      await refreshTasks();
      await settleMutationOrigin(taskId);
      return true;
    } catch (cause) {
      if (selectedTaskId.value === taskId) error.value = displayError(cause);
      return false;
    } finally {
      continuing.value = false;
    }
  };

  const queueFollowup = async (message: string): Promise<boolean> => {
    const detail = selectedTask.value;
    if (detail === undefined || detail.task.id !== selectedTaskId.value) return false;
    const taskId = detail.task.id;
    continuing.value = true;
    error.value = '';
    try {
      await queueAgentFollowup({
        taskId,
        message,
        idempotencyKey: createUuid(),
      });
      await refreshTasks();
      await settleMutationOrigin(taskId);
      return true;
    } catch (cause) {
      if (selectedTaskId.value === taskId) error.value = displayError(cause);
      return false;
    } finally {
      continuing.value = false;
    }
  };

  const answerQuestion = async (answer: string): Promise<boolean> => {
    const detail = selectedTask.value;
    const question = detail?.openQuestion;
    if (detail === undefined || question === undefined || detail.task.id !== selectedTaskId.value)
      return false;
    const taskId = detail.task.id;
    continuing.value = true;
    error.value = '';
    try {
      // A question, queued follow-up or terminal run event can advance the
      // durable task version while the form is already visible. Resolve the
      // authoritative version immediately before mutating; the user must
      // never have to reload the whole application to answer.
      const fresh = await fetchAgentTask(taskId);
      if (disposed) return false;
      rememberTaskDetail(taskId, fresh);
      if (selectedTaskId.value === taskId) selectedTask.value = fresh;
      const next = await answerAgentQuestion({
        taskId,
        questionId: question.id,
        answer,
        expectedTaskVersion: fresh.task.version,
        idempotencyKey: createUuid(),
      });
      applySnapshot(next, true);
      await refreshTasks();
      await settleMutationOrigin(taskId);
      return true;
    } catch (cause) {
      if (selectedTaskId.value === taskId) error.value = displayError(cause);
      try {
        const fresh = await fetchAgentTask(taskId);
        if (disposed) return false;
        rememberTaskDetail(taskId, fresh);
        if (selectedTaskId.value === taskId) selectedTask.value = fresh;
        await refreshTasks();
      } catch {
        // Preserve the original actionable mutation error.
      }
      return false;
    } finally {
      continuing.value = false;
    }
  };

  const acceptResult = async (result: AgentRunResult): Promise<boolean> => {
    const detail = selectedTask.value;
    if (detail === undefined || detail.task.id !== selectedTaskId.value) return false;
    const taskId = detail.task.id;
    accepting.value = true;
    error.value = '';
    try {
      await acceptAgentRunResult({
        runId: result.runId,
        resultRevision: result.resultRevision,
        expectedTaskVersion: detail.task.version,
      });
      await refreshTasks();
      // Keep the origin task's cache fresh even when the user switched away;
      // the visible selection itself stays untouched.
      try {
        const fresh = await fetchAgentTask(taskId);
        if (!disposed) rememberTaskDetail(taskId, fresh);
      } catch {
        // The refreshed task list already reflects the durable state.
      }
      // The user may have switched tasks while the request was in flight;
      // never jump back to the task that triggered the request.
      if (selectedTaskId.value === taskId) await reselectTask(taskId);
      return true;
    } catch (cause) {
      if (selectedTaskId.value === taskId) error.value = displayError(cause);
      // Keep the cache fresh so an idempotent retry is offered directly.
      try {
        const fresh = await fetchAgentTask(taskId);
        if (disposed) return false;
        rememberTaskDetail(taskId, fresh);
        if (selectedTaskId.value === taskId) selectedTask.value = fresh;
      } catch {
        // Preserve the original actionable mutation error.
      }
      return false;
    } finally {
      accepting.value = false;
    }
  };

  const mergeResult = async (result: AgentRunResult): Promise<boolean> => {
    const detail = selectedTask.value;
    if (
      detail === undefined ||
      detail.task.id !== selectedTaskId.value ||
      result.acceptedAt === undefined ||
      result.acceptedRevision !== result.resultRevision
    )
      return false;
    const taskId = detail.task.id;
    merging.value = true;
    // A new merge attempt replaces any stale conflict marker of an older
    // attempt; the marker never carries across tasks.
    conflictedRunId.value = undefined;
    error.value = '';
    try {
      const fresh = await fetchAgentTask(taskId);
      if (disposed) return false;
      rememberTaskDetail(taskId, fresh);
      if (selectedTaskId.value === taskId) selectedTask.value = fresh;
      await mergeAgentRunResult({
        runId: result.runId,
        resultRevision: result.resultRevision,
        expectedTaskVersion: fresh.task.version,
      });
      await refreshTasks();
      // Keep the origin task's cache fresh even when the user switched away;
      // the visible selection itself stays untouched.
      try {
        const freshAfter = await fetchAgentTask(taskId);
        if (!disposed) rememberTaskDetail(taskId, freshAfter);
      } catch {
        // The refreshed task list already reflects the durable state.
      }
      // The user may have switched tasks while the request was in flight;
      // never jump back to the task that triggered the request.
      if (selectedTaskId.value === taskId) await reselectTask(taskId);
      return true;
    } catch (cause) {
      if (
        cause instanceof HealthFetchError &&
        cause.apiCode === 'merge_conflict' &&
        selectedTaskId.value === taskId
      ) {
        conflictedRunId.value = result.runId;
      }
      if (selectedTaskId.value === taskId) error.value = displayError(cause);
      try {
        const fresh = await fetchAgentTask(taskId);
        if (disposed) return false;
        rememberTaskDetail(taskId, fresh);
        if (selectedTaskId.value === taskId) selectedTask.value = fresh;
      } catch {
        // Preserve the original actionable mutation error.
      }
      return false;
    } finally {
      merging.value = false;
    }
  };

  const resolveConflict = async (result: AgentRunResult): Promise<boolean> => {
    const detail = selectedTask.value;
    if (
      detail === undefined ||
      detail.task.id !== selectedTaskId.value ||
      conflictedRunId.value !== result.runId
    )
      return false;
    const taskId = detail.task.id;
    resolving.value = true;
    error.value = '';
    try {
      const fresh = await fetchAgentTask(taskId);
      if (disposed) return false;
      rememberTaskDetail(taskId, fresh);
      if (selectedTaskId.value === taskId) selectedTask.value = fresh;
      const input: StartAgentConflictResolutionRequest = {
        taskId: fresh.task.id,
        sourceRunId: result.runId,
        resultRevision: result.resultRevision,
        expectedTaskVersion: fresh.task.version,
        idempotencyKey: createUuid(),
      };
      const next = await startAgentConflictResolution(input);
      conflictedRunId.value = undefined;
      applySnapshot(next, true);
      await refreshTasks();
      await settleMutationOrigin(taskId);
      return true;
    } catch (cause) {
      if (selectedTaskId.value === taskId) error.value = displayError(cause);
      return false;
    } finally {
      resolving.value = false;
    }
  };

  const startReview = async (
    input: Omit<StartAgentReviewRequest, 'taskId' | 'idempotencyKey'>
  ): Promise<boolean> => {
    const detail = selectedTask.value;
    if (detail === undefined || detail.task.id !== selectedTaskId.value) return false;
    const taskId = detail.task.id;
    reviewing.value = true;
    error.value = '';
    try {
      const next = await startAgentReview({
        ...input,
        taskId,
        idempotencyKey: createUuid(),
      });
      applySnapshot(next, true);
      await refreshTasks();
      await settleMutationOrigin(taskId);
      return true;
    } catch (cause) {
      if (selectedTaskId.value === taskId) error.value = displayError(cause);
      return false;
    } finally {
      reviewing.value = false;
    }
  };

  const startCorrection = async (
    input: Omit<StartAgentCorrectionRequest, 'taskId' | 'idempotencyKey'>
  ): Promise<boolean> => {
    const detail = selectedTask.value;
    if (detail === undefined || detail.task.id !== selectedTaskId.value) return false;
    const taskId = detail.task.id;
    correcting.value = true;
    error.value = '';
    try {
      const next = await startAgentCorrection({
        ...input,
        taskId,
        idempotencyKey: createUuid(),
      });
      applySnapshot(next, true);
      await refreshTasks();
      await settleMutationOrigin(taskId);
      return true;
    } catch (cause) {
      if (selectedTaskId.value === taskId) error.value = displayError(cause);
      return false;
    } finally {
      correcting.value = false;
    }
  };

  const startRelease = async (result: AgentRunResult): Promise<boolean> => {
    const detail = selectedTask.value;
    if (
      detail === undefined ||
      detail.task.id !== selectedTaskId.value ||
      result.mergedAt === undefined ||
      result.acceptedRevision !== result.resultRevision
    )
      return false;
    const taskId = detail.task.id;
    releasing.value = true;
    error.value = '';
    try {
      await startReleaseBuild({
        taskId,
        runId: result.runId,
        revision: result.resultRevision,
        idempotencyKey: createUuid(),
      });
      await refreshTasks();
      await settleMutationOrigin(taskId);
      if (selectedTaskId.value === taskId) scheduleTaskRefresh();
      return true;
    } catch (cause) {
      if (selectedTaskId.value === taskId) error.value = displayError(cause);
      return false;
    } finally {
      releasing.value = false;
    }
  };

  const activatePreparedRelease = async (release: ReleaseJob): Promise<boolean> => {
    const detail = selectedTask.value;
    if (
      detail === undefined ||
      detail.task.id !== selectedTaskId.value ||
      release.artifactDigest === undefined
    )
      return false;
    const taskId = detail.task.id;
    deploying.value = true;
    error.value = '';
    try {
      await activateRelease({
        taskId,
        releaseId: release.id,
        revision: release.revision,
        digest: release.artifactDigest,
      });
      await settleMutationOrigin(taskId);
      if (selectedTaskId.value === taskId) scheduleTaskRefresh();
      return true;
    } catch (cause) {
      if (selectedTaskId.value === taskId) error.value = displayError(cause);
      return false;
    } finally {
      deploying.value = false;
    }
  };

  const rollbackActiveRelease = async (): Promise<boolean> => {
    const detail = selectedTask.value;
    if (detail === undefined || detail.task.id !== selectedTaskId.value) return false;
    const taskId = detail.task.id;
    deploying.value = true;
    error.value = '';
    try {
      await rollbackRelease({ taskId });
      await settleMutationOrigin(taskId);
      if (selectedTaskId.value === taskId) scheduleTaskRefresh();
      return true;
    } catch (cause) {
      if (selectedTaskId.value === taskId) error.value = displayError(cause);
      return false;
    } finally {
      deploying.value = false;
    }
  };

  return {
    snapshot,
    connection,
    error,
    streamIssue,
    submitting,
    steering,
    cancelling,
    continuing,
    accepting,
    merging,
    reviewing,
    correcting,
    resolving,
    conflictedRunId,
    releasing,
    deploying,
    projects,
    tasks,
    selectedTaskId,
    selectedTask,
    tasksLoading,
    start,
    steer,
    cancel,
    pause,
    continueTask,
    queueFollowup,
    answerQuestion,
    acceptResult,
    mergeResult,
    startReview,
    startCorrection,
    resolveConflict,
    startRelease,
    activateRelease: activatePreparedRelease,
    rollbackRelease: rollbackActiveRelease,
    refreshProjects,
    selectTask,
    showTaskList,
    removeTask,
    refreshTasks,
    reconnect,
  };
}
