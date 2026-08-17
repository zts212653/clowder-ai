/**
 * Messages API Schemas
 * Zod schemas for message-related API validation.
 * Extracted from parse-multipart.ts for better organization.
 */

import {
  type ContextAttachment,
  ContextAttachmentsSchema,
  catIdSchema,
  type FileContent,
  type ImageContent,
  MESSAGE_BUNDLE_MAX_ITEMS,
  MessageBundleSelectionItemSchema,
  type MessageContent,
} from '@cat-cafe/shared';
import { z } from 'zod';

const boundedBundleId = z.string().trim().min(1).max(128);
const MESSAGE_BUNDLE_MAX_TARGET_CATS = 10;

export const messageBundleForwardSchema = z
  .object({
    sourceThreadId: boundedBundleId,
    items: z.array(MessageBundleSelectionItemSchema).min(1).max(MESSAGE_BUNDLE_MAX_ITEMS),
    // Shape validation lives here; AgentRouter is the runtime source of truth for
    // whether every requested cat exists and is currently routable.
    targetCats: z.array(boundedBundleId).min(1).max(MESSAGE_BUNDLE_MAX_TARGET_CATS),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    const seenMessageIds = new Set<string>();
    bundle.items.forEach((item, index) => {
      if (seenMessageIds.has(item.messageId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'messageId'],
          message: 'Message Bundle items must have unique messageId values',
        });
      }
      seenMessageIds.add(item.messageId);
    });

    const seenCats = new Set<string>();
    bundle.targetCats.forEach((catId, index) => {
      if (seenCats.has(catId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['targetCats', index],
          message: 'Message Bundle targetCats must be unique',
        });
      }
      seenCats.add(catId);
    });
  });

const requestContextAttachmentsSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}, ContextAttachmentsSchema.optional());

/**
 * Schema for POST /api/messages request body.
 * Used for both JSON and multipart form data validation.
 */
export const sendMessageSchema = z
  .object({
    content: z.string().max(100000),
    contextAttachments: requestContextAttachmentsSchema,
    /** Legacy fallback only; preferred identity source is X-Cat-Cafe-User header. */
    userId: z.string().min(1).max(100).optional(),
    mentions: z.array(catIdSchema()).optional(),
    threadId: z.string().min(1).max(100).optional(),
    /** Client-provided idempotency key (UUID). Optional — server generates one if absent. */
    idempotencyKey: z.string().uuid().optional(),
    /** F35: Message visibility. Default 'public'. 'whisper' requires whisperTo. */
    visibility: z.enum(['public', 'whisper']).optional(),
    /** F35: Whisper recipients. Required when visibility='whisper'. */
    whisperTo: z.array(catIdSchema()).optional(),
    /** F39: Delivery mode. undefined = smart default (queue when active, immediate otherwise). */
    deliveryMode: z.enum(['immediate', 'queue', 'force']).optional(),
    /** F264: author-declared work disposition. Missing is server-default next_work. */
    messageDisposition: z.enum(['continue_current', 'next_work']).optional(),
    /** #699: ID of message being replied to (quote). */
    replyTo: z.string().min(1).max(100).optional(),
    /** F294: transient selection plus exact cats; server persists only the canonical refs-only carrier. */
    messageBundle: messageBundleForwardSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (
      data.content.trim().length === 0 &&
      (data.contextAttachments?.length ?? 0) === 0 &&
      data.messageBundle === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'content, contextAttachments, or messageBundle must be non-empty',
        path: ['content'],
      });
    }
    if (data.visibility === 'whisper' && (!data.whisperTo || data.whisperTo.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'whisperTo must be non-empty when visibility is whisper',
        path: ['whisperTo'],
      });
    }
    if (!data.messageBundle) return;

    const incompatible: Array<[boolean, keyof typeof data, string]> = [
      [data.content.trim().length > 0, 'content', 'messageBundle cannot include client-authored content'],
      [
        (data.contextAttachments?.length ?? 0) > 0,
        'contextAttachments',
        'messageBundle cannot include contextAttachments',
      ],
      [(data.mentions?.length ?? 0) > 0, 'mentions', 'messageBundle routes only through targetCats'],
      [data.visibility === 'whisper', 'visibility', 'messageBundle cannot be a whisper'],
      [(data.whisperTo?.length ?? 0) > 0, 'whisperTo', 'messageBundle cannot include whisperTo'],
      [data.replyTo !== undefined, 'replyTo', 'messageBundle cannot include replyTo'],
    ];
    for (const [invalid, path, message] of incompatible) {
      if (invalid) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    }
    if (!data.threadId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['threadId'],
        message: 'messageBundle requires an explicit target threadId',
      });
    } else if (data.threadId === data.messageBundle.sourceThreadId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['threadId'],
        message: 'messageBundle target thread must differ from sourceThreadId',
      });
    }
  });

export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export function buildMessageContentBlocks(
  content: string,
  contextAttachments: readonly ContextAttachment[] = [],
  uploadedContent: readonly (ImageContent | FileContent)[] = [],
): MessageContent[] {
  const blocks: MessageContent[] = [];
  if (content.length > 0) blocks.push({ type: 'text', text: content });
  for (const attachment of contextAttachments) {
    blocks.push({ type: 'context_attachment', attachment });
  }
  blocks.push(...uploadedContent);
  return blocks;
}
