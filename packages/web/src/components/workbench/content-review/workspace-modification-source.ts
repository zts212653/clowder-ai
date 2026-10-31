import type { ContentModificationRequest } from '@cat-cafe/shared';
import type { ContentReviewView } from './content-review-contract';

/**
 * The exact source a content-modification request names for a workspace, publication or evolution review. The same
 * value is the `source` of a media chat attachment, so "请猫修改" and 「引用到聊天」 can never name different versions.
 * It reads the review's own source (the version that was reviewed), not a newer current source.
 */
export function workspaceReviewRequestSource(view: ContentReviewView): ContentModificationRequest['source'] {
  const source = view.review.source;
  if (source.kind === 'collective-artifact' || source.kind === 'collective-media')
    throw new Error('Collective modification requires its shared content owner');
  if (source.kind === 'video-project') throw new Error('Video project modification requires its project service');
  if (source.kind === 'publication')
    return {
      kind: 'publication',
      contentRef: source.publication.contentRef,
      ownerRevision: source.publication.ownerRevision,
      ledgerRef: view.review.reviewId,
      expectedLedgerRevision: view.review.revision,
    };
  if (source.kind === 'evolution')
    return {
      kind: 'evolution',
      locator: source.locator,
      expectedSourceRevision: source.revision,
      reviewId: view.review.reviewId,
      expectedReviewRevision: view.review.revision,
    };
  return {
    kind: 'workspace',
    locator: source.locator,
    expectedSourceRevision: source.revision,
    reviewId: view.review.reviewId,
    expectedReviewRevision: view.review.revision,
  };
}
