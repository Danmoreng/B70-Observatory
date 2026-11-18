import type { EngineMode, EnginePolicy } from '../engine/mode.js';
import type { MemoryRequest, MemoryResponse } from '@observatory/contracts';
import { randomUUID } from 'node:crypto';
import { imageStorageFailureReason, isRunStorageBudgetError } from '../runner/storage-budget.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import {
  AgentRunSnapshotSchema,
  AGENT_MODEL_IMAGE_TARGET_BYTES,
  AgentStreamEventSchema,
  SERVICE_NAME,
  type AgentRunSnapshot,
  type AgentLiveChanges,
  type AgentTaskTelemetry,
  type AgentInputImage,
  type AgentRunState,
  type AgentStreamEvent,
  type AgentTimelineImage,
  type AgentTimelineItem,
  type DurableTaskDetail,
  type RecentWork,
  type DurableTaskList,
  type RegenerateTaskTitleResult,
  type DurableTracePage,
  type AgentProject,
  type ProjectArchitecture,
  type CreateAgentProjectRequest,
  type StartAppPreviewRequest,
  type AppPreview,
  type AgentRunResult,
  type AcceptAgentRunRequest,
  type MergeAgentRunRequest,
  type AnswerAgentQuestionRequest,
  type CancelAgentRunRequest,
  type ContinueAgentTaskRequest,
  type RegisterAgentProjectRequest,
  type QueueAgentFollowupRequest,
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
  RpcJsonlDecoder as JsonlDecoder,
  decodeStrictBase64,
  validateAgentImage,
} from '@observatory/runner';

const MAX_RPC_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_TOOL_IMAGES = 16;
const MAX_ITEM_TEXT = 262_144;
const MAX_TIMELINE_TEXT = 4 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 10_000;
const TRUNCATION_MARKER = '[Live output truncated in memory]';

type ThinkingLevel = NonNullable<AgentRunState['thinkingLevel']>;

export interface AgentManagerOptions {
  /** Absolute path to the Pi executable. No shell is involved. */
  executable: string;
  /** Fixed workspace in which Pi's tools are allowed to operate. */
  workspace: string;
  /** Pi profile containing the configured local provider and model catalog. */
  profileDir?: string;
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  /** Trusted durable run ID. Omitted only by isolated unit fixtures. */
  runId?: string;
  /** Injectable clock for deterministic state tests. */
  now?: () => Date;
  maxTimelineItems?: number;
  /** Trusted process factory used by the isolated runner; never request-controlled. */
  spawnProcess?: (args: readonly string[]) => ChildProcessWithoutNullStreams;
  /** Synchronous durable sink. It must succeed before an event is published. */
  beforePublish?: (event: AgentStreamEvent) => void;
  /** Called when Pi starts the exact queued user message. */
  onSteeringConfirmed?: (steeringId: string) => void;
  /** Stops the complete sandbox scope, including detached descendants. */
  stopJob?: () => Promise<void>;
  /** Immutable extension paths already mounted by the trusted launcher. */
  extensions?: readonly string[];
  /** Small runner-owned policy appended without bloating the visible user task. */
  systemPromptAppend?: string;
  /**
   * Internal transport for the same policy when it exceeds one CLI argument:
   * a fixed private path of a UTF-8 file created by the service in the
   * per-run profile before start. Pi's resource loader reads the existing
   * file path; the argument itself stays a short fixed path.
   */
  systemPromptAppendFile?: string;
  /**
   * Runner-owned image sink: persists one validated image binary for the
   * active run and returns its strict metadata. It must never receive or
   * return base64 in a trace-visible form; binary access stays with the
   * private run-bound image route.
   */
  onInputImage?: (input: { mimeType: string; data: Buffer; label?: string }) => AgentTimelineImage;
  onImage?: (input: { mimeType: string; data: Buffer; label?: string }) => AgentTimelineImage;
}

/** Validate bytes before accepting a task or spawning a process. */
export function validateInputImages(images: readonly AgentInputImage[] = []): void {
  if (images.length > 4)
    throw new AgentControlError('protocol', 'At most four reference images are allowed.');
  for (const image of images) {
    const data = decodeStrictBase64(image.data);
    const validation = data === undefined ? undefined : validateAgentImage(image.mimeType, data);
    if (
      data === undefined ||
      data.length > AGENT_MODEL_IMAGE_TARGET_BYTES ||
      validation === undefined ||
      !validation.ok
    ) {
      throw new AgentControlError(
        'protocol',
        'Invalid model image copy. Prepare the reference through the dashboard image picker.'
      );
    }
  }
}

export type AgentListener = (event: AgentStreamEvent) => void;

/** One bounded, run-bound image delivered through the private control route. */
export interface AgentRunImagePayload {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  data: Buffer;
  byteLength: number;
  width: number;
  height: number;
  label?: string;
}

