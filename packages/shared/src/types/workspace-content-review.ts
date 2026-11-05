import { z } from 'zod';
import { artifactReviewAnchorSchema, immutableMediaSchema, reviewedMediaAssetSchema } from './artifact-review.js';
import { artifactReviewDrawingSchema, artifactReviewImageEditSchema } from './artifact-review-drawing.js';
import { reviewedMediaTypeSchema } from './artifact-review-media.js';
import { evolutionMediaLocatorSchema } from './evolution-media-source.js';
import { videoProjectMessageContextSchema } from './video-project-message.js';
import {
  type VideoProjectReviewAnchor,
  videoProjectReviewAnchorSchema,
  videoProjectReviewHistorySchema,
  videoProjectReviewSourceSchema,
} from './video-project-review.js';

const id = z.string().trim().min(1).max(256);
const timestamp = z.string().datetime();
const revision = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const positive = z.number().int().positive().safe();
const body = z.string().trim().min(1).max(8000);
const rawSourceQuote = z.string().min(1).max(8000);

export const maxWorkspaceContentAnnotations = 500;
export const maxWorkspaceContentVisualMarks = 500;
/** Current source plus one immutable metadata snapshot for every retained anchored record. */
export const maxWorkspaceContentSourceHistory = 1 + maxWorkspaceContentAnnotations + maxWorkspaceContentVisualMarks;

export const workspaceContentLocatorSchema = z
  .object({ worktreeId: id, path: z.string().trim().min(1).max(2048) })
  .strict();
export type WorkspaceContentLocator = z.infer<typeof workspaceContentLocatorSchema>;

export const workspaceContentActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human'), actorId: id }).strict(),
  z.object({ kind: z.literal('cat'), actorId: id }).strict(),
]);
export type WorkspaceContentActor = z.infer<typeof workspaceContentActorSchema>;

export const workspaceContentSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('collective-media'),
      contentRef: id,
      ownerRevision: positive,
      blobDigest: revision,
      ownerReceiptRef: id,
      revision,
      mime: z.enum(['image/png', 'video/mp4']),
      media: immutableMediaSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('collective-artifact'),
      revision,
      ownerRevision: positive,
      mime: z.literal('text/markdown'),
      byteLength: z.number().int().nonnegative().max(65536),
    })
    .strict(),
  videoProjectReviewSourceSchema,
  z
    .object({
      kind: z.literal('evolution'),
      locator: evolutionMediaLocatorSchema,
      revision,
      mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm']),
      byteLength: positive,
      media: immutableMediaSchema,
      label: z.string().trim().min(1).max(1000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('text'),
      locator: workspaceContentLocatorSchema,
      revision,
      mime: z.string().trim().min(1).max(128),
      byteLength: z.number().int().nonnegative().safe(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('media'),
      locator: workspaceContentLocatorSchema,
      revision,
      mime: reviewedMediaTypeSchema,
      byteLength: positive,
      media: immutableMediaSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('publication'),
      revision,
      mime: reviewedMediaTypeSchema,
      media: immutableMediaSchema,
      publication: reviewedMediaAssetSchema.omit({ media: true, mediaType: true }),
    })
    .strict(),
]);
export type WorkspaceContentSource = z.infer<typeof workspaceContentSourceSchema>;

export const workspaceTextAnchorSchema = z
  .object({
    kind: z.literal('text_quote'),
    baseRevision: revision,
    start: z.number().int().nonnegative().safe(),
    end: z.number().int().positive().safe(),
    /** Raw source evidence is never normalized like a human-authored comment body. */
    quote: rawSourceQuote,
    quoteDigest: revision,
    contextDigest: revision,
  })
  .strict()
  .refine((anchor) => anchor.end > anchor.start, 'Text range must be nonempty');

export const workspaceMediaAnchorSchema = z
  .object({ baseRevision: revision, anchor: artifactReviewAnchorSchema })
  .strict();

export const workspaceContentAnchorSchema = z.union([
  workspaceTextAnchorSchema,
  workspaceMediaAnchorSchema,
  videoProjectReviewAnchorSchema,
]);
export type WorkspaceContentAnchor = z.infer<typeof workspaceContentAnchorSchema>;

