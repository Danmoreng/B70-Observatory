import { z } from 'zod';
import { UtcTimestampSchema } from '@observatory/contracts';

/**
 * Runtime contracts for values written through the repository layer.
 *
 * These schemas sit on the boundary between (possibly future) callers and
 * SQLite: every insert is parsed (Zod, strict) before a single parameter is
 * bound. This is the "runtime-validierte Grenze" for the persistence layer
 * – raw LLM content has no place in any of these shapes.
 *
 * Data privacy (M2 review finding 4): the write contracts contain **no
 * free-text fields at all** – no `detail`, no `errorMessage`, no
 * `prompt`/`response`/`messages`/`authorization`/`token`. Only
 * machine-readable codes, enums and typed numeric/boolean metadata can be
 * written, so smuggled content is structurally impossible, not merely
 * discouraged. The pre-existing `detail`/`errorMessage` columns are kept
 * for schema compatibility but are never populated.
 */

/** Request path only – query strings are forbidden (may carry secrets). */
const PATH_ONLY_REGEX = /^[A-Za-z0-9._~!$&'()*+,;=@:/-]+$/;
const METRIC_NAME_REGEX = /^[A-Za-z0-9_:.-]+$/;
const UNIT_REGEX = /^[A-Za-z0-9_%.]+$/;
const CODE_REGEX = /^[a-z0-9_.-]+$/;

const nonNegativeInt = z.number().int().nonnegative();

export const RequestOriginSchema = z.enum(['web', 'pi', 'script', 'cli', 'unknown']);
export type RequestOrigin = z.infer<typeof RequestOriginSchema>;

export const RequestStatusSchema = z.enum(['in_progress', 'completed', 'error', 'aborted']);
export type RequestStatus = z.infer<typeof RequestStatusSchema>;

export const HttpRequestMethodSchema = z.enum([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);
export type HttpRequestMethod = z.infer<typeof HttpRequestMethodSchema>;

/** Input for creating a request row. */
export const NewRequestSchema = z
  .object({
    /** Stable request id (UUID), assigned by the gateway (M3). */
    id: z.string().uuid(),
    origin: RequestOriginSchema.default('unknown'),
    model: z.string().min(1).max(128).optional(),
    /** URL *path* of the target endpoint. Query strings are rejected. */
    endpoint: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => PATH_ONLY_REGEX.test(value), {
        message: 'endpoint must be a URL path without query string or fragment',
      }),
    method: HttpRequestMethodSchema.default('POST'),
    startedAtUtc: UtcTimestampSchema,
    promptBytes: nonNegativeInt.default(0),
  })
  .strict();
export type NewRequest = z.infer<typeof NewRequestSchema>;

/** Terminal state of a request (success, error or client abort). */
export const RequestResultSchema = z
  .object({
    requestId: z.string().uuid(),
    status: z.enum(['completed', 'error', 'aborted']),
    completedAtUtc: UtcTimestampSchema,
    durationMs: nonNegativeInt,
    /**
     * Total response size in bytes. Only known at the end of the request
     * (M2 review finding 3), so it is mandatory here – `create()` leaves
     * the column at its `0` default until `finish()` updates it.
     */
    responseBytes: nonNegativeInt,
    ttftMs: nonNegativeInt.optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    promptTokens: nonNegativeInt.optional(),
    completionTokens: nonNegativeInt.optional(),
    totalTokens: nonNegativeInt.optional(),
    prefixCacheQueries: nonNegativeInt.optional(),
    prefixCacheHits: nonNegativeInt.optional(),
    mtpDraftTokens: nonNegativeInt.optional(),
    mtpAcceptedTokens: nonNegativeInt.optional(),
    /**
     * Sanitized machine-readable class, e.g. `upstream_timeout`.
     * Free-text error descriptions are deliberately not part of the write
     * contract (M2 review finding 4): codes only, so no raw content or
     * secrets can ride along in an "error message".
     */
    errorCode: z
      .string()
      .min(1)
      .max(64)
      .regex(CODE_REGEX, { message: 'errorCode must match [a-z0-9_.-]+' })
      .optional(),
  })
  .strict();
export type RequestResult = z.infer<typeof RequestResultSchema>;

export const RequestEventTypeSchema = z.enum([
  'start',
  'first_token',
  'token',
  'error',
  'abort',
  'complete',
]);
export type RequestEventType = z.infer<typeof RequestEventTypeSchema>;

/** One lifecycle event attached to a request. */
export const RequestEventSchema = z
  .object({
    requestId: z.string().uuid(),
    eventType: RequestEventTypeSchema,
    atUtc: UtcTimestampSchema,
  })
  .strict();
export type RequestEvent = z.infer<typeof RequestEventSchema>;

export const MetricSourceSchema = z.enum(['vllm', 'gpu', 'system', 'service']);
export type MetricSource = z.infer<typeof MetricSourceSchema>;

/** One normalized metric sample. `unit` is mandatory and machine-checkable. */
export const MetricSampleSchema = z
  .object({
    source: MetricSourceSchema,
    name: z.string().min(1).max(128).regex(METRIC_NAME_REGEX),
    value: z.number().finite(),
    /** e.g. `percent`, `bytes`, `celsius`, `watts`, `megahertz`, `ratio`, `count` */
    unit: z.string().min(1).max(32).regex(UNIT_REGEX),
    atUtc: UtcTimestampSchema,
    /**
     * Label dimensions of the metric (e.g. `{ device: "intel-arc-pro-b70" }`).
     * Labels are part of the metric's *series identity* (M2 review finding
     * 2): the same (source, name, atUtc) may exist once per distinct label
     * set. Stored as canonical (key-sorted) JSON; `undefined`/`{}` means
     * "no labels". Keys and values are plain strings only.
     */
    labels: z.record(z.string().min(1).max(64), z.string().min(1).max(256)).optional(),
  })
  .strict();
export type MetricSample = z.infer<typeof MetricSampleSchema>;

export const ServiceNameSchema = z.enum(['api', 'gateway', 'vllm', 'gpu', 'system']);
export type ServiceName = z.infer<typeof ServiceNameSchema>;

export const ServiceSeveritySchema = z.enum(['info', 'warn', 'error']);
export type ServiceSeverity = z.infer<typeof ServiceSeveritySchema>;

/** Lifecycle event of one of the observatory's own services.
 *
 * Note (M2 review finding 4): there is no free-text `detail` field – the
 * machine-readable `type` is the only descriptive field, so raw log output
 * or secrets cannot be smuggled into the table.
 */
export const ServiceEventSchema = z
  .object({
    service: ServiceNameSchema,
    severity: ServiceSeveritySchema,
    /** e.g. `started`, `stopped`, `crash`, `restart` */
    type: z.string().min(1).max(64),
    atUtc: UtcTimestampSchema,
  })
  .strict();
export type ServiceEvent = z.infer<typeof ServiceEventSchema>;
