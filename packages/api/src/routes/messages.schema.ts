/**
 * Messages API Schemas
 * Zod schemas for message-related API validation.
 * Extracted from parse-multipart.ts for better organization.
 */

import { catIdSchema } from '@cat-cafe/shared';
import { z } from 'zod';

/**
 * Schema for POST /api/messages request body.
 * Used for both JSON and multipart form data validation.
 */
export const sendMessageSchema = z
  .object({
    content: z.string().min(1).max(100000),
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
  })
  .refine((data) => data.visibility !== 'whisper' || (data.whisperTo && data.whisperTo.length > 0), {
    message: 'whisperTo must be non-empty when visibility is whisper',
    path: ['whisperTo'],
  });

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
