import { z } from 'zod';
import { collectiveLocationSchema, collectiveRecipientSchema } from './collective.js';
import { collectiveArtifactSelectionSchema } from './collective-artifact.js';
import {
  collectiveModificationReworkSchema,
  collectiveModificationTargetSchema,
} from './collective-content-modification.js';

const id = z.string().trim().min(1).max(256);
/** A 64 KiB before/after patch can expand sixfold in JSON, plus up to 500 edit descriptors. */
export const maxCollectiveArtifactProposalPayloadBytes = 2 * 1024 * 1024;
export const maxCollectiveArtifactProposalEnvelopeBytes = maxCollectiveArtifactProposalPayloadBytes + 16 * 1024;
export const collectiveArtifactReadPageSchema = z
  .object({
    annotationOffset: z.number().int().nonnegative().max(500).default(0),
    annotationLimit: z.number().int().min(1).max(2).default(2),
    annotationId: id.optional(),
    replyOffset: z.number().int().nonnegative().max(100).default(0),
    requestOffset: z.number().int().nonnegative().max(10000).default(0),
    requestLimit: z.number().int().min(1).max(30).default(30),
    cursor: z.number().int().nonnegative().max(10000000).default(0),
    expectedSnapshot: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export const collectiveArtifactHistoryPageSchema = z
  .object({
    offset: z.number().int().nonnegative().max(10000).default(0),
    limit: z.number().int().min(1).max(30).default(30),
  })
  .strict();
export const collectiveArtifactAnnotationInputSchema = z
  .object({
    kind: z.literal('annotate'),
    messageEventId: id,
    quote: z.string().min(1).max(8000),
    selection: collectiveArtifactSelectionSchema.optional(),
    expectedReviewRevision: z.number().int().positive().safe(),
  })
  .strict();
/** The Service resolves the immutable public message; the browser cannot supply its author or body. */
export const collectiveArtifactAnnotationCommandSchema = collectiveArtifactAnnotationInputSchema
  .extend({
    body: z.string().trim().min(1).max(8000),
    location: collectiveLocationSchema,
  })
  .strict();

const reviewStateAction = z
  .object({
    kind: z.literal('set_annotation_state'),
    annotationId: id,
    state: z.enum(['open', 'resolved']),
  })
  .strict();
const reviewReplyInput = z
  .object({
    kind: z.literal('reply'),
    annotationId: id,
    messageEventId: id,
  })
  .strict();
const reviewActionFields = {
  kind: z.literal('review-action'),
  expectedReviewRevision: z.number().int().positive().safe(),
};
/** Reply text and parent are resolved by the Service from one immutable public Human message. */
export const collectiveArtifactReviewActionInputSchema = z
  .object({
    ...reviewActionFields,
    action: z.discriminatedUnion('kind', [reviewStateAction, reviewReplyInput]),
  })
  .strict();
export const collectiveArtifactReviewActionCommandSchema = z
  .object({
    ...reviewActionFields,
    action: z.discriminatedUnion('kind', [
      reviewStateAction,
      reviewReplyInput
        .extend({
          body: z.string().trim().min(1).max(8000),
          location: collectiveLocationSchema,
          replyToEventId: id,
        })
        .strict(),
    ]),
  })
  .strict();
export const collectiveArtifactPublishedSelectionInputSchema = z
  .object({
    kind: z.literal('annotate-published-selections'),
    messageEventId: id,
  })
  .strict();

export const collectiveArtifactModificationRequestInputSchema = z
  .object({
    kind: z.literal('request-modification'),
    messageEventId: id,
    annotationIds: z.array(id).max(12),
    selections: z.array(collectiveArtifactSelectionSchema).min(1).max(12).optional(),
    rework: collectiveModificationReworkSchema.optional(),
    expectedReviewRevision: z.number().int().positive().safe(),
  })
  .strict();
/** Only Service-resolved public message provenance and its declared named Cat enter the owner. */
export const collectiveArtifactModificationRequestCommandSchema = collectiveArtifactModificationRequestInputSchema
  .extend({
    instruction: z.string().trim().min(1).max(8000),
    location: collectiveLocationSchema,
    target: collectiveModificationTargetSchema,
  })
  .strict();

export const collectiveArtifactProposalSelectionSchema = z
  .object({
    requestId: id,
    proposalRef: id,
  })
  .strict();
/** Human request control, separate from content settlement and whole-invocation cancellation. */
export const collectiveArtifactControlSchema = z
  .object({
    requestId: id,
    expectedRequestRevision: z.number().int().positive().safe(),
    proposalRef: id.optional(),
  })
  .strict();

/** Atomically send one public named-Cat request and bind its existing owner selections. */
export const publishCollectiveArtifactRequestSchema = z
  .object({
    serviceInstanceId: id,
    collectiveId: id,
    artifactId: id,
    sourceEventId: id,
    ownerRevision: z.number().int().positive().safe(),
    annotationIds: z.array(id).max(12),
    selections: z.array(collectiveArtifactSelectionSchema).min(1).max(12).optional(),
    rework: collectiveModificationReworkSchema.optional(),
    expectedReviewRevision: z.number().int().positive().safe(),
    clientEventId: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(8000),
    recipient: collectiveRecipientSchema,
  })
  .strict();
