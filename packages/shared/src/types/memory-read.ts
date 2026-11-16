import { z } from 'zod';
import { memoryCueDocumentWindowRequestSchema } from './memory-cue.js';

const id = z.string().min(1).max(200);
const version = z.string().min(1).max(300);
/** A matter's selected-segment revision is distinct from a whole message's citation revision. */
export const memoryMessageSelectionSchema = z
  .object({
    segment: z.enum(['body', 'quote_comment', 'quote_text']),
    contentBlockIndex: z.number().int().nonnegative().optional(),
    attachmentId: id.optional(),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    expectedRevision: version,
  })
  .strict();
export type MemoryMessageSelection = z.infer<typeof memoryMessageSelectionSchema>;
export const messageReadRefSchema = z
  .object({
    kind: z.literal('message'),
    messageId: id,
    contextCount: z.number().int().min(0).max(10).optional(),
    threadId: id.optional(),
    expectedRevision: version.optional(),
    sourceSelection: memoryMessageSelectionSchema.optional(),
  })
  .strict();
export const matterReadRefSchema = z
  .object({
    kind: z.literal('matter'),
    matterId: id,
    expectedRevision: z.number().int().positive().optional(),
    cursor: z.string().max(2000).optional(),
    limit: z.number().int().min(1).max(30).optional(),
    history: z.boolean().optional(),
  })
  .strict();
export const profileReadRefSchema = z
  .object({
    kind: z.literal('profile'),
    layer: z.enum(['primer', 'corpus', 'capsule']).optional(),
    expectedRevision: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    requestId: id.optional(),
  })
  .strict();
export const cueReadRefSchema = z
  .object({
    kind: z.literal('cue'),
    handle: z.string().trim().min(1).max(2000),
    clientRequestId: id.optional(),
    window: memoryCueDocumentWindowRequestSchema.optional(),
    expectedRevision: version.optional(),
  })
  .strict();
export const fileReadRefSchema = z
  .object({
    kind: z.literal('file'),
    path: z.string().min(1).max(4096),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1).optional(),
    charOffset: z.number().int().nonnegative().optional(),
    expectedRevision: version.optional(),
  })
  .strict();

/** Closed projection of existing source coordinates. Addresses never grant access. */
export const memoryReadRefSchema = z.discriminatedUnion('kind', [
  messageReadRefSchema,
  matterReadRefSchema,
  profileReadRefSchema,
  cueReadRefSchema,
  fileReadRefSchema,
]);
export type ReadRef = z.infer<typeof memoryReadRefSchema>;
export type MemoryReadContentKind = 'original_message' | 'document' | 'cat_summary' | 'approved_view' | 'mixed';
export interface MemoryReadEnvelope {
  status: 'ok' | 'source_changed' | 'not_available' | 'unsupported';
  ref: ReadRef;
  contentKind: MemoryReadContentKind;
  version?: string | number;
  data?: unknown;
  sources: ReadRef[];
  /** Thread-only provenance uses the existing thread reader/search, never a fabricated message ref. */
  sourceThreads?: Array<{ threadId: string }>;
  sourcesStatus: 'available' | 'not_provided';
  complete: boolean;
  nextRef?: ReadRef;
  retryRef?: ReadRef;
  error?: { reason: string; retryable: boolean };
}

/** Only an existing typed drill pointer is accepted; never infer a source from free prose. */
export function readRefFromDrillDown(drill: { tool: string; params?: Record<string, unknown> }): ReadRef | undefined {
  const params = drill.params ?? {};
  let candidate: unknown;
  if (drill.tool === 'cat_cafe_read_memory') candidate = params.ref;
  else if (
    drill.tool === 'cat_cafe_get_message' ||
    (drill.tool === 'cat_cafe_get_thread_context' && params.messageId)
  ) {
    const before = Number(params.before ?? 0);
    const after = Number(params.after ?? 0);
    if (drill.tool === 'cat_cafe_get_thread_context' && before !== after) return undefined;
    const contextCount = drill.tool === 'cat_cafe_get_message' ? params.contextCount : before;
    candidate = {
      kind: 'message',
      messageId: params.messageId,
      ...(params.threadId ? { threadId: params.threadId } : {}),
      ...(contextCount ? { contextCount: Number(contextCount) } : {}),
    };
  } else if (drill.tool === 'cat_cafe_read_file_slice') {
    candidate = {
      kind: 'file',
      ...Object.fromEntries(
        ['path', 'startLine', 'endLine', 'charOffset']
          .filter((key) => params[key] !== undefined)
          .map((key) => [key, key === 'path' ? params[key] : Number(params[key])]),
      ),
    };
  }
  const parsed = memoryReadRefSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}
