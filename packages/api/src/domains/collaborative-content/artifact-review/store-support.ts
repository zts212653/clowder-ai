import { createHash } from 'node:crypto';
import type { ArtifactReview } from '@cat-cafe/shared';
import { ArtifactReviewError } from './errors.js';
import type { PendingReviewVersion, ReviewMutation } from './store.js';

export function receiptReference(reviewId: string, operationId: string): string {
  return `content-review:${reviewId}:receipt:${createHash('sha256').update(operationId).digest('hex')}`;
}

export function fingerprint(input: ReviewMutation): string {
  return createHash('sha256')
    .update(JSON.stringify([input.actor, input.expectedRevision, input.round, input.kind, input.request]))
    .digest('hex');
}

export function assertReservation(
  pending: PendingReviewVersion | null,
  input: ReviewMutation,
  completing: boolean,
): void {
  if (pending && (!completing || pending.input.operationId !== input.operationId))
    throw new ArtifactReviewError('version_pending');
  if (completing && (!pending || fingerprint(pending.input) !== fingerprint(input)))
    throw new ArtifactReviewError('operation_reused');
}

export function assertSameReservation(pending: PendingReviewVersion, input: ReviewMutation): void {
  if (pending.input.operationId !== input.operationId) throw new ArtifactReviewError('version_pending');
  if (fingerprint(pending.input) !== fingerprint(input)) throw new ArtifactReviewError('operation_reused');
}

export function assertReviewSuccessor(current: ArtifactReview, next: ArtifactReview): void {
  if (
    next.revision !== current.revision + 1 ||
    next.reviewId !== current.reviewId ||
    next.contentRef !== current.contentRef ||
    next.task.ownerUserId !== current.task.ownerUserId ||
    next.task.threadId !== current.task.threadId ||
    next.task.taskId !== current.task.taskId
  ) {
    throw new ArtifactReviewError('invalid_action');
  }
}

export function auditPredecessor(review: ArtifactReview, input: ReviewMutation): unknown {
  const round = review.rounds.find((item) => item.number === input.round);
  if (!round) return undefined;
  const request = input.request as { action?: { annotationId?: string; replyId?: string } } | null;
  const action = request?.action;
  if (action?.annotationId) {
    const annotation = round.annotations.find((item) => item.id === action.annotationId);
    if (action.replyId) return annotation?.replies.find((item) => item.id === action.replyId);
    return annotation;
  }
  return {
    state: round.state,
    judgmentRequest: round.judgmentRequest,
    decision: round.decision,
    attentionRetiredReason: round.attentionRetiredReason,
  };
}
