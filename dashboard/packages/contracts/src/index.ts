/**
 * Shared, runtime-validated API contracts for the Local AI B70 Observatory.
 *
 * Both the backend (Fastify) and the frontend (Vue) import these schemas so
 * that a single source of truth defines the wire format. Types exported via
 * `z.infer` are derived from the schemas instead of being duplicated.
 *
 * Conventions:
 * - Timestamps are ISO 8601 strings in the canonical, calendar-valid
 *   `Date.toISOString()` form `YYYY-MM-DDTHH:MM:SS.sssZ`. Offsets
 *   (`+02:00`), other precisions (no fractional part, 1–2 or 5–6 digits)
 *   and normalized-but-invalid calendar dates (e.g. `2025-02-29`,
 *   `24:00:00`) are all rejected, so values compare correctly
 *   lexicographically (M2 review: retention/range pruning).
 * - Durations are expressed in seconds (`*Seconds`), byte counters in bytes.
 */
import { z } from 'zod';
export * from './live-changes.js';
import { AgentTaskTelemetrySchema } from './task-telemetry.js';
export * from './task-telemetry.js';

/** Stable product identifier used in API payloads. */
export const SERVICE_NAME = 'local-ai-b70-observatory' as const;

/** Overall and per-check service state. */
export const ServiceStatusSchema = z.enum(['ok', 'degraded', 'error']);
export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;

/**
 * Canonical UTC timestamp: exactly the form `Date.toISOString()` produces –
 * `YYYY-MM-DDTHH:MM:SS.sssZ`.
 *
 * Both the shape check (exactly three fractional digits) and the round-trip
 * check (`new Date(value).toISOString() === value`) are required. The
 * round-trip rejects dates the engine would silently normalize away, e.g.
 * `2025-02-29` (→ March 1), `2025-04-31` (→ May 1) or `24:00:00` (→ next
 * day `00:00:00`). Because only one canonical string per instant exists,
 * retention cutoffs and range queries stay correct lexicographically.
 */
export const UtcTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, {
    message:
      'value must be a canonical UTC timestamp of the exact form YYYY-MM-DDTHH:mm:ss.sssZ (Date.toISOString output)',
  })
  .refine(
    (value) => {
      const date = new Date(value);
      return !Number.isNaN(date.getTime()) && date.toISOString() === value;
    },
    { message: 'value must be a real calendar date-time (not a normalized out-of-range date)' }
  );

/** Individual component health check (e.g. gateway, vLLM, GPU, database). */
export const HealthCheckSchema = z.object({
  name: z.string().min(1).max(64),
  status: ServiceStatusSchema,
  message: z.string().min(1).max(256).optional(),
});
export type HealthCheck = z.infer<typeof HealthCheckSchema>;

/** Response body of `GET /api/health`. */
export const HealthPayloadSchema = z
  .object({
    service: z.literal(SERVICE_NAME),
    /** Worst status of all checks: ok < degraded < error. */
    status: ServiceStatusSchema,
    version: z.string().min(1).max(64),
    /** Process start time, UTC. */
    startedAt: UtcTimestampSchema,
    /** Time of measurement, UTC. */
    timestamp: UtcTimestampSchema,
    /** Whole seconds since `startedAt`. */
    uptimeSeconds: z.number().int().nonnegative(),
    checks: z.array(HealthCheckSchema).min(1),
  })
  .strict();
export type HealthPayload = z.infer<typeof HealthPayloadSchema>;

/** Validate untrusted input (e.g. an HTTP response body) as a health payload. */
export function parseHealthPayload(value: unknown): HealthPayload {
  return HealthPayloadSchema.parse(value);
}

/** Error codes used by the API error contract. */
export const ApiErrorCodeSchema = z.enum([
  'bad_request',
  'unauthorized',
  'forbidden',
  'too_many_requests',
  'not_found',
  'internal_error',
  'service_unavailable',
  'conflict',
  'merge_conflict',
  'busy',
  'not_running',
  'protocol',
  'unavailable',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

/** Error body returned by the API for all non-2xx responses. */
export const ApiErrorSchema = z
  .object({
    error: z
      .object({
        code: ApiErrorCodeSchema,
        /** Human-readable, safe-to-display message. Never contains secrets. */
        message: z.string().min(1).max(512),
        /** Present once the gateway assigns request IDs (M3); optional in M1. */
        requestId: z.string().uuid().optional(),
      })
      .strict(),
  })
  .strict();
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** Validate untrusted input as an API error body. */
export function parseApiError(value: unknown): ApiError {
  return ApiErrorSchema.parse(value);
}

/** Password-only browser login. The password is never returned or persisted as plain text. */
export const LoginRequestSchema = z
  .object({
    password: z.string().min(1).max(1024),
  })
  .strict();
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

/**
 * Browser authentication state.
 *
 * `loginRequired` is an optional operator-mode flag: servers run in
 * `OBSERVATORY_BROWSER_AUTH_MODE=none` announce `loginRequired: false`, so
 * the client can skip the login screen and the sign-out action. The field
 * is absent from older servers (which always run password authentication),
 * and clients must treat an absent value as "login required" to stay
 * compatible with those responses.
 */
export const AuthSessionSchema = z
  .object({
    authenticated: z.boolean(),
    expiresAt: UtcTimestampSchema.optional(),
    loginRequired: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.authenticated !== (value.expiresAt !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'expiresAt must be present exactly when authenticated is true',
      });
    }
  });
export type AuthSession = z.infer<typeof AuthSessionSchema>;

export function parseAuthSession(value: unknown): AuthSession {
  return AuthSessionSchema.parse(value);
}

// ---------------------------------------------------------------------------
// Agent Cockpit: bounded live view of one Pi RPC session. The same normalized
// events are durably persisted in the private runner database (operator opt-in
// recorded by ADR-02) before they reach the authenticated same-origin stream.
// ---------------------------------------------------------------------------

export const AgentRunStatusSchema = z.enum([
  /** Agent execution is disabled by server configuration; no runner client is active. */
  'disabled',
  /** A runner is configured, but its control endpoint cannot currently be reached. */
  'unreachable',
  'idle',
  /** Stored durably and waiting for an agent slot. No model or sandbox is active. */
  'queued',
  'starting',
  'running',
  'cancelling',
  'paused',
  'cancelled',
  /** Pi is idle, but checks and human acceptance remain separate. */
  'settled',
  'failed',
]);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

export const AgentTimelineKindSchema = z.enum([
  'task',
  'steering',
  'assistant',
  'thinking',
  'tool',
  'compaction',
  'retry',
  'notice',
  'error',
]);
export type AgentTimelineKind = z.infer<typeof AgentTimelineKindSchema>;

export const AgentTimelineStateSchema = z.enum(['queued', 'running', 'complete', 'error']);
export type AgentTimelineState = z.infer<typeof AgentTimelineStateSchema>;

/**
 * Strict metadata for one runner-persisted agent image. The binary lives in
 * the private runner database; only these validated, bounded fields may ever
 * appear in a timeline item, trace event or SSE frame. No URLs, host paths or
 * base64 payloads are accepted here.
 */
export const AgentTimelineImageSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().uuid(),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    byteLength: z
      .number()
      .int()
      .min(1)
      .max(2 * 1024 * 1024),
    width: z.number().int().min(1).max(1920),
    height: z.number().int().min(1).max(8192),
    label: z.string().trim().min(1).max(128).optional(),
  })
  .strict();
export type AgentTimelineImage = z.infer<typeof AgentTimelineImageSchema>;

export const AgentIdentitySchema = z
  .object({ id: z.string().regex(/^[a-f0-9]{16}$/), name: z.string().min(1).max(80) })
  .strict();
export const SubagentRunSchema = AgentIdentitySchema.extend({
  status: z.enum(['starting', 'running', 'completed', 'failed', 'stopped']),
}).strict();
export type SubagentRun = z.infer<typeof SubagentRunSchema>;

