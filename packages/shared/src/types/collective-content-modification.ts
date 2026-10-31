import { z } from 'zod';
import { collectiveLocationSchema } from './collective.js';
import { respondContentTextSchema } from './content-modification.js';

const id = z.string().trim().min(1).max(256);
const positive = z.number().int().positive().safe();
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** The old candidate remains historical context; its quote positions never become positions in the new version. */
export const collectiveModificationReworkSchema = z.object({ requestId: id, proposalRef: id }).strict();
export const collectiveModificationResolutionSchema = z
  .object({
    kind: z.enum(['cancelled', 'rejected']),
    operationId: id,
    actorHumanId: id,
    expectedRequestRevision: positive,
    proposalRef: id.optional(),
    receiptRef: id,
    resolvedAt: z.number().int().nonnegative().safe(),
  })
  .strict();
/** References only: the existing owner manifest and F309 ledger retain all source text and selections. */
export const collectiveModificationSourceSchema = z
  .object({
    scopeRef: id,
    serviceInstanceId: id,
    collectiveId: id,
    artifactId: id,
    contentRef: id,
    ownerRevision: positive,
    blobDigest: digest,
    ledgerRef: id,
    ledgerRevision: positive,
    sourceEventId: id,
    requestEventId: id,
    location: collectiveLocationSchema,
    rework: collectiveModificationReworkSchema.optional(),
  })
  .strict();
export const collectiveModificationTargetSchema = z
  .object({
    humanId: id,
    catId: id,
    connectionId: id,
    participationRevision: positive,
  })
  .strict();
export const collectiveModificationIntentSchema = z
  .object({
    ownerUserId: id,
    requestingHumanId: id,
    source: collectiveModificationSourceSchema,
    target: collectiveModificationTargetSchema,
    instruction: z.string().trim().min(1).max(8000),
    annotationIds: z.array(id).min(1).max(12),
  })
  .strict();
/** This owner-private journal record is never a Human Client projection. */
export const collectiveModificationRecordSchema = collectiveModificationIntentSchema
  .extend({
    v: z.literal(1),
    kind: z.literal('collective-artifact'),
    requestId: z.string().regex(/^f309-modification-[a-f0-9]{64}$/),
    revision: positive,
    state: z.enum(['requested', 'running', 'proposal_ready', 'cancelled', 'accepted', 'conflict', 'unavailable']),
    resolution: collectiveModificationResolutionSchema.optional(),
    transferOutcome: z
      .object({ reason: z.literal('custody_transferred'), transferId: id, sourceCustodyRevision: positive })
      .strict()
      .optional(),
    execution: z.object({ invocationId: id, threadId: id }).strict().optional(),
    createdAt: z.number().int().nonnegative().safe(),
    updatedAt: z.number().int().nonnegative().safe(),
  })
  .strict();
export type CollectiveModificationIntent = z.infer<typeof collectiveModificationIntentSchema>;
export type CollectiveModificationRecord = z.infer<typeof collectiveModificationRecordSchema>;
/** Public owner journal projection. Host execution, owner identity and endpoint authority remain private. */
export const collectiveModificationProjectionSchema = collectiveModificationRecordSchema
  .pick({
    requestId: true,
    revision: true,
    state: true,
    requestingHumanId: true,
    annotationIds: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    target: z.object({ humanId: id, catId: id }).strict(),
    ownerRevision: positive,
    blobDigest: digest,
    requestEventId: id,
    sourceEventId: id,
    location: collectiveLocationSchema,
    latestProposalRevision: z.number().int().nonnegative().optional(),
    latestProposalRef: id.optional(),
    unavailableReason: z.literal('custody_transferred').optional(),
    resolution: collectiveModificationResolutionSchema
      .omit({ operationId: true, expectedRequestRevision: true })
      .optional(),
    rework: collectiveModificationReworkSchema.optional(),
  })
  .strict();
export type CollectiveModificationProjection = z.infer<typeof collectiveModificationProjectionSchema>;
/** The shared content owner version replaces the private Task revision at this boundary. */
export const respondCollectiveContentTextSchema = respondContentTextSchema
  .omit({ expectedTaskRevision: true })
  .extend({
    expectedOwnerRevision: positive,
  })
  .strict();
export type RespondCollectiveContentText = z.infer<typeof respondCollectiveContentTextSchema>;

/** Submit acknowledgement only. The exact edits remain in the owner and are read through the paged preview. */
export const collectiveContentTextProposalReceiptSchema = z
  .object({
    proposalRef: id,
    requestId: id,
    revision: positive,
    operationId: z.string().uuid(),
    baseRevision: digest,
    resultRevision: digest,
    authorCatId: id,
    createdAt: z.number().int().nonnegative().safe(),
    receiptRef: id,
  })
  .strict();
export type CollectiveContentTextProposalReceipt = z.infer<typeof collectiveContentTextProposalReceiptSchema>;
