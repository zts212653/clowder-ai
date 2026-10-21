import { z } from 'zod';
import { artifactReviewDrawingSchema, artifactReviewImageEditSchema } from './artifact-review-drawing.js';
import {
  artifactReviewAnchorSchema,
  reviewedMediaAssetSchema,
  reviewedMediaTypeSchema,
} from './artifact-review-media.js';

export type {
  ArtifactReviewAnchor,
  ImmutableMedia,
  ReviewedMediaAsset,
  ReviewedMediaType,
} from './artifact-review-media.js';
export {
  artifactReviewAnchorSchema,
  immutableMediaSchema,
  reviewedMediaAssetSchema,
  reviewedMediaTypeSchema,
} from './artifact-review-media.js';

const ref = z.string().trim().min(1).max(2048);
const id = z.string().trim().min(1).max(128);
const positive = z.number().int().positive().safe();
const text = z.string().trim().min(1).max(8000);
const timestamp = z.string().datetime();

export const artifactReviewActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human'), actorId: id }).strict(),
  z.object({ kind: z.literal('cat'), actorId: id }).strict(),
]);
export type ArtifactReviewActor = z.infer<typeof artifactReviewActorSchema>;
export type ArtifactReviewAuditActor = ArtifactReviewActor | { kind: 'owner'; actorId: 'content-review' };

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
    imageEdit: artifactReviewImageEditSchema.optional(),
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

/** Stored verified mapping. Public legacy responses still use the smaller strict input schema above. */
export const artifactReviewResponseRecordSchema = artifactReviewResponseSchema.extend({
  resultAnchor: artifactReviewAnchorSchema.optional(),
  /** Direct Human judgment of this exact result response; the original operation audit retains earlier choices. */
  judgment: z
    .object({
      outcome: z.enum(['accepted', 'reopened']),
      actor: z.object({ kind: z.literal('human'), actorId: id }).strict(),
      decidedAt: timestamp,
      receiptRef: ref,
    })
    .strict()
    .optional(),
});
export type ArtifactReviewResponseRecord = z.infer<typeof artifactReviewResponseRecordSchema>;

export const artifactReviewVisualMarkSchema = z
  .object({
    drawing: artifactReviewDrawingSchema,
    author: artifactReviewActorSchema,
    createdAt: timestamp,
    state: z.enum(['active', 'deleted']),
    deletedAt: timestamp.optional(),
  })
  .strict();
export type ArtifactReviewVisualMark = z.infer<typeof artifactReviewVisualMarkSchema>;

export const artifactReviewRoundSchema = z
  .object({
    /** Version 3 rounds retain only this canonical F309 ledger coordinate. */
    ledgerRef: id.optional(),
    /** Read projection only; never persisted with the round. */
    ledgerRevision: positive.optional(),
    number: positive,
    asset: reviewedMediaAssetSchema,
    openedAt: timestamp,
    state: z.enum(['draft', 'awaiting_human', 'approved', 'changes_requested', 'superseded']),
    annotations: z.array(artifactReviewAnnotationSchema).max(500),
    visualMarks: z.array(artifactReviewVisualMarkSchema).max(500).optional(),
    responses: z.array(artifactReviewResponseRecordSchema).max(500),
    responseSource: z
      .object({
        round: positive,
        ownerRevision: positive,
        reviewRevision: positive,
        requestId: id.optional(),
        ledgerRef: id.optional(),
        ledgerRevision: positive.optional(),
      })
      .strict()
      .optional(),
    responseAuthor: artifactReviewActorSchema.optional(),
    judgmentRequest: z
      .object({ summary: text, judgmentNeeded: text, requestedBy: artifactReviewActorSchema, requestedAt: timestamp })
      .strict()
      .optional(),
    decision: z
      .object({
        outcome: z.enum(['approved', 'changes_requested']),
        explanation: z.string().trim().max(8000),
        actor: artifactReviewActorSchema,
        decidedAt: timestamp,
        receiptRef: ref,
      })
      .strict()
      .refine((decision) => decision.outcome === 'approved' || decision.explanation.length > 0, {
        message: 'Changes require human feedback',
        path: ['explanation'],
      })
      .optional(),
    attentionRetiredReason: z.enum(['task_changed', 'task_closed', 'asset_changed', 'access_revoked']).optional(),
  })
  .strict();
export type ArtifactReviewRound = z.infer<typeof artifactReviewRoundSchema>;

export const artifactReviewSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    reviewId: id,
    revision: positive,
    title: z.string().trim().min(1).max(300),
    task: z.object({ taskId: id, threadId: id, ownerUserId: id, observedRevision: positive }).strict(),
    contentRef: ref,
    rounds: z.array(artifactReviewRoundSchema).min(1).max(200),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict()
  .refine(
    (review) =>
      review.version >= 2 ||
      review.rounds.every(
        (round) =>
          round.visualMarks === undefined &&
          round.annotations.every(
            (annotation) =>
              !annotation.imageEdit &&
              annotation.anchor.kind !== 'image-point' &&
              !(annotation.anchor.kind === 'video-range' && annotation.anchor.framePoint),
          ),
      ),
    'Artwork extensions require record version 2',
  )
  .refine(
    (review) => review.version === 3 || review.rounds.every((round) => !round.ledgerRef),
    'Linked ledgers require record version 3',
  )
  .refine(
    (review) =>
      review.rounds.every((round) => {
        const reference = round.responseSource;
        if (!reference) return true;
        const source = review.rounds.find((item) => item.number === reference.round);
        return (
          source !== undefined &&
          source.number < round.number &&
          source.asset.ownerRevision === reference.ownerRevision &&
          source.ledgerRef === reference.ledgerRef &&
          reference.reviewRevision < review.revision
        );
      }),
    'Response source must name its retained original round',
  );