/** One assembled entry in the cockpit timeline. */
export const AgentTimelineItemSchema = z
  .object({
    id: z.string().uuid(),
    at: UtcTimestampSchema,
    kind: AgentTimelineKindSchema,
    title: z.string().min(1).max(256),
    /** Absent for the main agent; children have a separate conversation in the same run. */
    agent: AgentIdentitySchema.optional(),
    /** Bounded normalized content; persisted only in the private runner DB. */
    text: z.string().max(262_144).optional(),
    /** Structured tool-call arguments, kept separate from tool output for rendering. */
    argumentsText: z.string().max(262_144).optional(),
    /** Structured tool result, kept separate from arguments for rendering. */
    outputText: z.string().max(262_144).optional(),
    /**
     * Validated image metadata for tool results carrying real image content
     * (browser screenshots, image reads). The pixel data itself is never
     * part of this contract.
     */
    images: z.array(AgentTimelineImageSchema).min(1).max(16).optional(),
    state: AgentTimelineStateSchema.optional(),
    toolName: z.string().min(1).max(128).optional(),
    toolCallId: z.string().min(1).max(512).optional(),
    durationMs: z.number().int().nonnegative().max(86_400_000).optional(),
    argumentsTruncated: z.boolean().optional(),
    outputTruncated: z.boolean().optional(),
  })
  .strict();
export type AgentTimelineItem = z.infer<typeof AgentTimelineItemSchema>;

/** Small mutable session header, sent independently from timeline deltas. */
export const AgentRunStateSchema = z
  .object({
    service: z.literal(SERVICE_NAME),
    engine: z.enum(['pi-rpc', 'pi-durable']).optional(),
    enabled: z.boolean(),
    status: AgentRunStatusSchema,
    sequence: z.number().int().nonnegative(),
    runId: z.string().uuid().optional(),
    name: z.string().min(1).max(160).optional(),
    task: z.string().min(1).max(65_536).optional(),
    provider: z.string().min(1).max(128).optional(),
    model: z.string().min(1).max(256).optional(),
    thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
    startedAt: UtcTimestampSchema.optional(),
    finishedAt: UtcTimestampSchema.optional(),
    desktopAvailable: z.boolean().optional(),
    pendingSteering: z.number().int().nonnegative(),
    activeRuns: z.number().int().nonnegative().max(8).optional(),
    maxActiveRuns: z.number().int().positive().max(8).optional(),
    subagents: z.array(SubagentRunSchema).max(3).optional(),
    /** Safe operational explanation; never stderr, a prompt or a tool result. */
    reason: z.string().min(1).max(512).optional(),
  })
  .strict();
export type AgentRunState = z.infer<typeof AgentRunStateSchema>;

export const AgentRunSnapshotSchema = AgentRunStateSchema.extend({
  timeline: z.array(AgentTimelineItemSchema).max(1_000),
}).strict();
export type AgentRunSnapshot = z.infer<typeof AgentRunSnapshotSchema>;

/** Incremental SSE operations after the initial snapshot. */
export const AgentStreamEventSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('state'),
      /** Present on M6.3 streams; optional only for reading pre-M6.3 traces. */
      runId: z.string().uuid().optional(),
      sequence: z.number().int().nonnegative(),
      state: AgentRunStateSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('append'),
      runId: z.string().uuid().optional(),
      sequence: z.number().int().nonnegative(),
      item: AgentTimelineItemSchema,
      prunedItemIds: z.array(z.string().uuid()).max(1_000).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('append_text'),
      runId: z.string().uuid().optional(),
      sequence: z.number().int().nonnegative(),
      itemId: z.string().uuid(),
      text: z.string().min(1).max(65_536),
      prunedItemIds: z.array(z.string().uuid()).max(1_000).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('replace'),
      runId: z.string().uuid().optional(),
      sequence: z.number().int().nonnegative(),
      item: AgentTimelineItemSchema,
      prunedItemIds: z.array(z.string().uuid()).max(1_000).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('reset'),
      runId: z.string().uuid().optional(),
      sequence: z.number().int().nonnegative(),
      snapshot: z.lazy(() => AgentRunSnapshotSchema),
    })
    .strict(),
]);
export type AgentStreamEvent = z.infer<typeof AgentStreamEventSchema>;

/** Apply bounded live-window changes without serializing the entire window again. */
export function reduceAgentTimeline(
  timeline: AgentTimelineItem[],
  event: AgentStreamEvent
): AgentTimelineItem[] {
  if (event.operation === 'reset') return event.snapshot.timeline;
  if (event.operation === 'state') return timeline;
  let next = timeline;
  if (event.operation === 'append') next = [...timeline, event.item];
  else if (event.operation === 'replace')
    next = timeline.map((item) => (item.id === event.item.id ? event.item : item));
  else
    next = timeline.map((item) =>
      item.id === event.itemId
        ? { ...item, text: `${item.text ?? ''}${event.text}`.slice(0, 262_144) }
        : item
    );
  if (event.prunedItemIds?.length) {
    const removed = new Set(event.prunedItemIds);
    next = next.filter((item) => !removed.has(item.id));
  }
  return next.slice(-1_000);
}

const ProjectRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\0') &&
      !value.split('/').some((part) => part === '..'),
    'must be a safe project-relative path'
  );

export const AgentProjectCheckSchema = z
  .object({
    label: z.string().trim().min(1).max(160),
    argv: z.array(z.string().min(1).max(1024)).min(1).max(32),
  })
  .strict();
export type AgentProjectCheck = z.infer<typeof AgentProjectCheckSchema>;

export const AgentProjectSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(160),
    repositoryPath: z.string().min(1).max(1024),
    targetBranch: z.string().min(1).max(256),
    workdir: ProjectRelativePathSchema.default('.'),
    editPaths: z.array(ProjectRelativePathSchema).min(1).max(64).default(['.']),
    dependencyPath: ProjectRelativePathSchema.optional(),
    checks: z.array(AgentProjectCheckSchema).max(12).default([]),
    /** Present only when the operator-installed runner permits this fixed target. */
    releaseTarget: z.literal('observatory').optional(),
    /** Historical registration, excluded from new-task selection. */
    archived: z.boolean().optional(),
    /** Runner-owned repository with an isolated Node application runtime. */
    appCapable: z.boolean().optional(),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  })
  .strict();
export type AgentProject = z.infer<typeof AgentProjectSchema>;

export const AgentProjectListSchema = z
  .object({ items: z.array(AgentProjectSchema).max(100) })
  .strict();
export type AgentProjectList = z.infer<typeof AgentProjectListSchema>;

export const RegisterAgentProjectRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    archived: z.boolean().optional(),
    repositoryPath: z.string().trim().min(1).max(1024),
    targetBranch: z.string().trim().min(1).max(256),
    workdir: ProjectRelativePathSchema.default('.'),
    editPaths: z.array(ProjectRelativePathSchema).min(1).max(64).default(['.']),
    dependencyPath: ProjectRelativePathSchema.optional(),
    checks: z.array(AgentProjectCheckSchema).max(12).default([]),
  })
  .strict();
export type RegisterAgentProjectRequest = z.infer<typeof RegisterAgentProjectRequestSchema>;

/** Only public GitHub HTTPS URLs; browser input never becomes a shell command. */
export const CreateAgentProjectRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    idempotencyKey: z.string().uuid(),
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('app') }).strict(),
      z
        .object({
          kind: z.literal('github'),
          url: z
            .string()
            .trim()
            .max(512)
            .regex(
              /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}(?:\.git)?\/?$/
            )
            .refine((value) => !['.', '..', '.git'].includes(value.split('/')[4] ?? '')),
        })
        .strict(),
    ]),
  })
  .strict();
export type CreateAgentProjectRequest = z.infer<typeof CreateAgentProjectRequestSchema>;

export const StartAppPreviewRequestSchema = z
  .object({
    projectId: z.string().uuid(),
    runId: z.string().uuid().optional(),
    revision: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
  })
  .strict()
  .refine((value) => (value.runId === undefined) === (value.revision === undefined));
export type StartAppPreviewRequest = z.infer<typeof StartAppPreviewRequestSchema>;

export const AppPreviewSchema = z
  .object({
    projectId: z.string().uuid(),
    status: z.enum(['stopped', 'starting', 'running', 'failed']),
    revision: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    port: z.number().int().min(1).max(65535).optional(),
    accessPath: z
      .string()
      .regex(/^\/_b70\/open\/[a-f0-9]{64}$/)
      .optional(),
    logs: z.string().max(16384),
  })
  .strict();
export type AppPreview = z.infer<typeof AppPreviewSchema>;

