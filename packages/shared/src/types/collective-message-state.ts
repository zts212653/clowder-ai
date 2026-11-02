import { z } from 'zod';
import { collectiveRecipientSchema } from './collective.js';
import { collectiveArtifactSelectionSchema } from './collective-artifact.js';
import { collectiveModificationReworkSchema } from './collective-content-modification.js';
import {
  collectiveMessageAttachmentSchema,
  collectiveMessageQuoteSchema,
  validateCollectiveRichContent,
} from './collective-message-content.js';
import { collectiveMessageRichBlockSchema } from './collective-message-rich.js';

const id = z.string().trim().min(1).max(200);
const artifactIdentity = z.object({ artifactId: id, ownerRevision: z.number().int().positive(), blobDigest: id });
/** Private state only. Original recording bytes stay in this person's durable device cache. */
export const collectiveComposerVoiceDraftSchema = z
  .object({
    captureId: id,
    state: z.enum(['recording', 'transcribing', 'failed', 'ready']),
    transcript: z.string().max(32_000).optional(),
    applied: z.boolean(),
  })
  .strict();
export type CollectiveComposerVoiceDraft = z.infer<typeof collectiveComposerVoiceDraftSchema>;
/** Incomplete authoring belongs to this private draft, never to a public event. */
export const collectiveComposerRichEditorSchema = z
  .object({
    kind: z.enum(['checklist', 'interactive', 'html_widget', 'diff']),
    title: z.string().max(240),
    source: z.string().max(48_000),
  })
  .strict();
export type CollectiveComposerRichEditor = z.infer<typeof collectiveComposerRichEditorSchema>;
export const collectiveComposerDraftSchema = z
  .object({
    body: z.string().max(32_000),
    recipient: collectiveRecipientSchema,
    recipientLabel: z.string().max(240),
    attachments: z.array(collectiveMessageAttachmentSchema).max(12).optional(),
    contextAttachments: z.array(collectiveMessageQuoteSchema).max(12).optional(),
    richBlocks: z.array(collectiveMessageRichBlockSchema).max(12).optional(),
    richEditor: collectiveComposerRichEditorSchema.optional(),
    voiceDraft: collectiveComposerVoiceDraftSchema.optional(),
    entrust: z.boolean().optional(),
    responseRequested: z.boolean().optional(),
    replyToEventId: id.optional(),
    replyNeedsSelection: z.boolean().optional(),
    artifactSelections: z
      .array(artifactIdentity.extend({ span: collectiveArtifactSelectionSchema }).strict())
      .max(12)
      .optional(),
    artifactRework: artifactIdentity
      .extend({ sourceOwnerRevision: z.number().int().positive(), rework: collectiveModificationReworkSchema })
      .strict()
      .optional(),
    artifactReply: artifactIdentity
      .extend({ annotationId: id, messageEventId: id, authorHumanId: id })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((content, context) => {
    validateCollectiveRichContent(content, context);
    if (new TextEncoder().encode(JSON.stringify(content)).length > 192 * 1024)
      context.addIssue({ code: 'custom', message: 'Private draft exceeds 192 KiB' });
  });
export type CollectiveComposerDraft = z.infer<typeof collectiveComposerDraftSchema>;
export const collectiveHumanChannelCoordinatesSchema = z
  .object({
    serviceInstanceId: id,
    collectiveId: id,
    channelId: id,
    rootEventId: id.optional(),
  })
  .strict();
export const collectiveSaveComposerDraftSchema = collectiveHumanChannelCoordinatesSchema
  .extend({
    expectedRevision: z.number().int().nonnegative().safe(),
    clientOperationId: id,
    content: collectiveComposerDraftSchema,
  })
  .strict();
export const collectiveDraftRecordSchema = collectiveHumanChannelCoordinatesSchema
  .extend({
    humanId: id,
    revision: z.number().int().nonnegative().safe(),
    content: collectiveComposerDraftSchema,
    clientOperationId: z.string().trim().min(1).max(205).optional(),
  })
  .strict();
export const collectiveReadPositionSchema = z
  .object({
    sequence: z.number().int().nonnegative().safe(),
    eventId: id.optional(),
  })
  .strict();
export const collectiveHumanChannelStateSchema = z
  .object({
    draft: collectiveDraftRecordSchema,
    read: collectiveReadPositionSchema,
    unreadCount: z.number().int().nonnegative().safe(),
  })
  .strict();
export const collectiveSaveDraftResultSchema = z
  .object({
    status: z.enum(['stored', 'conflict']),
    draft: collectiveDraftRecordSchema,
  })
  .strict();
