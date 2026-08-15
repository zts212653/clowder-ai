import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyExternalCloudReview } from '../dist/domains/community/external-review/external-cloud-review-classifier.js';

const currentHeadSha = '6908af814bbbfa52803f43db7c6968fa7c25cc00';
const knownCloudReviewer = 'chatgpt-codex-connector[bot]';

const awaitState = (overrides = {}) => ({
  v: 1,
  generation: 1,
  subjectRef: 'pr:acme/widgets#7',
  ownerFence: { kind: 'containing_task', generation: 1 },
  baseline: {
    capturedAt: 1_000,
    headSha: currentHeadSha,
    review: {
      resultTriggerCommentId: 70,
      resultTriggerHeadSha: currentHeadSha,
    },
  },
  continuation: {
    when: [{ kind: 'pr_review_result_available', triggerCommentId: 70 }],
    // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract field.
    then: 'Consume the exact review result.',
  },
  expiresAt: 120_000,
  createdAt: 1_000,
  provenance: 'explicit_registration',
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

const cleanConversation = (overrides = {}) => ({
  id: 73,
  author: knownCloudReviewer,
  body: "Codex Review: Didn't find any major issues. :rocket:\n\n**Reviewed commit:** `6908af814b`",
  createdAt: '2026-07-14T19:00:02.000Z',
  commitId: undefined,
  commentType: 'conversation',
  ...overrides,
});

const classify = (overrides = {}) =>
  classifyExternalCloudReview({
    currentHeadSha,
    awaitState: awaitState(),
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
    assert.deepEqual(result.waitResult, {
      triggerCommentId: 70,
      sourceRef: 'review:71',
      decisionCursor: 71,
      reviewer: knownCloudReviewer,
      decision: 'COMMENTED',
    });
  });

  it('recognizes the known connector canonical clean conversation for the exact current head', () => {
    const result = classify({ comments: [cleanConversation()] });

    assert.deepEqual(result.observation, {
      headSha: currentHeadSha,
      status: 'clean',
      triggerCommentId: 70,
    });
    assert.deepEqual(result.correlatedCommentIds, [73]);
    assert.deepEqual(result.waitResult, {
      triggerCommentId: 70,
      sourceRef: 'conversation:73',
      conversationCommentCursor: 73,
      reviewer: knownCloudReviewer,
      decision: 'CLEAN',
    });
  });

  it('fails closed for unknown, stale, missing-commit, and ambiguous conversation prose', () => {
    const cases = [
      cleanConversation({ author: 'unknown-review-bot[bot]' }),
      cleanConversation({ body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `0123456789`" }),
      cleanConversation({ body: "Codex Review: Didn't find any major issues." }),
      cleanConversation({ body: 'Codex Review: Found 2 issues.\n\n**Reviewed commit:** `6908af814b`' }),
      cleanConversation({
        body: "Someone said Codex Review: Didn't find any major issues.\n**Reviewed commit:** `6908af814b`",
      }),
    ];

    for (const candidate of cases) {
      const result = classify({ comments: [candidate] });
      assert.equal(result.waitResult, undefined);
      assert.equal(result.observation.status, 'running');
      assert.deepEqual(result.correlatedCommentIds, []);
    }
  });

  it('does not correlate stale-head reviews or a wait registered for another head', () => {
    const stale = classify({
      comments: [comment({ commitId: 'head-old' })],
      reviews: [review({ commitId: 'head-old' })],
    });
    assert.equal(stale.observation.status, 'running');
    assert.deepEqual(stale.correlatedCommentIds, []);
    assert.deepEqual(stale.correlatedReviewIds, []);

    const mismatchedWait = classify({
      awaitState: awaitState({
        baseline: {
          capturedAt: 1_000,
          headSha: 'head-old',
          review: { resultTriggerCommentId: 70, resultTriggerHeadSha: 'head-old' },
        },
      }),
    });
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