/** Model-ready image copies, independent of original file size at selection. */
export const MAX_AGENT_INPUT_BODY_BYTES = 8 * 1024 * 1024;
// Four reference copies plus two tool screenshots must fit the 16 MiB vision relay.
// This is an automatic encoding target, not a limit on selected original files.
export const AGENT_MODEL_IMAGE_TARGET_BYTES = 1024 * 1024;
export const AgentInputImageSchema = z
  .object({
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    data: z
      .string()
      .min(4)
      .max(1_398_104)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .refine((value) => value.length % 4 === 0),
    label: z.string().trim().min(1).max(128),
  })
  .strict();
export type AgentInputImage = z.infer<typeof AgentInputImageSchema>;
const AgentInputImagesSchema = z.array(AgentInputImageSchema).min(1).max(4);

/** A visual selection is context, never an expansion of the project's edit permissions. */
export const ArchitectureTargetSchema = z
  .object({
    mapId: z.string().regex(/^[a-z0-9-]{1,80}$/),
    nodeId: z.string().regex(/^[a-z0-9-]{1,80}$/),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    label: z.string().trim().min(1).max(160),
    breadcrumbs: z.array(z.string().trim().min(1).max(160)).min(1).max(12),
    sourcePaths: z.array(ProjectRelativePathSchema).max(24),
    point: z
      .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
      .strict()
      .optional(),
  })
  .strict();
export type ArchitectureTarget = z.infer<typeof ArchitectureTargetSchema>;

const MapTextSchema = z
  .object({ en: z.string().min(1).max(512), de: z.string().min(1).max(512) })
  .strict();
export const ProjectArchitectureSchema = z
  .object({
    projectId: z.string().uuid(),
    mapId: z.string().regex(/^[a-z0-9-]{1,80}$/),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    generatedAt: UtcTimestampSchema,
    kind: z.enum(['curated', 'directories']),
    nodes: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9-]{1,80}$/),
            parentId: z
              .string()
              .regex(/^[a-z0-9-]{1,80}$/)
              .optional(),
            label: MapTextSchema,
            description: MapTextSchema,
            sourcePaths: z.array(ProjectRelativePathSchema).max(24),
            screen: z.enum(['projects', 'task', 'overview']).optional(),
          })
          .strict()
      )
      .min(1)
      .max(80),
  })
  .strict();
export type ProjectArchitecture = z.infer<typeof ProjectArchitectureSchema>;
export type ArchitectureNode = ProjectArchitecture['nodes'][number];

export const StartAgentRunRequestSchema = z
  .object({
    projectId: z.string().uuid().optional(),
    architectureTarget: ArchitectureTargetSchema.optional(),
    task: z.string().trim().min(1).max(65_536),
    images: AgentInputImagesSchema.optional(),
    name: z.string().trim().min(1).max(160).optional(),
    /** Stable client-generated key; retries with the same content reuse one run. */
    idempotencyKey: z.string().uuid().optional(),
  })
  .strict();
export type StartAgentRunRequest = z.infer<typeof StartAgentRunRequestSchema>;

export const ContinueAgentTaskRequestSchema = z
  .object({
    taskId: z.string().uuid(),
    images: AgentInputImagesSchema.optional(),
    message: z.string().trim().min(1).max(65_536),
    idempotencyKey: z.string().uuid(),
  })
  .strict();
export type ContinueAgentTaskRequest = z.infer<typeof ContinueAgentTaskRequestSchema>;

export const QueueAgentFollowupRequestSchema = ContinueAgentTaskRequestSchema.omit({
  images: true,
});
export type QueueAgentFollowupRequest = z.infer<typeof QueueAgentFollowupRequestSchema>;

export const AnswerAgentQuestionRequestSchema = z
  .object({
    taskId: z.string().uuid(),
    questionId: z.string().uuid(),
    answer: z.string().trim().min(1).max(16_384),
    expectedTaskVersion: z.number().int().positive(),
    idempotencyKey: z.string().uuid(),
  })
  .strict();
export type AnswerAgentQuestionRequest = z.infer<typeof AnswerAgentQuestionRequestSchema>;

export const AcceptAgentRunRequestSchema = z
  .object({
    runId: z.string().uuid(),
    resultRevision: z.string().regex(/^[a-f0-9]{40}$/),
    expectedTaskVersion: z.number().int().positive(),
  })
  .strict();
export type AcceptAgentRunRequest = z.infer<typeof AcceptAgentRunRequestSchema>;

export const MergeAgentRunRequestSchema = z
  .object({
    runId: z.string().uuid(),
    resultRevision: z.string().regex(/^[a-f0-9]{40}$/),
    expectedTaskVersion: z.number().int().positive(),
  })
  .strict();
export type MergeAgentRunRequest = z.infer<typeof MergeAgentRunRequestSchema>;

export const StartReleaseRequestSchema = z
  .object({
    taskId: z.string().uuid(),
    runId: z.string().uuid(),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    /** Stable client-generated key; retries never create a second build. */
    idempotencyKey: z.string().uuid(),
  })
  .strict();
export type StartReleaseRequest = z.infer<typeof StartReleaseRequestSchema>;

export const ActivateReleaseRequestSchema = z
  .object({
    taskId: z.string().uuid(),
    releaseId: z.string().uuid(),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ActivateReleaseRequest = z.infer<typeof ActivateReleaseRequestSchema>;

export const RollbackReleaseRequestSchema = z.object({ taskId: z.string().uuid() }).strict();
export type RollbackReleaseRequest = z.infer<typeof RollbackReleaseRequestSchema>;

export const StartAgentReviewRequestSchema = z
  .object({
    taskId: z.string().uuid(),
    sourceRunId: z.string().uuid(),
    resultRevision: z.string().regex(/^[a-f0-9]{40}$/),
    instructions: z.string().trim().min(1).max(16_384).optional(),
    idempotencyKey: z.string().uuid(),
  })
  .strict();
export type StartAgentReviewRequest = z.infer<typeof StartAgentReviewRequestSchema>;

export const StartAgentCorrectionRequestSchema = z
  .object({
    taskId: z.string().uuid(),
    reviewId: z.string().uuid(),
    findingIds: z.array(z.string().uuid()).min(1).max(100),
    instructions: z.string().trim().min(1).max(16_384).optional(),
    idempotencyKey: z.string().uuid(),
  })
  .strict();
export type StartAgentCorrectionRequest = z.infer<typeof StartAgentCorrectionRequestSchema>;

export const StartAgentConflictResolutionRequestSchema = z
  .object({
    taskId: z.string().uuid(),
    sourceRunId: z.string().uuid(),
    resultRevision: z.string().regex(/^[a-f0-9]{40}$/),
    expectedTaskVersion: z.number().int().positive(),
    idempotencyKey: z.string().uuid(),
  })
  .strict();
export type StartAgentConflictResolutionRequest = z.infer<
  typeof StartAgentConflictResolutionRequestSchema
>;

export const SteerAgentRunRequestSchema = z
  .object({
    runId: z.string().uuid(),
    expectedRunVersion: z.number().int().positive(),
    expectedTaskVersion: z.number().int().positive(),
    message: z.string().trim().min(1).max(16_384),
    idempotencyKey: z.string().uuid(),
  })
  .strict();
export type SteerAgentRunRequest = z.infer<typeof SteerAgentRunRequestSchema>;

export const CancelAgentRunRequestSchema = z
  .object({
    runId: z.string().uuid(),
    expectedRunVersion: z.number().int().positive(),
    expectedTaskVersion: z.number().int().positive(),
    idempotencyKey: z.string().uuid(),
  })
  .strict();
export type CancelAgentRunRequest = z.infer<typeof CancelAgentRunRequestSchema>;

export function parseAgentRunSnapshot(value: unknown): AgentRunSnapshot {
  return AgentRunSnapshotSchema.parse(value);
}

export function parseAgentStreamEvent(value: unknown): AgentStreamEvent {
  return AgentStreamEventSchema.parse(value);
}

// ---------------------------------------------------------------------------
// M6.2: durable task, turn and run metadata.
//
// The operator explicitly opted into full normalized traces. Gateway traffic
// remains outside this domain, but agent reasoning and tool payloads are
// durable and must stay bound to their exact run.
// ---------------------------------------------------------------------------

export const DurableTaskStatusSchema = z.enum(['open', 'accepted', 'archived']);
export type DurableTaskStatus = z.infer<typeof DurableTaskStatusSchema>;

export const DurableTurnStatusSchema = z.enum([
  'queued',
  'active',
  'waiting_for_input',
  'completed',
  'cancelled',
  'interrupted',
]);
export type DurableTurnStatus = z.infer<typeof DurableTurnStatusSchema>;

export const DurableRunStatusSchema = z.enum([
  'queued',
  'starting',
  'running',
  'completed',
  'yielded',
  'failed',
  'cancelled',
  'interrupted',
]);
export type DurableRunStatus = z.infer<typeof DurableRunStatusSchema>;

export const RunCheckStatusSchema = z.enum(['not_run', 'passed', 'failed']);
export type RunCheckStatus = z.infer<typeof RunCheckStatusSchema>;

export const DurableRunSchema = z
  .object({
    id: z.string().uuid(),
    taskId: z.string().uuid(),
    turnId: z.string().uuid(),
    status: DurableRunStatusSchema,
    version: z.number().int().positive(),
    profileId: z.string().min(1).max(128),
    baseRevision: z.string().regex(/^[a-f0-9]{40}$/),
    resultRevision: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    filesChanged: z.number().int().nonnegative().optional(),
    checkStatus: RunCheckStatusSchema,
    createdAt: UtcTimestampSchema,
    startedAt: UtcTimestampSchema.optional(),
    finishedAt: UtcTimestampSchema.optional(),
    reason: z.string().min(1).max(512).optional(),
  })
  .strict();
export type DurableRun = z.infer<typeof DurableRunSchema>;

export const DurableTaskSummarySchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1).max(160),
    projectId: z.string().uuid().default('00000000-0000-4000-8000-000000000000'),
    projectName: z.string().min(1).max(160).default('Standardprojekt'),
    architectureTarget: ArchitectureTargetSchema.optional(),
    status: DurableTaskStatusSchema,
    version: z.number().int().positive(),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    latestRun: DurableRunSchema,
    attention: z.enum(['question', 'error', 'review', 'waiting', 'none']).optional(),
  })
  .strict();
