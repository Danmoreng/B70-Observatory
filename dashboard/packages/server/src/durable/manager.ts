import { createHash } from 'node:crypto';
import { imageStorageFailureReason, isRunStorageBudgetError } from '../runner/storage-budget.js';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import {
  Harness,
  createRegistry,
  type Conversation,
  type ConversationId,
  type ConversationView,
  type ConversationWatch,
  type EntryRecord,
  type Submission,
  type ToolRegistration,
  type LiveState,
  type CompactionStatus,
} from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import type { Models, AssistantMessage, ImageContent } from '@earendil-works/pi-ai';
import {
  AgentRunSnapshotSchema,
  AgentStreamEventSchema,
  type AgentRunSnapshot,
  type AgentTimelineItem,
  type SubagentRun,
  type AgentTimelineImage,
  type AgentStreamEvent,
  type StartAgentRunRequest,
  type SteerAgentRunRequest,
  type CancelAgentRunRequest,
  SERVICE_NAME,
} from '@observatory/contracts';
import {
  AgentControlError,
  type AgentListener,
  type AgentManagerOptions,
  type AgentRunImagePayload,
} from '../agent/manager.js';
import { validateAgentImage } from '@observatory/runner';
import { readWorkspaceInstructions } from './instructions.js';
import { createDashboardTools, sandboxToolCall } from './tools.js';
import { createSubagentTools } from './subagents.js';
import { assertMayStartWork, remainingWorkSeconds } from './working-hours.js';
import { ENGINE_RECOVERY_MS, ENGINE_RETRY_POLICY } from './model-recovery.js';

const MAX_TEXT = 262_144;
function id(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function bounded(text: string) {
  return text.length <= MAX_TEXT
    ? text
    : text.slice(0, MAX_TEXT - 48) + '\n[Ausgabe in der Dashboard-Ansicht gekürzt]';
}
function pretty(value: unknown) {
  return bounded(JSON.stringify(value, null, 2) ?? '');
}
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: unknown) =>
      typeof block === 'object' &&
      block !== null &&
      'type' in block &&
      block.type === 'text' &&
      'text' in block
        ? String(block.text)
        : ''
    )
    .filter(Boolean)
    .join('\n');
}
export interface DurableManagerOptions extends Pick<
  AgentManagerOptions,
  'beforePublish' | 'onSteeringConfirmed' | 'onImage' | 'onInputImage'
