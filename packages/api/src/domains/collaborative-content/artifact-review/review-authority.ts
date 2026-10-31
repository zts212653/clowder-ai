import { createHash } from 'node:crypto';
import type { ArtifactReview, ArtifactReviewView, TaskItem } from '@cat-cafe/shared';

export function reviewIdentity(taskId: string, contentRef: string): string {
  return `review-${createHash('sha256')
    .update(JSON.stringify([taskId, contentRef]))
    .digest('hex')}`;
}

export function reviewRetainsArtifact(review: ArtifactReview, artifactRef: string): boolean {
  return (
    artifactRef === `content:${review.contentRef}` ||
    review.rounds.some((round) => round.asset.sourcePublication.artifactRef === artifactRef)
  );
}

export function isCurrentArtifactLinked(task: TaskItem, review: ArtifactReview): boolean {
  const refs = task.entrustedWork?.artifactRefs;
  return (
    refs?.length === 1 &&
    (refs[0] === `content:${review.contentRef}` ||
      refs[0] === review.rounds.at(-1)?.asset.sourcePublication.artifactRef)
  );
}

export function isLineageLinked(task: TaskItem, review: ArtifactReview): boolean {
  const refs = task.entrustedWork?.artifactRefs;
  return (
    isCurrentArtifactLinked(task, review) ||
    (refs?.length === 1 && refs[0] === review.rounds[0]?.asset.sourcePublication.artifactRef)
  );
}

export function reviewAuthorityState(
  review: ArtifactReview,
  task: TaskItem,
  currentOwnerRevision: number,
): ArtifactReviewView['authority']['state'] {
  if (task.status === 'done' || task.entrustedWork?.closure.state !== 'open') return 'task_closed';
  const round = review.rounds.at(-1);
  if (
    !task.ownerCatId ||
    task.entrustedWork?.revision !== review.task.observedRevision ||
    !isLineageLinked(task, review)
  )
    return 'task_changed';
  if (round?.state === 'awaiting_human' && round.judgmentRequest?.requestedBy.actorId !== task.ownerCatId)
    return 'task_changed';
  return round?.asset.ownerRevision === currentOwnerRevision ? 'current' : 'asset_changed';
}
