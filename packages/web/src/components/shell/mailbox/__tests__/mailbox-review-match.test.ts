import type { ArtifactReviewView, UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import { expect, it } from 'vitest';
import { matchesMailboxReview, readMailboxReviewSource } from '../mailbox-review-match';
import { REVIEW_OWNER, reviewItem, reviewView } from './mailbox-review-fixtures';

it('binds the typed current receipt to the same owner, review and Task revision', () => {
  const source = readMailboxReviewSource(reviewItem(), REVIEW_OWNER);
  expect(source).not.toBeNull();
  expect(source && matchesMailboxReview(source, reviewView())).toBe(true);
});

it('refuses an undecodable source instead of throwing inside a mailbox row', () => {
  const item = reviewItem();
  delete (item.linkedNeedsMe[0].receipt as Partial<(typeof item.linkedNeedsMe)[0]['receipt']>).taskRef;
  expect(readMailboxReviewSource(item, REVIEW_OWNER)).toBeNull();
  const malformed: unknown = { ...reviewItem(), linkedNeedsMe: [null, { receipt: {} }] };
  expect(readMailboxReviewSource(malformed as UnifiedAttentionItemV1, REVIEW_OWNER)).toBeNull();
});

const badSource: [string, (item: UnifiedAttentionItemV1) => void][] = [
  [
    'ordinary judgment',
    (item) => {
      item.linkedNeedsMe[0].receipt.producer.producerId = 'f292.repair';
    },
  ],
  [
    'wrong decision',
    (item) => {
      item.decisionRef = 'f309.content_review:another-review';
    },
  ],
  [
    'foreign owner',
    (item) => {
      item.linkedNeedsMe[0].ownerRead.envelope.visibility.ownerUserId = 'another-owner';
    },
  ],
  [
    'stale source',
    (item) => {
      item.linkedNeedsMe[0].ownerRead.envelope.freshness = { state: 'stale', observedRevision: 8 };
    },
  ],
  [
    'Task drift',
    (item) => {
      item.linkedNeedsMe[0].receipt.taskRef.observedRevision = 9;
    },
  ],
  [
    'action drift',
    (item) => {
      item.linkedNeedsMe[0].receipt.action = { actionRef: 'content-review:review-native', expectedProducerRevision: 6 };
    },
  ],
  [
    'unavailable action',
    (item) => {
      delete item.linkedNeedsMe[0].receipt.action;
    },
  ],
  [
    'ineligible',
    (item) => {
      item.linkedNeedsMe[0].receipt.eligible = false;
    },
  ],
  [
    'ambiguous receipt',
    (item) => {
      item.linkedNeedsMe.push(structuredClone(item.linkedNeedsMe[0]));
    },
  ],
];
it.each(badSource)('never opens a writer from %s', (_label, change) => {
  const item = reviewItem();
  change(item);
  expect(readMailboxReviewSource(item, REVIEW_OWNER)).toBeNull();
});

const badView: [string, (view: ArtifactReviewView) => void][] = [
  [
    'another review',
    (view) => {
      view.review.reviewId = 'another-review';
    },
  ],
  [
    'new review revision',
    (view) => {
      view.review.revision = 6;
    },
  ],
  [
    'foreign owner',
    (view) => {
      view.review.task.ownerUserId = 'another-owner';
    },
  ],
  [
    'different Task',
    (view) => {
      view.review.task.taskId = 'another-task';
    },
  ],
  [
    'new Task revision',
    (view) => {
      view.authority.taskRevision = 9;
    },
  ],
  [
    'read-only authority',
    (view) => {
      view.authority.canWrite = false;
    },
  ],
  [
    'changed asset',
    (view) => {
      view.authority.state = 'asset_changed';
    },
  ],
  [
    'pending publication',
    (view) => {
      view.pendingVersion = true;
    },
  ],
  [
    'old requested round',
    (view) => {
      view.review.rounds.push({
        ...structuredClone(view.review.rounds[0]),
        number: 2,
        state: 'draft',
        judgmentRequest: undefined,
      });
    },
  ],
  [
    'retired attention',
    (view) => {
      view.review.rounds[0].attentionRetiredReason = 'task_closed';
    },
  ],
];
it.each(badView)('keeps the original writer locked after %s', (_label, change) => {
  const source = readMailboxReviewSource(reviewItem(), REVIEW_OWNER);
  if (!source) throw new Error('Expected the original current source fixture');
  const view = reviewView();
  change(view);
  expect(matchesMailboxReview(source, view)).toBe(false);
});