export const workspaceContentReplySchema = z
  .object({
    id,
    body,
    author: workspaceContentActorSchema,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type WorkspaceContentReply = z.infer<typeof workspaceContentReplySchema>;

export const workspaceContentVisualMarkSchema = z
  .object({
    drawing: artifactReviewDrawingSchema,
    baseRevision: revision,
    author: workspaceContentActorSchema,
    createdAt: timestamp,
    state: z.enum(['active', 'deleted']),
    deletedAt: timestamp.optional(),
  })
  .strict();
export type WorkspaceContentVisualMark = z.infer<typeof workspaceContentVisualMarkSchema>;

export const workspaceContentAnnotationSchema = z
  .object({
    collectiveMessage: z
      .object({
        serviceInstanceId: id,
        collectiveId: id,
        eventId: id,
        channelId: id,
        rootEventId: id,
        ownerRevision: positive,
        blobDigest: revision,
      })
      .strict()
      .optional(),
    imageEdit: artifactReviewImageEditSchema.optional(),
    reanchoredFrom: z.object({ round: positive, annotationId: id }).strict().optional(),
    id,
    /** Stable operation identity allows a client to reconcile an unknown write result. */
    operationId: id.optional(),
    anchor: workspaceContentAnchorSchema,
    body,
    author: workspaceContentActorSchema,
    createdAt: timestamp,
    updatedAt: timestamp,
    state: z.enum(['open', 'resolved']),
    /** Missing on legacy records; new writes always retain the durable thread. */
    replies: z.array(workspaceContentReplySchema).max(100).optional(),
    /** F326 project-only append-only events; absent on legacy text/media annotations. */
    projectHistory: z.array(videoProjectReviewHistorySchema).min(1).max(1000).optional(),
    /** Original delivered Human message and frozen screening evidence; absent on Phase A direct opinions. */
    projectMessage: videoProjectMessageContextSchema.optional(),
  })
  .strict();
export type WorkspaceContentAnnotation = z.infer<typeof workspaceContentAnnotationSchema>;

export const workspaceContentReviewSchema = z
  .object({
    collaborationScope: z
      .object({
        kind: z.literal('collective-artifact'),
        scopeRef: id,
        serviceInstanceId: id,
        collectiveId: id,
        artifactId: id,
        sourceEventId: id.optional(),
        custodyRevision: positive.optional(),
      })
      .strict()
      .optional(),
    version: z.literal(1),
    reviewId: id,
    ownerUserId: id,
    contentRef: id,
    source: workspaceContentSourceSchema,
    /** Bounded immutable owner metadata snapshots; never source bytes or projection URLs. */
    sourceHistory: z.array(workspaceContentSourceSchema).min(1).max(maxWorkspaceContentSourceHistory).optional(),
    revision: positive,
    annotations: z.array(workspaceContentAnnotationSchema).max(maxWorkspaceContentAnnotations),
    /** Missing on legacy records; visual markup remains F309 metadata, never media bytes. */
    visualMarks: z.array(workspaceContentVisualMarkSchema).max(maxWorkspaceContentVisualMarks).optional(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict()
  .superRefine((review, context) => {
    const shared = review.source.kind === 'collective-artifact' || review.source.kind === 'collective-media';
    if (
      shared !== Boolean(review.collaborationScope) ||
      (shared && (review.sourceHistory ?? []).some((source) => source.kind !== review.source.kind)) ||
      (review.source.kind === 'collective-media' &&
        (!review.collaborationScope?.sourceEventId || !review.collaborationScope.custodyRevision))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Collective source and collaboration scope must agree',
      });
  });
export type WorkspaceContentReview = z.infer<typeof workspaceContentReviewSchema>;

export type WorkspaceContentAnnotationResolution = {
  readonly annotationId: string;
  readonly status: 'attached' | 'moved' | 'ambiguous' | 'orphaned';
  /** Each retained project location has its own version-bound resolution, including the original target. */
  readonly projectTargets?: readonly {
    readonly anchor: VideoProjectReviewAnchor;
    readonly status: 'attached' | 'moved' | 'ambiguous' | 'orphaned';
  }[];
};

export type WorkspaceContentVisualMarkResolution = {
  readonly markId: string;
  readonly status: 'attached' | 'orphaned';
};

export const workspaceContentReviewActionSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('add_visual_marks'), marks: z.array(artifactReviewDrawingSchema).min(1).max(100) })
    .strict(),
  z.object({ kind: z.literal('delete_visual_mark'), markId: id }).strict(),
  z.object({ kind: z.literal('reply'), annotationId: id, replyId: id, body }).strict(),
  z.object({ kind: z.literal('set_annotation_state'), annotationId: id, state: z.enum(['open', 'resolved']) }).strict(),
]);
export type WorkspaceContentReviewAction = z.infer<typeof workspaceContentReviewActionSchema>;

export interface WorkspaceContentReviewReceipt {
  readonly receiptRef: string;
  readonly reviewId: string;
  readonly operationId: string;
  readonly revision: number;
  readonly actor: WorkspaceContentActor;
  readonly createdAt: string;
  readonly replayed: boolean;
  /** Authority for an internal first-file preparation; no duplicate Human body is retained. */
  readonly preparationSource?: {
    readonly kind: 'human_message';
    readonly threadId: string;
    readonly messageId: string;
    readonly messageRevision: `sha256:${string}`;
  };
}

export interface WorkspaceContentReviewView {
  readonly review: WorkspaceContentReview;
  readonly sourceState: 'current' | 'changed' | 'unavailable';
  readonly currentSource?: WorkspaceContentSource;
  readonly annotationResolutions: readonly WorkspaceContentAnnotationResolution[];
  readonly visualMarkResolutions?: readonly WorkspaceContentVisualMarkResolution[];
  readonly canWrite: boolean;
  /** Fresh owner permission to append to an existing discussion, independently of version editing. */
  readonly canReply?: boolean;
  readonly historyReadOnly?: boolean;
}
