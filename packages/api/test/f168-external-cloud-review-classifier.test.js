import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyExternalCloudReview } from '../dist/domains/community/external-review/external-cloud-review-classifier.js';

const currentHeadSha = 'head-current';
const knownCloudReviewer = 'chatgpt-codex-connector[bot]';

const eventWait = (overrides = {}) => ({
  v: 1,
  invocationId: 'invocation-1',
  threadId: 'thread-1',
  ownerCatId: 'codex-sol',
  subjectKey: 'pr:acme/widgets#7',
  expectedSignal: 'review_posted',
  triggerHeadSha: currentHeadSha,
  coverage: {
    status: 'covered',
    kind: 'github_review_trigger_eyes',
    triggerCommentId: 70,
    observedAt: 1_000,
  },
  ...overrides,
});

const review = (overrides = {}) => ({
  id: 71,
  author: knownCloudReviewer,
  state: 'COMMENTED',
  body: '',
  submittedAt: '2026-07-14T19:00:00.000Z',
  commitId: currentHeadSha,
  ...overrides,
});

const comment = (overrides = {}) => ({
  id: 72,
  reviewId: 71,
  author: knownCloudReviewer,
  body: 'P1: current-head finding',
  createdAt: '2026-07-14T19:00:01.000Z',
  commitId: currentHeadSha,
  commentType: 'inline',
  ...overrides,
});

const classify = (overrides = {}) =>
  classifyExternalCloudReview({
    currentHeadSha,
    eventWait: eventWait(),
    comments: [],
    reviews: [],
    knownCloudReviewerLogins: [knownCloudReviewer],
    now: 2_000,
    timeoutMs: 60_000,
    ...overrides,
  });

describe('F168 external cloud-review classifier', () => {
  it('reports a covered current-head request as running without consuming unrelated feedback', () => {
    const result = classify();

    assert.deepEqual(result.observation, {
      headSha: currentHeadSha,
      status: 'running',
      triggerCommentId: 70,
    });
    assert.deepEqual(result.correlatedCommentIds, []);
    assert.deepEqual(result.correlatedReviewIds, []);
  });

  it('correlates inline findings to an exact current-head cloud review and reports blocking', () => {
    const result = classify({ comments: [comment()], reviews: [review()] });

    assert.deepEqual(result.observation, {
      headSha: currentHeadSha,
      status: 'blocking',
      triggerCommentId: 70,
      reviewId: 71,
    });
    assert.deepEqual(result.correlatedCommentIds, [72]);
    assert.deepEqual(result.correlatedReviewIds, [71]);
  });

  it('reports an exact current-head cloud decision with no inline findings as clean', () => {
    const result = classify({ reviews: [review()] });

    assert.deepEqual(result.observation, {
      headSha: currentHeadSha,
      status: 'clean',
      triggerCommentId: 70,
      reviewId: 71,
    });
    assert.deepEqual(result.correlatedReviewIds, [71]);
  });

  it('does not correlate stale-head reviews or a wait registered for another head', () => {
    const stale = classify({
      comments: [comment({ commitId: 'head-old' })],
      reviews: [review({ commitId: 'head-old' })],
    });
    assert.equal(stale.observation.status, 'running');
    assert.deepEqual(stale.correlatedCommentIds, []);
    assert.deepEqual(stale.correlatedReviewIds, []);

    const mismatchedWait = classify({ eventWait: eventWait({ triggerHeadSha: 'head-old' }) });
    assert.equal(mismatchedWait.observation, null);
  });

  it('never consumes feedback from an unknown bot and fails closed after timeout', () => {
    const result = classify({
      comments: [comment({ author: 'dependabot[bot]' })],
      reviews: [review({ author: 'dependabot[bot]' })],
      now: 61_001,
    });

    assert.deepEqual(result.observation, {
      headSha: currentHeadSha,
      status: 'failed_or_timeout',
      triggerCommentId: 70,
    });
    assert.deepEqual(result.correlatedCommentIds, []);
    assert.deepEqual(result.correlatedReviewIds, []);
  });
});
