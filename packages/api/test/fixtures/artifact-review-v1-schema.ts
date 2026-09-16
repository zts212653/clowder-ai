// Frozen v1 reader from 44a6f01400c7fa41f6e17f7e3a88001e1867c5f8. Compatibility tests only.
import { z } from 'zod';

const ref = z.string().trim().min(1).max(2048);
const id = z.string().trim().min(1).max(128);
const positive = z.number().int().positive().safe();
const tick = z.number().int().safe();
const text = z.string().trim().min(1).max(8000);
const timestamp = z.string().datetime();
const rational = z.object({ numerator: positive, denominator: positive }).strict();

export const artifactReviewActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human'), actorId: id }).strict(),
  z.object({ kind: z.literal('cat'), actorId: id }).strict(),
]);
export type ArtifactReviewActor = z.infer<typeof artifactReviewActorSchema>;
export type ArtifactReviewAuditActor = ArtifactReviewActor | { kind: 'owner'; actorId: 'content-review' };

export const immutableMediaSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), width: positive.max(32768), height: positive.max(32768) }).strict(),
  z
    .object({
      kind: z.literal('video'),
      width: positive.max(32768),
      height: positive.max(32768),
      codedWidth: positive.max(32768),
      codedHeight: positive.max(32768),
      rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
      pixelAspectRatio: rational,
      streamId: id,
      streamIndex: z.number().int().min(0).max(64),
      timebase: rational,
      startTick: tick,
      durationTicks: positive,
      containerStartSeconds: z.number().finite(),
    })
    .strict(),
]);
export type ImmutableMedia = z.infer<typeof immutableMediaSchema>;

export const reviewedMediaAssetSchema = z
  .object({
    contentRef: ref,
    ownerRevision: positive,
    blobDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    mediaType: z.enum(['image/png', 'video/mp4']),
    media: immutableMediaSchema,
    sourcePublication: z.object({ artifactRef: ref, sourceRef: ref, revision: ref }).strict(),
    ownerReceiptRef: ref,
  })
  .strict();
export type ReviewedMediaAsset = z.infer<typeof reviewedMediaAssetSchema>;

const region = {
  x: z.number().finite().min(0),
  y: z.number().finite().min(0),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
};
export const artifactReviewAnchorSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('image-region'), ...region }).strict(),
    z
      .object({
        kind: z.literal('video-range'),
        streamId: id,
        startTick: tick,
        endTick: tick,
        frameRegion: z
          .object({ tick, ...region })
          .strict()
          .optional(),
      })
      .strict(),
  ])
  .superRefine((anchor, context) => {
    if (anchor.kind !== 'video-range') return;
    if (anchor.endTick <= anchor.startTick)
      context.addIssue({ code: 'custom', message: 'Video range must be nonempty and half-open' });
    if (
      anchor.frameRegion &&
      (anchor.frameRegion.tick < anchor.startTick || anchor.frameRegion.tick >= anchor.endTick)
    ) {
      context.addIssue({ code: 'custom', message: 'Frame must be inside the selected time range' });
    }
  });
export type ArtifactReviewAnchor = z.infer<typeof artifactReviewAnchorSchema>;