export type ArtifactReview = z.infer<typeof artifactReviewSchema>;

export const artifactReviewActionSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('request_media_edit'),
        mediaType: reviewedMediaTypeSchema,
        annotationId: id,
        body: text,
        anchor: artifactReviewAnchorSchema.optional(),
        /** Multiple ranges belong to this one request and immutable source round. */
        selections: z
          .array(
            z
              .object({
                id,
                selection: artifactReviewAnchorSchema,
                instruction: text.optional(),
              })
              .strict(),
          )
          .min(1)
          .max(12)
          .optional(),
      })
      .strict(),
    z
      .object({ kind: z.literal('add_visual_marks'), marks: z.array(artifactReviewDrawingSchema).min(1).max(100) })
      .strict(),
    z.object({ kind: z.literal('delete_visual_mark'), markId: id }).strict(),
    z
      .object({
        kind: z.literal('request_image_edit'),
        annotationId: id,
        edit: artifactReviewImageEditSchema,
        note: z.string().trim().max(7600).optional(),
      })
      .strict(),
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
    z
      .object({ kind: z.literal('set_annotation_state'), annotationId: id, state: z.enum(['open', 'resolved']) })
      .strict(),
    z
      .object({
        kind: z.literal('judge_response'),
        sourceRound: positive,
        annotationId: id,
        resultOwnerRevision: positive,
        outcome: z.enum(['accepted', 'reopened']),
      })
      .strict(),
    z.object({ kind: z.literal('request_judgment'), summary: text, judgmentNeeded: text }).strict(),
    z.object({ kind: z.literal('submit_feedback'), explanation: text }).strict(),
    z
      .object({
        kind: z.literal('decide'),
        outcome: z.enum(['approved', 'changes_requested']),
        explanation: z.string().trim().max(8000),
      })
      .strict(),
    z.object({ kind: z.literal('reopen'), explanation: text }).strict(),
  ])
  .superRefine((action, ctx) => {
    if (action.kind === 'decide' && action.outcome === 'changes_requested' && !action.explanation)
      ctx.addIssue({ code: 'custom', path: ['explanation'], message: 'Changes require human feedback' });
    if (action.kind !== 'request_media_edit' || !action.selections) return;
    if (action.anchor) ctx.addIssue({ code: 'custom', path: ['anchor'], message: 'Choose single or named selections' });
    if (new Set(action.selections.map((item) => item.id)).size !== action.selections.length)
      ctx.addIssue({ code: 'custom', path: ['selections'], message: 'Selection ids must be unique' });
  });
export type ArtifactReviewAction = z.infer<typeof artifactReviewActionSchema>;

export const artifactReviewCommandSchema = z
  .object({
    expectedLedgerRevision: positive.optional(),
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
    requestId: id.optional(),
    expectedLedgerRevision: positive.optional(),
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
  /** Exact current request, derived from the atomic journal binding and canonical review audit. */
  modificationRequest?: { requestId: string; receiptRef: string };
  pendingVersion: boolean;
  /** Authorized, locator-free coordinates for the direct Human recovery action. */
  pendingSubmission?: {
    kind: 'work-submit-response';
    operationId: string;
    sourceRound: number;
    expectedReviewRevision: number;
  };
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
    returnDelivery?: {
      state: 'pending' | 'queued' | 'retired';
      receiptRef: string;
      messageId?: string;
      kind?:
        | 'submit_feedback'
        | 'decide'
        | 'reopen'
        | 'request_image_edit'
        | 'request_media_edit'
        | 'judge_response'
        | 'supersede_request';
    };
  };
}

/** A verified existing context; it never grants access or creates a Task on open. */
export const publicationReviewContextSchema = z
  .object({
    reviewId: id,
    round: positive,
    taskId: id,
    threadId: id,
    title: text,
    taskTitle: text,
    threadTitle: text,
    targetCatId: id.nullable(),
    targetName: text,
    ledgerRef: id.optional(),
    state: z.enum(['draft', 'awaiting_human', 'approved', 'changes_requested', 'superseded']).optional(),
    taskState: z.enum(['active', 'closed']).optional(),
  })
  .strict();
export type PublicationReviewContext = z.infer<typeof publicationReviewContextSchema>;

export interface ArtifactReviewAuditEntry {
  receipt: ArtifactReviewReceipt;
  round: number;
  kind: string;
  /** Prior and new field values belong only to this canonical history, never another writable body store. */
  detail: unknown;
}
