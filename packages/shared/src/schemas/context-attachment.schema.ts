import { z } from 'zod';
import {
  CONTEXT_ATTACHMENT_COMMENT_MAX_LENGTH,
  CONTEXT_ATTACHMENT_MAX_COUNT,
  CONTEXT_ATTACHMENT_PROMPT_MAX_CHARS,
  CONTEXT_ATTACHMENT_QUOTE_MAX_LENGTH,
  CONTEXT_ATTACHMENT_VERSION,
  serializeContextAttachmentsPrompt,
} from '../types/context-attachment.js';

const boundedId = z.string().trim().min(1).max(128);
const boundedPath = z.string().trim().min(1).max(4096);
const boundedMetadata = z.string().trim().min(1).max(512);
const lineNumber = z.number().int().positive().max(10_000_000);
const characterOffset = z.number().int().nonnegative().max(10_000_000);

function withValidLineRange<T extends z.ZodRawShape>(shape: T) {
  return z
    .object(shape)
    .strict()
    .refine(
      (value) => value.lineStart === undefined || value.lineEnd === undefined || value.lineEnd >= value.lineStart,
      {
        message: 'lineEnd must be greater than or equal to lineStart',
        path: ['lineEnd'],
      },
    );
}

export const ThreadContextAttachmentSchema = z
  .object({
    v: z.literal(CONTEXT_ATTACHMENT_VERSION),
    id: boundedId,
    kind: z.literal('thread'),
    threadId: boundedId,
    title: z.string().trim().min(1).max(500),
  })
  .strict();

export const WorkspaceFileContextAttachmentSchema = withValidLineRange({
  v: z.literal(CONTEXT_ATTACHMENT_VERSION),
  id: boundedId,
  kind: z.literal('workspace_file'),
  path: boundedPath,
  worktreeId: boundedMetadata.optional(),
  branch: boundedMetadata.optional(),
  lineStart: lineNumber.optional(),
  lineEnd: lineNumber.optional(),
});

export const MessageQuoteSourceSchema = z
  .object({
    kind: z.literal('message'),
    threadId: boundedId,
    messageId: boundedId,
    senderCatId: boundedId.optional(),
  })
  .strict();

export const CliOutputQuoteSourceSchema = z
  .object({
    kind: z.literal('cli_output'),
    threadId: boundedId,
    messageId: boundedId,
    segmentId: boundedMetadata.optional(),
  })
  .strict();

export const WorkspaceFileQuoteSourceSchema = withValidLineRange({
  kind: z.literal('workspace_file'),
  path: boundedPath,
  worktreeId: boundedMetadata.optional(),
  branch: boundedMetadata.optional(),
  language: z.string().trim().min(1).max(100).optional(),
  lineStart: lineNumber.optional(),
  lineEnd: lineNumber.optional(),
});

export const QuoteContextSourceSchema = z.union([
  MessageQuoteSourceSchema,
  CliOutputQuoteSourceSchema,
  WorkspaceFileQuoteSourceSchema,
]);

export const QuoteContextAttachmentSchema = z
  .object({
    v: z.literal(CONTEXT_ATTACHMENT_VERSION),
    id: boundedId,
    kind: z.literal('quote'),
    text: z.string().min(1).max(CONTEXT_ATTACHMENT_QUOTE_MAX_LENGTH),
    comment: z.string().trim().min(1).max(CONTEXT_ATTACHMENT_COMMENT_MAX_LENGTH).optional(),
    selectionStart: characterOffset.optional(),
    selectionEnd: characterOffset.optional(),
    source: QuoteContextSourceSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasStart = value.selectionStart !== undefined;
    const hasEnd = value.selectionEnd !== undefined;
    if (hasStart !== hasEnd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'selectionStart and selectionEnd must be provided together',
        path: hasStart ? ['selectionEnd'] : ['selectionStart'],
      });
      return;
    }
    if (
      value.selectionStart !== undefined &&
      value.selectionEnd !== undefined &&
      value.selectionEnd <= value.selectionStart
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'selectionEnd must be greater than selectionStart',
        path: ['selectionEnd'],
      });
    }
    if (value.source.kind === 'cli_output') {
      const hasSegment = value.source.segmentId !== undefined;
      if (hasStart && !hasSegment) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'CLI Output selection coordinates require a stable segmentId',
          path: ['source', 'segmentId'],
        });
      } else if (!hasStart && hasSegment) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'CLI Output segmentId requires selection coordinates',
          path: ['selectionStart'],
        });
      }
    }
  });

export const ContextAttachmentSchema = z.union([
  ThreadContextAttachmentSchema,
  WorkspaceFileContextAttachmentSchema,
  QuoteContextAttachmentSchema,
]);

export const ContextAttachmentsSchema = z
  .array(ContextAttachmentSchema)
  .max(CONTEXT_ATTACHMENT_MAX_COUNT)
  .superRefine((attachments, ctx) => {
    const projectedLength = serializeContextAttachmentsPrompt(attachments).length;
    if (projectedLength > CONTEXT_ATTACHMENT_PROMPT_MAX_CHARS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Context attachment prompt exceeds ${CONTEXT_ATTACHMENT_PROMPT_MAX_CHARS} characters`,
      });
    }
  });

export const ContextAttachmentContentSchema = z
  .object({
    type: z.literal('context_attachment'),
    attachment: ContextAttachmentSchema,
  })
  .strict();
