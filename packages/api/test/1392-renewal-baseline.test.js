/**
 * #1392 AC-1: where generation N+1 starts.
 *
 * Gap-free renewal means N+1 begins exactly where the observation that consumed N ended — never
 * at a fresh GitHub read taken later, because anything arriving between the match and that read
 * would be absorbed into the baseline and never reported. These tests pin the two ways that goes
 * wrong: absorbing a signal N could not see, and carrying an old HEAD forward so every later
 * same-HEAD predicate is blocked while tracking still looks alive.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const MODULE_URL = new URL('../dist/domains/github-signals/GitHubWaitRenewalBaseline.js', import.meta.url);

const OLD_HEAD = 'aaaa1111';
const NEW_HEAD = 'bbbb2222';

function prBaseline(overrides = {}) {
  return {
    capturedAt: 100,
    headSha: OLD_HEAD,
    review: { inlineCommentCursor: 10, conversationCommentCursor: 20, decisionCursor: 30, decision: 'COMMENTED' },
    ci: { bucket: 'pending', fingerprint: `${OLD_HEAD}:pending` },
    conflict: { mergeState: 'MERGEABLE' },
    ...overrides,
  };
}

describe('#1392 renewal baseline — same HEAD', () => {
  it('starts N+1 from this observation, so the fact that matched N cannot match N+1 again', async () => {
    const { renewPrWaitBaseline } = await import(MODULE_URL.href);
    const next = renewPrWaitBaseline(
      prBaseline(),
      { review: { lastInlineCommentCursor: 11, lastConversationCommentCursor: 25, lastDecisionCursor: 31 } },
      { headSha: OLD_HEAD, ci: { bucket: 'pass', fingerprint: `${OLD_HEAD}:pass`, blockerCount: 0 } },
      500,
    );

    assert.equal(next.capturedAt, 500);
    assert.equal(next.headSha, OLD_HEAD);
    assert.deepEqual(
      { i: next.review.inlineCommentCursor, c: next.review.conversationCommentCursor, d: next.review.decisionCursor },
      { i: 11, c: 25, d: 31 },
    );
    assert.equal(next.ci.fingerprint, `${OLD_HEAD}:pass`, 'the CI result N consumed is now history');
  });

  it('never moves a cursor backwards, whatever a stale source reports', async () => {
    const { renewPrWaitBaseline } = await import(MODULE_URL.href);
    const next = renewPrWaitBaseline(
      prBaseline(),
      { review: { lastInlineCommentCursor: 3, lastConversationCommentCursor: 4, lastDecisionCursor: 5 } },
      { headSha: OLD_HEAD, review: { decisionCursor: 1 } },
      500,
    );

    assert.equal(next.review.inlineCommentCursor, 10);
    assert.equal(next.review.conversationCommentCursor, 20);
    assert.equal(next.review.decisionCursor, 30);
  });
});

describe('#1392 renewal baseline — HEAD changed', () => {
  it('moves N+1 onto the new HEAD, so later same-HEAD predicates are not blocked forever', async () => {
    const { renewPrWaitBaseline } = await import(MODULE_URL.href);
    const next = renewPrWaitBaseline(prBaseline(), {}, { headSha: NEW_HEAD }, 500);

    assert.equal(next.headSha, NEW_HEAD);
  });

  it('does not absorb the new HEAD CI result that arrived in the same poll', async () => {
    const { renewPrWaitBaseline } = await import(MODULE_URL.href);
    const { matchGitHubWaitPredicates } = await import('../dist/domains/github-signals/GitHubWaitPredicateCatalog.js');
    const newHeadPass = { bucket: 'pass', fingerprint: `${NEW_HEAD}:pass`, blockerCount: 0 };

    // N waited on both. HEAD moved in this poll, so the same-HEAD guard kept N from seeing the
    // CI result on the new HEAD. If N+1 absorbed it, it would never be reported.
    const next = renewPrWaitBaseline(prBaseline(), {}, { headSha: NEW_HEAD, ci: newHeadPass }, 500);
    const matched = matchGitHubWaitPredicates([{ kind: 'pr_ci_terminal' }], next, {
      headSha: NEW_HEAD,
      ci: newHeadPass,
    });

    assert.equal(matched.length, 1, 'the new-HEAD CI result must still be reportable by N+1');
  });

  it('does not let a review written against the old HEAD count for the new one', async () => {
    const { renewPrWaitBaseline } = await import(MODULE_URL.href);
    const { matchGitHubWaitPredicates } = await import('../dist/domains/github-signals/GitHubWaitPredicateCatalog.js');

    const next = renewPrWaitBaseline(
      prBaseline(),
      { review: { lastDecisionCursor: 31 } },
      { headSha: NEW_HEAD, review: { decisionCursor: 31, decision: 'APPROVED' } },
      500,
    );
    const matched = matchGitHubWaitPredicates([{ kind: 'pr_review_decision_changed' }], next, {
      headSha: NEW_HEAD,
      review: { decisionCursor: 31, decision: 'APPROVED' },
    });

    assert.equal(matched.length, 0, 'an old-HEAD approval is not an approval of the new HEAD');
  });

  it('does not absorb a review-thread reply that arrived with the push', async () => {
    const { renewPrWaitBaseline } = await import(MODULE_URL.href);
    const { matchGitHubWaitPredicates } = await import('../dist/domains/github-signals/GitHubWaitPredicateCatalog.js');
    const before = { reviewThreadId: 'T1', resolved: false, lastCommentId: 7 };
    const replied = { ...before, lastCommentId: 8 };

    // Same trap as CI: the same-HEAD guard kept N from reporting the reply, so N+1 must still see it.
    const next = renewPrWaitBaseline(
      prBaseline({ review: { ...prBaseline().review, threads: [before] } }),
      {},
      { headSha: NEW_HEAD, review: { decisionCursor: 30, threads: [replied] } },
      500,
    );
    const matched = matchGitHubWaitPredicates([{ kind: 'pr_review_thread_changed', reviewThreadIds: ['T1'] }], next, {
      headSha: NEW_HEAD,
      review: { decisionCursor: 30, threads: [replied] },
    });

    assert.equal(matched.length, 1, 'the reply must still be reportable by N+1');
  });
});

describe('#1392 renewal baseline — issue', () => {
  it('advances past every comment this observation saw, including ones the collector has not recorded', async () => {
    const { renewIssueWaitBaseline } = await import(MODULE_URL.href);
    const next = renewIssueWaitBaseline(
      { capturedAt: 100, issue: { lastCommentCursor: 100, state: 'open', authorLogin: 'author' } },
      { issue: { lastCommentCursor: 101 } },
      {
        issue: {
          state: 'open',
          comments: [
            { id: 101, author: 'a' },
            { id: 105, author: 'b' },
          ],
        },
      },
      500,
    );

    assert.equal(next.issue.lastCommentCursor, 105);
    assert.equal(next.issue.authorLogin, 'author', 'the frozen author is carried, not re-derived');
    assert.equal(next.capturedAt, 500);
  });
});