export interface AgentController {
  engineMode?(mode?: EngineMode): Promise<EnginePolicy>;
  memoryCall?(input: MemoryRequest): Promise<MemoryResponse>;
  snapshot(): AgentRunSnapshot;
  subscribe(listener: AgentListener): () => void;
  start(input: StartAgentRunRequest): Promise<AgentRunSnapshot>;
  startReview?(input: StartAgentReviewRequest): Promise<AgentRunSnapshot>;
  startCorrection?(input: StartAgentCorrectionRequest): Promise<AgentRunSnapshot>;
  startConflictResolution?(input: StartAgentConflictResolutionRequest): Promise<AgentRunSnapshot>;
  continueTask?(input: ContinueAgentTaskRequest): Promise<AgentRunSnapshot>;
  queueFollowup?(input: QueueAgentFollowupRequest): Promise<{ queued: true }>;
  answerQuestion?(input: AnswerAgentQuestionRequest): Promise<AgentRunSnapshot>;
  steer(input: SteerAgentRunRequest): Promise<AgentRunSnapshot>;
  pause?(input: CancelAgentRunRequest): Promise<AgentRunSnapshot>;
  cancel?(input: CancelAgentRunRequest): Promise<AgentRunSnapshot>;
  recentWork?(): Promise<RecentWork>;
  listTasks?(): Promise<DurableTaskList>;
  getTask?(taskId: string): Promise<DurableTaskDetail>;
  getTaskChangeImage?(taskId: string, runId: string, path: string): Promise<AgentRunImagePayload>;
  getTaskChanges?(taskId: string, runId?: string, refresh?: boolean): Promise<AgentLiveChanges>;
  getTaskTelemetry?(taskId: string): Promise<AgentTaskTelemetry>;
  regenerateTaskTitle?(taskId: string): Promise<RegenerateTaskTitleResult>;
  getRunTrace?(runId: string, afterSequence?: number, limit?: number): Promise<DurableTracePage>;
  deleteTask?(taskId: string): Promise<boolean>;
  listProjects?(): Promise<AgentProject[]>;
  getProjectArchitecture?(projectId: string): Promise<ProjectArchitecture>;
  registerProject?(input: RegisterAgentProjectRequest): Promise<AgentProject>;
  createProject?(input: CreateAgentProjectRequest): Promise<AgentProject>;
  getAppPreview?(projectId: string): Promise<AppPreview>;
  startAppPreview?(input: StartAppPreviewRequest): Promise<AppPreview>;
  stopAppPreview?(projectId: string): Promise<AppPreview>;
  getRunResult?(runId: string): Promise<AgentRunResult>;
  /**
   * Bounded binary payload of one run-bound image. Both IDs are validated by
   * the controller implementation; unknown or foreign-run images are 404.
   */
  getDesktopFrame?(runId: string): Promise<AgentRunImagePayload | undefined>;
  getRunImage?(runId: string, imageId: string): Promise<AgentRunImagePayload>;
  acceptRunResult?(input: AcceptAgentRunRequest): Promise<AgentRunResult>;
  mergeRunResult?(input: MergeAgentRunRequest): Promise<AgentRunResult>;
  startRelease?(input: StartReleaseRequest): Promise<ReleaseJob>;
  activateRelease?(input: ActivateReleaseRequest): Promise<ReleaseJob>;
  rollbackRelease?(input: RollbackReleaseRequest): Promise<{ accepted: true }>;
  close(): Promise<void>;
}

export class AgentControlError extends Error {
  constructor(
    readonly code:
      | 'busy'
      | 'not_running'
      | 'not_found'
      | 'conflict'
      | 'merge_conflict'
      | 'protocol'
      | 'unavailable',
    message: string
  ) {
    super(message);
    this.name = 'AgentControlError';
  }
}

