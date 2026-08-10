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
  type MessageContent,
} from '@cat-cafe/shared';
import { z } from 'zod';

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
  })
  .refine((data) => data.content.trim().length > 0 || (data.contextAttachments?.length ?? 0) > 0, {
    message: 'content or contextAttachments must be non-empty',
    path: ['content'],
  })
  .refine((data) => data.visibility !== 'whisper' || (data.whisperTo && data.whisperTo.length > 0), {
    message: 'whisperTo must be non-empty when visibility is whisper',
    path: ['whisperTo'],
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
