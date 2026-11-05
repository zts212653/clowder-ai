import { z } from 'zod';
import { collectiveLocationSchema } from './collective.js';

const id = z.string().trim().min(1).max(256);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const prepareCollectiveArtifactPublicationSchema = z
  .object({
    serviceInstanceId: id,
    collectiveId: id,
    connectionId: id,
    sourceEventId: id,
    requestId: id,
    title: z.string().trim().min(1).max(200),
    blobDigest: digest,
    workId: id.optional(),
  })
  .strict();
/** Durable content-free publication intent. Endpoint coordinates never project into the work Client. */
export const collectiveArtifactPublicationRecordSchema = prepareCollectiveArtifactPublicationSchema
  .extend({
    publicationId: id,
    contentRef: id,
    artifactId: id,
    humanId: id,
    membershipRevision: z.number().int().positive().safe(),
    endpointId: id,
    sourceLocation: collectiveLocationSchema,
    requestDigest: digest,
    status: z.enum(['pending', 'published']),
    effectPending: z.boolean().optional(),
    receiptRef: id.optional(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type CollectiveArtifactPublication = z.infer<typeof collectiveArtifactPublicationRecordSchema>;
export const collectiveArtifactPublicationUploadSchema = z
  .object({
    publicationId: id,
    // Base64 keeps even 64KiB of control-character Markdown inside the fixed HTTP envelope.
    bytesBase64: z
      .string()
      .max(87384)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  })
  .strict();
export const collectiveArtifactPublicationOperationSchema = z
  .object({
    relayRef: id,
    publication: collectiveArtifactPublicationRecordSchema,
    bytesBase64: collectiveArtifactPublicationUploadSchema.shape.bytesBase64,
    expiresAt: z.number().int().positive().safe(),
  })
  .strict();
export type CollectiveArtifactPublicationOperation = z.infer<typeof collectiveArtifactPublicationOperationSchema>;
export const collectiveArtifactPublicationValidationSchema = z
  .object({
    serviceInstanceId: id,
    collectiveId: id,
    connectionId: id,
    publicationId: id,
    relayRef: id,
  })
  .strict();

/** Only the receipt can cross the recovery endpoint: no content, new decision, or replayed effect. */
export const collectiveArtifactPublicationReceiptSchema = z
  .object({
    receiptId: id,
    contentRef: id,
    previousOwnerRevision: z.literal(0),
    ownerRevision: z.literal(1),
    blobDigest: digest,
    actor: z.object({ kind: z.literal('human'), actorId: id }).strict(),
    operationId: id,
    outboxSequence: z.literal(1),
    operationContext: z
      .object({
        kind: z.literal('collective-artifact:publish'),
        requestDigest: digest,
        actorHumanId: id,
        scopeRef: id,
        custodyRevision: z.literal(1),
        dispositionId: id,
      })
      .strict(),
  })
  .strict();
export const collectiveArtifactPublicationRecoverySchema = z
  .object({
    serviceInstanceId: id,
    collectiveId: id,
    connectionId: id,
    publicationId: id,
    outcome: z.discriminatedUnion('status', [
      z.object({ status: z.literal('committed'), receipt: collectiveArtifactPublicationReceiptSchema }).strict(),
      z.object({ status: z.literal('absent') }).strict(),
    ]),
  })
  .strict();
export type CollectiveArtifactPublicationRecovery = z.infer<typeof collectiveArtifactPublicationRecoverySchema>;