interface PendingCommand {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RpcObject {
  type?: unknown;
  [key: string]: unknown;
}

function isObject(value: unknown): value is RpcObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function limitedString(value: unknown, max: number): string | undefined {
  const text = stringValue(value);
  return text === undefined ? undefined : text.slice(0, max);
}

function boundedText(value: string): string {
  if (value.length <= MAX_ITEM_TEXT) return value;
  const marker = '\n\n[Live output truncated in memory]\n\n';
  const budget = MAX_ITEM_TEXT - marker.length;
  const head = Math.floor(budget * 0.6);
  return value.slice(0, head) + marker + value.slice(-(budget - head));
}

function pretty(value: unknown): string {
  if (value === undefined) return '';
  try {
    const encoded = JSON.stringify(value, null, 2);
    return boundedText(encoded ?? String(value));
  } catch {
    return '[Value could not be displayed]';
  }
}

function resultText(value: unknown): string {
  if (!isObject(value)) return pretty(value);
  const blocks = Array.isArray(value.content) ? value.content : [];
  const text = blocks
    .map((block) => {
      if (!isObject(block)) return pretty(block);
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      if (block.type === 'image') return '[Image result]';
      return pretty(block);
    })
    .filter(Boolean)
    .join('\n');
  const details = value.details === undefined ? '' : `\n\nDetails\n${pretty(value.details)}`;
  return boundedText(`${text}${details}`.trim());
}

function toolTitle(toolName: string, args: unknown): string {
  if (isObject(args)) {
    const path =
      stringValue(args.path) ?? stringValue(args.file_path) ?? stringValue(args.filePath);
    if (path !== undefined) return `${toolName} · ${path}`.slice(0, 256);
    const command = stringValue(args.command);
    if (command !== undefined) {
      const firstLine = command.split('\n')[0] ?? command;
      return `${toolName} · ${firstLine.slice(0, 120)}`.slice(0, 256);
    }
  }
  return toolName.slice(0, 256);
}

function assistantFailure(message: unknown): string | null | undefined {
  if (!isObject(message) || message.role !== 'assistant') return undefined;
  const stopReason = stringValue(message.stopReason);
  if (stopReason === undefined) return undefined;
  if (stopReason === 'error') return 'Pi ended with a model error.';
  if (stopReason === 'aborted') return 'Pi reported an aborted model response.';
  if (stopReason === 'length') return 'Pi ended because the model output limit was reached.';
  return null;
}

/**
 * Pi receives only the small process environment it needs for local RPC use.
 * In particular, Observatory credentials/configuration and unrelated service
 * secrets must never be inherited by the coding agent or its tools.
 */
export function buildAgentEnvironment(profileDir?: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { PI_OFFLINE: '1' };
  for (const name of ['HOME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ'] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  if (profileDir !== undefined) environment.PI_CODING_AGENT_DIR = profileDir;
  return environment;
}

export { JsonlDecoder };

/**
 * Owns one Pi RPC child process and translates its provider-specific event
 * stream into a small stable Observatory contract. The runner may attach a
 * synchronous durable sink; application logs never receive this content.
 */
export class PiAgentManager implements AgentController {
  private readonly now: () => Date;
  private readonly maxTimelineItems: number;
  private readonly listeners = new Set<AgentListener>();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly timeline: AgentTimelineItem[] = [];
  private readonly itemByContentIndex = new Map<number, string>();
  private readonly itemByToolCall = new Map<string, string>();
  private readonly toolArgs = new Map<string, string>();
  private readonly toolStartedAt = new Map<string, number>();
  private child: ChildProcessWithoutNullStreams | undefined;
  private sequence = 0;
  private closing = false;
  private startInProgress = false;
  private modelFailure: string | undefined;
  private protocolFailure: string | undefined;
  private cancelling = false;
  private state: AgentRunState;

  constructor(private readonly options: AgentManagerOptions) {
    this.now = options.now ?? (() => new Date());
    this.maxTimelineItems = Math.min(1_000, Math.max(50, options.maxTimelineItems ?? 600));
    this.state = {
      service: SERVICE_NAME,
      enabled: true,
      status: 'idle',
      sequence: 0,
      provider: options.provider,
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      pendingSteering: 0,
    };
  }

  snapshot(): AgentRunSnapshot {
    return AgentRunSnapshotSchema.parse({
      ...this.state,
      sequence: this.sequence,
      timeline: this.timeline.map((item) => ({ ...item })),
    });
  }

  subscribe(listener: AgentListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(input: StartAgentRunRequest): Promise<AgentRunSnapshot> {
    if (
      this.startInProgress ||
      this.state.status === 'starting' ||
      this.state.status === 'running'
    ) {
      throw new AgentControlError('busy', 'An agent run is already active.');
    }
    // Claim the single-agent slot before the first await. Without this lock,
    // two HTTP requests in the same event-loop turn can both pass the status
    // check and spawn separate Pi children.
    validateInputImages(input.images);
    this.startInProgress = true;
    try {
      await this.terminateExisting();

      this.timeline.length = 0;
      this.itemByContentIndex.clear();
      this.itemByToolCall.clear();
      this.toolArgs.clear();
      this.toolStartedAt.clear();
      this.modelFailure = undefined;
      this.protocolFailure = undefined;
      this.cancelling = false;
      const startedAt = this.now().toISOString();
      this.state = {
        service: SERVICE_NAME,
        enabled: true,
        status: 'starting',
        sequence: this.sequence,
        runId: this.options.runId ?? randomUUID(),
        name: input.name ?? input.task.split('\n')[0]?.slice(0, 160) ?? 'Agent task',
        task: input.task,
        provider: this.options.provider,
        model: this.options.model,
        thinkingLevel: this.options.thinkingLevel,
        startedAt,
        pendingSteering: 0,
      };
      const inputImages = input.images?.map((image) => {
        const sink = this.options.onInputImage ?? this.options.onImage;
        if (sink === undefined)
          throw new AgentControlError('unavailable', 'Reference image storage is unavailable.');
        return sink({
          mimeType: image.mimeType,
          data: Buffer.from(image.data, 'base64'),
          label: image.label,
        });
      });
      this.emitReset();
      this.appendItem({
        id: randomUUID(),
        at: startedAt,
        kind: 'task',
        title: 'Aufgabe',
        ...(inputImages === undefined ? {} : { images: inputImages }),
        text: input.task,
        state: 'complete',
      });

      const args = [
        '--mode',
        'rpc',
        '--no-session',
        '--offline',
        '--provider',
        this.options.provider,
        '--model',
        this.options.model,
        '--thinking',
        this.options.thinkingLevel,
        '--name',
        this.state.name ?? 'Observatory agent run',
        ...(this.options.systemPromptAppendFile !== undefined
          ? ['--append-system-prompt', this.options.systemPromptAppendFile]
          : this.options.systemPromptAppend === undefined
            ? []
            : ['--append-system-prompt', this.options.systemPromptAppend]),
        ...(this.options.extensions?.flatMap((extension) => ['--extension', extension]) ?? []),
      ];
      const child =
        this.options.spawnProcess?.(args) ??
        spawn(this.options.executable, args, {
          cwd: this.options.workspace,
          env: buildAgentEnvironment(this.options.profileDir),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      this.child = child;
      this.attach(child);

      try {
        await this.sendCommand({
          type: 'prompt',
          message: input.task,
          ...(input.images === undefined
            ? {}
            : {
                images: input.images.map(({ mimeType, data }) => ({
                  type: 'image',
                  mimeType,
                  data,
                })),
              }),
        });
        void this.sendCommand({ type: 'get_state' })
          .then((data) => this.applyRpcState(data))
          .catch(() => undefined);
        return this.snapshot();
      } catch (error) {
        this.fail('Pi did not accept the task. Check the configured executable and provider.');
        child.kill('SIGTERM');
        throw error;
      }
    } finally {
      this.startInProgress = false;
    }
  }

  async steer(input: SteerAgentRunRequest): Promise<AgentRunSnapshot> {
    const { message, runId, idempotencyKey } = input;
    if (this.state.runId !== runId) {
      throw new AgentControlError('conflict', 'The selected run is no longer active.');
    }
    if (this.state.status !== 'starting' && this.state.status !== 'running') {
      throw new AgentControlError('not_running', 'There is no active agent turn to steer.');
    }
    if (this.state.pendingSteering >= 8) {
      throw new AgentControlError('busy', 'The steering queue already contains eight messages.');
    }
    const item: AgentTimelineItem = {
      id: idempotencyKey,
      at: this.now().toISOString(),
      kind: 'steering',
      title: 'Dein Kommentar · wartet auf Zustellung',
      text: message,
      state: 'queued',
    };
    this.appendItem(item);
    this.setState({ pendingSteering: this.state.pendingSteering + 1 });
    try {
      await this.sendCommand({ type: 'steer', message });
      return this.snapshot();
    } catch (error) {
      this.replaceItem({ ...item, title: 'Kommentar abgelehnt', state: 'error' });
      this.setState({ pendingSteering: Math.max(0, this.state.pendingSteering - 1) });
      throw error;
    }
  }

  async cancel(input: CancelAgentRunRequest): Promise<AgentRunSnapshot> {
    if (this.state.runId !== input.runId) {
      throw new AgentControlError('conflict', 'The selected run is no longer active.');
    }
    if (this.state.status === 'cancelled') return this.snapshot();
    if (!['starting', 'running', 'cancelling'].includes(this.state.status)) {
      throw new AgentControlError('not_running', 'The selected run has already ended.');
    }
    if (this.cancelling) return this.snapshot();
    this.cancelling = true;
    this.setState({ status: 'cancelling', pendingSteering: 0, reason: 'Run wird beendet.' });
    for (const item of [...this.timeline]) {
      if (item.kind === 'steering' && item.state === 'queued') {
        this.replaceItem({ ...item, title: 'Kommentar nicht mehr zugestellt', state: 'error' });
      }
    }
    try {
      await this.sendCommand({ type: 'clear_queue' }).catch(() => undefined);
      await this.sendCommand({ type: 'abort' }).catch(() => undefined);
      // Kill the complete cgroup first; a direct-process termination remains
      // the bounded fallback when the scope was already collected.
      await this.options.stopJob?.().catch(() => undefined);
      await this.terminateExisting();
      this.setState({
        status: 'cancelled',
        finishedAt: this.now().toISOString(),
        pendingSteering: 0,
        reason: 'Run wurde abgebrochen.',
      });
      return this.snapshot();
    } finally {
      this.cancelling = false;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.terminateExisting();
    this.listeners.clear();
  }

  private attach(child: ChildProcessWithoutNullStreams): void {
    const stdout = new JsonlDecoder((line) => this.handleLine(line));
    // Pi redirects extension stdout to stderr to protect the RPC channel.
    // Decode only our bounded child envelopes there; never publish raw Pi diagnostics.
    let stderrPending = '';
    let skippingDiagnostic = false;
    const stderrDecoder = new StringDecoder('utf8');
    child.stderr.on('data', (chunk: Buffer) => {
      try {
        stderrPending += stderrDecoder.write(chunk);
        while (stderrPending.includes('\n')) {
          const separator = stderrPending.indexOf('\n');
          const line = stderrPending.slice(0, separator);
          stderrPending = stderrPending.slice(separator + 1);
          const skip = skippingDiagnostic || Buffer.byteLength(line) > MAX_RPC_RECORD_BYTES;
          skippingDiagnostic = false;
          if (skip) continue;
          let event: unknown;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (isObject(event) && event.type === 'b70_subagent_event')
            this.handleSubagentEvent(event);
        }
        if (Buffer.byteLength(stderrPending) > MAX_RPC_RECORD_BYTES) {
          stderrPending = '';
          skippingDiagnostic = true;
        }
      } catch (error) {
        this.handleStreamFailure(error, 'Sub-agent event processing failed.', child);
      }
    });
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        stdout.push(chunk);
      } catch (error) {
        this.handleStreamFailure(error, 'Pi violated the RPC framing limit.', child);
      }
    });
    child.stdout.on('end', () => {
      try {
        stdout.end();
      } catch (error) {
        this.handleStreamFailure(error, 'Pi violated the RPC framing limit.', child);
      }
    });
    child.once('error', () => {
      if (this.child !== child) return;
      this.fail('Pi could not be started. Check the configured executable.');
      this.rejectPending(new AgentControlError('unavailable', 'Pi could not be started.'));
    });
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.rejectPending(new AgentControlError('unavailable', 'The Pi process has stopped.'));
      if (
        !this.closing &&
        !this.cancelling &&
        !['settled', 'failed', 'cancelled'].includes(this.state.status)
      ) {
        this.fail(
          `Pi stopped before the run settled (${signal === null ? `exit ${code ?? 'unknown'}` : signal}).`
        );
      }
    });
  }

  private handleStreamFailure(
    error: unknown,
    protocolReason: string,
    child: ChildProcessWithoutNullStreams
  ): void {
    child.kill('SIGTERM');
    if (error instanceof AgentControlError && error.code === 'unavailable') return;
    try {
      this.fail(protocolReason);
    } catch {
      // The durable sink already requested shutdown; do not turn its failure
      // into an uncaught stream callback exception.
    }
  }

  private handleLine(line: string): void {
    if (this.closing) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.protocolFailure = 'Pi sent invalid JSON on the RPC channel.';
      this.appendItem({
        id: randomUUID(),
        at: this.now().toISOString(),
        kind: 'error',
        title: 'Ungültige Pi-RPC-Antwort',
        text: boundedText(line),
        state: 'error',
      });
      return;
    }
    if (!isObject(value)) return;
    if (value.type === 'response') {
      this.handleResponse(value);
      return;
    }
    this.handleEvent(value);
  }

