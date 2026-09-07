/**
 * #1392 AC-6b regression fence — the load-bearing line for the issue's headline bug.
 *
 * The issue ("conversation comments collected but no notification") is prevented by ONE line:
 * a `pr_conversation_comment_added` waiter must make the baseline reader fetch the review frontier
 * and seed a NON-ZERO conversationCommentCursor. If that predicate is dropped from `needsReview`,
 * the baseline cursor is 0, the wait re-matches ALL history, and the silent-notification bug returns.
 *
 * Every route/matcher test stubs `fetchPrWaitBaseline` or hand-installs `baseline.review`, so nothing
 * else exercises `readGitHubWaitBaseline` directly. This test closes that gap.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readGitHubWaitBaseline } from '../dist/domains/github-signals/GitHubWaitBaselineReader.js';

function makeDeps(overrides = {}) {
  const calls = { fetchConversationComments: 0, fetchReviews: 0, fetchInlineComments: 0 };
  return {
    calls,
    deps: {
      fetchCi: async () => ({ headSha: 'head-1', aggregateBucket: 'pass' }),
      fetchInlineComments: async () => {
        calls.fetchInlineComments++;
        return overrides.inline ?? [];
      },
      fetchConversationComments: async () => {
        calls.fetchConversationComments++;
        return overrides.conversation ?? [];
      },
      fetchReviews: async () => {
        calls.fetchReviews++;
        return overrides.reviews ?? [];
      },
      fetchMergeState: async () => ({ mergeState: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
      fetchReviewThreads: async () => [],
      now: () => 1_700_000_000_000,
    },
  };
}

describe('#1392 AC-6b — baseline reader seeds the conversation frontier for a conversation-comment waiter', () => {
  test('pr_conversation_comment_added ⇒ fetches the review frontier and seeds a NON-ZERO conversationCommentCursor', async () => {
    const { calls, deps } = makeDeps({ conversation: [{ id: 100 }, { id: 250 }, { id: 180 }] });
    const snap = await readGitHubWaitBaseline(
      {
        repoFullName: 'owner/repo',
        prNumber: 7,
        when: [{ kind: 'pr_conversation_comment_added', authorLogins: ['maintainer'] }],
      },
      deps,
    );
    // needsReview fired ⇒ the review frontier was actually fetched (not skipped).
    assert.equal(calls.fetchConversationComments, 1, 'a conversation waiter MUST fetch the review frontier');
    // Baseline seeded to the current max ⇒ pre-registration comments are zero-delta (no silent re-fire).
    assert.ok(snap.baseline.review, 'baseline.review must exist for a conversation waiter');
    assert.equal(snap.baseline.review.conversationCommentCursor, 250, 'cursor must be the current max, not 0');
    assert.equal(snap.collectorState.review.lastConversationCommentCursor, 250);
  });

  test('every registration freezes all source frontiers even when a surface is excluded', async () => {
    const { calls, deps } = makeDeps({ conversation: [{ id: 250 }] });
    const snap = await readGitHubWaitBaseline(
      { repoFullName: 'owner/repo', prNumber: 7, when: [{ kind: 'pr_head_changed' }] },
      deps,
    );
    assert.equal(calls.fetchConversationComments, 1);
    assert.equal(snap.baseline.review.conversationCommentCursor, 250);
    assert.equal(snap.baseline.base.isBehind, false);
  });
});
