import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ArchitectureTargetSchema,
  StartAgentRunRequestSchema,
  AgentRunSnapshotSchema,
  canTransitionRun,
  canTransitionTurn,
  reduceAgentTimeline,
  AgentStreamEventSchema,
  AgentTimelineImageSchema,
  AgentTaskTelemetrySchema,
  InferenceRequestTelemetrySchema,
  InferenceTelemetryTotalsSchema,
  DurableRunSchema,
  DurableTaskDetailSchema,
  DurableTaskListSchema,
  RecentWorkSchema,
  DurableTracePageSchema,
  ReleaseJobSchema,
  type AgentRunSnapshot,
  type AgentProject,
  type AgentReview,
  type AgentReviewSubmission,
  type ReleaseJob,
  type AgentRunResult,
  type AgentStreamEvent,
  type DurableRun,
  type DurableRunStatus,
  type DurableTaskDetail,
  type DurableTurnStatus,
  type DurableTaskList,
  type DurableTracePage,
  type CancelAgentRunRequest,
  type ContinueAgentTaskRequest,
  type RegisterAgentProjectRequest,
  type QueueAgentFollowupRequest,
  type StartAgentRunRequest,
  type StartAgentReviewRequest,
  type StartAgentCorrectionRequest,
  type StartReleaseRequest,
  type SteerAgentRunRequest,
  type AgentTimelineImage,
  type AgentTaskTelemetry,
  type AgentRunTelemetry,
  type InferenceRequestTelemetry,
  type InferenceTelemetryTotals,
} from '@observatory/contracts';
import { validateAgentImage } from '@observatory/runner';
import {
  DEFAULT_RUN_STORAGE_BUDGET_BYTES,
  RUN_STORAGE_CONTROL_RESERVE_BYTES,
} from './storage-budget.js';

const MAX_TRACE_EVENTS = 50_000;
const MAX_TRACE_PAGE_BYTES = 4 * 1024 * 1024;
const ACTIVE_RUNS = "'queued','starting','running'";
// Legacy immediate dispatches still reserve a slot while queued. Durable backlog does not.
const OCCUPIED_RUN_PREDICATE =
  "(status IN ('starting','running') OR (status='queued' AND NOT EXISTS (SELECT 1 FROM agent_queue q WHERE q.run_id=agent_runs.id)))";

/**
 * Normal run lifecycle edges, plus one explicitly documented exception:
 * `queued -> failed` is the legitimate early start failure, where a run is
 * marked failed before the runner ever started it (start refused, sandbox
 * failure, recovery launch failure before the run was claimed). Backwards
 * transitions (for example `running -> starting`) are not permitted; only
 * `queued -> failed` beyond the shared graph is allowed here.
 */
function isAllowedRunUpdate(from: DurableRunStatus, to: DurableRunStatus): boolean {
  return canTransitionRun(from, to) || (from === 'queued' && to === 'failed');
}

function snapshotStatus(
  status: DurableRunStatus,
  previous?: AgentRunSnapshot['status']
): AgentRunSnapshot['status'] {
  if (status === 'interrupted') return previous === 'paused' ? 'paused' : 'failed';
  if (status === 'completed' || status === 'yielded') return 'settled';
  return status;
}

interface ImageRow {
  id: string;
  run_id: string;
  mime_type: string;
  byte_length: number;
  width: number;
  height: number;
  label: string | null;
  data: Buffer | Uint8Array;
}

export class TaskStoreError extends Error {
  constructor(
    readonly code:
      | 'busy'
      | 'conflict'
      | 'idempotency_conflict'
      | 'invalid_transition'
      | 'not_found'
      | 'persistence'
      | 'storage_budget',
    message: string
  ) {
    super(message);
    this.name = 'TaskStoreError';
  }
}

export interface AcceptedRun {
  taskId: string;
  turnId: string;
  runId: string;
  sandboxRunId: string;
  projectId: string;
  baseRevision: string;
  inputRevision: string;
  sourceWorkspace?: string;
  created: boolean;
}

export interface QueuedRun {
  accepted: AcceptedRun;
  input: StartAgentRunRequest;
  recentContext: string;
}

export interface AcceptedReview extends AcceptedRun {
  reviewId: string;
  instructions?: string;
}

export interface AcceptedRelease {
  release: ReleaseJob;
  created: boolean;
}

export interface AcceptedSteering {
  id: string;
  runId: string;
  message: string;
  created: boolean;
  runVersion: number;
  taskVersion: number;
}

export interface AcceptedCancellation {
  id: string;
  runId: string;
  created: boolean;
  runVersion: number;
  taskVersion: number;
}

interface RunRow {
  id: string;
  task_id: string;
  turn_id: string;
  status: string;
  version: number;
  profile_id: string;
  base_revision: string;
  result_revision: string | null;
  files_changed: number | null;
  check_status: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  reason: string | null;
}

interface TaskRow {
  has_open_question: number;
  result_accepted_at: string | null;
  id: string;
  title: string;
  project_id: string;
  project_name: string;
  architecture_target_json: string | null;
  status: string;
  version: number;
  created_at: string;
  updated_at: string;
  run_id: string;
  run_task_id: string;
  turn_id: string;
  run_status: string;
  run_version: number;
  profile_id: string;
  base_revision: string;
  result_revision: string | null;
  files_changed: number | null;
  check_status: string;
  run_created_at: string;
  started_at: string | null;
  finished_at: string | null;
  reason: string | null;
}

interface TraceRow {
  id: number;
  run_id: string;
  sequence: number;
  recorded_at: string;
  payload_json: string;
}

function rollbackQuietly(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK;');
  } catch {
    // BEGIN itself may have failed; preserve the original error.
  }
}

const MIGRATION = `
CREATE TABLE IF NOT EXISTS runner_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  repository_path TEXT NOT NULL UNIQUE,
  target_branch TEXT NOT NULL,
  workdir TEXT NOT NULL,
  edit_paths_json TEXT NOT NULL,
  dependency_path TEXT,
  checks_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
  status TEXT NOT NULL CHECK(status IN ('open','accepted','archived')),
  version INTEGER NOT NULL CHECK(version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_turns (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal > 0),
  status TEXT NOT NULL CHECK(status IN ('queued','active','waiting_for_input','completed','cancelled','interrupted')),
  version INTEGER NOT NULL CHECK(version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, ordinal)
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
  sandbox_run_id TEXT NOT NULL UNIQUE CHECK(length(sandbox_run_id) = 32),
  status TEXT NOT NULL CHECK(status IN ('queued','starting','running','completed','yielded','failed','cancelled','interrupted')),
  version INTEGER NOT NULL CHECK(version > 0),
  profile_id TEXT NOT NULL CHECK(length(profile_id) BETWEEN 1 AND 128),
  base_revision TEXT NOT NULL CHECK(length(base_revision) = 40),
  check_status TEXT NOT NULL CHECK(check_status IN ('not_run','passed','failed')),
  owner_generation TEXT,
  lease_expires_at TEXT,
  job_instance_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  reason TEXT CHECK(reason IS NULL OR length(reason) <= 512),
  latest_snapshot_json TEXT,
  latest_snapshot_sequence INTEGER,
  trace_event_count INTEGER NOT NULL DEFAULT 0,
  trace_payload_bytes INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
CREATE INDEX IF NOT EXISTS idx_agent_runs_task_created ON agent_runs(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_inference_telemetry (
  request_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  duration_ms REAL NOT NULL CHECK(duration_ms >= 0),
  engine_wait_ms REAL CHECK(engine_wait_ms IS NULL OR engine_wait_ms >= 0),
  outcome TEXT NOT NULL CHECK(outcome IN ('completed','failed')),
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_input_tokens INTEGER,
  prefill_tokens INTEGER,
  prefill_ms REAL,
  decode_tokens INTEGER,
  decode_ms REAL
);
CREATE INDEX IF NOT EXISTS idx_agent_inference_telemetry_run ON agent_inference_telemetry(run_id);

CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 262144),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_task_created ON agent_messages(task_id, created_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_messages_run_role ON agent_messages(run_id, role);

CREATE TABLE IF NOT EXISTS agent_dispatches (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
  status TEXT NOT NULL CHECK(status IN ('pending','claimed','started','finished')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_queue (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
  accepted_json TEXT NOT NULL,
  input_json TEXT NOT NULL,
  recent_context TEXT NOT NULL,
  origin_task_id TEXT
);
CREATE TABLE IF NOT EXISTS agent_steering (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 16384),
  status TEXT NOT NULL CHECK(status IN ('stored','sent','acknowledged','uncertain','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_cancellations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  idempotency_key TEXT UNIQUE,
  request_digest TEXT,
  status TEXT NOT NULL CHECK(status IN ('requested','stopping','completed','failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  reason TEXT CHECK(reason IS NULL OR length(reason) <= 512)
);

CREATE TABLE IF NOT EXISTS agent_trace_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence >= 0),
  recorded_at TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('state','append','append_text','replace','reset')),
  payload_json TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL CHECK(payload_bytes >= 0),
  UNIQUE(run_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_agent_trace_run_sequence ON agent_trace_events(run_id, sequence);

CREATE TABLE IF NOT EXISTS agent_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  media_type TEXT,
  byte_size INTEGER CHECK(byte_size IS NULL OR byte_size >= 0),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_images (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png','image/jpeg','image/webp')),
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 2097152),
  width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 1920),
  height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 8192),
  label TEXT CHECK(label IS NULL OR length(label) BETWEEN 1 AND 128),
  data BLOB NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_agent_images_run ON agent_images(run_id, created_at);

CREATE TABLE IF NOT EXISTS agent_input_images (
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  image_id TEXT NOT NULL REFERENCES agent_images(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 3),
  PRIMARY KEY(run_id, position)
);

CREATE TABLE IF NOT EXISTS agent_questions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  question TEXT NOT NULL CHECK(length(question) BETWEEN 1 AND 16384),
  status TEXT NOT NULL CHECK(status IN ('open','answered','cancelled')),
  answer TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_questions_open
  ON agent_questions(task_id) WHERE status='open';

CREATE TABLE IF NOT EXISTS agent_run_results (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  result_revision TEXT NOT NULL CHECK(length(result_revision)=40),
  workspace_path TEXT NOT NULL,
  files_json TEXT NOT NULL,
  diff_text TEXT NOT NULL,
  diff_truncated INTEGER NOT NULL DEFAULT 0,
  checks_json TEXT NOT NULL,
  accepted_at TEXT,
  accepted_revision TEXT,
  merged_at TEXT,
  merged_revision TEXT
);

CREATE TABLE IF NOT EXISTS agent_followups (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 65536),
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('queued','claimed')),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_followups_queued
  ON agent_followups(task_id) WHERE status='queued';

CREATE TABLE IF NOT EXISTS agent_reviews (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  source_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  reviewer_run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
  result_revision TEXT NOT NULL CHECK(length(result_revision)=40),
  instructions TEXT,
  summary TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_reviews_task_created
  ON agent_reviews(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_review_findings (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES agent_reviews(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  severity TEXT NOT NULL CHECK(severity IN ('critical','high','medium','low','info')),
  title TEXT NOT NULL,
  file_path TEXT,
  line_number INTEGER,
  reasoning TEXT NOT NULL,
  evidence TEXT,
  selected INTEGER NOT NULL DEFAULT 0,
  UNIQUE(review_id, ordinal)
);

CREATE TABLE IF NOT EXISTS release_jobs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES agent_projects(id) ON DELETE CASCADE,
  target TEXT NOT NULL CHECK(target='observatory'),
  revision TEXT NOT NULL CHECK(length(revision)=40),
  status TEXT NOT NULL CHECK(status IN ('queued','building','prepared','activating','active','failed','rolled_back')),
  check_status TEXT NOT NULL CHECK(check_status IN ('not_run','passed','failed')),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
  artifact_path TEXT,
  artifact_digest TEXT,
  build_log TEXT NOT NULL DEFAULT '',
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  prepared_at TEXT,
  activated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_release_jobs_task_created
  ON release_jobs(task_id, created_at DESC);
`;

function ensureColumn(
  database: DatabaseSync,
  table: string,
  name: string,
  declaration: string
): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === name)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
  }
}

function steeringDigest(input: SteerAgentRunRequest): string {
  return createHash('sha256')
    .update(JSON.stringify({ runId: input.runId, message: input.message.trim() }))
    .digest('hex');
}

function cancellationDigest(input: CancelAgentRunRequest): string {
  return createHash('sha256')
    .update(JSON.stringify({ runId: input.runId }))
    .digest('hex');
}

function digestRequest(input: StartAgentRunRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        projectId: input.projectId ?? null,
        task: input.task.trim(),
        ...(input.architectureTarget === undefined
          ? {}
          : { architectureTarget: input.architectureTarget }),
        name: input.name?.trim() ?? null,
        ...(input.images === undefined ? {} : { images: input.images }),
      })
    )
    .digest('hex');
}

function digestContinuation(input: ContinueAgentTaskRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        taskId: input.taskId,
        message: input.message.trim(),
        ...(input.images === undefined ? {} : { images: input.images }),
      })
    )
    .digest('hex');
}

function digestReview(input: StartAgentReviewRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        taskId: input.taskId,
        sourceRunId: input.sourceRunId,
        resultRevision: input.resultRevision,
        instructions: input.instructions?.trim() ?? null,
      })
    )
    .digest('hex');
}

function digestRelease(input: StartReleaseRequest): string {
  return createHash('sha256')
    .update(JSON.stringify({ taskId: input.taskId, runId: input.runId, revision: input.revision }))
    .digest('hex');
}

function releaseFromRow(row: Record<string, unknown>): ReleaseJob {
  return ReleaseJobSchema.parse({
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    projectId: row.project_id,
    target: row.target,
    revision: row.revision,
    status: row.status,
    checkStatus: row.check_status,
    buildLog: row.build_log,
    ...(row.artifact_digest === null ? {} : { artifactDigest: row.artifact_digest }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.prepared_at === null ? {} : { preparedAt: row.prepared_at }),
    ...(row.activated_at === null ? {} : { activatedAt: row.activated_at }),
    ...(row.reason === null ? {} : { reason: row.reason }),
  });
}

function runFromRow(row: RunRow): DurableRun {
  return DurableRunSchema.parse({
    id: row.id,
    taskId: row.task_id,
    turnId: row.turn_id,
    status: row.status,
    version: row.version,
    profileId: row.profile_id,
    baseRevision: row.base_revision,
    ...(row.result_revision === null ? {} : { resultRevision: row.result_revision }),
    ...(row.files_changed === null ? {} : { filesChanged: row.files_changed }),
    checkStatus: row.check_status,
    createdAt: row.created_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    ...(row.reason === null ? {} : { reason: row.reason }),
  });
}