  private handleResponse(value: RpcObject): void {
    const id = stringValue(value.id);
    if (id === undefined) return;
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (value.success === true) {
      pending.resolve(value.data);
    } else {
      const detail = limitedString(value.error, 384);
      pending.reject(
        new AgentControlError(
          'protocol',
          detail === undefined
            ? 'Pi rejected the RPC command.'
            : `Pi rejected the RPC command: ${detail}`
        )
      );
    }
  }

  private readonly subagentDecoders = new Map<string, PiAgentManager>();

  private handleSubagentEvent(envelope: RpcObject): void {
    if (['settled', 'failed', 'cancelled'].includes(this.state.status)) return;
    const id = limitedString(envelope.agentId, 32);
    const name = limitedString(envelope.name, 80) ?? 'Sub-Agent';
    if (id === undefined || !/^[a-f0-9]{16}$/.test(id) || !isObject(envelope.event)) return;
    const childEvent = envelope.event;
    if (childEvent.type === 'b70_subagent_stderr') return;
    const previousStatus = this.state.subagents?.find((agent) => agent.id === id)?.status;
    const childFailed =
      childEvent.type === 'message_end' &&
      isObject(childEvent.message) &&
      ['error', 'aborted'].includes(String(childEvent.message.stopReason));
    const status = childFailed
      ? 'failed'
      : childEvent.type === 'b70_subagent_status'
        ? childEvent.status
        : childEvent.type === 'agent_start'
          ? 'running'
          : childEvent.type === 'agent_settled'
            ? previousStatus === 'failed'
              ? 'failed'
              : 'completed'
            : undefined;
    if (['starting', 'running', 'completed', 'failed', 'stopped'].includes(String(status))) {
      const agents = this.state.subagents ?? [];
      if (agents.some((agent) => agent.id === id) || agents.length < 3) {
        this.setState({
          subagents: [
            ...agents.filter((agent) => agent.id !== id),
            {
              id,
              name,
              status: status as 'starting' | 'running' | 'completed' | 'failed' | 'stopped',
            },
          ],
        });
      }
    }
    if (childEvent.type === 'b70_subagent_status') return;
    let decoder = this.subagentDecoders.get(id);
    if (
      decoder === undefined ||
      (envelope.event.type === 'agent_start' &&
        ['settled', 'failed'].includes(decoder.snapshot().status))
    ) {
      if (decoder === undefined && this.subagentDecoders.size >= 3) return;
      decoder = new PiAgentManager({
        ...this.options,
        beforePublish: undefined,
        spawnProcess: undefined,
      });
      decoder.subscribe((event) => {
        if (event.operation === 'append' || event.operation === 'replace') {
          const item = {
            ...event.item,
            agent: { id, name },
          };
          if (event.operation === 'append') this.appendItem(item);
          else this.replaceItem(item);
        } else if (event.operation === 'append_text') this.appendText(event.itemId, event.text);
      });
      this.subagentDecoders.set(id, decoder);
    }
    if (envelope.event.type === 'b70_subagent_assignment') {
      decoder.appendItem({
        id: randomUUID(),
        at: this.now().toISOString(),
        kind: 'task',
        title: 'Aufgabe',
        text: boundedText(String(envelope.event.message ?? '')),
        state: 'complete',
      });
    } else decoder.handleEvent(envelope.event);
  }

