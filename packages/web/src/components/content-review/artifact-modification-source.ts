import type { ArtifactReviewRound, ArtifactReviewView, ContentModificationRequest } from '@cat-cafe/shared';
import { type MediaChatTarget, mediaChatTarget } from './media-chat-selection';

/** What 「引用到聊天」 names for a media round: the same source and Task a modification request names. */
export function artifactRoundChatTarget(
  view: ArtifactReviewView,
  round: ArtifactReviewRound,
  title = view.review.title,
): MediaChatTarget | null {
  const named = artifactRoundRequestSource(view, round);
  return named
    ? mediaChatTarget({
        title,
        mime: round.asset.mediaType,
        source: named.source,
        taskContext: named.taskContext,
      })
    : null;
}

/**
 * The exact source and Task a media round is modified under. The same value is the `source` and `taskContext` of a
 * media chat attachment, so "请猫修改" and 「引用到聊天」 name the same round, ledger and Task. Null while the ledger
 * version of a published round has not been verified: nothing is guessed in its place.
 */
export function artifactRoundRequestSource(
  view: ArtifactReviewView,
  round: ArtifactReviewRound,
): {
  source: ContentModificationRequest['source'];
  taskContext: {
    kind: 'media';
    taskId: string;
    expectedTaskRevision: number;
    reviewId: string;
    expectedReviewRevision: number;
    round: number;
  };
} | null {
  if (round.ledgerRef && round.ledgerRevision === undefined) return null;
  const source: ContentModificationRequest['source'] = round.ledgerRef
    ? {
        kind: 'publication',
        contentRef: round.asset.contentRef,
        ownerRevision: round.asset.ownerRevision,
        ledgerRef: round.ledgerRef,
        expectedLedgerRevision: round.ledgerRevision ?? 0,
      }
    : {
        kind: 'artifact-review',
        reviewId: view.review.reviewId,
        round: round.number,
        expectedReviewRevision: view.review.revision,
      };
  return {
    source,
    taskContext: {
      kind: 'media',
      taskId: view.review.task.taskId,
      expectedTaskRevision: view.authority.taskRevision,
      reviewId: view.review.reviewId,
      expectedReviewRevision: view.review.revision,
      round: round.number,
    },
  };
}