function summaryFromRow(row: TaskRow) {
  return {
    id: row.id,
    title: row.title,
    projectId: row.project_id,
    projectName: row.project_name,
    ...(row.architecture_target_json == null
      ? {}
      : {
          architectureTarget: ArchitectureTargetSchema.parse(
            JSON.parse(row.architecture_target_json)
          ),
        }),
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attention:
      row.status !== 'open'
        ? 'none'
        : ['queued', 'starting', 'running'].includes(row.run_status)
          ? 'none'
          : row.has_open_question
            ? 'question'
            : ['failed', 'interrupted'].includes(row.run_status)
              ? 'error'
              : row.run_status === 'completed' && row.result_revision && !row.result_accepted_at
                ? 'review'
                : row.run_status === 'yielded'
                  ? 'waiting'
                  : 'none',
    latestRun: runFromRow({
      id: row.run_id,
      task_id: row.run_task_id,
      turn_id: row.turn_id,
      status: row.run_status,
      version: row.run_version,
      profile_id: row.profile_id,
      base_revision: row.base_revision,
      result_revision: row.result_revision,
      files_changed: row.files_changed,
      check_status: row.check_status,
      created_at: row.run_created_at,
      started_at: row.started_at,
      finished_at: row.finished_at,
      reason: row.reason,
    }),
  };
}

export function reducePersistedTrace(
  current: AgentRunSnapshot | undefined,
  event: AgentStreamEvent
): AgentRunSnapshot | undefined {
  if (event.operation === 'reset') return event.snapshot;
  if (current === undefined || event.sequence <= current.sequence) return current;
  if (event.operation === 'state') return { ...event.state, timeline: current.timeline };
  return {
    ...current,
    sequence: event.sequence,
    timeline: reduceAgentTimeline(current.timeline, event),
  };
}

export class AgentTaskStore {
  readonly database: DatabaseSync;
  private readonly snapshotCache = new Map<string, AgentRunSnapshot>();

