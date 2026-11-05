import {
  collectiveMediaReviewCommandSchema,
  type WorkspaceContentReview,
  type WorkspaceContentReviewAction,
} from '@cat-cafe/shared';
import { WorkspaceContentReviewError } from '../workspace-review/errors.js';
import { applyWorkspaceReviewAction } from '../workspace-review/workspace-review-actions.js';
import { assertWorkspaceMediaAnchor, workspaceAnnotationId } from '../workspace-review/workspace-review-anchors.js';
import { appendWorkspaceSourceHistory } from '../workspace-review/workspace-review-mutations.js';
import type { AdmittedCollectiveMedia } from './media-authority.js';
import { mediaConstraintScope } from './media-authority.js';
import type { CollectiveMediaReviews } from './media-reviews.js';
import { collectiveMediaSource } from './media-source.js';

export async function actOnCollectiveMediaReview(
  admitted: AdmittedCollectiveMedia,
  unsafe: unknown,
  reviews: CollectiveMediaReviews,
) {
  if (admitted.constraint.agent) throw new WorkspaceContentReviewError('access_denied');
  const input = collectiveMediaReviewCommandSchema.parse(unsafe),
    action = input.action;
  const review = reviews.require(mediaConstraintScope(admitted.constraint), admitted.asset);
  const source = collectiveMediaSource(admitted.asset);
  const actor = { kind: 'human' as const, actorId: admitted.constraint.humanId },
    now = new Date().toISOString();
  const annotationId =
    action.kind === 'annotate' ? workspaceAnnotationId(review.reviewId, admitted.operationId) : action.annotationId;
  const annotation = review.annotations.find((item) => item.id === annotationId);
  if (action.kind !== 'annotate' && !annotation) throw new WorkspaceContentReviewError('not_found');
  if (
    action.kind === 'reply' &&
    (admitted.constraint.mediaReviewReply?.annotationId !== annotationId ||
      annotation?.anchor.baseRevision !== source.revision)
  )
    throw new WorkspaceContentReviewError('access_denied');
  const mutation = {
    reviewId: review.reviewId,
    expectedRevision: input.expectedReviewRevision,
    operationId: admitted.operationId,
    actor,
    now,
    kind: `collective-media:${action.kind}`,
    request: { source, action },
  };
  await admitted.authorize();
  const replay = reviews.store.replay(mutation);
  if (replay) return { receipt: replay.receipt, annotationId, ownerRevision: admitted.asset.ownerRevision };
  if (action.kind !== 'reply') await admitted.authorize(true);
  const change = (current: WorkspaceContentReview): WorkspaceContentReview => {
    if (action.kind !== 'reply' && current.source.revision !== source.revision)
      current = { ...current, source, sourceHistory: appendWorkspaceSourceHistory(current, source) };
    if (action.kind === 'annotate') {
      assertWorkspaceMediaAnchor(source, action.anchor);
      return {
        ...current,
        annotations: [
          ...current.annotations,
          {
            id: annotationId,
            operationId: admitted.operationId,
            body: action.body,
            anchor: { baseRevision: source.revision, anchor: action.anchor },
            author: actor,
            createdAt: now,
            updatedAt: now,
            state: 'open',
            replies: [],
          },
        ],
      };
    }
    if (action.kind === 'edit_annotation') {
      assertMediaAuthor(annotation?.author, actor.actorId, annotation?.anchor.baseRevision, source.revision);
      return {
        ...current,
        annotations: current.annotations.map((item) =>
          item.id === annotationId ? { ...item, body: action.body, updatedAt: now } : item,
        ),
      };
    }
    if (action.kind === 'edit_reply') {
      const reply = annotation?.replies?.find((item) => item.id === action.replyId);
      assertMediaAuthor(reply?.author, actor.actorId, annotation?.anchor.baseRevision, source.revision);
      return {
        ...current,
        annotations: current.annotations.map((item) =>
          item.id === annotationId
            ? {
                ...item,
                updatedAt: now,
                replies: item.replies?.map((reply) =>
                  reply.id === action.replyId ? { ...reply, body: action.body, updatedAt: now } : reply,
                ),
              }
            : item,
        ),
      };
    }
    if (annotation?.anchor.baseRevision !== source.revision) throw new WorkspaceContentReviewError('source_changed');
    const command: WorkspaceContentReviewAction =
      action.kind === 'reply' ? { ...action, replyId: admitted.operationId } : action;
    return applyWorkspaceReviewAction({ review: current, source, actor, now, action: command });
  };
  const result = reviews.store.mutate(mutation, (current) => ({
    ...change(current),
    revision: current.revision + 1,
    updatedAt: now,
  }));
  return { receipt: result.receipt, annotationId, ownerRevision: admitted.asset.ownerRevision };
}

function assertMediaAuthor(
  author: WorkspaceContentReview['annotations'][number]['author'] | undefined,
  humanId: string,
  baseRevision: string | undefined,
  selectedRevision: string,
) {
  if (author?.kind !== 'human' || author.actorId !== humanId || baseRevision !== selectedRevision)
    throw new WorkspaceContentReviewError('access_denied');
}