export const artifactReviewReplySchema = z
  .object({
    id,
    body: text,
    author: artifactReviewActorSchema,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export const artifactReviewAnnotationSchema = z
  .object({
    id,
    anchor: artifactReviewAnchorSchema,
    body: text,
    author: artifactReviewActorSchema,
    createdAt: timestamp,
    updatedAt: timestamp,
    state: z.enum(['open', 'resolved']),
    replies: z.array(artifactReviewReplySchema).max(100),
    reanchoredFrom: z.object({ round: positive, annotationId: id }).strict().optional(),
  })
  .strict();
export type ArtifactReviewAnnotation = z.infer<typeof artifactReviewAnnotationSchema>;

export const artifactReviewResponseSchema = z
  .object({
    annotationId: id,
    disposition: z.enum(['addressed', 'unchanged']),
    explanation: text,
  })
  .strict();
export type ArtifactReviewResponse = z.infer<typeof artifactReviewResponseSchema>;

export const artifactReviewRoundSchema = z
  .object({
    number: positive,
    asset: reviewedMediaAssetSchema,
    openedAt: timestamp,
    state: z.enum(['draft', 'awaiting_human', 'approved', 'changes_requested', 'superseded']),
    annotations: z.array(artifactReviewAnnotationSchema).max(500),
    responses: z.array(artifactReviewResponseSchema).max(500),
    responseAuthor: artifactReviewActorSchema.optional(),
    judgmentRequest: z
      .object({ summary: text, judgmentNeeded: text, requestedBy: artifactReviewActorSchema, requestedAt: timestamp })
      .strict()
      .optional(),
    decision: z
      .object({
        outcome: z.enum(['approved', 'changes_requested']),
        explanation: text,
        actor: artifactReviewActorSchema,
        decidedAt: timestamp,
        receiptRef: ref,
      })
      .strict()
      .optional(),
    attentionRetiredReason: z.enum(['task_changed', 'task_closed', 'asset_changed', 'access_revoked']).optional(),
  })
  .strict();
export type ArtifactReviewRound = z.infer<typeof artifactReviewRoundSchema>;

export const artifactReviewSchema = z
  .object({
    version: z.literal(1),
    reviewId: id,
    revision: positive,
    title: z.string().trim().min(1).max(300),
    task: z.object({ taskId: id, threadId: id, ownerUserId: id, observedRevision: positive }).strict(),
    contentRef: ref,
    rounds: z.array(artifactReviewRoundSchema).min(1).max(200),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type ArtifactReview = z.infer<typeof artifactReviewSchema>;

export const artifactReviewActionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('annotate'),
      annotationId: id,
      anchor: artifactReviewAnchorSchema,
      body: text,
      reanchoredFrom: z.object({ round: positive, annotationId: id }).strict().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('reply'), annotationId: id, replyId: id, body: text }).strict(),
  z.object({ kind: z.literal('edit'), annotationId: id, replyId: id.optional(), body: text }).strict(),
  z.object({ kind: z.literal('set_annotation_state'), annotationId: id, state: z.enum(['open', 'resolved']) }).strict(),
  z.object({ kind: z.literal('request_judgment'), summary: text, judgmentNeeded: text }).strict(),
  z.object({ kind: z.literal('submit_feedback'), explanation: text }).strict(),
  z
    .object({ kind: z.literal('decide'), outcome: z.enum(['approved', 'changes_requested']), explanation: text })
    .strict(),
  z.object({ kind: z.literal('reopen'), explanation: text }).strict(),
]);
export type ArtifactReviewAction = z.infer<typeof artifactReviewActionSchema>;

export const artifactReviewCommandSchema = z
  .object({
    reviewId: id,
    expectedRevision: positive,
    expectedTaskRevision: positive,
    round: positive,
    operationId: id,
    action: artifactReviewActionSchema,
  })
  .strict();
export type ArtifactReviewCommand = z.infer<typeof artifactReviewCommandSchema>;

export const prepareArtifactReviewSchema = z
  .object({
    taskId: id,
    expectedTaskRevision: positive,
    artifactRef: ref,
    expectedArtifactRevision: ref,
    operationId: id,
  })
  .strict();
export type PrepareArtifactReview = z.infer<typeof prepareArtifactReviewSchema>;
export type PreparedMediaReviewContext = Omit<PrepareArtifactReview, 'operationId'> & { title: string };

export const respondWithMediaVersionSchema = z
  .object({
    reviewId: id,
    expectedRevision: positive,
    expectedTaskRevision: positive,
    operationId: id,
    expectedOwnerRevision: positive,
    artifactRef: ref,
    expectedArtifactRevision: ref,
    responses: z.array(artifactReviewResponseSchema).max(500),
  })
  .strict();
export type RespondWithMediaVersion = z.infer<typeof respondWithMediaVersionSchema>;

export interface ArtifactReviewReceipt {
  receiptRef: string;
  reviewId: string;
  operationId: string;
  revision: number;
  actor: ArtifactReviewAuditActor;
  createdAt: string;
  outcome: 'applied' | 'aborted';
}

export interface ArtifactReviewView {
  review: ArtifactReview;
  pendingVersion: boolean;
  authority: {
    state: 'current' | 'task_changed' | 'task_closed' | 'asset_changed';
    taskRevision: number;
    ownerCatId: string | null;
    canWrite: boolean;
  };
  continuation: {
    taskId: string;
    expectedRevision: number;
    artifactRef: string;
    reviewEvidenceRef: string;
    ownerCatId: string | null;
    returnDelivery?: { state: 'pending' | 'queued' | 'retired'; receiptRef: string; messageId?: string };
  };
}

export interface ArtifactReviewAuditEntry {
  receipt: ArtifactReviewReceipt;
  round: number;
  kind: string;
  /** Prior and new field values belong only to this canonical history, never another writable body store. */
  detail: unknown;
}
