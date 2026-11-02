import { z } from 'zod';
import {
  CONTEXT_ATTACHMENT_COMMENT_MAX_LENGTH,
  CONTEXT_ATTACHMENT_QUOTE_MAX_LENGTH,
  CONTEXT_ATTACHMENT_VERSION,
} from '../types/context-attachment-limits.js';
import { messageMediaItemSelectorSchema } from '../types/message-media-item-selector.js';
import {
  boundedId,
  boundedMetadata,
  boundedPath,
  characterOffset,
  lineNumber,
  ownerRevision,
  withValidLineRange,
} from './context-attachment-primitives.js';

export const MessageQuoteSourceSchema = z
  .object({
    kind: z.literal('message'),
    threadId: boundedId,
    messageId: boundedId,
    senderCatId: boundedId.optional(),
    displayLabel: boundedMetadata.optional(),
    artifactFile: z
      .object({
        item: messageMediaItemSelectorSchema,
        url: z.string().min(1).max(2048),
        fileName: boundedMetadata,
        messageRevision: z.string().max(64).regex(/^\d+$/),
        displayDigest: ownerRevision,
      })
      .strict()
      .optional(),
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
  revision: ownerRevision.optional(),
  language: z.string().trim().min(1).max(100).optional(),
  lineStart: lineNumber.optional(),
  lineEnd: lineNumber.optional(),
});

export const CollectiveMessageQuoteSourceSchema = z
  .object({
    kind: z.literal('collective_message'),
    serviceInstanceId: z.string().regex(/^svc_[A-Za-z0-9_-]{8,150}$/),
    collectiveId: z.string().regex(/^col_[A-Za-z0-9_-]{8,150}$/),
    channelId: z.string().trim().min(1).max(160),
    eventId: z.string().regex(/^evt_[A-Za-z0-9_-]{8,150}$/),
  })
  .strict();

export const QuoteContextSourceSchema = z.union([
  MessageQuoteSourceSchema,
  CliOutputQuoteSourceSchema,
  WorkspaceFileQuoteSourceSchema,
  CollectiveMessageQuoteSourceSchema,
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