export const RecentWorkSchema = z
  .object({
    tasks: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            title: z.string(),
            projectName: z.string(),
            updatedAt: UtcTimestampSchema,
            runStatus: DurableRunStatusSchema,
          })
          .strict()
      )
      .max(3),
    projects: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            name: z.string(),
            updatedAt: UtcTimestampSchema,
          })
          .strict()
      )
      .max(3),
  })
  .strict();
export type RecentWork = z.infer<typeof RecentWorkSchema>;

export type DurableTaskSummary = z.infer<typeof DurableTaskSummarySchema>;

export const DurableTaskMessageSchema = z
  .object({
    id: z.string().uuid(),
    taskId: z.string().uuid(),
    turnId: z.string().uuid(),
    runId: z.string().uuid(),
    role: z.enum(['user', 'assistant']),
    text: z.string().min(1).max(262_144),
    createdAt: UtcTimestampSchema,
  })
  .strict();
export type DurableTaskMessage = z.infer<typeof DurableTaskMessageSchema>;

export const SteeringDeliveryStatusSchema = z.enum([
  'stored',
  'sent',
  'acknowledged',
  'uncertain',
  'cancelled',
]);
export type SteeringDeliveryStatus = z.infer<typeof SteeringDeliveryStatusSchema>;

export const DurableSteeringSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().uuid(),
    text: z.string().min(1).max(16_384),
    status: SteeringDeliveryStatusSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    sentAt: UtcTimestampSchema.optional(),
    acknowledgedAt: UtcTimestampSchema.optional(),
    confirmedAt: UtcTimestampSchema.optional(),
    reason: z.string().min(1).max(512).optional(),
  })
  .strict();
export type DurableSteering = z.infer<typeof DurableSteeringSchema>;

export const CancellationStatusSchema = z.enum(['requested', 'stopping', 'completed', 'failed']);
export type CancellationStatus = z.infer<typeof CancellationStatusSchema>;

export const DurableCancellationSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().uuid(),
    status: CancellationStatusSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    completedAt: UtcTimestampSchema.optional(),
    reason: z.string().min(1).max(512).optional(),
  })
  .strict();
export type DurableCancellation = z.infer<typeof DurableCancellationSchema>;

export const DurableTraceEventSchema = z
  .object({
    id: z.number().int().positive(),
    runId: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    recordedAt: UtcTimestampSchema,
    event: AgentStreamEventSchema,
  })
  .strict();
export type DurableTraceEvent = z.infer<typeof DurableTraceEventSchema>;

export const DurableTracePageSchema = z
  .object({
    runId: z.string().uuid(),
    items: z.array(DurableTraceEventSchema).max(250),
    hasMore: z.boolean(),
    nextAfterSequence: z.number().int().nonnegative().optional(),
  })
  .strict();
export type DurableTracePage = z.infer<typeof DurableTracePageSchema>;

export const AgentQuestionSchema = z
  .object({
    id: z.string().uuid(),
    taskId: z.string().uuid(),
    runId: z.string().uuid(),
    question: z.string().min(1).max(16_384),
    status: z.enum(['open', 'answered', 'cancelled']),
    answer: z.string().min(1).max(16_384).optional(),
    createdAt: UtcTimestampSchema,
    answeredAt: UtcTimestampSchema.optional(),
  })
  .strict();
export type AgentQuestion = z.infer<typeof AgentQuestionSchema>;

export const AgentRunCheckResultSchema = z
  .object({
    label: z.string().min(1).max(160),
    argv: z.array(z.string().min(1).max(1024)).min(1).max(32),
    status: z.enum(['passed', 'failed']),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().nonnegative(),
    output: z.string().max(524_288),
  })
  .strict();
export type AgentRunCheckResult = z.infer<typeof AgentRunCheckResultSchema>;

export const AgentRunResultSchema = z
  .object({
    runId: z.string().uuid(),
    resultRevision: z.string().regex(/^[a-f0-9]{40}$/),
    files: z.array(z.string().min(1).max(1024)).max(5_000),
    diff: z.string().max(524_288),
    diffTruncated: z.boolean().default(false),
    checkStatus: RunCheckStatusSchema,
    checks: z.array(AgentRunCheckResultSchema).max(12),
    acceptedAt: UtcTimestampSchema.optional(),
    acceptedRevision: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    mergedAt: UtcTimestampSchema.optional(),
    mergedRevision: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
  })
  .strict();
export type AgentRunResult = z.infer<typeof AgentRunResultSchema>;

export const ReleaseJobStatusSchema = z.enum([
  'queued',
  'building',
  'prepared',
  'activating',
  'active',
  'failed',
  'rolled_back',
]);
export type ReleaseJobStatus = z.infer<typeof ReleaseJobStatusSchema>;

export const ReleaseJobSchema = z
  .object({
    id: z.string().uuid(),
    taskId: z.string().uuid(),
    runId: z.string().uuid(),
    projectId: z.string().uuid(),
    target: z.literal('observatory'),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    status: ReleaseJobStatusSchema,
    checkStatus: RunCheckStatusSchema,
    buildLog: z.string().max(524_288),
    artifactDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    preparedAt: UtcTimestampSchema.optional(),
    activatedAt: UtcTimestampSchema.optional(),
    reason: z.string().min(1).max(512).optional(),
  })
  .strict();
export type ReleaseJob = z.infer<typeof ReleaseJobSchema>;

