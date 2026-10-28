import { z } from 'zod';
import { collectiveLocationSchema } from './collective.js';
import { collectiveCustodyTransferSchema } from './collective-artifact-custody.js';
import { collectiveModificationReworkSchema } from './collective-content-modification.js';

export const COLLECTIVE_ARTIFACT_VERSION_LIMIT = 10000;

const id = z.string().trim().min(1).max(256);
const positive = z.number().int().positive().safe();
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const coordinates = { serviceInstanceId: id, collectiveId: id };
/** UTF-16 offsets into the exact owner revision. The owner, never the Service, resolves quoted bytes. */
export const collectiveArtifactSelectionSchema = z
  .object({
    start: z.number().int().nonnegative().max(65536),
    end: z.number().int().positive().max(65536),
    quoteDigest: digest,
  })
  .strict()
  .refine((selection) => selection.end > selection.start && selection.end - selection.start <= 8000);
export const collectiveArtifactAdoptionLineageSchema = z
  .object({
    requestId: id,
    requestEventId: id,
    proposalRef: id,
    sourceEventId: id,
    sourceOwnerRevision: positive,
    location: collectiveLocationSchema,
  })
  .strict();
export const collectiveArtifactActionSchema = z.enum([
  'read',
  'history',
  'annotate',
  'propose',
  'preview',
  'apply',
  'cancel',
  'reject',
]);
export type CollectiveArtifactAction = z.infer<typeof collectiveArtifactActionSchema>;
export const collectiveArtifactVersionSchema = z
  .object({
    ownerRevision: positive,
    changeSummary: z.string().trim().min(1).max(2000).optional(),
    blobDigest: digest,
    receiptRef: id,
    recordedAt: z.string().datetime(),
    lineage: collectiveArtifactAdoptionLineageSchema.optional(),
    adoptedByHumanId: id.optional(),
    authorCatId: id.optional(),
  })
  .strict();
const access = z.object({ revision: positive, status: z.enum(['active', 'revoked']), mayApply: z.boolean() }).strict();
const custody = z
  .object({
    connectionId: id,
    endpointId: id,
    revision: positive,
    status: z.enum(['active', 'suspended']),
    ownerScopeRef: id.optional(),
  })
  .strict();
const handoff = z
  .object({
    handoffRef: id,
    targetConnectionId: id,
    expectedCustodyRevision: positive,
    offeredByHumanId: id,
    createdAt: z.string().datetime(),
  })
  .strict();
/** Immutable delegation coordinates only; public message and F309 owner retain instruction and request lifecycle. */
export const collectiveArtifactRequestSourceSchema = z
  .object({
    requestEventId: id,
    ownerRevision: positive,
    blobDigest: digest,
    annotationIds: z.array(id).max(12),
    selections: z.array(collectiveArtifactSelectionSchema).min(1).max(12).optional(),
    rework: collectiveModificationReworkSchema.optional(),
    expectedReviewRevision: positive,
    requestingHumanId: id,
    requesterMembershipRevision: positive,
    requesterAccessRevision: positive,
    targetMembershipRevision: positive,
    targetAccessRevision: positive,
  })
  .strict();
