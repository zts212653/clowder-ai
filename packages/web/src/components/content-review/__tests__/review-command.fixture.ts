import type { ArtifactReviewCommand, ArtifactReviewView } from '@cat-cafe/shared';
import { reviewDraftPrefix } from '../review-access-invalidation';

export const REVIEW_ID = `review-${'a'.repeat(64)}`;
export const prefix = reviewDraftPrefix('operator', REVIEW_ID);
export const draftKey = `${prefix}round:1:annotation`;
export const command: ArtifactReviewCommand = {
  reviewId: REVIEW_ID,
  expectedRevision: 1,
  expectedTaskRevision: 1,
  round: 1,
  operationId: 'stable-save',
  action: {
    kind: 'annotate',
    annotationId: 'mark',
    anchor: { kind: 'image-region', x: 1, y: 1, width: 5, height: 5 },
    body: '同一个人的草稿',
  },
};
export const initial: ArtifactReviewView = {
  review: {
    version: 1,
    reviewId: REVIEW_ID,
    revision: 1,
    title: '封面',
    contentRef: 'content-one',
    task: { taskId: 'task-one', threadId: 'thread-one', ownerUserId: 'operator', observedRevision: 1 },
    createdAt: '2026-09-07T14:00:00Z',
    updatedAt: '2026-09-07T14:00:00Z',
    rounds: [
      {
        number: 1,
        openedAt: '2026-09-07T14:00:00Z',
        state: 'draft',
        annotations: [],
        responses: [],
        asset: {
          contentRef: 'content-one',
          ownerRevision: 1,
          blobDigest: `sha256:${'a'.repeat(64)}`,
          mediaType: 'image/png',
          media: { kind: 'image', width: 100, height: 100 },
          ownerReceiptRef: 'receipt:one',
          sourcePublication: { artifactRef: '/uploads/one.png', sourceRef: 'message:thread-one:one', revision: '1' },
        },
      },
    ],
  },
  pendingVersion: false,
  authority: { state: 'current', taskRevision: 1, ownerCatId: 'codex-astra', canWrite: true },
  continuation: {
    taskId: 'task-one',
    expectedRevision: 1,
    artifactRef: 'content:content-one',
    reviewEvidenceRef: 'review:one',
    ownerCatId: 'codex-astra',
  },
};

export function appliedResult(view: ArtifactReviewView, sent: ArtifactReviewCommand) {
  return {
    view,
    receipt: {
      reviewId: sent.reviewId,
      operationId: sent.operationId,
      revision: sent.expectedRevision + 1,
      outcome: 'applied',
      receiptRef: 'receipt:committed',
      actor: { kind: 'human', actorId: view.review.task.ownerUserId },
      createdAt: '2026-10-17T00:00:00Z',
    },
  };
}
