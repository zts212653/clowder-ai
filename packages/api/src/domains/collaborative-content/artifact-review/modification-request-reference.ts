import type { ArtifactReview, ArtifactReviewAuditActor } from '@cat-cafe/shared';
import { ArtifactReviewError } from './errors.js';
import type { ArtifactReviewStore } from './store.js';

/** The journal binding committed with the review is the request authority; no second mutable round pointer. */
export function reviewModificationBindings(
  store: ArtifactReviewStore,
  review: ArtifactReview,
  round = review.rounds.at(-1)?.number,
) {
  if (!round) return [];
  const bindings = store.requests
    .forSource(review.task.ownerUserId, {
      kind: 'artifact-review',
      reviewId: review.reviewId,
      round,
      expectedReviewRevision: review.revision,
    })
    .filter(
      (record) =>
        record.progress.prepared?.kind === 'media' &&
        record.progress.task?.taskId === review.task.taskId &&
        record.payload.threadId === review.task.threadId &&
        record.progress.review?.reviewId === review.reviewId &&
        record.progress.review.round !== undefined &&
        record.progress.review.round <= round,
    )
    .map((record) => {
      const receipt = store.reviewReceipt(review.reviewId, record.progress.review!.receiptRef);
      if (!receipt || receipt.receiptRef !== record.progress.review!.receiptRef)
        throw new Error('Modification binding has no matching canonical review receipt');
      return { record, revision: receipt.revision };
    })
    .filter((binding) => binding.revision <= review.revision)
    .sort((a, b) => b.revision - a.revision);
  if (bindings[0] && bindings[1] && bindings[1].revision === bindings[0].revision)
    throw new Error('Multiple modification requests share one review commit revision');
  return bindings;
}

export function currentReviewModification(store: ArtifactReviewStore, review: ArtifactReview, round?: number) {
  return reviewModificationBindings(store, review, round)[0]?.record ?? null;
}

export function assertModificationResponseReference(
  store: ArtifactReviewStore,
  review: ArtifactReview,
  command: { requestId?: unknown },
  actor: ArtifactReviewAuditActor,
) {
  const current = store.get(review.reviewId);
  if (!current) throw new ArtifactReviewError('not_found');
  const request = currentReviewModification(store, current);
  if (!request && command.requestId === undefined) return; // Pre-F309 Task reviews retain their original contract.
  if (
    !request ||
    command.requestId !== request.requestId ||
    actor.kind !== 'cat' ||
    actor.actorId !== request.payload.targetCatId
  )
    throw new ArtifactReviewError('request_superseded');
  if (request.control) throw new ArtifactReviewError('request_cancelled');
}
