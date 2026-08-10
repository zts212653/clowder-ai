/**
 * Message Zod Schemas
 * 用于运行时验证的 Zod schemas
 */

import { z } from 'zod';
import { catIdSchema } from '../registry/cat-id-schema.js';
import { ContextAttachmentContentSchema, ContextAttachmentsSchema } from './context-attachment.schema.js';

/**
 * Message sender schema - discriminated union
 *
 * Note: catId uses z.string().refine() (via catIdSchema) instead of z.enum()
 * because route modules are imported before the registry is populated.
 * z.string().refine() defers validation to request time.
 *
 * Consequence: discriminatedUnion requires z.literal or z.enum for the
 * discriminator. Since we're inside a discriminated union on 'type',
 * catId validation happens at the field level, not the discriminator.
 */
export const MessageSenderSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('user'),
    userId: z.string().min(1),
  }),
  z.object({
    type: z.literal('cat'),
    catId: catIdSchema(),
  }),
]);

/**
 * Text content schema
 */
export const TextContentSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const MessageAssetUrlSchema = z.union([
  z.string().url(),
  z
    .string()
    .max(4096)
    .regex(
      /^\/uploads\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/,
      'Expected an absolute URL or canonical /uploads/ path',
    ),
]);

/**
 * Image content schema
 */
export const ImageContentSchema = z.object({
  type: z.literal('image'),
  url: MessageAssetUrlSchema,
  alt: z.string().optional(),
});

/**
 * File content schema — generic file attachments
 */
export const FileContentSchema = z.object({
  type: z.literal('file'),
  url: MessageAssetUrlSchema,
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  fileSize: z.number().int().nonnegative(),
});

/**
 * Code content schema
 */
export const CodeContentSchema = z.object({
  type: z.literal('code'),
  code: z.string(),
  language: z.string().optional(),
  filename: z.string().optional(),
});

/**
 * Tool call content schema
 */
export const ToolCallContentSchema = z.object({
  type: z.literal('tool_call'),
  toolName: z.string().min(1),
  toolId: z.string().min(1),
  input: z.record(z.unknown()),
});

/**
 * Tool result content schema
 */
export const ToolResultContentSchema = z.object({
  type: z.literal('tool_result'),
  toolId: z.string().min(1),
  result: z.unknown(),
  isError: z.boolean().optional(),
});

/**
 * Message content schema - discriminated union
 */
export const MessageContentSchema = z.discriminatedUnion('type', [
  TextContentSchema,
  ImageContentSchema,
  FileContentSchema,
  CodeContentSchema,
  ToolCallContentSchema,
  ToolResultContentSchema,
  ContextAttachmentContentSchema,
]);

/**
 * Collection-level message contract. Individual variants remain independently
 * parseable, while every durable/request content array shares aggregate
 * ContextAttachment count and prompt-budget invariants.
 */
export const MessageContentsSchema = z.array(MessageContentSchema).superRefine((contents, ctx) => {
  const attachments = contents
    .filter((content) => content.type === 'context_attachment')
    .map((content) => content.attachment);
  const result = ContextAttachmentsSchema.safeParse(attachments);
  if (!result.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Message content attachments violate the shared aggregate contract',
    });
  }
});

/**
 * Message status schema
 */
export const MessageStatusSchema = z.enum(['pending', 'streaming', 'complete', 'error']);

/**
 * Complete message schema
 */
export const MessageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  sender: MessageSenderSchema,
  content: MessageContentsSchema,
  status: MessageStatusSchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * Send message request schema
 */
export const SendMessageRequestSchema = z.object({
  threadId: z.string().min(1),
  content: MessageContentsSchema.refine((content) => content.length > 0, 'Message content must not be empty'),
  targetCatId: catIdSchema().optional(),
});

/**
 * Inferred type from schema
 */
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;