> {
  runId: string;
  requestId: string;
  provider: string;
  model: string;
  thinkingLevel: NonNullable<AgentRunSnapshot['thinkingLevel']>;
  storagePath: string;
  instructions: string;
  models: Models;
  env: ExecutionEnv;
  browser: boolean;
  desktop?: boolean;
  closeEnvironment: () => Promise<void>;
  initialSnapshot?: AgentRunSnapshot;
  /** Called after persisting the harness at the PC-wide deadline. */
  onPaused?: (manual: boolean) => Promise<void> | void;
  extraTools?: ToolRegistration[];
  modelRequestTimeoutMs?: number;
  memoryContext?: string;
}
/** The harness and its DB stay in the trusted runner; only env operations cross bwrap. */
export class DurableAgentManager {
  private readonly childProjections = new Map<
    ConversationId,
    {
      decoder: DurableAgentManager;
      watch: ConversationWatch;
      name: string;
    }
  >();
  private harness?: Harness;
  private storage?: Awaited<ReturnType<typeof openNodeSqliteStorage>>;
  private conversation?: Conversation;
  private watch?: ConversationWatch;
  private readonly listeners = new Set<AgentListener>();
  private readonly seenEntries = new Set<EntryRecord['id']>();
  private readonly imageCache = new Map<string, AgentTimelineImage[]>();
  private state: AgentRunSnapshot;
  private closed = false;
  private closePromise?: Promise<void>;
  private hardTimer?: ReturnType<typeof setTimeout>;
  private endAt = 0;
  private monitoring?: Promise<void>;
  private projectionError?: unknown;
  private readonly completedMessages = new Map<number, number>();
  private currentPartial?: { timestamp: number; ordinal: number };
  private lastFinalMessage = '';
  private readonly activeCompactions = new Map<CompactionStatus['taskId'], string>();
  constructor(private readonly options: DurableManagerOptions) {
    this.state = AgentRunSnapshotSchema.parse({
      service: SERVICE_NAME,
      enabled: true,
      engine: 'pi-durable',
      desktopAvailable: options.desktop === true,
      status: 'starting',
      runId: options.runId,
      provider: options.provider,
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      sequence: options.initialSnapshot?.sequence ?? 0,
      startedAt: options.initialSnapshot?.startedAt ?? new Date().toISOString(),
      pendingSteering: 0,
      timeline: options.initialSnapshot?.timeline ?? [],
      subagents: options.initialSnapshot?.subagents ?? [],
    });
    for (const item of this.state.timeline)
      if (item.toolCallId && item.images) this.imageCache.set(item.toolCallId, item.images);
  }
  private viewerPending?: Promise<AgentRunImagePayload | undefined>;
  private viewerCached?: AgentRunImagePayload;
  private viewerAt = 0;
  async getDesktopFrame(): Promise<AgentRunImagePayload | undefined> {
    if (
      !this.options.desktop ||
      this.closed ||
      !['starting', 'running'].includes(this.state.status)
    )
      return undefined;
    if (this.viewerPending) return this.viewerPending;
    if (Date.now() - this.viewerAt < 2000) return this.viewerCached;
    this.viewerPending = (async () => {
      try {
        const result = await sandboxToolCall(this.options.env, {}, 'desktop_viewer_frame', ctx, 10);
        const image = result.output.find((part) => part.type === 'image');
        if (!image || image.type !== 'image' || image.mimeType !== 'image/png') return undefined;
        const data = Buffer.from(image.data, 'base64');
        const valid = validateAgentImage('image/png', data);
        if (!valid.ok || valid.height > 1200) return undefined;
        return {
          mimeType: 'image/png' as const,
          data,
          byteLength: data.length,
          width: valid.width,
          height: valid.height,
        };
      } catch {
        return undefined;
      }
    })();
    try {
      this.viewerCached = await this.viewerPending;
      return this.viewerCached;
    } finally {
      this.viewerAt = Date.now();
      this.viewerPending = undefined;
    }
  }