const DeployedReleaseSchema = z
  .object({
    releaseId: z.string().min(1).max(128),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const DeploymentStateSchema = z
  .object({
    status: z.enum(['idle', 'activating', 'active', 'failed', 'rolled_back']),
    current: DeployedReleaseSchema.optional(),
    previous: DeployedReleaseSchema.optional(),
    pending: DeployedReleaseSchema.optional(),
    message: z.string().max(512).optional(),
    updatedAt: UtcTimestampSchema,
  })
  .strict();
export type DeploymentState = z.infer<typeof DeploymentStateSchema>;

export const AgentReviewFindingSeveritySchema = z.enum([
  'critical',
  'high',
  'medium',
  'low',
  'info',
]);
export type AgentReviewFindingSeverity = z.infer<typeof AgentReviewFindingSeveritySchema>;

export const AgentReviewFindingInputSchema = z
  .object({
    severity: AgentReviewFindingSeveritySchema,
    title: z.string().trim().min(1).max(160),
    file: ProjectRelativePathSchema.optional(),
    line: z.number().int().positive().max(10_000_000).optional(),
    reasoning: z.string().trim().min(1).max(8_192),
    evidence: z.string().trim().min(1).max(8_192).optional(),
  })
  .strict();
export type AgentReviewFindingInput = z.infer<typeof AgentReviewFindingInputSchema>;

export const AgentReviewSubmissionSchema = z
  .object({
    summary: z.string().trim().min(1).max(16_384),
    findings: z.array(AgentReviewFindingInputSchema).max(100),
  })
  .strict();
export type AgentReviewSubmission = z.infer<typeof AgentReviewSubmissionSchema>;

export const AgentReviewFindingSchema = AgentReviewFindingInputSchema.extend({
  id: z.string().uuid(),
  selected: z.boolean().default(false),
}).strict();
export type AgentReviewFinding = z.infer<typeof AgentReviewFindingSchema>;

export const AgentReviewSchema = z
  .object({
    id: z.string().uuid(),
    taskId: z.string().uuid(),
    sourceRunId: z.string().uuid(),
    reviewerRunId: z.string().uuid(),
    resultRevision: z.string().regex(/^[a-f0-9]{40}$/),
    instructions: z.string().min(1).max(16_384).optional(),
    status: DurableRunStatusSchema,
    summary: z.string().min(1).max(16_384).optional(),
    findings: z.array(AgentReviewFindingSchema).max(100),
    stale: z.boolean(),
    createdAt: UtcTimestampSchema,
    finishedAt: UtcTimestampSchema.optional(),
  })
  .strict();
export type AgentReview = z.infer<typeof AgentReviewSchema>;

export const DurableTaskDetailSchema = z
  .object({
    task: DurableTaskSummarySchema,
    runs: z.array(DurableRunSchema).max(100),
    messages: z.array(DurableTaskMessageSchema).max(500),
    steering: z.array(DurableSteeringSchema).max(1_000).default([]),
    cancellations: z.array(DurableCancellationSchema).max(100).default([]),
    openQuestion: AgentQuestionSchema.optional(),
    latestResult: AgentRunResultSchema.optional(),
    reviews: z.array(AgentReviewSchema).max(100).default([]),
    releases: z.array(ReleaseJobSchema).max(100).default([]),
    deployment: DeploymentStateSchema.optional(),
    queuedFollowup: z.string().min(1).max(65_536).optional(),
    latestSnapshot: AgentRunSnapshotSchema.optional(),
    traceEventCount: z.number().int().nonnegative(),
    telemetry: AgentTaskTelemetrySchema.optional(),
  })
  .strict();
export type DurableTaskDetail = z.infer<typeof DurableTaskDetailSchema>;

export const DurableTaskListSchema = z
  .object({
    items: z.array(DurableTaskSummarySchema).max(100),
    activeTaskId: z.string().uuid().optional(),
    activeTaskIds: z.array(z.string().uuid()).max(8).default([]),
  })
  .strict();
export type DurableTaskList = z.infer<typeof DurableTaskListSchema>;

export function parseDurableTaskList(value: unknown): DurableTaskList {
  return DurableTaskListSchema.parse(value);
}

/**
 * Outcome of a targeted title regeneration for one stored task. `regenerated`
 * is `false` when the model produced no usable title (the stored title is
 * kept) or when it returned exactly the title that is already stored.
 */
export const RegenerateTaskTitleResultSchema = z
  .object({
    taskId: z.string().uuid(),
    title: z.string().min(1).max(160),
    regenerated: z.boolean(),
  })
  .strict();
export type RegenerateTaskTitleResult = z.infer<typeof RegenerateTaskTitleResultSchema>;

export function parseDurableTaskDetail(value: unknown): DurableTaskDetail {
  return DurableTaskDetailSchema.parse(value);
}

export function parseDurableTracePage(value: unknown): DurableTracePage {
  return DurableTracePageSchema.parse(value);
}

export {
  canTransitionRun,
  canTransitionTurn,
  isTerminalRunStatus,
  isTerminalTurnStatus,
} from './agent-state.js';

// ---------------------------------------------------------------------------
// M4A: vLLM telemetry snapshot (Prometheus source, server-side normalized).
// Sent over the authenticated SSE stream (`event: telemetry`). All counters
// are cumulative values reported by vLLM; *PerSecond values are rates derived
// server-side from counter deltas and are `undefined` after a counter reset
// or before the first delta is observable. No raw LLM content or secrets can
// appear in this payload – only machine-readable numbers, a bounded model
// name and a sanitized source message.
// ---------------------------------------------------------------------------

/** Freshness of the vLLM Prometheus source behind the snapshot. */
export const TelemetrySourceStatusSchema = z.enum(['ok', 'stale', 'error']);
export type TelemetrySourceStatus = z.infer<typeof TelemetrySourceStatusSchema>;

/**
 * Result of the read-only Intel-GPU interface probe (M4A). GPU values are
 * shown only when the local interface reliably provides them with unambiguous
 * units; otherwise the UI must show an honest "not available" state.
 */
export const GpuAvailabilitySchema = z.union([
  z
    .object({
      available: z.literal(false),
      /** Concrete, secret-free explanation of the missing interface. */
      reason: z.string().min(1).max(256),
    })
    .strict(),
  z.object({ available: z.literal(true) }).strict(),
]);
export type GpuAvailability = z.infer<typeof GpuAvailabilitySchema>;

/** Finished reasons vLLM reports in `vllm:request_success_total`. */
export const FinishedReasonSchema = z.enum(['stop', 'length', 'abort', 'error', 'repetition']);
export type FinishedReason = z.infer<typeof FinishedReasonSchema>;

const nonNegativeInt = z.number().int().nonnegative();
const nonNegativeRate = z.number().nonnegative().finite();
const unitRatio = z.number().min(0).max(1).finite();

/** `vllm:num_requests_running` / `vllm:num_requests_waiting` (summed over engines). */
export const VllmTelemetryRequestsSchema = z
  .object({
    running: nonNegativeInt,
    waiting: nonNegativeInt,
  })
  .strict();
export type VllmTelemetryRequests = z.infer<typeof VllmTelemetryRequestsSchema>;

/** Token counters and rates from vLLM. */
export const VllmTelemetryTokensSchema = z
  .object({
    /** `vllm:prompt_tokens_total` (cumulative, full prompt lengths). */
    promptTokens: nonNegativeInt,
    /** `vllm:generation_tokens_total` (cumulative, emitted in real time). */
    generationTokens: nonNegativeInt,
    /**
     * Prefill throughput: newly computed prompt tokens (KV tokens that missed
     * the prefix cache) per second of actual prefill time, derived from the
     * vLLM per-request histograms `request_prefill_kv_computed_tokens` /
     * `request_prefill_time_seconds` over the window of finished requests.
     * Absent on first sighting, after a counter reset, when the series are
     * not reported, or while no prefill finished in the window (an idle
     * window has no prefill rate, not 0).
     */
    promptTokensPerSecond: nonNegativeRate.optional(),
    /**
     * Decode throughput in real time: delta of `vllm:generation_tokens_total`
     * per wall-clock second (the counter advances per emitted token). Absent
     * on first sighting or after a reset.
     */
    generationTokensPerSecond: nonNegativeRate.optional(),
    /**
     * Average decode throughput per concurrent request:
     * `generationTokensPerSecond / num_requests_running`. Absent while
     * `num_requests_running` is 0 (a per-request rate is undefined without
     * running requests, just like the prefill rate is absent in an idle
     * window) or after a counter reset.
     */
    generationTokensPerSecondPerRequest: nonNegativeRate.optional(),
  })
  .strict();
export type VllmTelemetryTokens = z.infer<typeof VllmTelemetryTokensSchema>;

/**
 * Prefix-cache counters (`prefix_cache_queries_total` /
 * `prefix_cache_hits_total`), cumulative since vLLM started.
 *
 * vLLM credits both counters in a single batch step per request at
 * *admission* (the moment the request is admitted to the scheduler and its
 * prompt is looked up in the KV cache): the request's full prompt length is
 * added to `queriedTokens` and the part found in the cache to
 * `hitTokens`. There is no matching per-request time axis to divide by (the
 * lookup is instantaneous at admission and vLLM reports no prefix-cache
 * duration), so this section deliberately carries **no** "tokens per second"
 * rate: a wall-clock delta of these counters would be "prompt length of the
 * requests admitted in the window ÷ window length", an aggregation artifact
 * that spikes with individual prompt lengths (e.g. one 26 000-token request
 * admitted in a 10 s window would read ~2 600 tok/s). The cumulative
 * counters and the cumulative hit rate below are the well-defined
 * quantities.
 */
export const VllmTelemetryPrefixCacheSchema = z
  .object({
    /** Tokens queried from the prefix cache (cumulative). */
    queriedTokens: nonNegativeInt,
    /** Tokens served from the prefix cache (cumulative). */
    hitTokens: nonNegativeInt,
    /** hitTokens / queriedTokens (cumulative since process start); absent while no queries were observed. */
    hitRate: unitRatio.optional(),
  })
  .strict();
export type VllmTelemetryPrefixCache = z.infer<typeof VllmTelemetryPrefixCacheSchema>;

/** MTP (speculative decoding) counters, summed over all engines. */
export const VllmTelemetryMtpSchema = z
  .object({
    /** `vllm:spec_decode_num_draft_tokens_total`. */
    draftTokens: nonNegativeInt,
    /** `vllm:spec_decode_num_accepted_tokens_total`. */
    acceptedTokens: nonNegativeInt,
    /** accepted / draft; absent while no drafts were observed. */
    acceptanceRate: unitRatio.optional(),
  })
  .strict();
export type VllmTelemetryMtp = z.infer<typeof VllmTelemetryMtpSchema>;

/** Finished requests (`vllm:request_success_total`, one series per reason). */
export const VllmTelemetryRequestsFinishedSchema = z
  .object({
    /** Sum over all finished-reason series. */
    total: nonNegativeInt,
    /** Counts per reason; unknown reason labels are excluded (total still includes them). */
    byReason: z.record(FinishedReasonSchema, nonNegativeInt).optional(),
  })
  .strict();
export type VllmTelemetryRequestsFinished = z.infer<typeof VllmTelemetryRequestsFinishedSchema>;

/** Average latencies derived from vLLM histogram `_sum`/`_count` pairs. */
export const VllmTelemetryLatencySchema = z
  .object({
    /** Mean end-to-end request latency in whole-precision ms. */
    e2eAvgMs: z.number().positive().finite().optional(),
    /** Mean time to first token in ms. */
    ttftAvgMs: z.number().positive().finite().optional(),
    /** Mean inter-token latency in ms. */
    interTokenAvgMs: z.number().positive().finite().optional(),
  })
  .strict();
export type VllmTelemetryLatency = z.infer<typeof VllmTelemetryLatencySchema>;

/**
 * One normalized vLLM telemetry snapshot.
 *
 * `timestamp` is the instant of the last *successful* scrape; if the source
 * is failing the payload keeps the last known values and the (unchanging)
 * `timestamp`, while `sourceStatus` moves to `stale`/`error`. Section objects
 * are omitted entirely when the corresponding vLLM series are absent, so the
 * UI can distinguish "not reported" from "zero".
 */
export const VllmTelemetryPayloadSchema = z
  .object({
    service: z.literal(SERVICE_NAME),
    sourceStatus: TelemetrySourceStatusSchema,
    /**
     * Sanitized, machine-readable explanation of the source failure
     * (e.g. `timeout nach 3000 ms`). Contains no URL, no header and no
     * secret.
     */
    sourceMessage: z.string().min(1).max(256).optional(),
    /** Instant of the last successful scrape (UTC, canonical form). */
    timestamp: UtcTimestampSchema,
    /** `model_name` label of the vLLM series. */
    model: z.string().min(1).max(128).optional(),
    requests: VllmTelemetryRequestsSchema.optional(),
    /** KV-cache usage in percent (0–100). vLLM reports 0–1. */
    kvCacheUsagePercent: z.number().min(0).max(100).finite().optional(),
    tokens: VllmTelemetryTokensSchema.optional(),
    prefixCache: VllmTelemetryPrefixCacheSchema.optional(),
    mtp: VllmTelemetryMtpSchema.optional(),
    requestsFinished: VllmTelemetryRequestsFinishedSchema.optional(),
    latency: VllmTelemetryLatencySchema.optional(),
    gpu: GpuAvailabilitySchema,
  })
  .strict();
export type VllmTelemetryPayload = z.infer<typeof VllmTelemetryPayloadSchema>;

/** Validate untrusted SSE data as a vLLM telemetry payload. */
export function parseVllmTelemetryPayload(value: unknown): VllmTelemetryPayload {
  return VllmTelemetryPayloadSchema.parse(value);
}

// ---------------------------------------------------------------------------
// M4B: system & GPU snapshot (sources: /proc, /sys, node:fs statfs).
// Sent over the authenticated SSE stream (`event: system`). All values are
// derived server-side from read-only local interfaces and runtime-validated
// before publication. Absent values are omitted ("not reported"), never
// faked as zero; GPU attributes the local driver does not expose are listed
// in `gpu.missing` so the UI can render an honest "nicht verfügbar" state.
// ---------------------------------------------------------------------------

/** CPU section of the system snapshot (source: `/proc/stat`, `/proc/loadavg`). */
export const SystemCpuSchema = z
  .object({
    /** Logical processor count of this machine (`os.cpus()`). */
    coreCount: z.number().int().positive().max(4096),
    /**
     * Busy percent (0–100) derived from jiffies deltas. Absent on the very
     * first measurement (no previous sample) and after a counter reset.
     */
    utilizationPercent: z.number().min(0).max(100).finite().optional(),
    /** 1/5/15-minute load averages (`/proc/loadavg`). */
    load1: z.number().min(0).max(1000).finite().optional(),
    load5: z.number().min(0).max(1000).finite().optional(),
    load15: z.number().min(0).max(1000).finite().optional(),
  })
  .strict();
export type SystemCpu = z.infer<typeof SystemCpuSchema>;

/** RAM section (source: `/proc/meminfo`; all counters in bytes). */
export const SystemMemorySchema = z
  .object({
    totalBytes: nonNegativeInt,
    /** `MemTotal - MemAvailable` (the figure `free(1)` shows as "used"). */
    usedBytes: nonNegativeInt.optional(),
    availableBytes: nonNegativeInt.optional(),
    usagePercent: z.number().min(0).max(100).finite().optional(),
  })
  .strict();
export type SystemMemory = z.infer<typeof SystemMemorySchema>;

/** Disk section (source: `node:fs statfs` on the configured path). */
export const SystemDiskSchema = z
  .object({
    /** Filesystem path the figures refer to. */
    path: z.string().min(1).max(255),
    totalBytes: nonNegativeInt,
    /** `df`-style used: capacity minus free blocks (reserved root blocks counted as used). */
    usedBytes: nonNegativeInt.optional(),
    /** Free for unprivileged users (`bavail`). */
    freeBytes: nonNegativeInt.optional(),
    usagePercent: z.number().min(0).max(100).finite().optional(),
  })
  .strict();
export type SystemDisk = z.infer<typeof SystemDiskSchema>;

/** Process/service section (source: `/proc/loadavg` plus own process state). */
export const SystemProcessSchema = z
  .object({
    /** Total kernel process/task count; absent if unreadable. */
    count: nonNegativeInt.optional(),
    /** Currently running (run-queue) processes. */
    running: nonNegativeInt.optional(),
    /** Resident set size of the observatory's own process, bytes. */
    observatoryRssBytes: nonNegativeInt,
    /** Whole seconds since the observatory process started. */
    uptimeSeconds: nonNegativeInt,
  })
  .strict();
export type SystemProcess = z.infer<typeof SystemProcessSchema>;

/** GPU attributes the local xe-driver interface does not expose. */
export const GpuMissingFieldSchema = z.enum([
  'utilization',
  'vram',
  'temperature',
  'power',
  'clock',
]);
export type GpuMissingField = z.infer<typeof GpuMissingFieldSchema>;

/**
 * Live Intel-GPU values with explicit Linux units. A field is present only
 * when the local interface actually exposes it with unambiguous units:
 * `gpu_busy_percent` (0–100), `mem_info_vram_*` (bytes) on the DRM device,
 * a documented hwmon power value or energy delta and `temp*_input`
 * (millidegrees Celsius) under hwmon, plus a documented driver clock where
 * present.
 */
export const GpuValuesSchema = z
  .object({
    utilizationPercent: z.number().min(0).max(100).finite().optional(),
    vramUsedBytes: nonNegativeInt.optional(),
    vramTotalBytes: nonNegativeInt.optional(),
    /** Degrees Celsius (max over all hwmon temperature sensors, 1 decimal). */
    temperatureC: z.number().finite().optional(),
    /** Watts (2 decimals), directly reported or derived from a hwmon energy delta. */
    powerWatts: z.number().min(0).finite().optional(),
    /** Megahertz from a documented hwmon or xe-driver frequency attribute. */
    clockMhz: z.number().min(0).finite().optional(),
  })
  .strict();
export type GpuValues = z.infer<typeof GpuValuesSchema>;

/**
 * `available: false` is the honest
 * terminal state (no usable xe interface); `available: true` with some
 * fields absent in `values` means "partially exposed" and those fields must
 * be rendered as "nicht verfügbar", never as 0.
 */
export const GpuSectionSchema = z.union([
  z
    .object({
      available: z.literal(false),
      /** Concrete, secret-free explanation of the missing interface. */
      reason: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      available: z.literal(true),
      /** DRM card name, e.g. `card0`. */
      card: z.string().min(1).max(64).optional(),
      values: GpuValuesSchema,
      missing: z.array(GpuMissingFieldSchema).max(5).optional(),
    })
    .strict(),
]);
export type GpuSection = z.infer<typeof GpuSectionSchema>;

/**
 * One normalized system snapshot. `timestamp` marks the last *successful*
 * collection; if the local sources fail the payload keeps the last known
 * values and the (unchanging) timestamp while `sourceStatus` moves to
 * `stale`/`error` – exactly like the vLLM telemetry snapshot.
 */
export const SystemSnapshotSchema = z
  .object({
    service: z.literal(SERVICE_NAME),
    sourceStatus: TelemetrySourceStatusSchema,
    /** Sanitized, secret-free explanation of the source failure. */
    sourceMessage: z.string().min(1).max(256).optional(),
    /** Instant of the last successful collection (UTC, canonical form). */
    timestamp: UtcTimestampSchema,
    cpu: SystemCpuSchema.optional(),
    memory: SystemMemorySchema.optional(),
    disk: SystemDiskSchema.optional(),
    process: SystemProcessSchema.optional(),
    gpu: GpuSectionSchema,
  })
  .strict();
export type SystemSnapshot = z.infer<typeof SystemSnapshotSchema>;

/** Validate untrusted SSE data as a system snapshot. */
export function parseSystemSnapshot(value: unknown): SystemSnapshot {
  return SystemSnapshotSchema.parse(value);
}

// ---------------------------------------------------------------------------
// M5A: read-only historical API.
//
// All schemas are strictly closed (`.strict()`): raw LLM content (prompts,
// responses, tool payloads), headers, cookies and secrets have no field in
// any of these shapes and therefore cannot appear in an API response. The
// same applies to the free-text `errorMessage`/`detail` database columns,
// which stay out of every contract here.
// ---------------------------------------------------------------------------

/** Origin of a request (mirrors the `requests.origin` column). */
export const RequestOriginSchema = z.enum(['web', 'pi', 'script', 'cli', 'unknown']);
export type RequestOrigin = z.infer<typeof RequestOriginSchema>;

/** Lifecycle status of a request (mirrors `requests.status`). */
export const RequestStatusSchema = z.enum(['in_progress', 'completed', 'error', 'aborted']);
export type RequestStatus = z.infer<typeof RequestStatusSchema>;

/** HTTP method of the proxied request (mirrors `requests.method`). */
export const RequestMethodSchema = z.enum([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);
export type RequestMethod = z.infer<typeof RequestMethodSchema>;

/** Lifecycle event types recorded in `request_events`. */
export const RequestEventTypeSchema = z.enum([
  'start',
  'first_token',
  'token',
  'error',
  'abort',
  'complete',
]);
export type RequestEventType = z.infer<typeof RequestEventTypeSchema>;

const nonNegativeIntM5a = z.number().int().nonnegative();
const errorCodeGen = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_.-]+$/);

/**
 * One row of the paginated request list (`GET /api/requests`). Metadata only:
 * statuses, counters with documented units (`*Ms` whole milliseconds,
 * `*Bytes` bytes, `*Tokens` whole tokens). Null-valued database fields are
 * omitted, so the UI can distinguish "not reported" from "zero".
 */
export const RequestSummarySchema = z
  .object({
    id: z.string().uuid(),
    origin: RequestOriginSchema,
    model: z.string().min(1).max(128).optional(),
    /** URL path of the proxied endpoint (query strings are never stored). */
    endpoint: z.string().min(1).max(512),
    method: RequestMethodSchema,
    status: RequestStatusSchema,
    httpStatus: z.number().int().min(100).max(599).optional(),
    startedAtUtc: UtcTimestampSchema,
    completedAtUtc: UtcTimestampSchema.optional(),
    durationMs: nonNegativeIntM5a.optional(),
    ttftMs: nonNegativeIntM5a.optional(),
    promptTokens: nonNegativeIntM5a.optional(),
    completionTokens: nonNegativeIntM5a.optional(),
    totalTokens: nonNegativeIntM5a.optional(),
    promptBytes: nonNegativeIntM5a,
    responseBytes: nonNegativeIntM5a,
    prefixCacheQueries: nonNegativeIntM5a.optional(),
    prefixCacheHits: nonNegativeIntM5a.optional(),
    mtpDraftTokens: nonNegativeIntM5a.optional(),
    mtpAcceptedTokens: nonNegativeIntM5a.optional(),
    /** Sanitized machine-readable error class (e.g. `upstream_timeout`). */
    errorCode: errorCodeGen.optional(),
  })
  .strict();
export type RequestSummary = z.infer<typeof RequestSummarySchema>;

/** One lifecycle event of a request, ordered by its per-request sequence. */
export const RequestEventDtoSchema = z
  .object({
    /** 1-based per-request sequence, strictly increasing. */
    sequence: z.number().int().positive(),
    eventType: RequestEventTypeSchema,
    atUtc: UtcTimestampSchema,
  })
  .strict();
export type RequestEventDto = z.infer<typeof RequestEventDtoSchema>;

/** Response of `GET /api/requests/:id`: full persisted metadata + events. */
export const RequestDetailSchema = RequestSummarySchema.extend({
  /** Lifecycle events in ascending `sequence` order. */
  events: z.array(RequestEventDtoSchema),
});
export type RequestDetail = z.infer<typeof RequestDetailSchema>;

/**
 * Opaque pagination cursor: URL-safe base64url, bounded in length. Its
 * content is server-internal (keyset position + filter binding) and must be
 * treated as an opaque, non-forgery-relevant handle: the server re-checks
 * every decoded cursor against the request's current filter set.
 */
export const CursorValueSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/, { message: 'cursor must be URL-safe base64url' });
export type CursorValue = z.infer<typeof CursorValueSchema>;

