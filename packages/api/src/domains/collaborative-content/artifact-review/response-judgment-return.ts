import type { ArtifactReviewView, ContentModificationProgress } from '@cat-cafe/shared';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import type { ReviewReturnIntent } from './return-store.js';
import type { ArtifactReviewStore } from './store.js';

/** A saved Human judgment follows its exact result, independently of a later unreviewed owner head. */
export function responseJudgmentIsCurrent(view: ArtifactReviewView, intent: ReviewReturnIntent): boolean {
  const round = view.review.rounds.find((item) => item.number === intent.round);
  return (
    (view.authority.state === 'current' || view.authority.state === 'asset_changed') &&
    !view.pendingVersion &&
    view.authority.taskRevision === intent.expectedTaskRevision &&
    view.authority.ownerCatId === intent.targetCatId &&
    round?.asset.ownerRevision === intent.ownerRevision &&
    round.responses.some((response) => response.judgment?.receiptRef === intent.receiptRef)
  );
}

/** Preserve the existing request's audience; a missing sealed audience cannot authorize a public return. */
export function responseJudgmentAudience(
  store: ArtifactReviewStore,
  intent: ReviewReturnIntent,
): ContentModificationProgress['sourceVisibility'] {
  const review = store.get(intent.reviewId);
  const round = review?.rounds.find((item) => item.number === intent.round);
  const requestId = round?.responseSource?.requestId;
  if (!requestId) return undefined;
  const request = store.requests.get(requestId, intent.ownerUserId);
  const audience = request?.progress.sourceVisibility;
  if (
    !request ||
    !audience ||
    request.payload.targetCatId !== intent.targetCatId ||
    request.payload.threadId !== intent.threadId ||
    request.progress.review?.reviewId !== intent.reviewId ||
    request.progress.review.round !== round?.responseSource?.round
  )
    throw new MediaOwnerError('access_denied');
  return audience;
}