  private handleEvent(event: RpcObject): void {
    const type = stringValue(event.type);
    if (['settled', 'failed', 'cancelled'].includes(this.state.status)) return;
    if (this.cancelling && !['queue_update', 'agent_settled', 'agent_end'].includes(type ?? '')) {
      return;
    }
    switch (type) {
      case 'extension_ui_request': {
        if (
          event.method !== 'notify' ||
          typeof event.message !== 'string' ||
          event.message.length > MAX_RPC_RECORD_BYTES
        )
          break;
        let envelope: unknown;
        try {
          envelope = JSON.parse(event.message);
        } catch {
          break;
        }
        if (isObject(envelope) && envelope.type === 'b70_subagent_event')
          this.handleSubagentEvent(envelope);
        break;
      }
      case 'b70_subagent_event':
        this.handleSubagentEvent(event);
        break;
      case 'agent_start':
        this.setState({ status: 'running', reason: undefined });
        break;
      case 'agent_end':
        if (event.willRetry === true) {
          this.modelFailure = undefined;
          this.setState({ status: 'running', reason: undefined });
        } else if (Array.isArray(event.messages)) {
          const lastAssistant = [...event.messages]
            .reverse()
            .find((message) => isObject(message) && message.role === 'assistant');
          this.recordAssistantOutcome(lastAssistant);
        }
        break;
      case 'agent_settled':
        if (this.cancelling) break;
        if (this.protocolFailure !== undefined || this.modelFailure !== undefined) {
          this.fail(this.protocolFailure ?? this.modelFailure ?? 'Pi ended with an unknown error.');
        } else {
          this.setState({
            status: 'settled',
            finishedAt: this.now().toISOString(),
            pendingSteering: 0,
            reason: 'Execution ended; automated checks and human review have not run.',
          });
          // A settled run cannot be steered again. End the RPC process as well
          // so its sandbox scope and cgroup do not linger until RuntimeMaxSec.
          const settledChild = this.child;
          setImmediate(() => {
            if (settledChild !== undefined && this.child === settledChild) {
              settledChild.kill('SIGTERM');
            }
          });
        }
        break;
      case 'turn_start':
        this.itemByContentIndex.clear();
        break;
      case 'message_start':
        this.handleMessageStart(event.message);
        break;
      case 'message_update':
        this.handleMessageUpdate(event.assistantMessageEvent);
        break;
      case 'message_end':
        this.handleMessageEnd(event.message);
        break;
      case 'tool_execution_start':
        this.handleToolStart(event);
        break;
      case 'tool_execution_update':
        this.handleToolUpdate(event);
        break;
      case 'tool_execution_end':
        this.handleToolEnd(event);
        break;
      case 'queue_update':
        this.handleQueueUpdate(event);
        break;
      case 'compaction_start':
        this.appendItem({
          id: randomUUID(),
          at: this.now().toISOString(),
          kind: 'compaction',
          title: `Kontextkomprimierung · ${limitedString(event.reason, 200) ?? 'gestartet'}`,
          state: 'running',
        });
        break;
      case 'compaction_end':
        this.appendItem({
          id: randomUUID(),
          at: this.now().toISOString(),
          kind: 'compaction',
          title:
            event.aborted === true ? 'Kontextkomprimierung abgebrochen' : 'Kontext komprimiert',
          text:
            event.errorMessage === undefined ? undefined : boundedText(String(event.errorMessage)),
          state: event.errorMessage === undefined ? 'complete' : 'error',
        });
        break;
      case 'auto_retry_start':
      case 'summarization_retry_scheduled':
        this.appendItem({
          id: randomUUID(),
          at: this.now().toISOString(),
          kind: 'retry',
          title: `Wiederholungsversuch ${String(event.attempt ?? '')}`.trim(),
          text:
            event.errorMessage === undefined ? undefined : boundedText(String(event.errorMessage)),
          state: 'queued',
        });
        break;
      case 'extension_error':
        this.appendItem({
          id: randomUUID(),
          at: this.now().toISOString(),
          kind: 'error',
          title: 'Pi-Erweiterungsfehler',
          text: event.error === undefined ? undefined : boundedText(String(event.error)),
          state: 'error',
        });
        break;
      default:
        break;
    }
  }