  snapshot(): AgentRunSnapshot {
    return structuredClone(this.state);
  }
  subscribe(listener: AgentListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async start(input: StartAgentRunRequest): Promise<AgentRunSnapshot> {
    assertMayStartWork();
    this.endAt = Date.now() + Math.max(1_000, remainingWorkSeconds() * 1000 - 30_000);
    await mkdir(dirname(this.options.storagePath), { recursive: true, mode: 0o700 });
    const registry = createRegistry();
    registry.install(createDashboardTools(this.options.browser, this.options.desktop));
    registry.install(
      createSubagentTools({
        attach: (childId, name) => this.attachChild(childId, name),
        finish: (childId, status) => this.finishChild(childId, status),
      })
    );
    if (this.options.extraTools)
      registry.install({ name: 'b70-extra', tools: this.options.extraTools });
    this.storage = await openNodeSqliteStorage(this.options.storagePath);
    this.harness = await Harness.open(
      this.storage,
      {
        models: this.options.models,
        registry,
        env: () => this.options.env,
        identity: { attribution: null },
        settings: {
          steeringMode: 'all',
          toolExecution: 'sequential',
          stream: {
            timeoutMs: this.options.modelRequestTimeoutMs ?? ENGINE_RECOVERY_MS,
            maxRetries: 0,
          },
          retry: ENGINE_RETRY_POLICY,
          compaction: {
            enabled: true,
            reserveTokens: 24_576,
            keepRecentTokens: 32_768,
            backgroundTokens: 32_768,
          },
        },
      },
      ctx
    );
    const instructions = [
      this.options.instructions,
      await readWorkspaceInstructions(this.options.env),
    ]
      .filter(Boolean)
      .join('\n\n');
    this.conversation = await this.harness.root(ctx, {
      agent: {
        model: { provider: this.options.provider, modelId: this.options.model },
        thinkingLevel: this.options.thinkingLevel,
        instructions,
        cwd: this.options.env.cwd,
      },
    });
    await this.conversation.configure(
      {
        instructions,
        model: { provider: this.options.provider, modelId: this.options.model },
        thinkingLevel: this.options.thinkingLevel,
        tools: registry
          .snapshot()
          .tools()
          .map((entry) => entry.tool),
      },
      ctx
    );
    // Bounded UI projection of full durable history; compaction changes model context only.
    const page = await this.conversation.entries({ order: 'descending' }, 1000, undefined, ctx);
    this.reset();
    for (const entry of [...page.items].reverse()) this.entry(entry);
    const children = await this.storage.scanConversations(
      { ownerConversationId: this.conversation.id, order: 'descending' },
      3,
      undefined,
      ctx
    );
    for (const child of [...children.items].reverse()) {
      const conversation = await this.harness.conversation(child.id, ctx);
      await conversation?.configure(
        {
          model: { provider: this.options.provider, modelId: this.options.model },
          tools: registry
            .snapshot()
            .tools()
            .map((entry) => entry.tool)
            .filter((tool) => !['delegate_tasks', 'ask_user'].includes(tool.name)),
        },
        ctx
      );
      const instructions = (await conversation?.agent(ctx))?.instructions ?? '';
      const name = /^B70_SUBAGENT_NAME: ([^\n]+)/.exec(instructions)?.[1];
      if (name) {
        await this.attachChild(child.id, name);
        const owner = child.owner && (await this.harness.getTask(child.owner.taskId, ctx));
        if (owner?.state.status === 'terminal') {
          const outcome = owner.state.outcome.status;
          await this.finishChild(
            child.id,
            outcome === 'completed' ? 'completed' : outcome === 'aborted' ? 'stopped' : 'failed'
          );
        }
      }
    }
    // Pi 1.5 defaults to a 50-entry live window. Keep the dashboard's existing
    // bounded history window so reconnects and busy tool rounds retain its trace.
    this.watch = await this.conversation.watch(ctx, { min: 1000, max: 1000 });
    this.project(this.watch.value);
    this.watch.start(async (call) => {
      if (this.closed) return;
      try {
        if (call.kind === 'failed') throw call.error;
        this.project(call.value);
      } catch (error) {
        this.projectionError = error;
        void this.close();
        throw error;
      }
    });
    if (this.options.memoryContext !== undefined)
      this.upsert({
        id: id('memory-context:' + this.options.runId),
        at: new Date().toISOString(),
        kind: 'notice',
        title: 'Memory · verwendeter Startkontext',
        text: this.options.memoryContext,
        state: 'complete',
      });
    this.setState({ status: 'running', name: input.name, task: input.task });
    const submission = await this.submit(input.task, this.options.requestId, 'task', input.images);
    this.monitoring = this.monitor(submission);
    this.hardTimer = setTimeout(
      () => {
        void this.pause(false).catch(() => undefined);
      },
      Math.max(1, this.endAt - Date.now())
    );
    this.hardTimer.unref();
    return this.snapshot();
  }
  async steer(input: SteerAgentRunRequest): Promise<AgentRunSnapshot> {
    if (input.runId !== this.options.runId)
      throw new AgentControlError('conflict', 'The selected run is no longer active.');
    if (this.closed || this.state.status !== 'running')
      throw new AgentControlError('not_running', 'There is no active agent turn to steer.');
    if (this.state.pendingSteering >= 8)
      throw new AgentControlError('busy', 'The steering queue is full.');
    await this.submit(input.message, input.idempotencyKey, 'steering');
    return this.snapshot();
  }
  async cancel(input: CancelAgentRunRequest): Promise<AgentRunSnapshot> {
    if (input.runId !== this.options.runId)
      throw new AgentControlError('conflict', 'The selected run is no longer active.');
    this.setState({ status: 'cancelling' });
    await this.conversation?.abort(ctx, { background: true });
    this.setState({
      status: 'cancelled',
      finishedAt: new Date().toISOString(),
      pendingSteering: 0,
      reason: 'Run wurde abgebrochen.',
      subagents: this.state.subagents?.map((agent) =>
        ['starting', 'running'].includes(agent.status) ? { ...agent, status: 'stopped' } : agent
      ),
    });
    return this.snapshot();
  }
  private async submit(
    text: string,
    requestId: string,
    kind: 'task' | 'steering',
    images?: StartAgentRunRequest['images']
  ): Promise<Submission> {
    if (!this.conversation) throw new Error('Durable conversation not open');
    const existing = await this.storage!.submissionByRequest(this.conversation.id, requestId, ctx);
    if (existing) {
      const submission = await this.harness!.submission(existing.id, ctx);
      if (!submission) throw new Error('Stored submission is unavailable');
      return submission;
    }
    const metadata: AgentTimelineImage[] = [];
    const content: Array<{ type: 'text'; text: string } | ImageContent> = [{ type: 'text', text }];
    for (const image of images ?? []) {
      content.push({ type: 'image', mimeType: image.mimeType, data: image.data });
      const stored = this.options.onInputImage?.({
        mimeType: image.mimeType,
        data: Buffer.from(image.data, 'base64'),
        label: image.label,
      });
      if (stored) metadata.push(stored);
    }
    return await this.conversation.submit(
      {
        type: 'input',
        content,
        whenBusy: 'steer',
        requestId,
        entry: { kind: 'b70.input', data: { id: requestId, kind, images: metadata } },
      },
      ctx
    );
  }
  private async monitor(submission: Submission): Promise<void> {
    try {
      const outcome = await submission.wait(ctx);
      await this.conversation!.waitForIdle(ctx);
      if (this.closed || this.state.status === 'cancelled' || this.state.status === 'cancelling')
        return;
      for (const entry of (await this.conversation!.context(ctx)).entries) this.entry(entry);
      if (this.projectionError) throw this.projectionError;
      this.setState({
        status: outcome.status === 'done' ? 'settled' : 'failed',
        pendingSteering: 0,
        finishedAt: new Date().toISOString(),
        ...(outcome.status === 'unanswered'
          ? {
              reason: `Pi Durable: ${outcome.reason}. ${pretty(outcome.detail ?? '')}`.slice(
                0,
                512
              ),
            }
          : {}),
      });
    } catch (error) {
      if (!this.closed)
        this.setState({
          status: 'failed',
          reason: error instanceof Error ? error.message.slice(0, 512) : 'Durable run failed.',
        });
    }
  }
  async pause(manual = true): Promise<void> {
    if (this.closed) return;
    await this.close();
    await this.options.onPaused?.(manual);
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    clearTimeout(this.hardTimer);
    this.closePromise = (async () => {
      try {
        await this.watch?.stop();
        await Promise.all([...this.childProjections.values()].map((child) => child.watch.stop()));
        await this.harness?.close(ctx);
      } finally {
        await this.options.closeEnvironment();
      }
    })();
    return this.closePromise;
  }
  private childIdentity(childId: ConversationId, name: string) {
    return { id: createHash('sha256').update(String(childId)).digest('hex').slice(0, 16), name };
  }
  private childStatus(childId: ConversationId, name: string, status: SubagentRun['status']) {
    const identity = this.childIdentity(childId, name);
    const agents = [...(this.state.subagents ?? [])];
    const index = agents.findIndex((agent) => agent.id === identity.id);
    if (index >= 0) agents[index] = { ...identity, status };
    else agents.push({ ...identity, status });
    this.setState({ subagents: agents.slice(-3) });
  }
  private async attachChild(childId: ConversationId, name: string): Promise<void> {
    if (this.closed) throw new Error('Runner is closing.');
    const known = this.childProjections.get(childId);
    if (known) {
      this.childStatus(childId, name, 'running');
      return;
    }
    const conversation = await this.harness!.conversation(childId, ctx);
    if (!conversation) throw new Error('Sub-agent conversation not found.');
    const identity = this.childIdentity(childId, name);
    const decoder = new DurableAgentManager({
      ...this.options,
      initialSnapshot: undefined,
      onSteeringConfirmed: undefined,
      beforePublish: (event) => {
        if (event.operation === 'append' || event.operation === 'replace') {
          this.upsert({
            ...event.item,
            id: id(`child:${childId}:${event.item.id}`),
            agent: identity,
          });
        }
      },
    });
    for (const item of this.state.timeline)
      if (item.agent?.id === identity.id && item.toolCallId && item.images)
        decoder.imageCache.set(item.toolCallId, item.images);
    const watch = await conversation.watch(ctx, { min: 1000, max: 1000 });
    this.childProjections.set(childId, { decoder, watch, name });
    const history = await conversation.entries({ order: 'descending' }, 1000, undefined, ctx);
    for (const entry of [...history.items].reverse()) decoder.entry(entry);
    decoder.project(watch.value);
    watch.start(async (call) => {
      if (this.closed) return;
      try {
        if (call.kind === 'failed') throw call.error;
        decoder.project(call.value);
      } catch (error) {
        this.projectionError = error;
        void this.close();
        throw error;
      }
    });
    this.childStatus(childId, name, 'running');
  }
  private async finishChild(
    childId: ConversationId,
    status: 'completed' | 'failed' | 'stopped'
  ): Promise<string> {
    const child = this.childProjections.get(childId);
    if (!child) throw new Error('Sub-agent projection unavailable.');
    const conversation = await this.harness!.conversation(childId, ctx);
    for (const entry of (await conversation!.context(ctx)).entries) child.decoder.entry(entry);
    const messages = child.decoder.state.timeline.filter((item) => item.kind === 'assistant');
    const failed = child.decoder.state.timeline.some(
      (item) => item.kind === 'assistant' && item.state === 'error'
    );
    this.childStatus(childId, child.name, failed ? 'failed' : status);
    const report = (messages.at(-1)?.text ?? 'No final report was produced.').slice(-32768);
    await child.watch.stop();
    this.childProjections.delete(childId);
    return report;
  }
  private project(view: ConversationView): void {
    for (const entry of view.entries) this.entry(entry);
    const live = view.docs['pi.live'] as unknown as LiveState | undefined;
    if (live?.generation?.message) this.assistant(live.generation.message, false);
    for (const tool of live?.tools ?? []) {
      const current = this.state.timeline.find((item) => item.id === id('tool:' + tool.callId));
      if (tool.status === 'done') continue;
      this.upsert({
        ...current,
        id: id('tool:' + tool.callId),
        at: current?.at ?? new Date().toISOString(),
        kind: 'tool',
        title: current?.title ?? tool.name,
        toolName: tool.name,
        toolCallId: tool.callId,
        state: tool.status === 'pending' ? 'queued' : 'running',
        ...(tool.output === undefined ? {} : { outputText: bounded(tool.output) }),
      });
    }
    if (live?.generation?.retry) {
      const retry = live.generation.retry;
      this.upsert({
        id: id('retry:' + retry.at),
        at: new Date().toISOString(),
        kind: 'retry',
        title: 'Wiederholungsversuch',
        text: bounded(retry.error),
        state: 'queued',
      });
    }
    const compactions = live?.compactions ?? [];
    for (const [taskId, itemId] of this.activeCompactions) {
      if (compactions.some((value) => value.taskId === taskId)) continue;
      const old = this.state.timeline.find((value) => value.id === itemId);
      if (old)
        this.upsert({
          ...old,
          state: live?.compactionFailure?.taskId === taskId ? 'error' : 'complete',
          text:
            live?.compactionFailure?.taskId === taskId ? live.compactionFailure.error : old.text,
        });
      this.activeCompactions.delete(taskId);
    }
    for (const compaction of compactions) {
      const key = id('compaction:' + compaction.taskId);
      const old = this.state.timeline.find((item) => item.id === key);
      this.activeCompactions.set(compaction.taskId, key);
      this.upsert({
        id: key,
        at: old?.at ?? new Date().toISOString(),
        kind: 'compaction',
        title: 'Kontext wird komprimiert',
        text: [compaction.trigger, `Versuch ${compaction.attempt}`, compaction.retry?.error]
          .filter(Boolean)
          .join('\n'),
        state: 'running',
      });
    }
    if (live?.compactionFailure && !this.activeCompactions.has(live.compactionFailure.taskId)) {
      const failure = live.compactionFailure;
      const key = id('compaction:' + failure.taskId);
      const old = this.state.timeline.find((item) => item.id === key);
      this.upsert({
        id: key,
        at: old?.at ?? new Date().toISOString(),
        kind: 'compaction',
        title: 'Kontextkomprimierung fehlgeschlagen',
        text: bounded(failure.error),
        state: 'error',
      });
    }
    const inbox = view.docs['pi.inbox'] as unknown as { items?: unknown[] } | undefined;
    const pending = inbox?.items?.length ?? 0;
    if (pending !== this.state.pendingSteering) this.setState({ pendingSteering: pending });
  }
  private entry(entry: EntryRecord): void {
    if (this.seenEntries.has(entry.id)) return;
    this.seenEntries.add(entry.id);
    for (const message of entry.model ?? []) {
      if (message.role === 'user') {
        const data = entry.data as
          { id?: string; kind?: string; images?: AgentTimelineImage[] } | undefined;
        const kind =
          entry.kind === 'pi.compaction'
            ? 'compaction'
            : data?.kind === 'steering'
              ? 'steering'
              : 'task';
        this.upsert({
          id: id('entry:' + entry.id),
          at: new Date(message.timestamp).toISOString(),
          kind,
          title:
            kind === 'compaction'
              ? 'Kontext komprimiert'
              : kind === 'steering'
                ? 'Dein Kommentar · zugestellt'
                : 'Deine Nachricht',
          text: bounded(messageText(message.content)),
          state: 'complete',
          ...(data?.images?.length ? { images: data.images } : {}),
        });
        if (data?.kind === 'steering' && data.id) this.options.onSteeringConfirmed?.(data.id);
      } else if (message.role === 'assistant') this.assistant(message, true);
      else if (message.role === 'toolResult') {
        const key = id('tool:' + message.toolCallId);
        const old = this.state.timeline.find((item) => item.id === key);
        const images = this.images(message.toolCallId, message.content);
        this.upsert({
          ...old,
          id: key,
          at: old?.at ?? new Date(message.timestamp).toISOString(),
          kind: 'tool',
          title: old?.title ?? message.toolName,
          toolName: message.toolName,
          toolCallId: message.toolCallId,
          outputText: bounded(messageText(message.content)),
          state: message.isError ? 'error' : 'complete',
          ...(images.length ? { images } : {}),
        });
      }
    }
  }
  private assistant(message: AssistantMessage, complete: boolean): void {
    const signature = JSON.stringify(message);
    if (!complete && signature === this.lastFinalMessage) return;
    const ordinal =
      this.currentPartial?.timestamp === message.timestamp
        ? this.currentPartial.ordinal
        : (this.completedMessages.get(message.timestamp) ?? 0);
    if (!complete) this.currentPartial = { timestamp: message.timestamp, ordinal };
    message.content.forEach((block, index) => {
      const at = new Date(message.timestamp).toISOString();
      if (block.type === 'text' || block.type === 'thinking')
        this.upsert({
          id: id(`assistant:${message.timestamp}:${ordinal}:${index}:${block.type}`),
          at,
          kind: block.type === 'text' ? 'assistant' : 'thinking',
          title: block.type === 'text' ? 'Agent' : 'Reasoning',
          text: bounded(block.type === 'text' ? block.text : block.thinking),
          state: complete
            ? message.stopReason === 'aborted' || message.stopReason === 'error'
              ? 'error'
              : 'complete'
            : 'running',
        });
      else if (block.type === 'toolCall') {
        const key = id('tool:' + block.id);
        const old = this.state.timeline.find((item) => item.id === key);
        this.upsert({
          ...old,
          id: key,
          at: old?.at ?? at,
          kind: 'tool',
          title: old?.title ?? block.name,
          toolName: block.name,
          toolCallId: block.id,
          argumentsText: pretty(block.arguments),
          state: old?.state ?? 'queued',
        });
      }
    });
    if (complete) {
      this.completedMessages.set(message.timestamp, ordinal + 1);
      this.currentPartial = undefined;
      this.lastFinalMessage = signature;
    }
  }
  private images(callId: string, content: unknown): AgentTimelineImage[] {
    const known = this.imageCache.get(callId);
    if (known) return known;
    const images: AgentTimelineImage[] = [];
    if (Array.isArray(content))
      for (const block of content) {
        if (
          block.type === 'image' &&
          ['image/png', 'image/jpeg', 'image/webp'].includes(block.mimeType)
        ) {
          try {
            const stored = this.options.onImage?.({
              mimeType: block.mimeType,
              data: Buffer.from(block.data, 'base64'),
            });
            if (stored) images.push(stored);
          } catch (error) {
            this.upsert({
              id: id('image-failed:' + callId),
              at: new Date().toISOString(),
              kind: 'notice',
              title: 'Bild nicht gespeichert',
              text: imageStorageFailureReason(error),
              state: 'error',
            });
            if (isRunStorageBudgetError(error)) {
              this.projectionError = error;
              this.setState({
                status: 'failed',
                finishedAt: new Date().toISOString(),
                reason: error.message.slice(0, 512),
                pendingSteering: 0,
              });
              void this.close();
              throw error;
            }
          }
        }
      }
    this.imageCache.set(callId, images);
    return images;
  }
  private upsert(item: AgentTimelineItem): void {
    const index = this.state.timeline.findIndex((old) => old.id === item.id);
    if (index >= 0) {
      if (JSON.stringify(this.state.timeline[index]) === JSON.stringify(item)) return;
      this.state.timeline[index] = item;
      this.publish({
        operation: 'replace',
        runId: this.options.runId,
        sequence: this.next(),
        item,
      });
    } else {
      this.state.timeline.push(item);
      const prunedItemIds: string[] = [];
      while (
        this.state.timeline.length > 1000 ||
        JSON.stringify(this.state.timeline).length > 4 * 1024 * 1024
      ) {
        const removed = this.state.timeline.shift();
        if (removed) prunedItemIds.push(removed.id);
        else break;
      }
      this.publish({
        operation: 'append',
        runId: this.options.runId,
        sequence: this.next(),
        item,
        ...(prunedItemIds.length ? { prunedItemIds } : {}),
      });
    }
  }
  private next() {
    return ++this.state.sequence;
  }
  private reset() {
    this.publish({
      operation: 'reset',
      runId: this.options.runId,
      sequence: this.next(),
      snapshot: this.snapshot(),
    });
  }
  private setState(change: Partial<AgentRunSnapshot>) {
    Object.assign(this.state, change);
    const { timeline: _, ...state } = this.state;
    void _;
    const sequence = this.next();
    this.publish({
      operation: 'state',
      runId: this.options.runId,
      sequence,
      state: { ...state, sequence },
    });
  }
  private publish(event: AgentStreamEvent) {
    const value = AgentStreamEventSchema.parse(event);
    this.options.beforePublish?.(value);
    for (const listener of [...this.listeners]) listener(value);
  }
}
