import {
  messageSearchAnswerAttachmentSchema,
  messageSearchAnswerRefSchema,
  selectedMessageSourcesSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import type { callbackPost } from './callback-tools.js';
import { errorResult, type ToolResult } from './file-tools.js';
import { messageSearchParams } from './message-search-transport.js';

/** Author input, never a renderable RichBlock or a caller-created Host binding. */
const sourceFields = {
  query: z.string().trim().min(1).max(2000).describe('Question or short label for the original sources in this reply.'),
  selections: selectedMessageSourcesSchema
    .optional()
    .describe(
      'Required for a new card: selected originals, their contentRevision from a full read, exact quote and your reason. Repeated text needs part/range in UTF-16 units. Omit only to retry an existing legacy query-only operation.',
    ),
  // Historical saved operations keep their original request digest on retry.
  retrievalMode: z.enum(['lexical', 'semantic', 'hybrid']).optional(),
  messageSort: z
    .enum(['time', 'relevance'])
    .optional()
    .describe('Original request identity for saved-operation retries; does not reorder new selections.'),
  threadId: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
};
export const sourceReplyDraftSchema = z
  .object({
    ...sourceFields,
    operationId: z.string().min(1).max(200).optional(),
  })
  .strict();
export const sourceReplyInputSchema = z.union([messageSearchAnswerAttachmentSchema, sourceReplyDraftSchema]);
export type SourceReplyInput = z.infer<typeof sourceReplyInputSchema>;
export const sourceCardRequestSchema = z
  .object({
    kind: z.literal('sources'),
    v: z.literal(1),
    id: z.string().min(1).max(200),
    ...sourceFields,
  })
  .strict();

/** Uses the existing authenticated write route: no text fallback, new store, or second publisher. */
export async function prepareSourceReply(
  input: z.infer<typeof sourceReplyDraftSchema>,
  scope: { operationId: string; destinationThreadId?: string; replyTo?: string; agentKeyCatId?: string },
  post: typeof callbackPost,
): Promise<{ ok: true; publicationRef: string; result: ToolResult } | { ok: false; result: ToolResult }> {
  const parsed = sourceReplyDraftSchema.safeParse(input);
  if (!parsed.success) return { ok: false, result: errorResult(`Invalid selected sources: ${parsed.error.message}`) };
  const result = await post(
    '/api/callbacks/search-evidence/answer',
    {
      // Keep the exact historical request identity. This POST never performs ordinary recall.
      ...messageSearchParams({
        ...parsed.data,
        mode: parsed.data.retrievalMode,
        messageSort: parsed.data.messageSort ?? 'time',
      }),
      operationId: parsed.data.operationId ?? scope.operationId,
      ...(scope.destinationThreadId ? { destinationThreadId: scope.destinationThreadId } : {}),
      ...(scope.replyTo ? { replyTo: scope.replyTo } : {}),
      ...(parsed.data.selections ? { selections: parsed.data.selections } : {}),
    },
    { agentKeyCatId: scope.agentKeyCatId, retryDelaysMs: [], enableOutbox: false },
  );
  if (result.isError) return { ok: false, result };
  const text = result.content.find((item) => item.type === 'text')?.text;
  let receipt: unknown;
  try {
    receipt = JSON.parse(text ?? '');
  } catch {
    receipt = null;
  }
  const prepared = z
    .object({
      status: z.enum(['prepared', 'published']),
      publicationRef: messageSearchAnswerRefSchema,
    })
    .safeParse(receipt);
  if (!prepared.success)
    return {
      ok: false,
      result: errorResult(
        `Source card preparation did not produce an attachable result. Retry the same operation and selections. ${text ?? ''}`,
      ),
    };
  return { ok: true, publicationRef: prepared.data.publicationRef, result };
}