  private handleMessageStart(message: unknown): void {
    if (!isObject(message) || message.role !== 'user') return;
    const content =
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .map((block) =>
                isObject(block) && block.type === 'text' && typeof block.text === 'string'
                  ? block.text
                  : ''
              )
              .join('')
          : undefined;
    const queued = this.timeline.find(
      (item) => item.kind === 'steering' && item.state === 'queued' && item.text === content
    );
    if (queued !== undefined) {
      this.replaceItem({ ...queued, title: 'Dein Kommentar · zugestellt', state: 'complete' });
      this.options.onSteeringConfirmed?.(queued.id);
    }
  }

  private handleMessageUpdate(raw: unknown): void {
    if (!isObject(raw)) return;
    const type = stringValue(raw.type);
    const index = typeof raw.contentIndex === 'number' ? raw.contentIndex : undefined;
    if (index === undefined) return;
    if (type === 'text_start' || type === 'thinking_start') {
      const item: AgentTimelineItem = {
        id: randomUUID(),
        at: this.now().toISOString(),
        kind: type === 'thinking_start' ? 'thinking' : 'assistant',
        title: type === 'thinking_start' ? 'Reasoning' : 'Agent',
        text: '',
        state: 'running',
      };
      this.itemByContentIndex.set(index, item.id);
      this.appendItem(item);
      return;
    }
    if (type === 'text_delta' || type === 'thinking_delta') {
      const id = this.itemByContentIndex.get(index);
      const delta = stringValue(raw.delta);
      if (id !== undefined && delta !== undefined) this.appendText(id, delta);
      return;
    }
    if (type === 'text_end' || type === 'thinking_end') {
      const id = this.itemByContentIndex.get(index);
      const item = id === undefined ? undefined : this.findItem(id);
      if (item !== undefined) {
        const authoritative =
          type === 'text_end' ? stringValue(raw.content) : stringValue(raw.content);
        this.replaceItem({
          ...item,
          text: boundedText(authoritative ?? item.text ?? ''),
          state: 'complete',
        });
      }
      return;
    }
    if (type === 'toolcall_start') {
      const callId = limitedString(raw.id, 512);
      const toolName = limitedString(raw.toolName, 128) ?? 'tool';
      if (callId === undefined) return;
      const item: AgentTimelineItem = {
        id: randomUUID(),
        at: this.now().toISOString(),
        kind: 'tool',
        title: toolName,
        argumentsText: 'Argumente werden empfangen …',
        state: 'queued',
        toolName,
        toolCallId: callId,
      };
      this.itemByToolCall.set(callId, item.id);
      this.appendItem(item);
      return;
    }
    if (type === 'toolcall_end' && isObject(raw.toolCall)) {
      const callId = limitedString(raw.toolCall.id, 512);
      if (callId === undefined) return;
      const toolName = limitedString(raw.toolCall.name, 128) ?? 'tool';
      const args = raw.toolCall.arguments;
      this.toolArgs.set(callId, pretty(args));
      this.upsertTool(callId, toolName, args, undefined, 'queued');
    }
  }

  private handleMessageEnd(message: unknown): void {
    if (!isObject(message)) return;
    if (message.role === 'custom' && message.customType === 'b70-subagents') {
      this.appendItem({
        id: randomUUID(),
        at: this.now().toISOString(),
        kind: 'notice',
        title: 'Sub-Agenten · Integration',
        text: boundedText(
          typeof message.content === 'string' ? message.content : pretty(message.content)
        ),
        state: 'complete',
      });
      return;
    }
    if (message.role === 'user') return;
    if (message.role !== 'assistant') return;
    this.recordAssistantOutcome(message);
    if (!Array.isArray(message.content)) return;
    for (const [index, block] of message.content.entries()) {
      if (!isObject(block)) continue;
      if (block.type === 'text' || block.type === 'thinking') {
        const text = block.type === 'text' ? stringValue(block.text) : stringValue(block.thinking);
        if (text === undefined) continue;
        const existingId = this.itemByContentIndex.get(index);
        const existing = existingId === undefined ? undefined : this.findItem(existingId);
        if (existing !== undefined) {
          this.replaceItem({ ...existing, text: boundedText(text), state: 'complete' });
        } else {
          const item: AgentTimelineItem = {
            id: randomUUID(),
            at: this.now().toISOString(),
            kind: block.type === 'thinking' ? 'thinking' : 'assistant',
            title: block.type === 'thinking' ? 'Reasoning' : 'Agent',
            text: boundedText(text),
            state: 'complete',
          };
          this.itemByContentIndex.set(index, item.id);
          this.appendItem(item);
        }
      } else if (block.type === 'toolCall') {
        const callId = limitedString(block.id, 512);
        if (callId === undefined) continue;
        const toolName = limitedString(block.name, 128) ?? 'tool';
        this.toolArgs.set(callId, pretty(block.arguments));
        this.upsertTool(callId, toolName, block.arguments, undefined, 'queued');
      }
    }
  }

