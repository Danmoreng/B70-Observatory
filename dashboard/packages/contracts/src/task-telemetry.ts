import { z } from 'zod';

const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Milliseconds = z.number().finite().nonnegative();
const UtcTimestamp = z
  .string()
  .datetime()
  .refine((value) => {
    const time = new Date(value);
    return Number.isFinite(time.getTime()) && time.toISOString() === value;
  }, 'Expected a canonical UTC timestamp.');

/** Server phase clocks, never client elapsed time. vLLM prompt phase runs from scheduling to first token. */
export const InferencePhaseTimingSchema = z
  .object({
    tokens: Count,
    durationMs: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type InferencePhaseTiming = z.infer<typeof InferencePhaseTimingSchema>;

export const InferenceUsageSchema = z
  .object({
    inputTokens: Count.nullable(),
    outputTokens: Count.nullable(),
    cachedInputTokens: Count.nullable(),
  })
  .strict();
export type InferenceUsage = z.infer<typeof InferenceUsageSchema>;

/** No request bodies, capability tokens or globally sampled GPU statistics. */
export const InferenceRequestTelemetrySchema = z
  .object({
    requestId: z.string().uuid(),
    startedAt: UtcTimestamp,
    finishedAt: UtcTimestamp,
    durationMs: Milliseconds,
    engineWaitMs: Milliseconds.optional(),
    outcome: z.enum(['completed', 'failed']),
    usage: InferenceUsageSchema.nullable(),
    prefill: InferencePhaseTimingSchema.nullable(),
    decode: InferencePhaseTimingSchema.nullable(),
  })
  .strict()
  .superRefine((sample, context) => {
    if (sample.outcome === 'failed' && (sample.usage || sample.prefill || sample.decode)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Failed requests cannot contribute completed phase measurements.',
      });
    }
  });
export type InferenceRequestTelemetry = z.infer<typeof InferenceRequestTelemetrySchema>;

export const InferencePhaseTotalsSchema = InferencePhaseTimingSchema.extend({
  /** Sum(tokens) / Sum(durationMs) * 1000, not an average of individual rates. */
  tokensPerSecond: z.number().finite().nonnegative(),
  /** Coverage: this many of completedRequests supplied valid phase timings. */
  samples: Count.positive(),
});
export const InferenceTelemetryTotalsSchema = z
  .object({
    requests: Count,
    completedRequests: Count,
    failedRequests: Count,
    usage: InferenceUsageSchema.nullable(),
    /** Initial context once, then newly consumed input content. Never a sum of prompts. */
    uniqueInputTokens: Count.nullable().optional(),
    /** Null means no completed request supplied a valid backend timing pair. */
    prefill: InferencePhaseTotalsSchema.nullable(),
    decode: InferencePhaseTotalsSchema.nullable(),
    /** Old unambiguous single-run conversations can recover counts, never clocks. */
    usageSource: z.literal('durable-history').optional(),
    runtime: z
      .object({
        wallMs: Milliseconds,
        toolMs: Milliseconds.nullable(),
        modelMs: Milliseconds.nullable(),
        engineWaitMs: Milliseconds.nullable(),
        otherMs: Milliseconds.nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type InferenceTelemetryTotals = z.infer<typeof InferenceTelemetryTotalsSchema>;

export const AgentRunTelemetrySchema = z
  .object({
    runId: z.string().uuid(),
    totals: InferenceTelemetryTotalsSchema,
  })
  .strict();
export type AgentRunTelemetry = z.infer<typeof AgentRunTelemetrySchema>;

export const AgentTaskTelemetrySchema = z
  .object({
    taskId: z.string().uuid(),
    /** All implementation runs of this task. Review runs remain separately scoped. */
    totals: InferenceTelemetryTotalsSchema,
    /** Same latest-100 implementation run window as task detail.runs. */
    runs: z.array(AgentRunTelemetrySchema).max(100),
  })
  .strict();
export type AgentTaskTelemetry = z.infer<typeof AgentTaskTelemetrySchema>;