/** Maximum page size of the request list. */
export const MAX_REQUEST_PAGE_SIZE = 200;
/** Default page size of the request list. */
export const DEFAULT_REQUEST_PAGE_SIZE = 50;
/** Maximum number of buckets a metric history response may contain. */
export const MAX_METRIC_HISTORY_BUCKETS = 1000;

/** Query contract of `GET /api/requests`. All parameters are optional. */
export const RequestListQuerySchema = z
  .object({
    /** Exact request-ID filter (UUID). */
    id: z.string().uuid().optional(),
    status: RequestStatusSchema.optional(),
    /** Exact model-name filter. */
    model: z.string().min(1).max(128).optional(),
    /** Include requests started at or after this instant (canonical UTC). */
    from: UtcTimestampSchema.optional(),
    /** Include requests started at or before this instant (canonical UTC). */
    to: UtcTimestampSchema.optional(),
    limit: z.coerce.number().int().min(1).max(MAX_REQUEST_PAGE_SIZE).optional(),
    cursor: CursorValueSchema.optional(),
  })
  .strict();
export type RequestListQuery = z.infer<typeof RequestListQuerySchema>;

/**
 * Response of `GET /api/requests`. Items are ordered newest first
 * (`startedAtUtc DESC, id DESC`). `nextCursor` is present if and only if
 * another page exists for the *same* filter set; it is null at the end.
 */