  private recordAssistantOutcome(message: unknown): void {
    const failure = assistantFailure(message);
    if (failure === undefined) return;
    this.modelFailure = failure ?? undefined;
  }

  private handleToolStart(event: RpcObject): void {
    const callId = limitedString(event.toolCallId, 512);
    if (callId === undefined) return;
    const toolName = limitedString(event.toolName, 128) ?? 'tool';
    this.toolStartedAt.set(callId, this.now().getTime());
    this.toolArgs.set(callId, pretty(event.args));
    this.upsertTool(callId, toolName, event.args, undefined, 'running');
  }

  private handleToolUpdate(event: RpcObject): void {
    const callId = limitedString(event.toolCallId, 512);
    if (callId === undefined) return;
    const toolName = limitedString(event.toolName, 128) ?? 'tool';
    this.upsertTool(
      callId,
      toolName,
      this.toolArgs.has(callId) ? undefined : event.args,
      event.partialResult,
      'running'
    );
  }

  private handleToolEnd(event: RpcObject): void {
    const callId = limitedString(event.toolCallId, 512);
    if (callId === undefined) return;
    const toolName = limitedString(event.toolName, 128) ?? 'tool';
    const started = this.toolStartedAt.get(callId);
    this.upsertTool(
      callId,
      toolName,
      undefined,
      event.result,
      event.isError === true ? 'error' : 'complete'
    );
    this.attachToolImages(callId, event.args, event.result);
    if (started !== undefined) {
      const itemId = this.itemByToolCall.get(callId);
      const item = itemId === undefined ? undefined : this.findItem(itemId);
      if (item !== undefined) {
        this.replaceItem({ ...item, durationMs: Math.max(0, this.now().getTime() - started) });
      }
      this.toolStartedAt.delete(callId);
    }
  }

  private upsertTool(
    callId: string,
    toolName: string,
    args: unknown,
    result: unknown,
    state: 'queued' | 'running' | 'complete' | 'error'
  ): void {
    const id = this.itemByToolCall.get(callId);
    const argumentsText = args === undefined ? (this.toolArgs.get(callId) ?? '') : pretty(args);
    if (args !== undefined) this.toolArgs.set(callId, argumentsText);
    const outputText = result === undefined ? '' : resultText(result);
    if (id === undefined) {
      const item: AgentTimelineItem = {
        id: randomUUID(),
        at: this.now().toISOString(),
        kind: 'tool',
        title: toolTitle(toolName, args),
        ...(argumentsText === '' ? {} : { argumentsText }),
        ...(outputText === '' ? {} : { outputText }),
        ...(argumentsText.includes(TRUNCATION_MARKER) ? { argumentsTruncated: true } : {}),
        ...(outputText.includes(TRUNCATION_MARKER) ? { outputTruncated: true } : {}),
        state,
        toolName,
        toolCallId: callId,
      };
      this.itemByToolCall.set(callId, item.id);
      this.appendItem(item);
      return;
    }
    const item = this.findItem(id);
    if (item !== undefined) {
      const replacement: AgentTimelineItem = {
        ...item,
        title: args === undefined ? item.title : toolTitle(toolName, args),
        argumentsText: argumentsText === '' ? undefined : argumentsText,
        outputText: outputText === '' ? undefined : outputText,
        argumentsTruncated: argumentsText.includes(TRUNCATION_MARKER) || undefined,
        outputTruncated: outputText.includes(TRUNCATION_MARKER) || undefined,
        text: undefined,
        state,
        toolName,
      };
      this.replaceItem(replacement);
    }
  }

  /**
   * Extracts real image content from a finished tool result, persists it
   * through the runner-owned sink and attaches only the strict metadata to
   * the timeline item. Base64 or binaries never reach the trace, the SSE
   * stream or the snapshot; a failed validation leaves no image behind.
   */
  private attachToolImages(callId: string, args: unknown, result: unknown): void {
    if (this.options.onImage === undefined) return;
    const itemId = this.itemByToolCall.get(callId);
    if (itemId === undefined) return;
    const item = this.findItem(itemId);
    if (item === undefined || !isObject(result) || !Array.isArray(result.content)) return;
    const label = isObject(args) ? limitedString(args.label, 128) : undefined;
    const metadata: AgentTimelineImage[] = [];
    for (const block of result.content) {
      if (metadata.length >= MAX_TOOL_IMAGES) break;
      if (!isObject(block) || block.type !== 'image') continue;
      const mimeType = typeof block.mimeType === 'string' ? block.mimeType.slice(0, 64) : '';
      const data = decodeStrictBase64(typeof block.data === 'string' ? block.data : '');
      if (data === undefined) continue;
      let stored: AgentTimelineImage | undefined;
      try {
        stored = this.options.onImage({ mimeType, data, label });
      } catch (error) {
        this.appendItem({
          id: randomUUID(),
          at: this.now().toISOString(),
          kind: 'notice',
          title: 'Bild nicht gespeichert',
          text: imageStorageFailureReason(error),
          state: 'error',
        });
        if (isRunStorageBudgetError(error)) {
          this.fail(error.message);
          void this.options.stopJob?.().catch(() => undefined);
          void this.close();
          return;
        }
        continue;
      }
      if (stored !== undefined && !metadata.some((entry) => entry.id === stored.id)) {
        metadata.push(stored);
      }
    }
    if (metadata.length === 0) return;
    this.replaceItem({ ...item, images: metadata });
  }

  private handleQueueUpdate(event: RpcObject): void {
    const pendingSteering = Array.isArray(event.steering) ? event.steering.length : 0;
    this.setState({ pendingSteering });
  }

