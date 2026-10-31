import { z } from 'zod';
import { assetWorkCoordinateSchema, indexedVersionRefSchema } from '../types/asset-canon.js';
import { MediaContextAttachmentSchema } from '../types/media-context-attachment.js';
import { projectScreeningContextAttachmentSchema } from '../types/video-project-message.js';

export { MediaContextAttachmentSchema } from '../types/media-context-attachment.js';

import {
  CONTEXT_ATTACHMENT_MAX_COUNT,
  CONTEXT_ATTACHMENT_PROMPT_MAX_CHARS,
  CONTEXT_ATTACHMENT_VERSION,
  serializeContextAttachmentsPrompt,
} from '../types/context-attachment.js';

import {
  boundedId,
  boundedMetadata,
  boundedPath,
  lineNumber,
  ownerRevision,
  withValidLineRange,
} from './context-attachment-primitives.js';

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
  revision: ownerRevision.optional(),
  lineStart: lineNumber.optional(),
  lineEnd: lineNumber.optional(),
});

export * from './quote-context-attachment.schema.js';

import { QuoteContextAttachmentSchema } from './quote-context-attachment.schema.js';

export const ContextAttachmentSchema = z.union([
  z
    .object({
      v: z.literal(1),
      id: z.string().min(1).max(128),
      kind: z.literal('asset'),
      workTitle: z.string().trim().min(1).max(300).optional(),
      name: z.string().min(1).max(1000),
      mediaType: z.string().min(1).max(256),
      indexedVersionRef: indexedVersionRefSchema,
      work: assetWorkCoordinateSchema,
    })
    .strict(),
  ThreadContextAttachmentSchema,
  WorkspaceFileContextAttachmentSchema,
  QuoteContextAttachmentSchema,
  MediaContextAttachmentSchema,
  projectScreeningContextAttachmentSchema,
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

/** New Cat-authored file references must name the F063 owner revision; the base schema remains legacy-readable. */
export const VersionBoundContextAttachmentsSchema = ContextAttachmentsSchema.superRefine((attachments, ctx) => {
  for (const [index, attachment] of attachments.entries()) {
    const revision =
      attachment.kind === 'workspace_file'
        ? attachment.revision
        : attachment.kind === 'quote' && attachment.source.kind === 'workspace_file'
          ? attachment.source.revision
          : 'not-a-workspace-reference';
    if (revision === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'New workspace-file references require the exact F063 owner revision',
        path: attachment.kind === 'quote' ? [index, 'source', 'revision'] : [index, 'revision'],
      });
    }
  }
});

export const ContextAttachmentContentSchema = z
  .object({
    type: z.literal('context_attachment'),
    attachment: ContextAttachmentSchema,
  })
  .strict();