  constructor(
    pathOrDatabase: string | DatabaseSync,
    readonly runStorageBudgetBytes = DEFAULT_RUN_STORAGE_BUDGET_BYTES
  ) {
    if (
      !Number.isSafeInteger(runStorageBudgetBytes) ||
      runStorageBudgetBytes < 1024 * 1024 ||
      runStorageBudgetBytes > 16 * 1024 ** 3
    )
      throw new Error('Invalid per-run storage budget.');
    if (typeof pathOrDatabase === 'string') {
      mkdirSync(dirname(pathOrDatabase), { recursive: true, mode: 0o700 });
      this.database = new DatabaseSync(pathOrDatabase, { timeout: 5_000 });
      this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    } else {
      this.database = pathOrDatabase;
    }
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    try {
      this.database.exec('BEGIN IMMEDIATE;');
      this.database.exec(MIGRATION);
      ensureColumn(this.database, 'agent_inference_telemetry', 'engine_wait_ms', 'REAL');
      ensureColumn(this.database, 'agent_steering', 'idempotency_key', 'TEXT');
      ensureColumn(this.database, 'agent_steering', 'request_digest', 'TEXT');
      ensureColumn(this.database, 'agent_steering', 'sent_at', 'TEXT');
      ensureColumn(this.database, 'agent_steering', 'acknowledged_at', 'TEXT');
      ensureColumn(this.database, 'agent_steering', 'confirmed_at', 'TEXT');
      ensureColumn(this.database, 'agent_steering', 'reason', 'TEXT');
      ensureColumn(this.database, 'agent_runs', 'latest_snapshot_json', 'TEXT');
      ensureColumn(this.database, 'agent_runs', 'latest_snapshot_sequence', 'INTEGER');
      ensureColumn(this.database, 'agent_runs', 'trace_event_count', 'INTEGER NOT NULL DEFAULT 0');
      ensureColumn(
        this.database,
        'agent_runs',
        'trace_payload_bytes',
        'INTEGER NOT NULL DEFAULT 0'
      );
      ensureColumn(this.database, 'agent_projects', 'archived', 'INTEGER NOT NULL DEFAULT 0');
      ensureColumn(this.database, 'agent_tasks', 'project_id', 'TEXT');
      ensureColumn(this.database, 'agent_tasks', 'architecture_target_json', 'TEXT');
      ensureColumn(this.database, 'agent_runs', 'result_revision', 'TEXT');
      ensureColumn(this.database, 'agent_runs', 'files_changed', 'INTEGER');
      ensureColumn(
        this.database,
        'agent_runs',
        'run_kind',
        "TEXT NOT NULL DEFAULT 'implementation'"
      );
      ensureColumn(this.database, 'agent_questions', 'answer_idempotency_key', 'TEXT');
      ensureColumn(this.database, 'agent_questions', 'answer_digest', 'TEXT');
      this.database.exec(`
        UPDATE agent_runs
           SET trace_event_count=(SELECT COUNT(*) FROM agent_trace_events e WHERE e.run_id=agent_runs.id),
               trace_payload_bytes=(SELECT COALESCE(SUM(payload_bytes),0) FROM agent_trace_events e WHERE e.run_id=agent_runs.id)
         WHERE trace_event_count=0
           AND EXISTS(SELECT 1 FROM agent_trace_events e WHERE e.run_id=agent_runs.id);
      `);
      this.database.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_steering_idempotency ON agent_steering(idempotency_key)'
      );
      this.database
        .prepare('INSERT OR IGNORE INTO runner_schema_migrations(version, applied_at) VALUES(1, ?)')
        .run(new Date().toISOString());
      this.database
        .prepare('INSERT OR IGNORE INTO runner_schema_migrations(version, applied_at) VALUES(2, ?)')
        .run(new Date().toISOString());
      this.database
        .prepare('INSERT OR IGNORE INTO runner_schema_migrations(version, applied_at) VALUES(3, ?)')
        .run(new Date().toISOString());
      this.database
        .prepare('INSERT OR IGNORE INTO runner_schema_migrations(version, applied_at) VALUES(4, ?)')
        .run(new Date().toISOString());
      this.database
        .prepare('INSERT OR IGNORE INTO runner_schema_migrations(version, applied_at) VALUES(5, ?)')
        .run(new Date().toISOString());
      ensureColumn(this.database, 'agent_run_results', 'merged_at', 'TEXT');
      ensureColumn(this.database, 'agent_run_results', 'merged_revision', 'TEXT');
      // Existing accepted rows predate the separated merge step and already
      // carried the result into the project; keep their durable state. This
      // backfill must run exactly once, when the columns are introduced, so
      // later approval-only rows never get faked merge markers.
      const mergeStepApplied = this.database
        .prepare('SELECT COUNT(*) AS count FROM runner_schema_migrations WHERE version=7')
        .get() as { count: number };
      if (mergeStepApplied.count === 0) {
        this.database.exec(`
          UPDATE agent_run_results
             SET merged_at=accepted_at, merged_revision=accepted_revision
           WHERE accepted_at IS NOT NULL AND merged_at IS NULL;
        `);
      }
      this.database
        .prepare('INSERT OR IGNORE INTO runner_schema_migrations(version, applied_at) VALUES(6, ?)')
        .run(new Date().toISOString());
      this.database
        .prepare('INSERT OR IGNORE INTO runner_schema_migrations(version, applied_at) VALUES(7, ?)')
        .run(new Date().toISOString());
      this.database
        .prepare('INSERT OR IGNORE INTO runner_schema_migrations(version, applied_at) VALUES(8, ?)')
        .run(new Date().toISOString());
      this.database
        .prepare('INSERT OR IGNORE INTO runner_schema_migrations(version, applied_at) VALUES(9, ?)')
        .run(new Date().toISOString());
      this.database
        .prepare(
          'INSERT OR IGNORE INTO runner_schema_migrations(version, applied_at) VALUES(10, ?)'
        )
        .run(new Date().toISOString());
      this.database
        .prepare(
          'INSERT OR IGNORE INTO runner_schema_migrations(version, applied_at) VALUES(11, ?)'
        )
        .run(new Date().toISOString());
      this.database.exec('COMMIT;');
    } catch (error) {
      rollbackQuietly(this.database);
      throw error;
    }
  }

  registerProject(input: RegisterAgentProjectRequest, at = new Date()): AgentProject {
    const now = at.toISOString();
    const existing = this.database
      .prepare('SELECT id,created_at FROM agent_projects WHERE repository_path=?')
      .get(input.repositoryPath) as { id: string; created_at: string } | undefined;
    const id = existing?.id ?? randomUUID();
    const createdAt = existing?.created_at ?? now;
    this.database
      .prepare(
        `INSERT INTO agent_projects(
           id,name,repository_path,target_branch,workdir,edit_paths_json,dependency_path,
           checks_json,created_at,updated_at,archived
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(repository_path) DO UPDATE SET
           name=excluded.name,target_branch=excluded.target_branch,workdir=excluded.workdir,
           edit_paths_json=excluded.edit_paths_json,dependency_path=excluded.dependency_path,
           checks_json=excluded.checks_json,updated_at=excluded.updated_at,
           archived=COALESCE(?,agent_projects.archived)`
      )
      .run(
        id,
        input.name,
        input.repositoryPath,
        input.targetBranch,
        input.workdir,
        JSON.stringify(input.editPaths),
        input.dependencyPath ?? null,
        JSON.stringify(input.checks),
        createdAt,
        now,
        input.archived === true ? 1 : 0,
        input.archived === undefined ? null : Number(input.archived)
      );
    return this.getProject(id);
  }

  seedDefaultProject(input: RegisterAgentProjectRequest): AgentProject {
    const project = this.registerProject(input);
    this.database
      .prepare('UPDATE agent_tasks SET project_id=? WHERE project_id IS NULL')
      .run(project.id);
    return project;
  }

  listProjects(): AgentProject[] {
    return this.database
      .prepare('SELECT * FROM agent_projects ORDER BY name COLLATE NOCASE,created_at')
      .all()
      .map((row) => this.projectFromRow(row as Record<string, unknown>));
  }

  getProject(projectId: string): AgentProject {
    const row = this.database.prepare('SELECT * FROM agent_projects WHERE id=?').get(projectId);
    if (row === undefined) throw new TaskStoreError('not_found', 'Project not found.');
    return this.projectFromRow(row as Record<string, unknown>);
  }

  private projectFromRow(row: Record<string, unknown>): AgentProject {
    return {
      id: String(row.id),
      name: String(row.name),
      repositoryPath: String(row.repository_path),
      archived: row.archived === 1,
      targetBranch: String(row.target_branch),
      workdir: String(row.workdir),
      editPaths: JSON.parse(String(row.edit_paths_json)) as string[],
      ...(row.dependency_path === null ? {} : { dependencyPath: String(row.dependency_path) }),
      checks: JSON.parse(String(row.checks_json)) as AgentProject['checks'],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  hasStartRequest(idempotencyKey: string): boolean {
    return (
      this.database
        .prepare('SELECT 1 FROM agent_dispatches WHERE idempotency_key=?')
        .get(idempotencyKey) !== undefined
    );
  }

  acceptRun(
    input: StartAgentRunRequest,
    options: {
      projectId?: string;
      profileId: string;
      baseRevision: string;
      maxActiveRuns?: number;
      enqueue?: boolean;
      originTaskId?: string;
      now?: Date;
      /**
       * Idempotency digests are computed from the original client request. The
       * service may replace `name` (e.g. with a model-generated title) for
       * persistence while identical retries must still match the dispatch.
       */
      digestInput?: StartAgentRunRequest;
    }
  ): AcceptedRun {
    const projectId = options.projectId ?? this.ensureLegacyProject();
    const now = (options.now ?? new Date()).toISOString();
    const key = input.idempotencyKey ?? randomUUID();
    const digest = digestRequest(options.digestInput ?? input);
    try {
      this.database.exec('BEGIN IMMEDIATE;');
      const existing = this.database
        .prepare(
          `SELECT d.request_digest, r.id AS run_id, r.task_id, r.turn_id, r.sandbox_run_id,
                  r.base_revision,t.project_id
             FROM agent_dispatches d
             JOIN agent_runs r ON r.id = d.run_id
             JOIN agent_tasks t ON t.id = r.task_id
            WHERE d.idempotency_key = ?`
        )
        .get(key) as
        | {
            request_digest: string;
            run_id: string;
            task_id: string;
            turn_id: string;
            sandbox_run_id: string;
            base_revision: string;
            project_id: string;
          }
        | undefined;
      if (existing !== undefined) {
        if (existing.request_digest !== digest) {
          throw new TaskStoreError(
            'idempotency_conflict',
            'The idempotency key is already bound to different task content.'
          );
        }
        this.database.exec('COMMIT;');
        return {
          taskId: existing.task_id,
          turnId: existing.turn_id,
          runId: existing.run_id,
          sandboxRunId: existing.sandbox_run_id,
          projectId: existing.project_id,
          baseRevision: existing.base_revision,
          inputRevision: existing.base_revision,
          created: false,
        };
      }
      const active = this.database
        .prepare(`SELECT COUNT(*) AS count FROM agent_runs WHERE ${OCCUPIED_RUN_PREDICATE}`)
        .get() as { count: number };
      if (!options.enqueue && active.count >= (options.maxActiveRuns ?? 1)) {
        throw new TaskStoreError('busy', 'The configured parallel agent limit is reached.');
      }
      const taskId = randomUUID();
      const turnId = randomUUID();
      const runId = randomUUID();
      const sandboxRunId = runId.replaceAll('-', '');
      const title =
        input.name?.trim() || input.task.trim().split('\n')[0]?.slice(0, 160) || 'Agent task';
      this.database
        .prepare(
          "INSERT INTO agent_tasks(id,title,project_id,architecture_target_json,status,version,created_at,updated_at) VALUES(?,?,?,?,'open',1,?,?)"
        )
        .run(
          taskId,
          title,
          projectId,
          input.architectureTarget === undefined ? null : JSON.stringify(input.architectureTarget),
          now,
          now
        );
      this.database
        .prepare(
          "INSERT INTO agent_turns(id,task_id,ordinal,status,version,created_at,updated_at) VALUES(?,?,1,'queued',1,?,?)"
        )
        .run(turnId, taskId, now, now);
      this.database
        .prepare(
          `INSERT INTO agent_runs(
             id,task_id,turn_id,sandbox_run_id,status,version,profile_id,base_revision,
             check_status,created_at
           ) VALUES(?,?,?,?, 'queued',1,?,?, 'not_run',?)`
        )
        .run(runId, taskId, turnId, sandboxRunId, options.profileId, options.baseRevision, now);
      this.database
        .prepare(
          "INSERT INTO agent_messages(id,task_id,turn_id,run_id,role,text,created_at) VALUES(?,?,?,?,'user',?,?)"
        )
        .run(randomUUID(), taskId, turnId, runId, input.task.trim(), now);
      this.database
        .prepare(
          `INSERT INTO agent_dispatches(
             id,run_id,idempotency_key,request_digest,status,created_at,updated_at
           ) VALUES(?,?,?,?, 'pending',?,?)`
        )
        .run(randomUUID(), runId, key, digest, now, now);
      const accepted: AcceptedRun = {
        taskId,
        turnId,
        runId,
        sandboxRunId,
        projectId,
        baseRevision: options.baseRevision,
        inputRevision: options.baseRevision,
        created: true,
      };
      if (options.enqueue) this.insertQueue(accepted, input, '', options.originTaskId);
      this.database.exec('COMMIT;');
      return accepted;
    } catch (error) {
      rollbackQuietly(this.database);
      if (error instanceof TaskStoreError) throw error;
      throw new TaskStoreError('persistence', 'The task could not be stored durably.');
    }
  }

  private getTaskTitle(taskId: string): string {
    return (
      this.database.prepare('SELECT title FROM agent_tasks WHERE id=?').get(taskId) as {
        title: string;
      }
    ).title;
  }

  private insertQueue(
    accepted: AcceptedRun,
    input: StartAgentRunRequest,
    recentContext: string,
    originTaskId?: string
  ): void {
    if (originTaskId && this.isAgentCreatedTask(originTaskId))
      throw new TaskStoreError('conflict', 'Agent-created tasks cannot create more tasks.');
    if (originTaskId) {
      const count = this.database
        .prepare('SELECT COUNT(*) AS count FROM agent_queue WHERE origin_task_id=?')
        .get(originTaskId) as { count: number };
      if (count.count >= 8)
        throw new TaskStoreError('conflict', 'A task can create at most eight tasks.');
    }
    this.database
      .prepare(
        'INSERT INTO agent_queue(run_id,accepted_json,input_json,recent_context,origin_task_id) VALUES(?,?,?,?,?)'
      )
      .run(
        accepted.runId,
        JSON.stringify(accepted),
        JSON.stringify(StartAgentRunRequestSchema.parse(input)),
        recentContext,
        originTaskId ?? null
      );
    for (const [position, image] of (input.images ?? []).entries()) {
      this.storeInputImage(accepted.runId, position, {
        mimeType: image.mimeType,
        data: Buffer.from(image.data, 'base64'),
        label: image.label,
      });
    }
  }

  isAgentCreatedTask(taskId: string): boolean {
    return (
      this.database
        .prepare(
          'SELECT 1 FROM agent_queue q JOIN agent_runs r ON r.id=q.run_id WHERE r.task_id=? AND q.origin_task_id IS NOT NULL LIMIT 1'
        )
        .get(taskId) !== undefined
    );
  }

  interruptedDurableTasks(): Array<{ taskId: string; runId: string }> {
    return (
      this.database
        .prepare(
          `SELECT task_id,id FROM agent_runs r WHERE status='interrupted' AND profile_id='durable-v1'
      AND id=(SELECT id FROM agent_runs WHERE task_id=r.task_id ORDER BY created_at DESC,rowid DESC LIMIT 1)
      ORDER BY created_at,rowid`
        )
        .all() as Array<{ task_id: string; id: string }>
    ).map((row) => ({ taskId: row.task_id, runId: row.id }));
  }

  occupiedRunIds(): string[] {
    return (
      this.database
        .prepare(`SELECT id FROM agent_runs WHERE ${OCCUPIED_RUN_PREDICATE}`)
        .all() as Array<{ id: string }>
    ).map((row) => row.id);
  }

  occupiedRunCount(): number {
    return (
      this.database
        .prepare(`SELECT COUNT(*) AS count FROM agent_runs WHERE ${OCCUPIED_RUN_PREDICATE}`)
        .get() as { count: number }
    ).count;
  }

  queuedRun(runId: string): QueuedRun | undefined {
    const row = this.database
      .prepare('SELECT accepted_json,input_json,recent_context FROM agent_queue WHERE run_id=?')
      .get(runId) as
      { accepted_json: string; input_json: string; recent_context: string } | undefined;
    if (!row) return undefined;
    return {
      accepted: JSON.parse(row.accepted_json) as AcceptedRun,
      input: StartAgentRunRequestSchema.parse(JSON.parse(row.input_json)),
      recentContext: row.recent_context,
    };
  }

  claimNextQueuedRun(maxActiveRuns: number, ownerGeneration: string): QueuedRun | undefined {
    if (this.occupiedRunCount() >= maxActiveRuns) return undefined;
    const row = this.database
      .prepare(
        "SELECT q.run_id FROM agent_queue q JOIN agent_runs r ON r.id=q.run_id WHERE r.status='queued' ORDER BY q.ordinal LIMIT 1"
      )
      .get() as { run_id: string } | undefined;
    if (!row) return undefined;
    const queued = this.queuedRun(row.run_id)!;
    this.markStarting(queued.accepted, ownerGeneration, new Date(), maxActiveRuns);
    return queued;
  }

  snapshotForRun(runId: string): AgentRunSnapshot {
    const row = this.database
      .prepare('SELECT * FROM agent_runs WHERE id=?')
      .get(runId) as unknown as RunRow | undefined;
    if (!row) throw new TaskStoreError('not_found', 'Run not found.');
    const detail = this.getTask(row.task_id);
    if (detail.latestSnapshot?.runId === runId) return detail.latestSnapshot;
    // Idempotent retries remain bound to their original run, even after newer turns exist.
    const run = runFromRow(row);
    const previous = this.materializeSnapshot(runId);
    const message = this.database
      .prepare(
        "SELECT id,text,created_at FROM agent_messages WHERE run_id=? AND role='user' ORDER BY created_at,id LIMIT 1"
      )
      .get(runId) as { id: string; text: string; created_at: string } | undefined;
    const references = this.taskInputImageMetadata(row.task_id, runId);
    return AgentRunSnapshotSchema.parse({
      service: 'local-ai-b70-observatory',
      enabled: true,
      sequence: 0,
      pendingSteering: 0,
      name: detail.task.title,
      ...(message ? { task: message.text } : {}),
      timeline: message
        ? [
            {
              id: message.id,
              at: message.created_at,
              kind: 'task',
              title: 'Aufgabe',
              text: message.text,
              state: run.status === 'queued' ? 'queued' : 'complete',
              ...(references.length ? { images: references } : {}),
            },
          ]
        : [],
      ...previous,
      runId,
      status: snapshotStatus(run.status, previous?.status),
      ...(run.startedAt ? { startedAt: run.startedAt } : {}),
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
      ...(run.reason ? { reason: run.reason } : {}),
    });
  }

  private ensureLegacyProject(): string {
    const existing = this.database
      .prepare('SELECT id FROM agent_projects ORDER BY created_at LIMIT 1')
      .get() as { id: string } | undefined;
    if (existing !== undefined) return existing.id;
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO agent_projects(
           id,name,repository_path,target_branch,workdir,edit_paths_json,checks_json,created_at,updated_at
         ) VALUES(?, 'Standardprojekt', '/legacy', 'main', '.', '["."]', '[]', ?, ?)`
      )
      .run(id, now, now);
    return id;
  }

  acceptContinuation(
    input: ContinueAgentTaskRequest,
    options: {
      profileId: string;
      maxActiveRuns?: number;
      enqueue?: boolean;
      recentContext?: string;
      now?: Date;
      expectedTaskVersion?: number;
      workspace?: { baseRevision: string; inputRevision: string; sourceWorkspace?: string };
    }
  ): AcceptedRun {
    const now = (options.now ?? new Date()).toISOString();
    const digest = digestContinuation(input);
    try {
      this.database.exec('BEGIN IMMEDIATE;');
      const existing = this.database
        .prepare(
          `SELECT d.request_digest,r.id AS run_id,r.task_id,r.turn_id,r.sandbox_run_id,
                  t.project_id,r.base_revision,rr.result_revision,rr.workspace_path
             FROM agent_dispatches d
             JOIN agent_runs r ON r.id=d.run_id
             JOIN agent_tasks t ON t.id=r.task_id
             LEFT JOIN agent_run_results rr ON rr.run_id=(
               SELECT id FROM agent_runs WHERE task_id=r.task_id AND result_revision IS NOT NULL
               ORDER BY created_at DESC,rowid DESC LIMIT 1
             )
            WHERE d.idempotency_key=?`
        )
        .get(input.idempotencyKey) as
        | {
            request_digest: string;
            run_id: string;
            task_id: string;
            turn_id: string;
            sandbox_run_id: string;
            project_id: string;
            base_revision: string;
            result_revision: string | null;
            workspace_path: string | null;
          }
        | undefined;
      if (existing !== undefined) {
        if (existing.request_digest !== digest) {
          throw new TaskStoreError(
            'idempotency_conflict',
            'The idempotency key is already bound to different content.'
          );
        }
        if (
          options.workspace !== undefined &&
          existing.base_revision !== options.workspace.baseRevision
        ) {
          throw new TaskStoreError(
            'idempotency_conflict',
            'The idempotency key is already bound to a different target revision.'
          );
        }
        this.acknowledgeFollowup(input);
        this.database.exec('COMMIT;');
        return {
          taskId: existing.task_id,
          turnId: existing.turn_id,
          runId: existing.run_id,
          sandboxRunId: existing.sandbox_run_id,
          projectId: existing.project_id,
          baseRevision: options.workspace?.baseRevision ?? existing.base_revision,
          inputRevision:
            options.workspace?.inputRevision ?? existing.result_revision ?? existing.base_revision,
          ...(options.workspace !== undefined
            ? options.workspace.sourceWorkspace === undefined
              ? {}
              : { sourceWorkspace: options.workspace.sourceWorkspace }
            : existing.workspace_path === null
              ? {}
              : { sourceWorkspace: existing.workspace_path }),
          created: false,
        };
      }
      const task = this.database
        .prepare(
          `SELECT t.project_id,t.version,t.status,r.base_revision,rr.result_revision,rr.workspace_path
             FROM agent_tasks t
             JOIN agent_runs r ON r.id=(SELECT id FROM agent_runs WHERE task_id=t.id AND run_kind='implementation' ORDER BY created_at DESC,rowid DESC LIMIT 1)
             LEFT JOIN agent_run_results rr ON rr.run_id=(
               SELECT id FROM agent_runs WHERE task_id=t.id AND result_revision IS NOT NULL ORDER BY created_at DESC,rowid DESC LIMIT 1
             )
            WHERE t.id=?`
        )
        .get(input.taskId) as
        | {
            project_id: string;
            version: number;
            status: string;
            base_revision: string;
            result_revision: string | null;
            workspace_path: string | null;
          }
        | undefined;
      if (task === undefined) throw new TaskStoreError('not_found', 'Task not found.');
      if (
        options.expectedTaskVersion !== undefined &&
        task.version !== options.expectedTaskVersion
      ) {
        throw new TaskStoreError('conflict', 'Task changed; reload before resolving conflicts.');
      }
      if (!['open', 'accepted'].includes(task.status)) {
        throw new TaskStoreError('conflict', 'An archived task cannot be continued.');
      }
      const activeForTask = this.database
        .prepare(
          `SELECT COUNT(*) AS count FROM agent_runs WHERE task_id=? AND status IN (${ACTIVE_RUNS})`
        )
        .get(input.taskId) as { count: number };
      if (activeForTask.count > 0)
        throw new TaskStoreError('busy', 'This task already has an active writer.');
      const active = this.database
        .prepare(`SELECT COUNT(*) AS count FROM agent_runs WHERE ${OCCUPIED_RUN_PREDICATE}`)
        .get() as { count: number };
      if (!options.enqueue && active.count >= (options.maxActiveRuns ?? 1))
        throw new TaskStoreError('busy', 'The configured parallel agent limit is reached.');
      const ordinalRow = this.database
        .prepare('SELECT COALESCE(MAX(ordinal),0)+1 AS ordinal FROM agent_turns WHERE task_id=?')
        .get(input.taskId) as { ordinal: number };
      const turnId = randomUUID();
      const runId = randomUUID();
      const sandboxRunId = runId.replaceAll('-', '');
      this.database
        .prepare(
          "INSERT INTO agent_turns(id,task_id,ordinal,status,version,created_at,updated_at) VALUES(?,?,?,'queued',1,?,?)"
        )
        .run(turnId, input.taskId, ordinalRow.ordinal, now, now);
      this.database
        .prepare(
          `INSERT INTO agent_runs(id,task_id,turn_id,sandbox_run_id,status,version,profile_id,base_revision,check_status,created_at)
         VALUES(?,?,?,?, 'queued',1,?,?, 'not_run',?)`
        )
        .run(
          runId,
          input.taskId,
          turnId,
          sandboxRunId,
          options.profileId,
          options.workspace?.baseRevision ?? task.base_revision,
          now
        );
      this.database
        .prepare(
          "INSERT INTO agent_messages(id,task_id,turn_id,run_id,role,text,created_at) VALUES(?,?,?,?,'user',?,?)"
        )
        .run(randomUUID(), input.taskId, turnId, runId, input.message.trim(), now);
      this.database
        .prepare(
          `INSERT INTO agent_dispatches(id,run_id,idempotency_key,request_digest,status,created_at,updated_at)
         VALUES(?,?,?,?, 'pending',?,?)`
        )
        .run(randomUUID(), runId, input.idempotencyKey, digest, now, now);
      this.database
        .prepare("UPDATE agent_tasks SET status='open',version=version+1,updated_at=? WHERE id=?")
        .run(now, input.taskId);
      const accepted: AcceptedRun = {
        taskId: input.taskId,
        turnId,
        runId,
        sandboxRunId,
        projectId: task.project_id,
        baseRevision: options.workspace?.baseRevision ?? task.base_revision,
        inputRevision:
          options.workspace?.inputRevision ?? task.result_revision ?? task.base_revision,
        ...(options.workspace !== undefined
          ? options.workspace.sourceWorkspace === undefined
            ? {}
            : { sourceWorkspace: options.workspace.sourceWorkspace }
          : task.workspace_path === null
            ? {}
            : { sourceWorkspace: task.workspace_path }),
        created: true,
      };
      if (options.enqueue)
        this.insertQueue(
          accepted,
          {
            task: input.message,
            name: this.getTaskTitle(input.taskId),
            idempotencyKey: input.idempotencyKey,
            ...(input.images === undefined ? {} : { images: input.images }),
          },
          options.recentContext ?? ''
        );
      this.acknowledgeFollowup(input);
      this.database.exec('COMMIT;');
      return accepted;
    } catch (error) {
      rollbackQuietly(this.database);
      if (error instanceof TaskStoreError) throw error;
      throw new TaskStoreError('persistence', 'The continuation could not be stored durably.');
    }
  }

  acceptReview(
    input: StartAgentReviewRequest,
    options: { profileId: string; maxActiveRuns?: number; now?: Date }
  ): AcceptedReview {
    const now = (options.now ?? new Date()).toISOString();
    const digest = digestReview(input);
    try {
      this.database.exec('BEGIN IMMEDIATE;');
      const existing = this.database
        .prepare(
          `SELECT d.request_digest,r.id AS run_id,r.task_id,r.turn_id,r.sandbox_run_id,
                  t.project_id,rv.id AS review_id,rv.result_revision,rv.instructions,
                  rr.workspace_path
             FROM agent_dispatches d
             JOIN agent_runs r ON r.id=d.run_id
             JOIN agent_tasks t ON t.id=r.task_id
             JOIN agent_reviews rv ON rv.reviewer_run_id=r.id
             JOIN agent_run_results rr ON rr.run_id=rv.source_run_id
            WHERE d.idempotency_key=?`
        )
        .get(input.idempotencyKey) as
        | {
            request_digest: string;
            run_id: string;
            task_id: string;
            turn_id: string;
            sandbox_run_id: string;
            project_id: string;
            review_id: string;
            result_revision: string;
            instructions: string | null;
            workspace_path: string;
          }
        | undefined;
      if (existing !== undefined) {
        if (existing.request_digest !== digest) {
          throw new TaskStoreError(
            'idempotency_conflict',
            'The idempotency key is already bound to a different review.'
          );
        }
        this.database.exec('COMMIT;');
        return {
          taskId: existing.task_id,
          turnId: existing.turn_id,
          runId: existing.run_id,
          sandboxRunId: existing.sandbox_run_id,
          projectId: existing.project_id,
          baseRevision: existing.result_revision,
          inputRevision: existing.result_revision,
          sourceWorkspace: existing.workspace_path,
          reviewId: existing.review_id,
          ...(existing.instructions === null ? {} : { instructions: existing.instructions }),
          created: false,
        };
      }
      const source = this.database
        .prepare(
          `SELECT r.task_id,t.project_id,rr.result_revision,rr.workspace_path
             FROM agent_runs r JOIN agent_tasks t ON t.id=r.task_id
             JOIN agent_run_results rr ON rr.run_id=r.id
            WHERE r.id=? AND r.task_id=? AND r.run_kind='implementation'`
        )
        .get(input.sourceRunId, input.taskId) as
        | {
            task_id: string;
            project_id: string;
            result_revision: string;
            workspace_path: string;
          }
        | undefined;
      if (source === undefined) throw new TaskStoreError('not_found', 'Review source not found.');
      if (source.result_revision !== input.resultRevision) {
        throw new TaskStoreError('conflict', 'The selected result revision changed.');
      }
      const active = this.database
        .prepare(`SELECT COUNT(*) AS count FROM agent_runs WHERE ${OCCUPIED_RUN_PREDICATE}`)
        .get() as { count: number };
      if (active.count >= (options.maxActiveRuns ?? 1)) {
        throw new TaskStoreError('busy', 'The configured parallel agent limit is reached.');
      }
      const ordinal = (
        this.database
          .prepare('SELECT COALESCE(MAX(ordinal),0)+1 AS value FROM agent_turns WHERE task_id=?')
          .get(input.taskId) as { value: number }
      ).value;
      const turnId = randomUUID();
      const runId = randomUUID();
      const reviewId = randomUUID();
      const sandboxRunId = runId.replaceAll('-', '');
      this.database
        .prepare(
          "INSERT INTO agent_turns(id,task_id,ordinal,status,version,created_at,updated_at) VALUES(?,?,?,'queued',1,?,?)"
        )
        .run(turnId, input.taskId, ordinal, now, now);
      this.database
        .prepare(
          `INSERT INTO agent_runs(id,task_id,turn_id,sandbox_run_id,status,version,profile_id,
             base_revision,check_status,created_at,run_kind)
           VALUES(?,?,?,?, 'queued',1,?,?, 'not_run',?,'review')`
        )
        .run(
          runId,
          input.taskId,
          turnId,
          sandboxRunId,
          options.profileId,
          input.resultRevision,
          now
        );
      this.database
        .prepare(
          `INSERT INTO agent_dispatches(id,run_id,idempotency_key,request_digest,status,created_at,updated_at)
           VALUES(?,?,?,?, 'pending',?,?)`
        )
        .run(randomUUID(), runId, input.idempotencyKey, digest, now, now);
      this.database
        .prepare(
          `INSERT INTO agent_reviews(id,task_id,source_run_id,reviewer_run_id,result_revision,
             instructions,created_at) VALUES(?,?,?,?,?,?,?)`
        )
        .run(
          reviewId,
          input.taskId,
          input.sourceRunId,
          runId,
          input.resultRevision,
          input.instructions?.trim() ?? null,
          now
        );
      this.database
        .prepare('UPDATE agent_tasks SET version=version+1,updated_at=? WHERE id=?')
        .run(now, input.taskId);
      this.database.exec('COMMIT;');
      return {
        taskId: input.taskId,
        turnId,
        runId,
        sandboxRunId,
        projectId: source.project_id,
        baseRevision: input.resultRevision,
        inputRevision: input.resultRevision,
        sourceWorkspace: source.workspace_path,
        reviewId,
        ...(input.instructions === undefined ? {} : { instructions: input.instructions.trim() }),
        created: true,
      };
    } catch (error) {
      rollbackQuietly(this.database);
      if (error instanceof TaskStoreError) throw error;
      throw new TaskStoreError('persistence', 'The review could not be stored durably.');
    }
  }

  reviewByRunId(runId: string): { id: string; resultRevision: string } | undefined {
    const row = this.database
      .prepare('SELECT id,result_revision FROM agent_reviews WHERE reviewer_run_id=?')
      .get(runId) as { id: string; result_revision: string } | undefined;
    return row === undefined ? undefined : { id: row.id, resultRevision: row.result_revision };
  }

  storeReviewSubmission(
    reviewId: string,
    submission: AgentReviewSubmission,
    at = new Date()
  ): void {
    const now = at.toISOString();
    try {
      this.database.exec('BEGIN IMMEDIATE;');
      const review = this.database.prepare('SELECT id FROM agent_reviews WHERE id=?').get(reviewId);
      if (review === undefined) throw new Error('unknown review');
      this.database.prepare('DELETE FROM agent_review_findings WHERE review_id=?').run(reviewId);
      const insert = this.database.prepare(
        `INSERT INTO agent_review_findings(id,review_id,ordinal,severity,title,file_path,line_number,
           reasoning,evidence,selected) VALUES(?,?,?,?,?,?,?,?,?,0)`
      );
      submission.findings.forEach((finding, ordinal) =>
        insert.run(
          randomUUID(),
          reviewId,
          ordinal,
          finding.severity,
          finding.title,
          finding.file ?? null,
          finding.line ?? null,
          finding.reasoning,
          finding.evidence ?? null
        )
      );
      this.database
        .prepare('UPDATE agent_reviews SET summary=?,finished_at=? WHERE id=?')
        .run(submission.summary, now, reviewId);
      this.database.exec('COMMIT;');
    } catch {
      rollbackQuietly(this.database);
      throw new TaskStoreError('persistence', 'The structured review could not be stored.');
    }
  }

  listReviews(taskId: string): AgentReview[] {
    const latest = this.database
      .prepare(
        `SELECT rr.result_revision FROM agent_run_results rr JOIN agent_runs r ON r.id=rr.run_id
           JOIN agent_turns t ON t.id=r.turn_id
          WHERE r.task_id=? AND r.run_kind='implementation' ORDER BY t.ordinal DESC LIMIT 1`
      )
      .get(taskId) as { result_revision: string } | undefined;
    const reviews = this.database
      .prepare(
        `SELECT rv.*,r.status,r.finished_at AS run_finished_at
           FROM agent_reviews rv JOIN agent_runs r ON r.id=rv.reviewer_run_id
          WHERE rv.task_id=? ORDER BY rv.created_at DESC LIMIT 100`
      )
      .all(taskId) as Array<Record<string, unknown>>;
    return reviews.map((row) => {
      const findings = this.database
        .prepare(
          `SELECT id,severity,title,file_path,line_number,reasoning,evidence,selected
             FROM agent_review_findings WHERE review_id=? ORDER BY ordinal`
        )
        .all(String(row.id))
        .map((raw) => {
          const finding = raw as Record<string, unknown>;
          return {
            id: String(finding.id),
            severity: String(finding.severity),
            title: String(finding.title),
            ...(finding.file_path === null ? {} : { file: String(finding.file_path) }),
            ...(finding.line_number === null ? {} : { line: Number(finding.line_number) }),
            reasoning: String(finding.reasoning),
            ...(finding.evidence === null ? {} : { evidence: String(finding.evidence) }),
            selected: Number(finding.selected) === 1,
          };
        });
      return {
        id: String(row.id),
        taskId: String(row.task_id),
        sourceRunId: String(row.source_run_id),
        reviewerRunId: String(row.reviewer_run_id),
        resultRevision: String(row.result_revision),
        ...(row.instructions === null ? {} : { instructions: String(row.instructions) }),
        status: String(row.status),
        ...(row.summary === null ? {} : { summary: String(row.summary) }),
        findings,
        stale: latest === undefined || latest.result_revision !== String(row.result_revision),
        createdAt: String(row.created_at),
        ...(row.finished_at === null && row.run_finished_at === null
          ? {}
          : { finishedAt: String(row.finished_at ?? row.run_finished_at) }),
      } as AgentReview;
    });
  }

  prepareCorrection(input: StartAgentCorrectionRequest): string {
    const review = this.listReviews(input.taskId).find((entry) => entry.id === input.reviewId);
    if (review === undefined) throw new TaskStoreError('not_found', 'Review not found.');
    if (review.status !== 'completed') {
      throw new TaskStoreError('conflict', 'Only a completed review can start a correction.');
    }
    if (review.stale) {
      throw new TaskStoreError('conflict', 'This review belongs to an older result version.');
    }
    const selected = review.findings.filter((finding) => input.findingIds.includes(finding.id));
    if (selected.length !== new Set(input.findingIds).size) {
      throw new TaskStoreError('conflict', 'At least one selected finding is not in this review.');
    }
    try {
      this.database.exec('BEGIN IMMEDIATE;');
      this.database
        .prepare('UPDATE agent_review_findings SET selected=0 WHERE review_id=?')
        .run(input.reviewId);
      const mark = this.database.prepare(
        'UPDATE agent_review_findings SET selected=1 WHERE review_id=? AND id=?'
      );
      for (const id of input.findingIds) mark.run(input.reviewId, id);
      this.database
        .prepare("UPDATE agent_tasks SET status='open',version=version+1,updated_at=? WHERE id=?")
        .run(new Date().toISOString(), input.taskId);
      this.database.exec('COMMIT;');
    } catch {
      rollbackQuietly(this.database);
      throw new TaskStoreError('persistence', 'The correction selection could not be stored.');
    }
    const findings = selected
      .map(
        (finding, index) =>
          `${index + 1}. [${finding.severity}] ${finding.title}${finding.file === undefined ? '' : ` (${finding.file}${finding.line === undefined ? '' : `:${finding.line}`})`}\n${finding.reasoning}${finding.evidence === undefined ? '' : `\nNachweis: ${finding.evidence}`}`
      )
      .join('\n\n');
    return [
      `Korrigiere die ausgewählten Befunde des unabhängigen Reviews für Revision ${review.resultRevision}:`,
      findings,
      input.instructions?.trim() ?? '',
      'Bearbeite nur diese Befunde, führe die konfigurierten Checks aus und schließe mit einem neuen prüfbaren Ergebnis ab.',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  queueFollowup(input: QueueAgentFollowupRequest, at = new Date()): { queued: true } {
    const now = at.toISOString();
    const existing = this.database
      .prepare('SELECT task_id,text FROM agent_followups WHERE idempotency_key=?')
      .get(input.idempotencyKey) as { task_id: string; text: string } | undefined;
    if (existing !== undefined) {
      if (existing.task_id !== input.taskId || existing.text !== input.message.trim()) {
        throw new TaskStoreError(
          'idempotency_conflict',
          'Follow-up key is already bound to different content.'
        );
      }
      return { queued: true };
    }
    const active = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM agent_runs WHERE task_id=? AND status IN (${ACTIVE_RUNS})`
      )
      .get(input.taskId) as { count: number };
    if (active.count === 0) {
      throw new TaskStoreError(
        'conflict',
        'The task is no longer running; send a normal continuation.'
      );
    }
    try {
      this.database.exec('BEGIN IMMEDIATE;');
      this.database
        .prepare(
          "INSERT INTO agent_followups(id,task_id,text,idempotency_key,status,created_at) VALUES(?,?,?,?, 'queued',?)"
        )
        .run(randomUUID(), input.taskId, input.message.trim(), input.idempotencyKey, now);
      this.database
        .prepare('UPDATE agent_tasks SET version=version+1,updated_at=? WHERE id=?')
        .run(now, input.taskId);
      this.database.exec('COMMIT;');
      return { queued: true };
    } catch {
      rollbackQuietly(this.database);
      throw new TaskStoreError('conflict', 'This task already has a queued follow-up.');
    }
  }

  pendingFollowups(): ContinueAgentTaskRequest[] {
    return (
      this.database
        .prepare(
          `SELECT f.task_id,f.text,f.idempotency_key FROM agent_followups f
      WHERE f.status='queued' AND EXISTS (SELECT 1 FROM agent_runs r WHERE r.id=(SELECT id FROM agent_runs WHERE task_id=f.task_id AND run_kind='implementation' ORDER BY created_at DESC,rowid DESC LIMIT 1) AND r.status='completed')
      AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.task_id=f.task_id AND r.status IN (${ACTIVE_RUNS}))
      ORDER BY f.created_at,f.id LIMIT 100`
        )
        .all() as Array<{ task_id: string; text: string; idempotency_key: string }>
    ).map((row) => ({
      taskId: row.task_id,
      message: row.text,
      idempotencyKey: row.idempotency_key,
    }));
  }

  private acknowledgeFollowup(input: ContinueAgentTaskRequest): void {
    this.database
      .prepare(
        "UPDATE agent_followups SET status='claimed' WHERE idempotency_key=? AND task_id=? AND text=? AND status='queued'"
      )
      .run(input.idempotencyKey, input.taskId, input.message.trim());
  }

  claimFollowup(taskId: string): ContinueAgentTaskRequest | undefined {
    const row = this.database
      .prepare(
        "SELECT id,text,idempotency_key FROM agent_followups WHERE task_id=? AND status='queued' ORDER BY created_at LIMIT 1"
      )
      .get(taskId) as { id: string; text: string; idempotency_key: string } | undefined;
    if (row === undefined) return undefined;
    this.database
      .prepare("UPDATE agent_followups SET status='claimed' WHERE id=? AND status='queued'")
      .run(row.id);
    return { taskId, message: row.text, idempotencyKey: row.idempotency_key };
  }

  storeRunResult(
    runId: string,
    result: Omit<AgentRunResult, 'runId' | 'acceptedAt' | 'acceptedRevision'>,
    workspacePath: string
  ): void {
    this.database
      .prepare(
        `INSERT INTO agent_run_results(run_id,result_revision,workspace_path,files_json,diff_text,diff_truncated,checks_json)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(run_id) DO UPDATE SET result_revision=excluded.result_revision,
         workspace_path=excluded.workspace_path,files_json=excluded.files_json,diff_text=excluded.diff_text,
         diff_truncated=excluded.diff_truncated,checks_json=excluded.checks_json`
      )
      .run(
        runId,
        result.resultRevision,
        workspacePath,
        JSON.stringify(result.files),
        result.diff,
        result.diffTruncated ? 1 : 0,
        JSON.stringify(result.checks)
      );
    this.database
      .prepare('UPDATE agent_runs SET result_revision=?,files_changed=?,check_status=? WHERE id=?')
      .run(result.resultRevision, result.files.length, result.checkStatus, runId);
  }

  getRunResult(runId: string): AgentRunResult {
    const row = this.database
      .prepare(
        `SELECT rr.*,r.check_status FROM agent_run_results rr JOIN agent_runs r ON r.id=rr.run_id WHERE rr.run_id=?`
      )
      .get(runId) as Record<string, unknown> | undefined;
    if (row === undefined) throw new TaskStoreError('not_found', 'Run result not found.');
    return {
      runId,
      resultRevision: String(row.result_revision),
      files: JSON.parse(String(row.files_json)) as string[],
      diff: String(row.diff_text),
      diffTruncated: Number(row.diff_truncated) === 1,
      checkStatus: String(row.check_status) as AgentRunResult['checkStatus'],
      checks: JSON.parse(String(row.checks_json)) as AgentRunResult['checks'],
      ...(row.accepted_at === null ? {} : { acceptedAt: String(row.accepted_at) }),
      ...(row.accepted_revision === null
        ? {}
        : { acceptedRevision: String(row.accepted_revision) }),
      ...(row.merged_at === null ? {} : { mergedAt: String(row.merged_at) }),
      ...(row.merged_revision === null ? {} : { mergedRevision: String(row.merged_revision) }),
    };
  }

  latestProjectResult(projectId: string): { runId: string; revision: string } | undefined {
    const row = this.database
      .prepare(
        `SELECT r.id,rr.result_revision FROM agent_runs r
       JOIN agent_tasks t ON t.id=r.task_id JOIN agent_run_results rr ON rr.run_id=r.id
       WHERE t.project_id=? AND r.status='completed' AND r.run_kind='implementation'
       ORDER BY r.created_at DESC,r.id DESC LIMIT 1`
      )
      .get(projectId) as { id: string; result_revision: string } | undefined;
    return row === undefined ? undefined : { runId: row.id, revision: row.result_revision };
  }

  runProject(runId: string): { projectId: string; status: string; kind: string } {
    const row = this.database
      .prepare(
        'SELECT t.project_id,r.status,r.run_kind FROM agent_runs r JOIN agent_tasks t ON t.id=r.task_id WHERE r.id=?'
      )
      .get(runId) as { project_id: string; status: string; run_kind: string } | undefined;
    if (row === undefined) throw new TaskStoreError('not_found', 'Run not found.');
    return { projectId: row.project_id, status: row.status, kind: row.run_kind };
  }

  resultWorkspace(runId: string): string {
    const row = this.database
      .prepare('SELECT workspace_path FROM agent_run_results WHERE run_id=?')
      .get(runId) as { workspace_path: string } | undefined;
    if (row === undefined) throw new TaskStoreError('not_found', 'Run result not found.');
    return row.workspace_path;
  }

  storeQuestion(taskId: string, runId: string, question: string, at = new Date()): void {
    const now = at.toISOString();
    this.database
      .prepare(
        "INSERT INTO agent_questions(id,task_id,run_id,question,status,created_at) VALUES(?,?,?,?, 'open',?)"
      )
      .run(randomUUID(), taskId, runId, question.trim(), now);
  }

  answerQuestion(
    taskId: string,
    questionId: string,
    answer: string,
    expectedTaskVersion: number,
    idempotencyKey: string,
    at = new Date()
  ): void {
    const now = at.toISOString();
    const digest = createHash('sha256').update(answer.trim()).digest('hex');
    const existing = this.database
      .prepare(
        'SELECT status,answer,answer_idempotency_key,answer_digest FROM agent_questions WHERE id=? AND task_id=?'
      )
      .get(questionId, taskId) as
      | {
          status: string;
          answer: string | null;
          answer_idempotency_key: string | null;
          answer_digest: string | null;
        }
      | undefined;
    if (existing?.status === 'answered') {
      if (existing.answer_digest === digest && existing.answer === answer.trim()) return;
      throw new TaskStoreError('conflict', 'Question was already answered differently.');
    }
    const task = this.database.prepare('SELECT version FROM agent_tasks WHERE id=?').get(taskId) as
      { version: number } | undefined;
    if (task === undefined) throw new TaskStoreError('not_found', 'Task not found.');
    if (task.version !== expectedTaskVersion)
      throw new TaskStoreError('conflict', 'Task changed; reload before answering.');
    const changed = this.database
      .prepare(
        "UPDATE agent_questions SET status='answered',answer=?,answered_at=?,answer_idempotency_key=?,answer_digest=? WHERE id=? AND task_id=? AND status='open'"
      )
      .run(answer.trim(), now, idempotencyKey, digest, questionId, taskId);
    if (changed.changes !== 1) throw new TaskStoreError('conflict', 'Question is no longer open.');
    this.database
      .prepare('UPDATE agent_tasks SET version=version+1,updated_at=? WHERE id=?')
      .run(now, taskId);
  }

  markAccepted(runId: string, revision: string, at = new Date()): void {
    const now = at.toISOString();
    const row = this.database.prepare('SELECT task_id FROM agent_runs WHERE id=?').get(runId) as
      { task_id: string } | undefined;
    if (row === undefined) throw new TaskStoreError('not_found', 'Run not found.');
    const current = this.database
      .prepare('SELECT accepted_revision FROM agent_run_results WHERE run_id=?')
      .get(runId) as { accepted_revision: string | null } | undefined;
    if (current === undefined) throw new TaskStoreError('not_found', 'Run result not found.');
    // A retry of the already approved exact revision stays a durable no-op.
    if (current.accepted_revision !== null && current.accepted_revision === revision) return;
    this.database
      .prepare('UPDATE agent_run_results SET accepted_at=?,accepted_revision=? WHERE run_id=?')
      .run(now, revision, runId);
    this.database
      .prepare("UPDATE agent_tasks SET status='accepted',version=version+1,updated_at=? WHERE id=?")
      .run(now, row.task_id);
  }

  markMerged(runId: string, revision: string, at = new Date()): void {
    const now = at.toISOString();
    const row = this.database.prepare('SELECT task_id FROM agent_runs WHERE id=?').get(runId) as
      { task_id: string } | undefined;
    if (row === undefined) throw new TaskStoreError('not_found', 'Run not found.');
    const current = this.database
      .prepare(
        'SELECT accepted_at,accepted_revision,merged_revision FROM agent_run_results WHERE run_id=?'
      )
      .get(runId) as
      | {
          accepted_at: string | null;
          accepted_revision: string | null;
          merged_revision: string | null;
        }
      | undefined;
    if (current === undefined) throw new TaskStoreError('not_found', 'Run result not found.');
    if (current.accepted_at === null || current.accepted_revision === null) {
      throw new TaskStoreError('conflict', 'The result must be accepted before merging.');
    }
    // A retry of the already merged result stays a durable no-op.
    if (current.merged_revision !== null && current.merged_revision === revision) return;
    this.database
      .prepare('UPDATE agent_run_results SET merged_at=?,merged_revision=? WHERE run_id=?')
      .run(now, revision, runId);
  }

  acceptSteering(input: SteerAgentRunRequest, at = new Date()): AcceptedSteering {
    const now = at.toISOString();
    const digest = steeringDigest(input);
    try {
      this.database.exec('BEGIN IMMEDIATE;');
      const existing = this.database
        .prepare(
          `SELECT s.id,s.run_id,s.text,s.request_digest,r.version AS run_version,
                  t.version AS task_version
             FROM agent_steering s
             JOIN agent_runs r ON r.id=s.run_id
             JOIN agent_tasks t ON t.id=r.task_id
            WHERE s.idempotency_key=?`
        )
        .get(input.idempotencyKey) as
        | {
            id: string;
            run_id: string;
            text: string;
            request_digest: string | null;
            run_version: number;
            task_version: number;
          }
        | undefined;
      if (existing !== undefined) {
        if (existing.request_digest !== digest) {
          throw new TaskStoreError(
            'idempotency_conflict',
            'The idempotency key is already bound to another steering message.'
          );
        }
        this.database.exec('COMMIT;');
        return {
          id: existing.id,
          runId: existing.run_id,
          message: existing.text,
          created: false,
          runVersion: existing.run_version,
          taskVersion: existing.task_version,
        };
      }
      const run = this.database
        .prepare(
          `SELECT r.task_id,r.version AS run_version,r.status,t.version AS task_version
             FROM agent_runs r JOIN agent_tasks t ON t.id=r.task_id WHERE r.id=?`
        )
        .get(input.runId) as
        { task_id: string; run_version: number; status: string; task_version: number } | undefined;
      if (run === undefined) throw new TaskStoreError('not_found', 'Run not found.');
      if (!['starting', 'running'].includes(run.status)) {
        throw new TaskStoreError('conflict', 'The selected run has already ended.');
      }
      if (
        run.run_version !== input.expectedRunVersion ||
        run.task_version !== input.expectedTaskVersion
      ) {
        throw new TaskStoreError('conflict', 'The selected run changed; reload before sending.');
      }
      const queued = this.database
        .prepare(
          "SELECT COUNT(*) AS count FROM agent_steering WHERE run_id=? AND (status IN ('stored','sent','uncertain') OR (status='acknowledged' AND confirmed_at IS NULL))"
        )
        .get(input.runId) as { count: number };
      if (queued.count >= 8) throw new TaskStoreError('busy', 'The steering queue is full.');
      const id = randomUUID();
      this.database
        .prepare(
          `INSERT INTO agent_steering(
             id,run_id,text,status,created_at,updated_at,idempotency_key,request_digest
           ) VALUES(?,?,?,'stored',?,?,?,?)`
        )
        .run(id, input.runId, input.message.trim(), now, now, input.idempotencyKey, digest);
      this.database.prepare('UPDATE agent_runs SET version=version+1 WHERE id=?').run(input.runId);
      this.database
        .prepare('UPDATE agent_tasks SET version=version+1,updated_at=? WHERE id=?')
        .run(now, run.task_id);
      this.database.exec('COMMIT;');
      return {
        id,
        runId: input.runId,
        message: input.message.trim(),
        created: true,
        runVersion: run.run_version + 1,
        taskVersion: run.task_version + 1,
      };
    } catch (error) {
      rollbackQuietly(this.database);
      if (error instanceof TaskStoreError) throw error;
      throw new TaskStoreError('persistence', 'The steering message could not be stored.');
    }
  }

  markSteeringStatus(
    id: string,
    status: 'sent' | 'acknowledged' | 'uncertain' | 'cancelled',
    reason?: string,
    at = new Date()
  ): void {
    const now = at.toISOString();
    const field =
      status === 'sent' ? 'sent_at' : status === 'acknowledged' ? 'acknowledged_at' : undefined;
    const statement =
      field === undefined
        ? 'UPDATE agent_steering SET status=?,updated_at=?,reason=? WHERE id=?'
        : `UPDATE agent_steering SET status=?,updated_at=?,reason=?,${field}=? WHERE id=?`;
    const result =
      field === undefined
        ? this.database.prepare(statement).run(status, now, reason ?? null, id)
        : this.database.prepare(statement).run(status, now, reason ?? null, now, id);
    if (Number(result.changes) !== 1) {
      throw new TaskStoreError('persistence', 'The steering delivery state could not be stored.');
    }
  }

  confirmSteering(id: string, at = new Date()): void {
    const now = at.toISOString();
    this.database
      .prepare(
        "UPDATE agent_steering SET status='acknowledged',confirmed_at=?,updated_at=? WHERE id=? AND confirmed_at IS NULL AND status IN ('sent','acknowledged','uncertain')"
      )
      .run(now, now, id);
  }

  acceptCancellation(input: CancelAgentRunRequest, at = new Date()): AcceptedCancellation {
    const now = at.toISOString();
    const digest = cancellationDigest(input);
    try {
      this.database.exec('BEGIN IMMEDIATE;');
      const existing = this.database
        .prepare(
          `SELECT c.id,c.run_id,c.request_digest,r.version AS run_version,t.version AS task_version
             FROM agent_cancellations c JOIN agent_runs r ON r.id=c.run_id
             JOIN agent_tasks t ON t.id=r.task_id WHERE c.idempotency_key=?`
        )
        .get(input.idempotencyKey) as
        | {
            id: string;
            run_id: string;
            request_digest: string | null;
            run_version: number;
            task_version: number;
          }
        | undefined;
      if (existing !== undefined) {
        if (existing.request_digest !== digest) {
          throw new TaskStoreError('idempotency_conflict', 'Cancellation key conflict.');
        }
        this.database.exec('COMMIT;');
        return {
          id: existing.id,
          runId: existing.run_id,
          created: false,
          runVersion: existing.run_version,
          taskVersion: existing.task_version,
        };
      }
      const run = this.database
        .prepare(
          `SELECT r.task_id,r.version AS run_version,r.status,t.version AS task_version
             FROM agent_runs r JOIN agent_tasks t ON t.id=r.task_id WHERE r.id=?`
        )
        .get(input.runId) as
        { task_id: string; run_version: number; status: string; task_version: number } | undefined;
      if (run === undefined) throw new TaskStoreError('not_found', 'Run not found.');
      if (!['queued', 'starting', 'running'].includes(run.status)) {
        throw new TaskStoreError('conflict', 'The selected run has already ended.');
      }
      if (
        run.run_version !== input.expectedRunVersion ||
        run.task_version !== input.expectedTaskVersion
      ) {
        throw new TaskStoreError('conflict', 'The selected run changed; reload before stopping.');
      }
      const id = randomUUID();
      this.database
        .prepare(
          `INSERT INTO agent_cancellations(
             id,run_id,idempotency_key,request_digest,status,created_at,updated_at
           ) VALUES(?,?,?,?,'requested',?,?)`
        )
        .run(id, input.runId, input.idempotencyKey, digest, now, now);
      this.database
        .prepare(
          "UPDATE agent_steering SET status='cancelled',updated_at=?,reason='Run cancellation requested.' WHERE run_id=? AND (status IN ('stored','sent','uncertain') OR (status='acknowledged' AND confirmed_at IS NULL))"
        )
        .run(now, input.runId);
      this.database.prepare('UPDATE agent_runs SET version=version+1 WHERE id=?').run(input.runId);
      this.database
        .prepare('UPDATE agent_tasks SET version=version+1,updated_at=? WHERE id=?')
        .run(now, run.task_id);
      this.database.exec('COMMIT;');
      return {
        id,
        runId: input.runId,
        created: true,
        runVersion: run.run_version + 1,
        taskVersion: run.task_version + 1,
      };
    } catch (error) {
      rollbackQuietly(this.database);
      if (error instanceof TaskStoreError) throw error;
      throw new TaskStoreError('persistence', 'The cancellation could not be stored.');
    }
  }

  markCancellation(
    id: string,
    status: 'stopping' | 'completed' | 'failed',
    reason?: string,
    at = new Date()
  ): void {
    const now = at.toISOString();
    const result = this.database
      .prepare(
        `UPDATE agent_cancellations SET status=?,updated_at=?,reason=?,
           completed_at=CASE WHEN ? IN ('completed','failed') THEN ? ELSE completed_at END WHERE id=?`
      )
      .run(status, now, reason ?? null, status, now, id);
    if (Number(result.changes) !== 1) {
      throw new TaskStoreError('persistence', 'The cancellation state could not be stored.');
    }
  }

  markStarting(
    run: AcceptedRun,
    ownerGeneration: string,
    at = new Date(),
    maxActiveRuns?: number
  ): void {
    const now = at.toISOString();
    const lease = new Date(at.getTime() + 30_000).toISOString();
    try {
      this.database.exec('BEGIN IMMEDIATE;');
      if (
        maxActiveRuns !== undefined &&
        this.occupiedRunIds().filter((id) => id !== run.runId).length >= maxActiveRuns
      )
        throw new TaskStoreError('busy', 'The configured parallel agent limit is reached.');
      const result = this.database
        .prepare(
          `UPDATE agent_runs SET status='starting',version=version+1,owner_generation=?,
             lease_expires_at=?,job_instance_id=?,started_at=? WHERE id=? AND status='queued'`
        )
        .run(ownerGeneration, lease, run.sandboxRunId, now, run.runId);
      if (Number(result.changes) !== 1) throw new Error('run is not queued');
      this.database
        .prepare("UPDATE agent_turns SET status='active',version=version+1,updated_at=? WHERE id=?")
        .run(now, run.turnId);
      this.database
        .prepare("UPDATE agent_dispatches SET status='claimed',updated_at=? WHERE run_id=?")
        .run(now, run.runId);
      this.database.exec('COMMIT;');
    } catch {
      rollbackQuietly(this.database);
      throw new TaskStoreError('persistence', 'The durable run claim failed.');
    }
  }

  recordTrace(
    runId: string,
    event: AgentStreamEvent,
    ownerGeneration: string,
    at = new Date()
  ): void {
    const payload = JSON.stringify(event);
    const bytes = Buffer.byteLength(payload);
    const nextSnapshot = reducePersistedTrace(this.snapshotCache.get(runId), event);
    const checkpoint =
      nextSnapshot !== undefined &&
      (event.operation === 'reset' || event.operation === 'state' || event.sequence % 100 === 0);
    try {
      this.database.exec('BEGIN IMMEDIATE;');
      const usage = this.database
        .prepare(
          `SELECT trace_event_count AS count,trace_payload_bytes AS bytes,
             (SELECT COALESCE(SUM(byte_length),0) FROM agent_images WHERE run_id=r.id) AS image_bytes
           FROM agent_runs r WHERE id=?`
        )
        .get(runId) as { count: number; bytes: number; image_bytes: number };
      if (usage.count >= MAX_TRACE_EVENTS) {
        throw new TaskStoreError('persistence', 'The durable trace limit was reached.');
      }
      const terminal =
        event.operation === 'state' &&
        ['settled', 'failed', 'cancelled'].includes(event.state.status);
      const errorNotice =
        (event.operation === 'append' || event.operation === 'replace') &&
        event.item.kind === 'notice' &&
        event.item.state === 'error';
      const limit =
        this.runStorageBudgetBytes -
        (terminal || errorNotice ? 0 : RUN_STORAGE_CONTROL_RESERVE_BYTES);
      if (usage.bytes + usage.image_bytes + bytes > limit)
        this.storageBudgetExceeded(usage.bytes + usage.image_bytes, bytes);
      this.database
        .prepare(
          'INSERT INTO agent_trace_events(run_id,sequence,recorded_at,operation,payload_json,payload_bytes) VALUES(?,?,?,?,?,?)'
        )
        .run(runId, event.sequence, at.toISOString(), event.operation, payload, bytes);
      const lease = new Date(at.getTime() + 30_000).toISOString();
      const leaseResult = this.database
        .prepare(
          `UPDATE agent_runs
              SET lease_expires_at=?,trace_event_count=trace_event_count+1,
                  trace_payload_bytes=trace_payload_bytes+?
            WHERE id=? AND owner_generation=? AND status IN ('starting','running')`
        )
        .run(lease, bytes, runId, ownerGeneration);
      if (Number(leaseResult.changes) !== 1) {
        throw new TaskStoreError('persistence', 'The run ownership lease was lost.');
      }
      if (checkpoint) {
        this.database
          .prepare(
            'UPDATE agent_runs SET latest_snapshot_json=?,latest_snapshot_sequence=? WHERE id=?'
          )
          .run(JSON.stringify(nextSnapshot), nextSnapshot.sequence, runId);
      }
      this.database.exec('COMMIT;');
      if (nextSnapshot !== undefined) this.snapshotCache.set(runId, nextSnapshot);
    } catch (error) {
      rollbackQuietly(this.database);
      if (error instanceof TaskStoreError) throw error;
      throw new TaskStoreError('persistence', 'The agent trace could not be stored durably.');
    }
  }

  private storageBudgetExceeded(used: number, requested: number): never {
    throw new TaskStoreError(
      'storage_budget',
      `Speicherbudget des Laufs erreicht: ${Math.ceil(used / 1024 / 1024)} MiB belegt, ${Math.ceil(requested / 1024)} KiB zusätzlich, ${this.runStorageBudgetBytes / 1024 / 1024} MiB Budget für Bilder und Transkript. Der Lauf wird angehalten; vorhandene Daten bleiben erhalten.`
    );
  }

  /**
   * Persists one agent-provided image binary bound to a run. The image is
   * strictly re-validated (magic bytes, real dimensions, byte/pixel budget)
   * and deduplicated per run by content hash; the per-run quota is checked
   * in the same transaction as the insert. Only strict metadata is returned.
   */
  storeConversationImage(
    runId: string,
    input: { mimeType: string; data: Buffer; label?: string }
  ): AgentTimelineImage {
    const sha = createHash('sha256').update(input.data).digest('hex');
    const row = this.database
      .prepare(
        `SELECT i.* FROM agent_images i
      JOIN agent_runs original ON original.id=i.run_id
      JOIN agent_runs current ON current.task_id=original.task_id
      WHERE current.id=? AND i.sha256=? AND i.mime_type=? ORDER BY i.created_at LIMIT 1`
      )
      .get(runId, sha, input.mimeType) as unknown as ImageRow | undefined;
    return row === undefined ? this.storeImage(runId, input) : this.imageFromRow(row);
  }

  storeImage(
    runId: string,
    input: { mimeType: string; data: Buffer; label?: string }
  ): AgentTimelineImage {
    const validation = validateAgentImage(input.mimeType, input.data);
    if (!validation.ok)
      throw new TaskStoreError('persistence', `Image rejected: ${validation.reason}`);
    const sha = createHash('sha256').update(input.data).digest('hex');
    const label =
      input.label === undefined
        ? undefined
        : input.label.trim().slice(0, 128) === ''
          ? undefined
          : input.label.trim().slice(0, 128);
    const nested = this.database.isTransaction;
    try {
      if (!nested) this.database.exec('BEGIN IMMEDIATE;');
      const run = this.database
        .prepare('SELECT task_id,trace_payload_bytes FROM agent_runs WHERE id=?')
        .get(runId) as { task_id: string; trace_payload_bytes: number } | undefined;
      if (run === undefined) throw new TaskStoreError('not_found', 'Run not found.');
      const existing = this.database
        .prepare('SELECT id FROM agent_images WHERE run_id=? AND sha256=?')
        .get(runId, sha) as { id: string } | undefined;
      if (existing !== undefined) {
        if (!nested) this.database.exec('COMMIT;');
        return this.imageFromRow(
          this.database
            .prepare('SELECT * FROM agent_images WHERE id=?')
            .get(existing.id) as unknown as ImageRow
        );
      }
      const usage = this.database
        .prepare('SELECT COALESCE(SUM(byte_length),0) AS bytes FROM agent_images WHERE run_id=?')
        .get(runId) as { bytes: number };
      if (
        usage.bytes + run.trace_payload_bytes + validation.byteLength >
        this.runStorageBudgetBytes - RUN_STORAGE_CONTROL_RESERVE_BYTES
      )
        this.storageBudgetExceeded(usage.bytes + run.trace_payload_bytes, validation.byteLength);
      const id = randomUUID();
      this.database
        .prepare(
          `INSERT INTO agent_images(
             id,run_id,task_id,sha256,mime_type,byte_length,width,height,label,data,created_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          id,
          runId,
          run.task_id,
          sha,
          validation.mimeType,
          validation.byteLength,
          validation.width,
          validation.height,
          label ?? null,
          input.data,
          new Date().toISOString()
        );
      if (!nested) this.database.exec('COMMIT;');
      return {
        id,
        runId,
        mimeType: validation.mimeType,
        byteLength: validation.byteLength,
        width: validation.width,
        height: validation.height,
        ...(label === undefined ? {} : { label }),
      };
    } catch (error) {
      if (!nested) rollbackQuietly(this.database);
      if (error instanceof TaskStoreError) throw error;
      throw new TaskStoreError('persistence', 'The agent image could not be stored durably.');
    }
  }

  storeInputImage(
    runId: string,
    position: number,
    input: { mimeType: string; data: Buffer; label?: string }
  ): AgentTimelineImage {
    const image = this.storeImage(runId, input);
    this.database
      .prepare(
        'INSERT INTO agent_input_images(run_id,image_id,position) VALUES(?,?,?) ON CONFLICT(run_id,position) DO NOTHING'
      )
      .run(runId, image.id, position);
    const row = this.database
      .prepare('SELECT image_id FROM agent_input_images WHERE run_id=? AND position=?')
      .get(runId, position) as { image_id: string };
    if (row.image_id !== image.id)
      throw new TaskStoreError(
        'conflict',
        'Reference image position is already bound to different content.'
      );
    return image;
  }

  /** Latest supplied reference set, never tool screenshots or another task's images. */
  getTaskInputImages(taskId: string) {
    return this.taskInputImageMetadata(taskId).map((image) =>
      this.getRunImage(image.runId, image.id)
    );
  }

  private taskInputImageMetadata(taskId: string, runId?: string): AgentTimelineImage[] {
    const rows = this.database
      .prepare(
        `
      SELECT i.id,i.run_id,i.mime_type,i.byte_length,i.width,i.height,i.label
      FROM agent_input_images a JOIN agent_images i ON i.id=a.image_id
      WHERE a.run_id=COALESCE(?,(SELECT r.id FROM agent_runs r WHERE r.task_id=? AND r.run_kind='implementation'
        AND EXISTS(SELECT 1 FROM agent_input_images previous WHERE previous.run_id=r.id)
        ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1))
      ORDER BY a.position LIMIT 4
    `
      )
      .all(runId ?? null, taskId) as unknown as Array<Omit<ImageRow, 'data'>>;
    return rows.map((row) => this.imageFromRow(row));
  }

  /**
   * Returns the bounded binary of one image, verified to belong to the
   * exact run; unknown IDs and images of other runs are not found.
   */
  getRunImage(runId: string, imageId: string) {
    const row = this.database
      .prepare('SELECT * FROM agent_images WHERE id=? AND run_id=?')
      .get(imageId, runId) as unknown as ImageRow | undefined;
    if (row === undefined) throw new TaskStoreError('not_found', 'Image not found for run.');
    const data = row.data;
    const buffer = Buffer.isBuffer(data)
      ? data
      : Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(0));
    return { ...this.imageFromRow(row), data: buffer };
  }

  private imageFromRow(row: Omit<ImageRow, 'data'>): AgentTimelineImage {
    return AgentTimelineImageSchema.parse({
      id: String(row.id),
      runId: String(row.run_id),
      mimeType: String(row.mime_type),
      byteLength: Number(row.byte_length),
      width: Number(row.width),
      height: Number(row.height),
      ...(row.label === null ? {} : { label: String(row.label) }),
    });
  }

  updateRunStatus(
    runId: string,
    status: DurableRunStatus,
    reason?: string,
    at = new Date(),
    ownerGeneration?: string,
    recovery = false
  ): void {
    const now = at.toISOString();
    const terminal = ['completed', 'yielded', 'failed', 'cancelled', 'interrupted'].includes(
      status
    );
    try {
      this.database.exec('BEGIN IMMEDIATE;');
      const row = this.database
        .prepare('SELECT task_id,turn_id,status,owner_generation FROM agent_runs WHERE id=?')
        .get(runId) as
        | { task_id: string; turn_id: string; status: string; owner_generation: string | null }
        | undefined;
      if (row === undefined) throw new Error('unknown run');
      if (['completed', 'yielded', 'failed', 'cancelled', 'interrupted'].includes(row.status)) {
        this.database.exec('COMMIT;');
        return;
      }
      if (row.status === status) {
        this.database.exec('COMMIT;');
        return;
      }
      if (
        !recovery &&
        ['starting', 'running'].includes(row.status) &&
        row.owner_generation !== ownerGeneration
      ) {
        throw new Error('run ownership generation mismatch');
      }
      if (!isAllowedRunUpdate(row.status as DurableRunStatus, status)) {
        throw new TaskStoreError(
          'invalid_transition',
          `Forbidden run transition: ${row.status} -> ${status}.`
        );
      }
      this.database
        .prepare(
          `UPDATE agent_runs SET status=?,version=version+1,reason=?,
             finished_at=CASE WHEN ? THEN ? ELSE finished_at END WHERE id=?`
        )
        .run(status, reason ?? null, terminal ? 1 : 0, now, runId);
      const turnStatus =
        status === 'completed'
          ? 'completed'
          : status === 'yielded'
            ? 'waiting_for_input'
            : terminal
              ? status === 'cancelled'
                ? 'cancelled'
                : 'interrupted'
              : 'active';
      const turn = this.database
        .prepare('SELECT status FROM agent_turns WHERE id=?')
        .get(row.turn_id) as { status: string } | undefined;
      if (turn === undefined) throw new Error('unknown turn');
      if (
        turn.status !== turnStatus &&
        !canTransitionTurn(turn.status as DurableTurnStatus, turnStatus as DurableTurnStatus)
      ) {
        throw new TaskStoreError(
          'invalid_transition',
          `Forbidden turn transition: ${turn.status} -> ${turnStatus}.`
        );
      }
      this.database
        .prepare('UPDATE agent_turns SET status=?,version=version+1,updated_at=? WHERE id=?')
        .run(turnStatus, now, row.turn_id);
      this.database
        .prepare('UPDATE agent_tasks SET version=version+1,updated_at=? WHERE id=?')
        .run(now, row.task_id);
      if (terminal) {
        this.database
          .prepare("UPDATE agent_dispatches SET status='finished',updated_at=? WHERE run_id=?")
          .run(now, runId);
      } else if (status === 'running') {
        this.database
          .prepare("UPDATE agent_dispatches SET status='started',updated_at=? WHERE run_id=?")
          .run(now, runId);
      }
      this.database.exec('COMMIT;');
    } catch (error) {
      rollbackQuietly(this.database);
      if (error instanceof TaskStoreError) throw error;
      throw new TaskStoreError('persistence', 'The durable run state could not be updated.');
    }
  }

  storeFinalAssistant(runId: string, snapshot: AgentRunSnapshot, at = new Date()): void {
    const last = [...snapshot.timeline]
      .reverse()
      .find((item) => item.kind === 'assistant' && item.text?.trim());
    if (last?.text === undefined) return;
    const row = this.database
      .prepare('SELECT task_id,turn_id FROM agent_runs WHERE id=?')
      .get(runId) as { task_id: string; turn_id: string } | undefined;
    if (row === undefined) return;
    this.database
      .prepare(
        "INSERT OR IGNORE INTO agent_messages(id,task_id,turn_id,run_id,role,text,created_at) VALUES(?,?,?,?,'assistant',?,?)"
      )
      .run(randomUUID(), row.task_id, row.turn_id, runId, last.text, at.toISOString());
  }

  /**
   * Reclaim the same Durable run after the previous runner has stopped its
   * tools. This is the explicit recovery command for the `interrupted ->
   * queued` edge defined by canRecoverRun in contracts/agent-state.ts; it is
   * deliberately not a normal updateRunStatus transition.
   */
  requeueDurableRun(runId: string): boolean {
    const result = this.database
      .prepare(
        "UPDATE agent_runs SET status='queued',owner_generation=NULL,lease_expires_at=NULL,finished_at=NULL,version=version+1 WHERE id=? AND status='interrupted' AND profile_id='durable-v1'"
      )
      .run(runId);
    this.snapshotCache.delete(runId);
    return Number(result.changes) === 1;
  }

  recoverInterrupted(at = new Date()): string[] {
    const rows = this.database
      .prepare(
        `SELECT id,task_id,turn_id,sandbox_run_id FROM agent_runs WHERE ${OCCUPIED_RUN_PREDICATE}`
      )
      .all() as Array<{ id: string; task_id: string; turn_id: string; sandbox_run_id: string }>;
    for (const row of rows) {
      this.updateRunStatus(
        row.id,
        'interrupted',
        'Runner restarted before completion.',
        at,
        undefined,
        true
      );
    }
    return rows.map((row) => row.sandbox_run_id);
  }

  acceptRelease(input: StartReleaseRequest, at = new Date()): AcceptedRelease {
    const digest = digestRelease(input);
    const now = at.toISOString();
    try {
      this.database.exec('BEGIN IMMEDIATE;');
      const existing = this.database
        .prepare('SELECT * FROM release_jobs WHERE idempotency_key=?')
        .get(input.idempotencyKey) as Record<string, unknown> | undefined;
      if (existing !== undefined) {
        if (existing.request_digest !== digest) {
          throw new TaskStoreError(
            'idempotency_conflict',
            'The release idempotency key is already bound to another commit.'
          );
        }
        this.database.exec('COMMIT;');
        return { release: releaseFromRow(existing), created: false };
      }
      const source = this.database
        .prepare(
          `SELECT r.task_id,t.project_id,rr.result_revision,rr.accepted_revision,rr.merged_revision
             FROM agent_runs r
             JOIN agent_tasks t ON t.id=r.task_id
             JOIN agent_run_results rr ON rr.run_id=r.id
            WHERE r.id=?`
        )
        .get(input.runId) as
        | {
            task_id: string;
            project_id: string;
            result_revision: string;
            accepted_revision: string | null;
            merged_revision: string | null;
          }
        | undefined;
      if (source === undefined) throw new TaskStoreError('not_found', 'Run result not found.');
      if (
        source.task_id !== input.taskId ||
        source.result_revision !== input.revision ||
        source.accepted_revision !== input.revision
      ) {
        throw new TaskStoreError(
          'conflict',
          'A release must reference the exact accepted run revision.'
        );
      }
      if (source.merged_revision === null) {
        throw new TaskStoreError(
          'conflict',
          'A release must reference a result that is already merged into the project.'
        );
      }
      const id = randomUUID();
      this.database
        .prepare(
          `INSERT INTO release_jobs(
             id,task_id,run_id,project_id,target,revision,status,check_status,
             idempotency_key,request_digest,build_log,created_at,updated_at
           ) VALUES(?,?,?,?,? ,?,?,?, ?,?,?,?,?)`
        )
        .run(
          id,
          input.taskId,
          input.runId,
          source.project_id,
          'observatory',
          input.revision,
          'queued',
          'not_run',
          input.idempotencyKey,
          digest,
          '',
          now,
          now
        );
      this.database
        .prepare('UPDATE agent_tasks SET version=version+1,updated_at=? WHERE id=?')
        .run(now, input.taskId);
      const row = this.database.prepare('SELECT * FROM release_jobs WHERE id=?').get(id) as Record<
        string,
        unknown
      >;
      this.database.exec('COMMIT;');
      return { release: releaseFromRow(row), created: true };
    } catch (error) {
      rollbackQuietly(this.database);
      if (error instanceof TaskStoreError) throw error;
      throw new TaskStoreError('persistence', 'The release job could not be stored.');
    }
  }

  getRelease(releaseId: string): ReleaseJob {
    const row = this.database.prepare('SELECT * FROM release_jobs WHERE id=?').get(releaseId) as
      Record<string, unknown> | undefined;
    if (row === undefined) throw new TaskStoreError('not_found', 'Release job not found.');
    return releaseFromRow(row);
  }

  releaseArtifactPath(releaseId: string): string | undefined {
    const row = this.database
      .prepare('SELECT artifact_path FROM release_jobs WHERE id=?')
      .get(releaseId) as { artifact_path: string | null } | undefined;
    if (row === undefined) throw new TaskStoreError('not_found', 'Release job not found.');
    return row.artifact_path ?? undefined;
  }

  markReleaseBuilding(releaseId: string, at = new Date()): ReleaseJob {
    const now = at.toISOString();
    const result = this.database
      .prepare(
        "UPDATE release_jobs SET status='building',updated_at=?,reason=NULL WHERE id=? AND status='queued'"
      )
      .run(now, releaseId);
    if (Number(result.changes) !== 1)
      throw new TaskStoreError('conflict', 'Release job is no longer queued.');
    return this.getRelease(releaseId);
  }

  markReleasePrepared(
    releaseId: string,
    artifactPath: string,
    artifactDigest: string,
    buildLog: string,
    at = new Date()
  ): ReleaseJob {
    const now = at.toISOString();
    const row = this.database
      .prepare('SELECT task_id FROM release_jobs WHERE id=?')
      .get(releaseId) as { task_id: string } | undefined;
    if (row === undefined) throw new TaskStoreError('not_found', 'Release job not found.');
    const update = this.database
      .prepare(
        `UPDATE release_jobs
            SET status='prepared',check_status='passed',artifact_path=?,artifact_digest=?,
                build_log=?,updated_at=?,prepared_at=?,reason=NULL
          WHERE id=? AND status='building'`
      )
      .run(artifactPath, artifactDigest, buildLog.slice(0, 524_288), now, now, releaseId);
    if (Number(update.changes) !== 1)
      throw new TaskStoreError('conflict', 'Release job is no longer building.');
    this.database
      .prepare('UPDATE agent_tasks SET version=version+1,updated_at=? WHERE id=?')
      .run(now, row.task_id);
    return this.getRelease(releaseId);
  }

  markReleaseFailed(releaseId: string, reason: string, buildLog = '', at = new Date()): ReleaseJob {
    const now = at.toISOString();
    const row = this.database
      .prepare('SELECT task_id FROM release_jobs WHERE id=?')
      .get(releaseId) as { task_id: string } | undefined;
    if (row === undefined) throw new TaskStoreError('not_found', 'Release job not found.');
    const update = this.database
      .prepare(
        `UPDATE release_jobs
            SET status='failed',check_status='failed',build_log=?,reason=?,updated_at=?
          WHERE id=? AND status IN ('queued','building')`
      )
      .run(buildLog.slice(0, 524_288), reason.slice(0, 512), now, releaseId);
    if (Number(update.changes) !== 1)
      throw new TaskStoreError('conflict', 'Release job can no longer fail from this state.');
    this.database
      .prepare('UPDATE agent_tasks SET version=version+1,updated_at=? WHERE id=?')
      .run(now, row.task_id);
    return this.getRelease(releaseId);
  }

  markReleaseActivating(releaseId: string, at = new Date()): ReleaseJob {
    const now = at.toISOString();
    const row = this.database
      .prepare('SELECT task_id FROM release_jobs WHERE id=?')
      .get(releaseId) as { task_id: string } | undefined;
    if (row === undefined) throw new TaskStoreError('not_found', 'Release job not found.');
    const update = this.database
      .prepare(
        "UPDATE release_jobs SET status='activating',updated_at=?,reason=NULL WHERE id=? AND status='prepared'"
      )
      .run(now, releaseId);
    if (Number(update.changes) !== 1)
      throw new TaskStoreError('conflict', 'Release job is not ready to activate.');
    this.database
      .prepare('UPDATE agent_tasks SET version=version+1,updated_at=? WHERE id=?')
      .run(now, row.task_id);
    return this.getRelease(releaseId);
  }

  syncReleaseDeployment(
    releaseId: string,
    status: 'active' | 'failed' | 'rolled_back',
    reason?: string,
    at = new Date()
  ): ReleaseJob | undefined {
    const now = at.toISOString();
    const row = this.database
      .prepare('SELECT task_id,status FROM release_jobs WHERE id=?')
      .get(releaseId) as { task_id: string; status: string } | undefined;
    if (row === undefined) return undefined;
    if (row.status === status) return this.getRelease(releaseId);
    const update = this.database
      .prepare(
        `UPDATE release_jobs
            SET status=?,updated_at=?,activated_at=CASE WHEN ?='active' THEN ? ELSE activated_at END,
                reason=?
          WHERE id=? AND status IN ('activating','active','rolled_back')`
      )
      .run(status, now, status, now, reason?.slice(0, 512) ?? null, releaseId);
    if (Number(update.changes) !== 1) return this.getRelease(releaseId);
    this.database
      .prepare('UPDATE agent_tasks SET version=version+1,updated_at=? WHERE id=?')
      .run(now, row.task_id);
    return this.getRelease(releaseId);
  }

  recoverInterruptedReleases(at = new Date()): void {
    const rows = this.database
      .prepare("SELECT id FROM release_jobs WHERE status IN ('queued','building')")
      .all() as Array<{ id: string }>;
    for (const row of rows) {
      this.markReleaseFailed(row.id, 'Runner restarted before the release step completed.', '', at);
    }
  }

  recentWork() {
    const tasks = this.database
      .prepare(
        `
      SELECT t.id,t.title,p.name AS projectName,t.updated_at AS updatedAt,r.status AS runStatus
      FROM agent_tasks t JOIN agent_projects p ON p.id=t.project_id JOIN agent_runs r ON r.id=(
        SELECT id FROM agent_runs WHERE task_id=t.id AND run_kind='implementation'
        ORDER BY created_at DESC,rowid DESC LIMIT 1
      )
      WHERE t.status <> 'archived' AND p.archived=0
      ORDER BY t.updated_at DESC,t.id LIMIT 3
    `
      )
      .all();
    const projects = this.database
      .prepare(
        `
      SELECT p.id,p.name,MAX(p.created_at,COALESCE(MAX(t.updated_at),p.created_at)) AS updatedAt
      FROM agent_projects p LEFT JOIN agent_tasks t ON t.project_id=p.id AND t.status <> 'archived'
      WHERE p.archived=0 GROUP BY p.id ORDER BY updatedAt DESC,p.id LIMIT 3
    `
      )
      .all();
    return RecentWorkSchema.parse({ tasks, projects });
  }

  listTasks(includeArchived = false): DurableTaskList {
    const rows = this.database
      .prepare(
        `SELECT t.id,t.title,t.project_id,p.name AS project_name,t.architecture_target_json,t.status,t.version,t.created_at,t.updated_at,
                r.id AS run_id,r.task_id AS run_task_id,r.turn_id,r.status AS run_status,
                r.version AS run_version,r.profile_id,r.base_revision,r.result_revision,r.files_changed,r.check_status,
                r.created_at AS run_created_at,r.started_at,r.finished_at,r.reason,
                EXISTS(SELECT 1 FROM agent_questions q WHERE q.task_id=t.id AND q.status='open') AS has_open_question,
                (SELECT accepted_at FROM agent_run_results rr WHERE rr.run_id=r.id) AS result_accepted_at
           FROM agent_tasks t JOIN agent_projects p ON p.id=t.project_id JOIN agent_runs r ON r.id=(
             SELECT id FROM agent_runs WHERE task_id=t.id AND run_kind='implementation' ORDER BY created_at DESC,rowid DESC LIMIT 1
           )
          ${includeArchived ? '' : "WHERE t.status <> 'archived'"}
          ORDER BY t.updated_at DESC LIMIT 100`
      )
      .all() as unknown as TaskRow[];
    const active = this.database
      .prepare(
        `SELECT task_id AS id FROM agent_runs WHERE ${OCCUPIED_RUN_PREDICATE} ORDER BY created_at,id`
      )
      .all() as Array<{ id: string }>;
    return DurableTaskListSchema.parse({
      items: rows.map(summaryFromRow),
      ...(active[0] === undefined ? {} : { activeTaskId: active[0].id }),
      activeTaskIds: active.map((row) => row.id),
    });
  }

  /** Idempotent per relay request; the caller binds the capability to this run. */
  recordInferenceTelemetry(runId: string, input: InferenceRequestTelemetry): boolean {
    const sample = InferenceRequestTelemetrySchema.parse(input);
    const existing = this.database
      .prepare('SELECT run_id FROM agent_inference_telemetry WHERE request_id=?')
      .get(sample.requestId) as { run_id: string } | undefined;
    if (existing) {
      if (existing.run_id !== runId)
        throw new TaskStoreError('conflict', 'Inference sample belongs to a different run.');
      return false;
    }
    if (!this.database.prepare('SELECT id FROM agent_runs WHERE id=?').get(runId)) {
      throw new TaskStoreError('not_found', 'Run not found.');
    }
    this.database
      .prepare(
        `INSERT INTO agent_inference_telemetry(
      request_id,run_id,started_at,finished_at,duration_ms,outcome,input_tokens,output_tokens,
      cached_input_tokens,prefill_tokens,prefill_ms,decode_tokens,decode_ms,engine_wait_ms
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        sample.requestId,
        runId,
        sample.startedAt,
        sample.finishedAt,
        sample.durationMs,
        sample.outcome,
        sample.usage?.inputTokens ?? null,
        sample.usage?.outputTokens ?? null,
        sample.usage?.cachedInputTokens ?? null,
        sample.prefill?.tokens ?? null,
        sample.prefill?.durationMs ?? null,
        sample.decode?.tokens ?? null,
        sample.decode?.durationMs ?? null,
        sample.engineWaitMs ?? null
      );
    return true;
  }

  private inferenceTotals(runId: string | null, taskId: string | null): InferenceTelemetryTotals {
    const row = this.database
      .prepare(
        `SELECT
      COUNT(*) AS requests,
      COALESCE(SUM(CASE WHEN outcome='completed' THEN 1 ELSE 0 END),0) AS completed,
      COALESCE(SUM(CASE WHEN outcome='failed' THEN 1 ELSE 0 END),0) AS failed,
      SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
      SUM(cached_input_tokens) AS cached_input_tokens,
      SUM(prefill_tokens) AS prefill_tokens, SUM(prefill_ms) AS prefill_ms,
      COUNT(prefill_ms) AS prefill_samples,
      SUM(decode_tokens) AS decode_tokens, SUM(decode_ms) AS decode_ms,
      COUNT(decode_ms) AS decode_samples
      FROM agent_inference_telemetry
      WHERE run_id IN (SELECT id FROM agent_runs WHERE id=? OR (task_id=? AND run_kind='implementation'))
    `
      )
      .get(runId, taskId) as Record<string, number | null>;
    const usage = {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cachedInputTokens: row.cached_input_tokens,
    };
    const phase = (name: 'prefill' | 'decode') => {
      const tokens = row[`${name}_tokens`];
      const durationMs = row[`${name}_ms`];
      const samples = row[`${name}_samples`];
      return typeof tokens === 'number' &&
        typeof durationMs === 'number' &&
        durationMs > 0 &&
        samples
        ? { tokens, durationMs, samples, tokensPerSecond: (tokens / durationMs) * 1000 }
        : null;
    };
    return InferenceTelemetryTotalsSchema.parse({
      requests: row.requests,
      completedRequests: row.completed,
      failedRequests: row.failed,
      usage: Object.values(usage).some((value) => value !== null) ? usage : null,
      prefill: phase('prefill'),
      decode: phase('decode'),
    });
  }

  getRunTelemetry(runId: string): AgentRunTelemetry {
    if (!this.database.prepare('SELECT id FROM agent_runs WHERE id=?').get(runId)) {
      throw new TaskStoreError('not_found', 'Run not found.');
    }
    return { runId, totals: this.inferenceTotals(runId, null) };
  }
  getRunEngineWaits(runId: string): Array<[number, number]> | undefined {
    const rows = this.database
      .prepare('SELECT started_at, engine_wait_ms FROM agent_inference_telemetry WHERE run_id=?')
      .all(runId) as { started_at: string; engine_wait_ms: number | null }[];
    if (!rows.length || rows.some((row) => row.engine_wait_ms === null)) return undefined;
    return rows.map((row) => {
      const start = Date.parse(row.started_at);
      return [start, start + row.engine_wait_ms!];
    });
  }

  getTaskTelemetry(taskId: string): AgentTaskTelemetry {
    if (!this.database.prepare('SELECT id FROM agent_tasks WHERE id=?').get(taskId)) {
      throw new TaskStoreError('not_found', 'Task not found.');
    }
    const rows = this.database
      .prepare(
        "SELECT id FROM agent_runs WHERE task_id=? AND run_kind='implementation' ORDER BY created_at DESC,rowid DESC LIMIT 100"
      )
      .all(taskId) as unknown as { id: string }[];
    return AgentTaskTelemetrySchema.parse({
      taskId,
      totals: this.inferenceTotals(null, taskId),
      runs: rows.map((row) => ({ runId: row.id, totals: this.inferenceTotals(row.id, null) })),
    });
  }

  /** Lightweight selection for preview polling: no traces, messages, result bodies or telemetry. */
  getTaskRunSelection(taskId: string, runId?: string): { run: DurableRun; latestRunId: string } {
    const latest = `SELECT id FROM agent_runs WHERE task_id=t.id AND run_kind='implementation' ORDER BY created_at DESC,rowid DESC LIMIT 1`;
    const row = this.database
      .prepare(
        `SELECT r.id,r.task_id,r.turn_id,r.status,r.version,r.profile_id,r.base_revision,
              r.result_revision,r.files_changed,r.check_status,r.created_at,r.started_at,
              r.finished_at,r.reason,(${latest}) AS latest_run_id
       FROM agent_tasks t JOIN agent_runs r ON r.task_id=t.id AND r.run_kind='implementation'
       WHERE t.id=? AND r.id=COALESCE(?,(${latest}))`
      )
      .get(taskId, runId ?? null) as (RunRow & { latest_run_id: string }) | undefined;
    if (row === undefined) throw new TaskStoreError('not_found', 'Task or run not found.');
    return { run: runFromRow(row), latestRunId: row.latest_run_id };
  }

  getTask(taskId: string): DurableTaskDetail {
    const list = this.listTasks(true);
    const task = list.items.find((item) => item.id === taskId);
    if (task === undefined) throw new TaskStoreError('not_found', 'Task not found.');
    const runs = (
      this.database
        .prepare(
          "SELECT * FROM agent_runs WHERE task_id=? AND run_kind='implementation' ORDER BY created_at DESC,rowid DESC LIMIT 100"
        )
        .all(taskId) as unknown as RunRow[]
    ).map(runFromRow);
    const messages = this.database
      .prepare(
        `SELECT m.id,m.task_id,m.turn_id,m.run_id,m.role,m.text,m.created_at
           FROM agent_messages m JOIN agent_turns t ON t.id=m.turn_id
          WHERE m.task_id=? ORDER BY t.ordinal,m.created_at,m.id LIMIT 500`
      )
      .all(taskId)
      .map((row) => {
        const value = row as Record<string, unknown>;
        return {
          id: value.id,
          taskId: value.task_id,
          turnId: value.turn_id,
          runId: value.run_id,
          role: value.role,
          text: value.text,
          createdAt: value.created_at,
        };
      });
    const steering = this.database
      .prepare(
        `SELECT id,run_id,text,status,created_at,updated_at,sent_at,acknowledged_at,
                confirmed_at,reason FROM agent_steering
          WHERE run_id IN (SELECT id FROM agent_runs WHERE task_id=?)
          ORDER BY created_at,id LIMIT 1000`
      )
      .all(taskId)
      .map((raw) => {
        const row = raw as Record<string, unknown>;
        return {
          id: row.id,
          runId: row.run_id,
          text: row.text,
          status: row.status,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          ...(row.sent_at === null ? {} : { sentAt: row.sent_at }),
          ...(row.acknowledged_at === null ? {} : { acknowledgedAt: row.acknowledged_at }),
          ...(row.confirmed_at === null ? {} : { confirmedAt: row.confirmed_at }),
          ...(row.reason === null ? {} : { reason: row.reason }),
        };
      });
    const cancellations = this.database
      .prepare(
        `SELECT id,run_id,status,created_at,updated_at,completed_at,reason
           FROM agent_cancellations
          WHERE run_id IN (SELECT id FROM agent_runs WHERE task_id=?)
          ORDER BY created_at,id LIMIT 100`
      )
      .all(taskId)
      .map((raw) => {
        const row = raw as Record<string, unknown>;
        return {
          id: row.id,
          runId: row.run_id,
          status: row.status,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
          ...(row.reason === null ? {} : { reason: row.reason }),
        };
      });
    const releases = (
      this.database
        .prepare(
          'SELECT * FROM release_jobs WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100'
        )
        .all(taskId) as Array<Record<string, unknown>>
    ).map(releaseFromRow);
    const latestRun = runs[0];
    const followupRow = this.database
      .prepare("SELECT text FROM agent_followups WHERE task_id=? AND status='queued' LIMIT 1")
      .get(taskId) as { text: string } | undefined;
    const questionRow = this.database
      .prepare(
        "SELECT * FROM agent_questions WHERE task_id=? AND status='open' ORDER BY created_at DESC,rowid DESC LIMIT 1"
      )
      .get(taskId) as Record<string, unknown> | undefined;
    const openQuestion =
      questionRow === undefined
        ? undefined
        : {
            id: questionRow.id,
            taskId: questionRow.task_id,
            runId: questionRow.run_id,
            question: questionRow.question,
            status: questionRow.status,
            createdAt: questionRow.created_at,
          };
    let latestResult: AgentRunResult | undefined;
    if (latestRun?.resultRevision !== undefined) {
      try {
        latestResult = this.getRunResult(latestRun.id);
      } catch {
        /* result may be mid-finalization */
      }
    }
    const latestSnapshotFromTrace =
      latestRun === undefined ? undefined : this.materializeSnapshot(latestRun.id);
    let latestSnapshot = latestSnapshotFromTrace;
    if (latestRun !== undefined) {
      const durableStatus = snapshotStatus(latestRun.status, latestSnapshot?.status);
      if (latestSnapshot === undefined) {
        const userMessage = messages.find(
          (message) => message.runId === latestRun.id && message.role === 'user'
        );
        const references = this.taskInputImageMetadata(taskId);
        latestSnapshot = AgentRunSnapshotSchema.parse({
          service: 'local-ai-b70-observatory',
          enabled: true,
          status: durableStatus,
          sequence: 0,
          runId: latestRun.id,
          name: task.title,
          ...(userMessage === undefined ? {} : { task: userMessage.text }),
          ...(latestRun.startedAt === undefined ? {} : { startedAt: latestRun.startedAt }),
          ...(latestRun.finishedAt === undefined ? {} : { finishedAt: latestRun.finishedAt }),
          pendingSteering: 0,
          ...(latestRun.reason === undefined ? {} : { reason: latestRun.reason }),
          timeline:
            userMessage === undefined
              ? []
              : [
                  {
                    id: userMessage.id,
                    at: userMessage.createdAt,
                    kind: 'task',
                    title: 'Aufgabe',
                    text: userMessage.text,
                    state: latestRun.status === 'queued' ? 'queued' : 'complete',
                    ...(references.length > 0 ? { images: references } : {}),
                  },
                ],
        });
      } else if (
        latestRun.status === 'interrupted' ||
        latestRun.status === 'cancelled' ||
        latestRun.status === 'failed'
      ) {
        latestSnapshot = AgentRunSnapshotSchema.parse({
          ...latestSnapshot,
          status: durableStatus,
          ...(latestRun.finishedAt === undefined ? {} : { finishedAt: latestRun.finishedAt }),
          ...(latestRun.reason === undefined ? {} : { reason: latestRun.reason }),
          timeline: latestSnapshot.timeline.map((item) =>
            item.state === 'running' || item.state === 'queued'
              ? { ...item, state: 'error' as const }
              : item
          ),
        });
      }
    }
    return DurableTaskDetailSchema.parse({
      task,
      runs,
      telemetry: this.getTaskTelemetry(taskId),
      messages,
      steering,
      cancellations,
      reviews: this.listReviews(taskId),
      releases,
      ...(openQuestion === undefined ? {} : { openQuestion }),
      ...(latestResult === undefined ? {} : { latestResult }),
      ...(followupRow === undefined ? {} : { queuedFollowup: followupRow.text }),
      ...(latestSnapshot === undefined ? {} : { latestSnapshot }),
      traceEventCount:
        latestRun === undefined
          ? 0
          : (
              this.database
                .prepare('SELECT trace_event_count AS count FROM agent_runs WHERE id=?')
                .get(latestRun.id) as { count: number }
            ).count,
    });
  }

  /**
   * Returns the text of the first user message of the task – the original
   * task description that fallback titles were derived from.
   */
  firstUserMessage(taskId: string): string | undefined {
    const row = this.database
      .prepare(
        `SELECT m.text FROM agent_messages m JOIN agent_turns t ON t.id=m.turn_id
          WHERE m.task_id=? AND m.role='user' ORDER BY t.ordinal,m.created_at,m.id LIMIT 1`
      )
      .get(taskId) as { text: string } | undefined;
    return row?.text;
  }

  /**
   * Replaces the stored task title (e.g. after a model-generated one).
   *
   * The title is cosmetic: renaming a task must not count as activity, so
   * `updated_at` (the list's sort key and the displayed last-activity time)
   * is intentionally left untouched. Only the version is bumped so clients
   * refetch the detail and see the fresh title in place.
   */
  setTaskTitle(taskId: string, title: string): boolean {
    const result = this.database
      .prepare('UPDATE agent_tasks SET title=?,version=version+1 WHERE id=?')
      .run(title, taskId);
    return result.changes > 0;
  }

  private materializeSnapshot(runId: string): AgentRunSnapshot | undefined {
    const cached = this.snapshotCache.get(runId);
    let snapshot = cached;
    let afterSequence = cached?.sequence ?? -1;
    if (snapshot === undefined) {
      const row = this.database
        .prepare('SELECT latest_snapshot_json,latest_snapshot_sequence FROM agent_runs WHERE id=?')
        .get(runId) as
        | { latest_snapshot_json: string | null; latest_snapshot_sequence: number | null }
        | undefined;
      if (row?.latest_snapshot_json !== null && row?.latest_snapshot_json !== undefined) {
        snapshot = AgentRunSnapshotSchema.parse(JSON.parse(row.latest_snapshot_json));
        afterSequence = row.latest_snapshot_sequence ?? snapshot.sequence;
      }
    }
    const rows = this.traceRows(runId, afterSequence);
    for (const row of rows) {
      snapshot = reducePersistedTrace(
        snapshot,
        AgentStreamEventSchema.parse(JSON.parse(row.payload_json))
      );
    }
    if (snapshot === undefined) return undefined;
    snapshot = AgentRunSnapshotSchema.parse(snapshot);
    this.snapshotCache.set(runId, snapshot);
    if (rows.length > 0) {
      try {
        this.database
          .prepare(
            'UPDATE agent_runs SET latest_snapshot_json=?,latest_snapshot_sequence=? WHERE id=?'
          )
          .run(JSON.stringify(snapshot), snapshot.sequence, runId);
      } catch {
        // A read remains useful even if a read-only/capacity failure prevents caching.
      }
    }
    return snapshot;
  }

  traceRows(runId: string, afterSequence = -1): TraceRow[] {
    return this.database
      .prepare(
        'SELECT id,run_id,sequence,recorded_at,payload_json FROM agent_trace_events WHERE run_id=? AND sequence>? ORDER BY sequence'
      )
      .all(runId, afterSequence) as unknown as TraceRow[];
  }

  getRunTrace(runId: string, afterSequence = -1, limit = 100): DurableTracePage {
    const boundedLimit = Math.min(250, Math.max(1, Math.trunc(limit)));
    const run = this.database.prepare('SELECT id FROM agent_runs WHERE id=?').get(runId);
    if (run === undefined) throw new TaskStoreError('not_found', 'Run not found.');
    const rows = this.database
      .prepare(
        `SELECT id,run_id,sequence,recorded_at,payload_json
           FROM agent_trace_events
          WHERE run_id=? AND sequence>?
          ORDER BY sequence LIMIT ?`
      )
      .all(runId, Math.trunc(afterSequence), boundedLimit + 1) as unknown as TraceRow[];
    const pageRows: TraceRow[] = [];
    let pageBytes = 0;
    for (const row of rows) {
      if (pageRows.length >= boundedLimit) break;
      const rowBytes = Buffer.byteLength(row.payload_json);
      if (pageRows.length > 0 && pageBytes + rowBytes > MAX_TRACE_PAGE_BYTES) break;
      pageRows.push(row);
      pageBytes += rowBytes;
    }
    const hasMore = rows.length > pageRows.length;
    const page = pageRows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      sequence: row.sequence,
      recordedAt: row.recorded_at,
      event: AgentStreamEventSchema.parse(JSON.parse(row.payload_json)),
    }));
    return DurableTracePageSchema.parse({
      runId,
      items: page,
      hasMore,
      ...(hasMore && page.length > 0 ? { nextAfterSequence: page[page.length - 1]!.sequence } : {}),
    });
  }

  deleteTask(taskId: string): boolean {
    const runs = this.database
      .prepare('SELECT id FROM agent_runs WHERE task_id=?')
      .all(taskId) as Array<{
      id: string;
    }>;
    const result = this.database.prepare('DELETE FROM agent_tasks WHERE id=?').run(taskId);
    for (const run of runs) this.snapshotCache.delete(run.id);
    return Number(result.changes) === 1;
  }

  close(): void {
    this.snapshotCache.clear();
    this.database.close();
  }
}