  private applyRpcState(value: unknown): void {
    if (!isObject(value)) return;
    const model = isObject(value.model) ? limitedString(value.model.id, 256) : undefined;
    const thinkingLevel = stringValue(value.thinkingLevel);
    const allowedThinking = new Set<ThinkingLevel>([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    this.setState({
      model: model ?? this.state.model,
      name: limitedString(value.sessionName, 160) ?? this.state.name,
      thinkingLevel:
        thinkingLevel !== undefined && allowedThinking.has(thinkingLevel as ThinkingLevel)
          ? (thinkingLevel as ThinkingLevel)
          : this.state.thinkingLevel,
    });
  }

  private sendCommand(command: Record<string, unknown>): Promise<unknown> {
    const child = this.child;
    if (child === undefined || child.stdin.destroyed) {
      return Promise.reject(new AgentControlError('unavailable', 'The Pi process is unavailable.'));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AgentControlError('protocol', 'Pi did not answer the RPC command in time.'));
      }, COMMAND_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, ...command })}\n`, (error) => {
        if (error === null || error === undefined) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new AgentControlError('unavailable', 'The Pi command channel is unavailable.'));
      });
    });
  }

  private setState(patch: Partial<AgentRunState>): void {
    const sequence = this.sequence + 1;
    this.sequence = sequence;
    this.state = { ...this.state, ...patch, sequence };
    if (['settled', 'failed', 'cancelled'].includes(patch.status ?? '') && this.state.subagents) {
      this.state.subagents = this.state.subagents.map((agent) =>
        ['starting', 'running'].includes(agent.status) ? { ...agent, status: 'stopped' } : agent
      );
    }
    this.publish(
      AgentStreamEventSchema.parse({
        operation: 'state',
        runId: this.state.runId,
        sequence,
        state: { ...this.state },
      })
    );
  }

  private appendItem(item: AgentTimelineItem): void {
    this.timeline.push(item);
    const prunedItemIds = this.pruneTimeline();
    const sequence = ++this.sequence;
    this.state = { ...this.state, sequence };
    this.publish(
      AgentStreamEventSchema.parse({
        operation: 'append',
        runId: this.state.runId,
        sequence,
        item,
        ...(prunedItemIds.length ? { prunedItemIds } : {}),
      })
    );
  }

  private appendText(itemId: string, delta: string): void {
    const item = this.findItem(itemId);
    if (item === undefined || delta.length === 0) return;
    const current = item.text ?? '';
    const capacity = MAX_ITEM_TEXT - current.length;
    if (capacity <= 0) return;
    const accepted = delta.slice(0, capacity);
    item.text = current + accepted;
    const prunedItemIds = this.pruneTimeline();
    for (let offset = 0; offset < accepted.length; offset += 65_536) {
      const text = accepted.slice(offset, offset + 65_536);
      const sequence = ++this.sequence;
      this.state = { ...this.state, sequence };
      this.publish(
        AgentStreamEventSchema.parse({
          operation: 'append_text',
          runId: this.state.runId,
          sequence,
          itemId,
          text,
          ...(offset + 65_536 >= accepted.length && prunedItemIds.length ? { prunedItemIds } : {}),
        })
      );
    }
  }

  private replaceItem(item: AgentTimelineItem): void {
    const index = this.timeline.findIndex((candidate) => candidate.id === item.id);
    if (index === -1) return;
    this.timeline[index] = item;
    const prunedItemIds = this.pruneTimeline();
    const sequence = ++this.sequence;
    this.state = { ...this.state, sequence };
    this.publish(
      AgentStreamEventSchema.parse({
        operation: 'replace',
        runId: this.state.runId,
        sequence,
        item,
        ...(prunedItemIds.length ? { prunedItemIds } : {}),
      })
    );
  }

  private findItem(id: string): AgentTimelineItem | undefined {
    return this.timeline.find((item) => item.id === id);
  }

  /** Keep both entry count and aggregate live content at a practical bound. */
  private pruneTimeline(): string[] {
    const itemTextLength = (item: AgentTimelineItem): number =>
      (item.text?.length ?? 0) + (item.argumentsText?.length ?? 0) + (item.outputText?.length ?? 0);
    let textLength = this.timeline.reduce((sum, item) => sum + itemTextLength(item), 0);
    const removed: AgentTimelineItem[] = [];
    while (this.timeline.length > this.maxTimelineItems || textLength > MAX_TIMELINE_TEXT) {
      const item = this.timeline.shift();
      if (item === undefined) break;
      textLength -= itemTextLength(item);
      removed.push(item);
    }
    for (const old of removed) {
      if (old.toolCallId !== undefined) {
        this.itemByToolCall.delete(old.toolCallId);
        this.toolArgs.delete(old.toolCallId);
        this.toolStartedAt.delete(old.toolCallId);
      }
      for (const [index, id] of this.itemByContentIndex) {
        if (id === old.id) this.itemByContentIndex.delete(index);
      }
    }
    return removed.map((item) => item.id);
  }

  private emitReset(): void {
    const sequence = ++this.sequence;
    this.state = { ...this.state, sequence };
    this.publish(
      AgentStreamEventSchema.parse({
        operation: 'reset',
        runId: this.state.runId,
        sequence,
        snapshot: this.snapshot(),
      })
    );
  }

  private publish(event: AgentStreamEvent): void {
    this.options.beforePublish?.(event);
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A disconnected/broken browser is not allowed to terminate Pi or
        // prevent other Cockpit clients from receiving the event.
      }
    }
  }

  private fail(reason: string): void {
    this.setState({
      status: 'failed',
      finishedAt: this.now().toISOString(),
      reason: reason.slice(0, 512),
      pendingSteering: 0,
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async terminateExisting(): Promise<void> {
    const child = this.child;
    if (child === undefined) return;
    this.child = undefined;
    this.rejectPending(
      new AgentControlError('unavailable', 'The previous Pi process was stopped.')
    );
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 2_000);
      timer.unref();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
}