/** Private domain state: no content bytes, annotation bodies or candidate edits. */
export const collectiveArtifactRecordSchema = z
  .object({
    ...coordinates,
    artifactId: id,
    contentRef: id,
    publishedByHumanId: id,
    custody,
    access: z.record(id, access),
    pendingHandoff: handoff.optional(),
    custodyTransfers: z.record(id, collectiveCustodyTransferSchema).default({}),
    custodyHistory: z.array(custody).max(10000),
    title: z.string().trim().min(1).max(200),
    mediaType: z.enum(['text/markdown', 'image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm']),
    sourceEventId: id,
    sourceLocation: collectiveLocationSchema,
    workId: id.optional(),
    revision: positive,
    versions: z.array(collectiveArtifactVersionSchema).min(1).max(COLLECTIVE_ARTIFACT_VERSION_LIMIT),
    requestSources: z.record(id, collectiveArtifactRequestSourceSchema).default({}),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type CollectiveArtifactRecord = z.infer<typeof collectiveArtifactRecordSchema>;
/** Human projection never discloses endpoint, connection, another member's policy or handoff tickets. */
export const collectiveArtifactProjectionSchema = collectiveArtifactRecordSchema
  .omit({
    custody: true,
    access: true,
    pendingHandoff: true,
    custodyTransfers: true,
    custodyHistory: true,
    requestSources: true,
  })
  .extend({
    versions: z.array(collectiveArtifactVersionSchema).length(1),
    versionCount: positive.max(COLLECTIVE_ARTIFACT_VERSION_LIMIT),
    availability: z.enum(['available', 'owner_unavailable']),
    accessRevision: positive,
    canApply: z.boolean(),
    canManageAccess: z.boolean().optional(),
    canManageCustody: z.boolean().optional(),
  })
  .strict();
export type CollectiveArtifactProjection = z.infer<typeof collectiveArtifactProjectionSchema>;
export const registerCollectiveArtifactSchema = z
  .object({
    ...coordinates,
    connectionId: id,
    contentRef: id,
    title: z.string().trim().min(1).max(200),
    mediaType: collectiveArtifactRecordSchema.shape.mediaType,
    sourceEventId: id,
    workId: id.optional(),
    ownerRevision: positive,
    changeSummary: z.string().trim().min(1).max(2000).optional(),
    blobDigest: digest,
    receiptRef: id,
    requestId: id,
    expectedRevision: positive.optional(),
    expectedCustodyRevision: positive.optional(),
  })
  .strict();
export type RegisterCollectiveArtifact = z.infer<typeof registerCollectiveArtifactSchema>;
export const collectiveArtifactConstraintRequestSchema = z
  .object({
    ...coordinates,
    artifactId: id,
    sourceEventId: id,
    action: collectiveArtifactActionSchema,
    ownerRevision: positive.optional(),
  })
  .strict();
const artifactAgentContextSchema = z
  .object({
    requestEventId: id,
    catId: id,
    humanId: id,
    connectionId: id,
    participationRevision: positive,
    membershipRevision: positive,
    revocationEpoch: positive,
  })
  .strict();
export const collectiveArtifactConstraintSchema = z
  .object({
    ...coordinates,
    artifactId: id,
    contentRef: id,
    humanId: id,
    action: collectiveArtifactActionSchema,
    sourceEventId: id,
    custodyRevision: positive,
    ownerRevision: positive,
    /** Service catalogue head, independent of the historical revision selected by the reader. */
    catalogueOwnerRevision: positive.optional(),
    blobDigest: digest,
    membershipRevision: positive,
    revocationEpoch: positive,
    decisionRef: id,
    expiresAt: z.number().int().positive().safe(),
    effectMode: z.literal('replay_only').optional(),
    agent: artifactAgentContextSchema.optional(),
    requestTarget: artifactAgentContextSchema.optional(),
    /** Internally issued only for a verified public reply; never accepted in browser constraint requests. */
    reviewReply: z.object({ annotationId: id, messageEventId: id }).strict().optional(),
    /** Internal reply-only subject for the retained PNG/MP4 review surface; never a browser constraint input. */
    mediaReviewReply: z.object({ annotationId: id }).strict().optional(),
  })
  .strict();
export type CollectiveArtifactConstraint = z.infer<typeof collectiveArtifactConstraintSchema>;
export const collectiveArtifactAgentConstraintRequestSchema = collectiveArtifactConstraintRequestSchema
  .extend({
    connectionId: id,
    requestEventId: id,
    catId: id,
    participationRevision: positive,
  })
  .strict();
export const validateCollectiveArtifactConstraintSchema = collectiveArtifactConstraintRequestSchema
  .extend({
    connectionId: id,
    decisionRef: id,
  })
  .strict();
export const revokeCollectiveArtifactAccessSchema = z
  .object({
    ...coordinates,
    artifactId: id,
    humanId: id,
    expectedAccessRevision: positive,
    requestId: id,
  })
  .strict();
export const updateCollectiveArtifactAccessSchema = revokeCollectiveArtifactAccessSchema
  .extend({
    access: z.enum(['read', 'apply', 'revoked']),
  })
  .strict();
export const offerCollectiveArtifactCustodySchema = z
  .object({
    ...coordinates,
    artifactId: id,
    targetHumanId: id,
    targetConnectionId: id.optional(),
    expectedCustodyRevision: positive,
    requestId: id,
  })
  .strict();
export const acceptCollectiveArtifactCustodySchema = z
  .object({
    ...coordinates,
    artifactId: id,
    connectionId: id,
    handoffRef: id,
    expectedCustodyRevision: positive,
    contentRef: id,
    ownerRevision: positive,
    blobDigest: digest,
    receiptRef: id,
    ownerScopeRef: id,
    preparedRef: id.optional(),
    readyRef: id.optional(),
    requestId: id,
  })
  .strict();
export type AcceptCollectiveArtifactCustody = z.infer<typeof acceptCollectiveArtifactCustodySchema>;
export const listCollectiveArtifactsSchema = z.object({ ...coordinates, channelId: id.optional() }).strict();

/** Endpoint-only continuity for an explicitly re-shared retained asset; never accepted from the browser DTO. */
export const recoverCollectiveMediaCustodySchema = registerCollectiveArtifactSchema
  .extend({
    previousConnectionId: id.optional(),
    previousCustodyProof: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

export const COLLECTIVE_MEDIA_CUSTODY_PROOF_CONTEXT = 'collective-retained-media-custody:v1';

export const collectiveArtifactCatalogueHistoryRequestSchema = z
  .object({
    ...coordinates,
    artifactId: id,
    sourceEventId: id,
    offset: z.number().int().nonnegative().max(COLLECTIVE_ARTIFACT_VERSION_LIMIT).default(0),
    limit: z.number().int().min(1).max(30).default(30),
    snapshotOwnerRevision: positive.optional(),
    expectedSnapshot: digest.optional(),
  })
  .strict();
export const collectiveArtifactCatalogueHistoryPageSchema = z
  .object({
    artifactId: id,
    contentRef: id,
    sourceEventId: id,
    snapshotOwnerRevision: positive,
    snapshot: digest,
    total: positive,
    offset: z.number().int().nonnegative(),
    nextOffset: z.number().int().positive().optional(),
    versions: z.array(collectiveArtifactVersionSchema).max(30),
  })
  .strict();
export const collectiveArtifactRequestReceiptQuerySchema = z
  .object({ ...coordinates, requestEventIds: z.array(id).min(1).max(30) })
  .strict();
export const collectiveArtifactRequestReceiptPageSchema = z
  .object({
    receipts: z
      .array(
        z
          .object({
            artifact: collectiveArtifactProjectionSchema,
            version: collectiveArtifactVersionSchema,
          })
          .strict(),
      )
      .max(30),
  })
  .strict();
