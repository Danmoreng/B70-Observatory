import { z } from 'zod';
export const MemoryScopeSchema = z.enum(['developer', 'workstation', 'project']);
export const MemorySourceSchema = z
  .object({
    kind: z.enum(['user', 'run', 'check', 'code']),
    ref: z.string().trim().min(1).max(512),
  })
  .strict();
export const MemoryWriteSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    content: z.string().trim().min(1).max(16000),
    scope: MemoryScopeSchema,
    projectId: z.string().uuid().optional(),
    kind: z.enum(['fact', 'procedure', 'episode']).default('fact'),
    status: z.enum(['proposed', 'confirmed', 'superseded']).default('proposed'),
    visibility: z.enum(['local', 'shared']).default('local'),
    sources: z.array(MemorySourceSchema).min(1).max(12),
    validUntil: z.string().datetime().optional(),
  })
  .strict()
  .refine(
    (v) => (v.scope === 'project') === (v.projectId !== undefined),
    'Project scope requires exactly one project'
  );
export const MemoryImageSchema = z
  .object({
    id: z.number().int().positive(),
    mimeType: z.enum(['image/png', 'image/jpeg']),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    byteLength: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    purpose: z.enum(['reference', 'bug', 'before', 'after']),
    runId: z.string().uuid(),
    sourceImageId: z.string().uuid(),
    capturedAt: z.string().datetime(),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    embedded: z.boolean(),
  })
  .strict();
export const MemoryRecordSchema = z
  .object({
    id: z.string().uuid(),
    version: z.number().int().positive(),
    title: z.string(),
    content: z.string(),
    scope: MemoryScopeSchema,
    projectId: z.string().uuid().optional(),
    machineId: z.string(),
    image: MemoryImageSchema.optional(),
    kind: z.enum(['fact', 'procedure', 'episode']),
    status: z.enum(['proposed', 'confirmed', 'superseded']),
    visibility: z.enum(['local', 'shared']),
    sources: z.array(MemorySourceSchema),
    validUntil: z.string().datetime().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    score: z.number().optional(),
  })
  .strict();
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;
export type MemoryWrite = z.infer<typeof MemoryWriteSchema>;
export const MemoryRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('status') }).strict(),
  z.object({ operation: z.literal('runImages'), runId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('image'), id: z.string().uuid() }).strict(),
  z
    .object({
      operation: z.literal('capture'),
      runId: z.string().uuid(),
      imageId: z.string().uuid(),
      title: z.string().trim().min(1).max(160),
      description: z.string().trim().min(1).max(16000),
      purpose: z.enum(['reference', 'bug', 'before', 'after']),
    })
    .strict(),
  z
    .object({
      operation: z.literal('list'),
      projectId: z.string().uuid().optional(),
      scope: MemoryScopeSchema.optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('search'),
      query: z.string().trim().min(1).max(2000),
      projectId: z.string().uuid().optional(),
      includeEpisodes: z.boolean().optional(),
      limit: z.number().int().min(1).max(30).optional(),
    })
    .strict(),
  z.object({ operation: z.literal('create'), entry: MemoryWriteSchema }).strict(),
  z
    .object({
      operation: z.literal('update'),
      id: z.string().uuid(),
      version: z.number().int().positive(),
      entry: MemoryWriteSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('remove'),
      id: z.string().uuid(),
      version: z.number().int().positive(),
    })
    .strict(),
  z.object({ operation: z.literal('history'), id: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('evidence'), id: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('ingest'), runId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('maintenance') }).strict(),
  z.object({ operation: z.literal('distill'), runId: z.string().uuid() }).strict(),
]);
export type MemoryRequest = z.infer<typeof MemoryRequestSchema>;
export const MemoryResponseSchema = z
  .object({
    enabled: z.boolean(),
    image: z.object({ mimeType: z.string(), data: z.string() }).strict().optional(),
    runImages: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            runId: z.string().uuid(),
            mimeType: z.string(),
            width: z.number(),
            height: z.number(),
            byteLength: z.number(),
            label: z.string().optional(),
          })
          .strict()
      )
      .optional(),
    items: z.array(MemoryRecordSchema).optional(),
    item: MemoryRecordSchema.optional(),
    removed: z.boolean().optional(),
    evidence: z
      .array(
        z
          .object({
            kind: z.string(),
            ref: z.string(),
            text: z.string().optional(),
            taskId: z.string().uuid().optional(),
            runId: z.string().uuid().optional(),
          })
          .strict()
      )
      .optional(),
    imported: z.number().int().optional(),
    distillation: z.object({ created: z.number().int(), requestId: z.string().uuid() }).optional(),
    status: z
      .object({
        records: z.number().int(),
        proposed: z.number().int(),
        confirmed: z.number().int(),
        episodes: z.number().int(),
        embedded: z.number().int(),
        chunks: z.number().int(),
        model: z.string(),
        dimensions: z.number().int(),
        backend: z.literal('cpu'),
        semanticReady: z.boolean(),
        indexing: z.boolean(),
        images: z.number().int().optional(),
        embeddedImages: z.number().int().optional(),
        visionReady: z.boolean().optional(),
        error: z.string().optional(),
      })
      .optional(),
    warning: z.string().optional(),
    maintenance: z
      .object({
        duplicateGroups: z.array(z.array(z.string().uuid())),
        expired: z.array(z.string().uuid()),
      })
      .optional(),
  })
  .strict();
export type MemoryResponse = z.infer<typeof MemoryResponseSchema>;
