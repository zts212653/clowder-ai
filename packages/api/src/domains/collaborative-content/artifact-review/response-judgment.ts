import type { ArtifactReview, ArtifactReviewAction, ArtifactReviewActor, ArtifactReviewRound } from '@cat-cafe/shared';
import { ArtifactReviewError } from './errors.js';

export function judgeResponse(
  review: ArtifactReview,
  result: ArtifactReviewRound,
  action: Extract<ArtifactReviewAction, { kind: 'judge_response' }>,
  context: { actor: ArtifactReviewActor; now: string; receiptRef: string },
): void {
  if (context.actor.kind !== 'human') throw new ArtifactReviewError('human_required');
  const sourceNumber = result.responseSource?.round ?? result.number - 1;
  const source = review.rounds.find((item) => item.number === sourceNumber);
  const response = result.responses.find((item) => item.annotationId === action.annotationId);
  const original = source?.annotations.find((item) => item.id === action.annotationId);
  if (sourceNumber !== action.sourceRound || result.asset.ownerRevision !== action.resultOwnerRevision)
    throw new ArtifactReviewError('asset_changed');
  if (!source || !response || !original) throw new ArtifactReviewError('invalid_action');
  if (
    review.rounds.some(
      (item) =>
        item.number > result.number &&
        (item.responseSource?.round ?? item.number - 1) === sourceNumber &&
        item.responses.some((row) => row.annotationId === action.annotationId),
    )
  )
    throw new ArtifactReviewError('asset_changed', 'A newer response exists for this opinion');
  response.judgment = {
    outcome: action.outcome,
    actor: context.actor,
    decidedAt: context.now,
    receiptRef: context.receiptRef,
  };
  original.state = action.outcome === 'accepted' ? 'resolved' : 'open';
  original.updatedAt = context.now;
}
