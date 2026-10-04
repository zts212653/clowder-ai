import type { ArtifactReview } from '@cat-cafe/shared';
import { ArtifactReviewError } from '../../artifact-review/errors.js';
import { currentReviewModification } from '../../artifact-review/modification-request-reference.js';
import type { ArtifactReviewStore } from '../../artifact-review/store.js';

export interface ModificationSupersession {
  requestId: string;
  requestReceiptRef: string;
  cancellationReceiptRef: string;
}

/** Replace only this cancelled decision. Version, Task, ledger and other work are untouched. */
export function cancelledModificationReplacement(
  store: ArtifactReviewStore,
  review: ArtifactReview,
  roundNumber: number,
): ModificationSupersession | null {
  const round = review.rounds.at(-1);
  if (!round || round.number !== roundNumber || round.state !== 'changes_requested') return null;
  const prior = currentReviewModification(store, review);
  if (
    !prior ||
    prior.progress.review?.round !== roundNumber ||
    prior.control?.taskResolution !== 'preserved' ||
    prior.control.actorId !== review.task.ownerUserId ||
    round.decision?.receiptRef !== prior.progress.review.receiptRef
  )
    return null;
  return {
    requestId: prior.requestId,
    requestReceiptRef: prior.progress.review.receiptRef,
    cancellationReceiptRef: prior.control.receiptRef,
  };
}

/** Called again in the same SQLite transaction that commits the new decision, journal binding and single outbox. */
export function assertModificationSupersession(
  store: ArtifactReviewStore,
  review: ArtifactReview,
  round: number,
  expected: ModificationSupersession,
) {
  const current = cancelledModificationReplacement(store, review, round);
  if (
    !current ||
    current.requestId !== expected.requestId ||
    current.requestReceiptRef !== expected.requestReceiptRef ||
    current.cancellationReceiptRef !== expected.cancellationReceiptRef
  )
    throw new ArtifactReviewError('request_superseded');
}
