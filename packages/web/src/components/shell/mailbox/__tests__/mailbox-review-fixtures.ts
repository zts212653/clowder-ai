import type { ArtifactReviewView, UnifiedAttentionItemV1 } from '@cat-cafe/shared';

export const REVIEW_OWNER = 'owner-review';
export const REVIEW_ID = 'review-native';

export function reviewView(): ArtifactReviewView {
  return {
    review: {
      version: 1,
      reviewId: REVIEW_ID,
      revision: 5,
      title: '封面提案',
      task: { taskId: 'review-task', threadId: 'review-thread', ownerUserId: REVIEW_OWNER, observedRevision: 8 },
      contentRef: 'content-cover',
      createdAt: '2026-10-14T12:00:00Z',
      updatedAt: '2026-10-14T12:00:00Z',
      rounds: [
        {
          number: 1,
          openedAt: '2026-10-14T12:00:00Z',
          state: 'awaiting_human',
          annotations: [],
          responses: [],
          judgmentRequest: {
            summary: '请核对这版封面',
            judgmentNeeded: '标题是否清楚',
            requestedBy: { kind: 'cat', actorId: 'codex61-sol' },
            requestedAt: '2026-10-14T12:00:00Z',
          },
          asset: {
            contentRef: 'content-cover',
            ownerRevision: 1,
            blobDigest: `sha256:${'a'.repeat(64)}`,
            mediaType: 'image/png',
            media: { kind: 'image', width: 100, height: 100 },
            ownerReceiptRef: 'receipt:cover',
            sourcePublication: {
              artifactRef: '/uploads/cover.png',
              sourceRef: 'message:review-thread:cover',
              revision: '1',
            },
          },
        },
      ],
    },
    pendingVersion: false,
    authority: { state: 'current', canWrite: true, taskRevision: 8, ownerCatId: 'codex61-sol' },
    continuation: {
      taskId: 'review-task',
      expectedRevision: 8,
      artifactRef: 'content:content-cover',
      reviewEvidenceRef: 'review:cover',
      ownerCatId: 'codex61-sol',
    },
  };
}

export function reviewItem(): UnifiedAttentionItemV1 {
  return {
    decisionRef: `f309.content_review:${REVIEW_ID}`,
    kind: 'judgment',
    summary: '标题是否清楚',
    linkedNeedsMe: [
      {
        ownerRead: {
          envelope: {
            subjectRef: 'task:work:review-task',
            revision: 8,
            visibility: { ownerUserId: REVIEW_OWNER },
            freshness: { state: 'current', observedRevision: 8 },
          },
          work: { title: '封面提案', ownerCatId: 'codex61-sol' },
          attentionReceipts: [],
        },
        receipt: {
          eligible: true,
          kind: 'judgment',
          producer: { producerId: 'f309.content_review', subjectRef: REVIEW_ID, revision: 5 },
          taskRef: { subjectRef: 'task:work:review-task', observedRevision: 8 },
          action: { actionRef: `content-review:${REVIEW_ID}`, expectedProducerRevision: 5 },
        },
      },
    ],
  };
}
