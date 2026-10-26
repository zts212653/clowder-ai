import { z } from 'zod';
import { collectiveRecipientSchema } from './collective.js';
import { collectiveArtifactSelectionSchema } from './collective-artifact.js';
import { collectiveModificationReworkSchema } from './collective-content-modification.js';
import { collectiveMessageAttachmentSchema } from './collective-message-content.js';

const id = z.string().trim().min(1).max(200);
const artifactIdentity = z.object({ artifactId: id, ownerRevision: z.number().int().positive(), blobDigest: id });
export const collectiveComposerDraftSchema = z
  .object({
    body: z.string().max(32_000),
    recipient: collectiveRecipientSchema,
    recipientLabel: z.string().max(240),
    attachments: z.array(collectiveMessageAttachmentSchema).max(12).optional(),
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
  .strict();
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
