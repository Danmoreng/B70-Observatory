import { z } from 'zod';

export const MAX_LIVE_CHANGE_FILES = 500;
export const MAX_LIVE_DIFF_BYTES = 262_144;
export const LIVE_CHANGES_POLL_MS = 5 * 60 * 1_000;

export const AgentLiveChangeFileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (path) => !path.startsWith('/') && !path.includes('\0') && !path.split('/').includes('..')
      ),
    status: z.enum(['added', 'modified', 'deleted', 'untracked', 'type_changed', 'unknown']),
  })
  .strict();

/** A read-only, bounded preview. It is never an approvable run result. */
export const AgentLiveChangesSchema = z
  .object({
    taskId: z.string().uuid(),
    runId: z.string().uuid(),
    /** Last successful capture; for unavailable/empty responses, time of the failed attempt. */
    capturedAt: z
      .string()
      .datetime()
      .refine((value) => {
        const instant = new Date(value);
        return Number.isFinite(instant.getTime()) && instant.toISOString() === value;
      }, 'Timestamp must be canonical UTC.'),
    status: z.enum(['live', 'complete', 'unavailable']),
    stale: z.boolean(),
    truncated: z.boolean(),
    files: z.array(AgentLiveChangeFileSchema).max(MAX_LIVE_CHANGE_FILES),
    diff: z
      .string()
      .max(MAX_LIVE_DIFF_BYTES)
      .refine(
        (value) => new TextEncoder().encode(value).length <= MAX_LIVE_DIFF_BYTES,
        'Diff exceeds UTF-8 byte budget.'
      ),
    message: z.string().max(512).optional(),
  })
  .strict();

export const AgentLiveChangesQuerySchema = z
  .object({ runId: z.string().uuid().optional(), refresh: z.literal('1').optional() })
  .strict();
export type AgentLiveChanges = z.infer<typeof AgentLiveChangesSchema>;
export type AgentLiveChangeFile = z.infer<typeof AgentLiveChangeFileSchema>;
