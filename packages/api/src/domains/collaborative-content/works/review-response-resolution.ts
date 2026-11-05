import type { ArtifactReview, WorkCommand } from '@cat-cafe/shared';
import type { ContentSettlementReceiptV1 } from '../../video-studio/content-owner/types.js';
import { ArtifactReviewError } from '../artifact-review/errors.js';
import type { ArtifactReviewStore } from '../artifact-review/store.js';
import { receiptReference } from '../artifact-review/store-support.js';

export type WorkResponseResolution = Extract<WorkCommand, { action: 'resolve-review-submission' }>;
/** A concurrent authorized reader may already have projected the receipt before the resolver takes its lock. */
export function completedWorkResponseResolution(
  store: ArtifactReviewStore,
  review: ArtifactReview,
  command: WorkResponseResolution,
  receipt: ContentSettlementReceiptV1,
) {
  const recorded = store.reviewReceipt(review.reviewId, receiptReference(review.reviewId, command.pendingOperationId));
  const version = store.works.get(review.task.ownerUserId, review.contentRef, receipt.ownerRevision);
  const round = review.rounds.find((item) => item.asset.ownerReceiptRef === receipt.receiptId);
  if (
    recorded?.outcome !== 'applied' ||
    recorded.operationId !== command.pendingOperationId ||
    receipt.operationContext?.kind !== 'work:submit' ||
    version?.operationId !== command.pendingOperationId ||
    version.requestDigest !== receipt.operationContext.requestDigest ||
    version.receiptRef !== receipt.receiptId ||
    round?.responseSource?.round !== command.sourceRound ||
    round.responseSource.reviewRevision !== command.expectedReviewRevision ||
    recorded.revision !== command.expectedReviewRevision + 1
  )
    throw new ArtifactReviewError('revision_conflict');
  return {
    status: 'saved' as const,
    reference: { contentRef: receipt.contentRef, ownerRevision: receipt.ownerRevision },
    receipt,
    version,
    review: { review, receipt: recorded, replayed: true },
  };
}