export const RequestListResponseSchema = z
  .object({
    items: z.array(RequestSummarySchema).max(MAX_REQUEST_PAGE_SIZE),
    nextCursor: CursorValueSchema.nullable(),
  })
  .strict();
export type RequestListResponse = z.infer<typeof RequestListResponseSchema>;

/**
 * Query contract of `GET /api/metrics/history`. Exactly one allowlisted
 * series per call; both bounds are canonical UTC, inclusive. `bucketSeconds`
 * is the explicit aggregation width (epoch-aligned buckets).
 */
export const MetricsHistoryQuerySchema = z
  .object({
    /** Allowlisted series key (checked server-side). */
    series: z.string().min(1).max(64),
    from: UtcTimestampSchema,
    to: UtcTimestampSchema,
    /** Bucket width in whole seconds (1–86400); the result is capped at 1000 buckets. */
    bucketSeconds: z.coerce.number().int().min(1).max(86_400),
  })
  .strict();
export type MetricsHistoryQuery = z.infer<typeof MetricsHistoryQuerySchema>;

/** One aggregation bucket of a metric history series. */
export const MetricBucketSchema = z
  .object({
    /** Canonical UTC instant of the bucket start (epoch-aligned). */
    atUtc: UtcTimestampSchema,
    min: z.number().finite(),
    max: z.number().finite(),
    avg: z.number().finite(),
    /** Number of raw samples inside the bucket. */
    count: z.number().int().positive(),
  })
  .strict();
