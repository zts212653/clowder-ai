import { z } from 'zod';
import { reviewedMediaAssetSchema } from './artifact-review-media.js';
import { collectiveMediaOperationId, collectiveMediaReviewCommandSchema } from './collective-artifact-media.js';
import { collectiveArtifactReadPageSchema } from './collective-artifact-operations.js';
import { type CollectiveMediaSurfaceRefV1, collectiveMediaSurfaceRefV1Schema } from './collective-media-surface.js';
import { workspaceContentReviewSchema, workspaceContentSourceSchema } from './workspace-content-review.js';

const source = workspaceContentSourceSchema.options[0];
const positive = z.number().int().positive().safe();
const offset = z.number().int().nonnegative().safe();
const page = z.object({ offset, total: offset, nextOffset: offset.optional() }).strict();
/** Public F309 projection: retained immutable media metadata only, never a private principal or publication. */
export const collectiveMediaViewSchema = reviewedMediaAssetSchema
  .omit({ sourcePublication: true })
  .extend({
    kind: z.literal('collective-media'),
    mediaType: z.enum(['image/png', 'video/mp4']),
    view: z
      .object({
        review: workspaceContentReviewSchema
          .innerType()
          .omit({ ownerUserId: true })
          .extend({
            source,
            sourceHistory: source.array().max(1001).optional(),
          })
          .strict(),
        currentSource: source,
        sourceState: z.enum(['current', 'changed']),
        canWrite: z.boolean(),
        canReply: z.boolean(),
        historyReadOnly: z.boolean(),
        annotationPage: page,
        replyPages: page
          .extend({ annotationId: z.string().min(1).max(256) })
          .array()
          .max(2),
        annotationResolutions: z
          .object({
            annotationId: z.string().min(1).max(256),
            status: z.enum(['attached', 'moved', 'ambiguous', 'orphaned']),
          })
          .strict()
          .array()
          .max(2),
      })
      .strict(),
  })
  .strict();
export type CollectiveMediaView = z.infer<typeof collectiveMediaViewSchema>;

export const collectiveMediaReceiptSchema = z
  .object({
    annotationId: z.string().min(1).max(256),
    ownerRevision: positive,
    receipt: z
      .object({
        reviewId: z.string().min(1).max(256),
        receiptRef: z.string().min(1).max(256),
        operationId: z.string().regex(/^collective-media-operation:[a-f0-9]{64}$/),
        revision: positive,
        actor: z.object({ kind: z.literal('human'), actorId: z.string().min(1).max(256) }).strict(),
        createdAt: z.string().datetime(),
        replayed: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const collectiveMediaSurfaceRequestSchema = z
  .object({
    type: z.literal('collective:host-media-request'),
    ref: collectiveMediaSurfaceRefV1Schema,
    requestId: z.string().uuid(),
    operation: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('read'), page: collectiveArtifactReadPageSchema }).strict(),
      z
        .object({
          kind: z.literal('annotate'),
          operationId: z.string().uuid(),
          command: collectiveMediaReviewCommandSchema,
        })
        .strict(),
    ]),
  })
  .strict();
export type CollectiveMediaSurfaceRequest = z.infer<typeof collectiveMediaSurfaceRequestSchema>;
export const collectiveMediaSurfaceResultSchema = z
  .object({
    type: z.literal('collective:client-media-result'),
    ref: collectiveMediaSurfaceRefV1Schema,
    requestId: z.string().uuid(),
    result: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('read'),
          title: z.string().trim().min(1).max(500).optional(),
          actors: z
            .object({ humanId: z.string().min(1).max(256), displayName: z.string().min(1).max(120) })
            .strict()
            .array()
            .max(4)
            .optional(),
          value: collectiveMediaViewSchema,
        })
        .strict(),
      z.object({ kind: z.literal('annotated'), value: collectiveMediaReceiptSchema }).strict(),
      z
        .object({
          kind: z.literal('error'),
          code: z.enum(['access_denied', 'owner_unavailable', 'conflict', 'unavailable']),
        })
        .strict(),
    ]),
  })
  .strict();
export type CollectiveMediaSurfaceResult = z.infer<typeof collectiveMediaSurfaceResultSchema>;

export async function assertCollectiveMediaReceipt(
  value: unknown,
  ref: CollectiveMediaSurfaceRefV1,
  requestId: string,
  reviewId?: string,
) {
  const receipt = collectiveMediaReceiptSchema.parse(value);
  if (
    receipt.ownerRevision !== ref.ownerRevision ||
    receipt.receipt.actor.actorId !== ref.humanId ||
    receipt.receipt.operationId !== (await collectiveMediaOperationId(ref, 'annotate', requestId)) ||
    (reviewId !== undefined && receipt.receipt.reviewId !== reviewId)
  )
    throw new Error('MEDIA_RECEIPT_MISMATCH');
  return receipt;
}

/** Both bridges recheck the tuple; MIME/catalogue presence alone never authorizes an owner read. */
export function assertCollectiveMediaView(
  value: unknown,
  expected: {
    contentRef: string;
    ownerRevision: number;
    blobDigest: string;
    mediaType: string;
    serviceInstanceId: string;
    collectiveId: string;
    artifactId: string;
    sourceEventId: string;
  },
) {
  const parsed = collectiveMediaViewSchema.parse(value),
    scope = parsed.view.review.collaborationScope;
  const current = parsed.view.currentSource;
  if (
    parsed.contentRef !== expected.contentRef ||
    parsed.ownerRevision !== expected.ownerRevision ||
    parsed.blobDigest !== expected.blobDigest ||
    parsed.mediaType !== expected.mediaType ||
    current.contentRef !== parsed.contentRef ||
    current.ownerRevision !== parsed.ownerRevision ||
    current.blobDigest !== parsed.blobDigest ||
    current.mime !== parsed.mediaType ||
    current.ownerReceiptRef !== parsed.ownerReceiptRef ||
    JSON.stringify(current.media) !== JSON.stringify(parsed.media) ||
    scope?.serviceInstanceId !== expected.serviceInstanceId ||
    scope.collectiveId !== expected.collectiveId ||
    scope.artifactId !== expected.artifactId ||
    scope.sourceEventId !== expected.sourceEventId ||
    !scope.custodyRevision
  )
    throw new Error('MEDIA_REFERENCE_CHANGED');
  return parsed;
}
