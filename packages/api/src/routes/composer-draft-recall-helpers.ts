import {
  CONTEXT_ATTACHMENT_MAX_COUNT,
  ContextAttachmentContentSchema,
  ContextAttachmentsSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import type { QueueEntry } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';

const composerDraftImageBlockSchema = z
  .object({
    type: z.literal('image'),
    url: z
      .string()
      .max(2_048)
      .refine(
        (url) =>
          /^\/uploads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(url) &&
          !url.split('/').some((segment) => segment === '.' || segment === '..'),
        'Draft images must reference a canonical uploaded asset',
      ),
    alt: z.string().max(500).optional(),
  })
  .strict();

const composerDraftContentBlocksSchema = z
  .array(z.union([composerDraftImageBlockSchema, ContextAttachmentContentSchema]))
  .max(5 + CONTEXT_ATTACHMENT_MAX_COUNT)
  .superRefine((blocks, ctx) => {
    if (blocks.filter((block) => block.type === 'image').length > 5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Composer drafts support at most 5 images',
      });
    }
    const attachments = blocks.flatMap((block) => (block.type === 'context_attachment' ? [block.attachment] : []));
    if (!ContextAttachmentsSchema.safeParse(attachments).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Composer draft context attachments violate the shared aggregate contract',
      });
    }
  });

export const composerDraftPutSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    text: z.string().max(100_000),
    contentBlocks: composerDraftContentBlocksSchema.optional(),
    replyTo: z.string().min(1).max(100).optional(),
  })
  .strict();

export const composerDraftClearSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
});

export const recallBodySchema = z.object({
  threadId: z.string().min(1).max(100),
  expectedDraftRevision: z.number().int().nonnegative(),
  merge: z.enum(['replace', 'append']),
});

export function projectRecallMessage(message: Awaited<ReturnType<IMessageStore['getById']>> & object) {
  return {
    id: message.id,
    threadId: message.threadId,
    deliveryStatus: message.deliveryStatus,
    recall: message.recall,
    queueCustody: message.queueCustody,
    _tombstone: message._tombstone,
  };
}

export function queueEntryMessageIds(entry: Pick<QueueEntry, 'messageId' | 'mergedMessageIds'>): string[] {
  return [entry.messageId ?? '', ...entry.mergedMessageIds].filter(Boolean);
}

export function rebuildCarrierWithout(
  removed: QueueEntry,
  recalledMessageId: string,
  storedMembers: ReadonlyMap<string, { id: string; content: string }>,
): QueueEntry | null {
  const remaining = queueEntryMessageIds(removed)
    .filter((messageId) => messageId !== recalledMessageId)
    .map((messageId) => storedMembers.get(messageId))
    .filter((message): message is { id: string; content: string } => Boolean(message));
  const primary = remaining[0];
  if (!primary) return null;
  return {
    ...removed,
    content: remaining.map((message) => message.content).join('\n\n'),
    messageId: primary.id,
    mergedMessageIds: remaining.slice(1).map((message) => message.id),
  };
}