export type MetricBucket = z.infer<typeof MetricBucketSchema>;

/** Response of `GET /api/metrics/history`. Buckets are in ascending order. */
export const MetricsHistoryResponseSchema = z
  .object({
    series: z.string().min(1).max(64),
    /** Unambiguous unit of the series (e.g. `percent`, `bytes`). */
    unit: z.string().min(1).max(32),
    bucketSeconds: z.number().int().min(1).max(86_400),
    buckets: z.array(MetricBucketSchema).max(MAX_METRIC_HISTORY_BUCKETS),
  })
  .strict();
export type MetricsHistoryResponse = z.infer<typeof MetricsHistoryResponseSchema>;

/** Validate untrusted input as a request-list response. */
export function parseRequestListResponse(value: unknown): RequestListResponse {
  return RequestListResponseSchema.parse(value);
}

/** Validate untrusted input as a request-detail response. */
export function parseRequestDetail(value: unknown): RequestDetail {
  return RequestDetailSchema.parse(value);
}

/** Validate untrusted input as a metric-history response. */
export function parseMetricsHistoryResponse(value: unknown): MetricsHistoryResponse {
  return MetricsHistoryResponseSchema.parse(value);
}

/** A bounded invalidation signal; actual metadata is read through the historical API. */
export const HistoryChangeSchema = z
  .object({
    resources: z
      .array(z.enum(['requests', 'metrics']))
      .min(1)
      .max(2),
    timestamp: UtcTimestampSchema,
  })
  .strict();
export type HistoryChange = z.infer<typeof HistoryChangeSchema>;

// ---------------------------------------------------------------------------
// M5C: numbered SSE events, replay and re-synchronisation.
//
// Every replayable data frame on `GET /api/events` carries a validated `id:`
// field of the form `<generation>-<sequence>`. `<generation>` is a random
// 8-hex-char process token (a server restart creates a new generation, so an
// id from a previous process can never match the new buffer); `<sequence>` is
// strictly monotonically increasing from 1 within the process. Connection-
// local `stream` control frames do not advance this global data cursor.
// ---------------------------------------------------------------------------

/** Named event types on the shared `/api/events` stream. */
export const SseEventTypeSchema = z.enum(['health', 'telemetry', 'system', 'history', 'stream']);
export type SseEventType = z.infer<typeof SseEventTypeSchema>;

/**
 * First control frame of an SSE connection (M5C). It tells the browser how to
 * interpret the frames that follow:
 * - `resync`: the client's `Last-Event-ID` was missing, too old, foreign
 *   (different process generation), invalid or in the future – the journal
 *   cannot prove continuity, so the server sends fresh current snapshots and
 *   the browser must treat its previous values as reloaded, not replayed;
 * - `replay`: the buffered missed events (ids > Last-Event-ID) are re-sent
 *   exactly once in global order; `types` lists which event kinds are part
 *   of the replay, so the browser can keep sources it did *not* miss current.
 *
 * The notice contains no telemetry values and no request content.
 */
export const StreamNoticeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('resync') }).strict(),
  z
    .object({ kind: z.literal('replay'), types: z.array(SseEventTypeSchema).min(0).max(5) })
    .strict(),
]);
export type StreamNotice = z.infer<typeof StreamNoticeSchema>;

/** Validate untrusted SSE data as a stream notice. */
export function parseStreamNotice(value: unknown): StreamNotice {
  return StreamNoticeSchema.parse(value);
}

export const EngineUnitStateSchema = z.enum([
  'active',
  'activating',
  'deactivating',
  'inactive',
  'failed',
  'unknown',
]);
const EngineUnitRuntimeSchema = z
  .object({
    state: EngineUnitStateSchema,
    uptimeSeconds: nonNegativeInt.optional(),
  })
  .strict();
export const EngineRuntimesSchema = z
  .object({
    hostUptimeSeconds: nonNegativeInt,
    text: EngineUnitRuntimeSchema,
    image: EngineUnitRuntimeSchema,
  })
  .strict();
export type EngineRuntimes = z.infer<typeof EngineRuntimesSchema>;

/** State of the single locally managed vLLM user service. */
export const EngineServiceStatusSchema = z
  .object({
    activeState: EngineUnitStateSchema,
    autostart: z.boolean(),
    gpu: z
      .object({
        phase: z.enum([
          'text',
          'draining',
          'loading-image',
          'image',
          'loading-text',
          'failed',
          'closed',
        ]),
        activeText: z.number().int().nonnegative(),
        waitingText: z.number().int().nonnegative(),
        waitingImages: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type EngineServiceStatus = z.infer<typeof EngineServiceStatusSchema>;

export const EngineServiceActionSchema = z
  .object({
    action: z.enum(['start', 'stop', 'restart', 'enable', 'disable']),
  })
  .strict();
export type EngineServiceAction = z.infer<typeof EngineServiceActionSchema>['action'];

/** A bounded browser dictation recording; processed locally on the CPU. */
export const SpeechInputSchema = z
  .object({
    data: z
      .string()
      .min(4)
      .max(11_184_812)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    mimeType: z.enum(['audio/mp4', 'audio/webm', 'audio/ogg', 'audio/wav']),
    language: z.enum(['de-DE', 'en-US']).default('de-DE'),
  })
  .strict();
export type SpeechInput = z.infer<typeof SpeechInputSchema>;
export const SpeechStatusSchema = z
  .object({
    available: z.boolean(),
    device: z.literal('cpu'),
    maxSeconds: z.literal(120),
  })
  .strict();
export const SpeechResultSchema = z.object({ text: z.string().max(16_384) }).strict();

export * from './memory.js';

export const EngineModeSchema = z.enum(['text', 'hybrid', 'studio']);
export type EngineMode = z.infer<typeof EngineModeSchema>;
export const EngineModeStateSchema = z.object({
  mode: EngineModeSchema,
  changing: z.boolean(),
  imageTools: z.boolean(),
  agentsAllowed: z.boolean(),
  available: z.boolean().default(true),
});
export type EngineModeState = z.infer<typeof EngineModeStateSchema>;
export { parseStudioResponse, StudioDraftSchema, StudioReferenceSchema } from './studio.js';
export {
  EngineMetricsSchema,
  ImageJobMetricSchema,
  type EngineMetrics,
  type ImageJobMetric,
} from './engine-metrics.js';
