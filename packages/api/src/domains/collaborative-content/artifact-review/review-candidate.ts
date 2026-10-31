import type { ArtifactReview, ReviewedMediaAsset, TaskItem } from '@cat-cafe/shared';
import { publicationLedgerId } from './canonical-ledger.js';
import { reviewIdentity } from './review-authority.js';

/** No writes: the request coordinator can bind this candidate inside its ledger/outbox transaction. */
export function createReviewCandidate(input: {
  task: TaskItem;
  asset: ReviewedMediaAsset;
  ownerUserId: string;
  taskRevision: number;
  now: string;
  linkedLedger: boolean;
}): ArtifactReview {
  const { task, asset, ownerUserId, taskRevision, now, linkedLedger } = input;
  return {
    version: linkedLedger ? 3 : 1,
    reviewId: reviewIdentity(task.id, asset.contentRef),
    revision: 1,
    title: task.title,
    contentRef: asset.contentRef,
    task: { taskId: task.id, threadId: task.threadId, ownerUserId, observedRevision: taskRevision },
    rounds: [
      {
        number: 1,
        asset,
        openedAt: now,
        state: 'draft',
        annotations: [],
        responses: [],
        ...(linkedLedger ? { ledgerRef: publicationLedgerId(ownerUserId, asset) } : {}),
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}
