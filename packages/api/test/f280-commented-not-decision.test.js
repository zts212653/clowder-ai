import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { matchGitHubWaitPredicates } = await import('../dist/domains/github-signals/GitHubWaitPredicateCatalog.js');

const when = [{ kind: 'pr_review_decision_changed' }];
const baseline = Object.freeze({
  capturedAt: 1,
  headSha: 'aaaa1111',
  review: { inlineCommentCursor: 0, conversationCommentCursor: 0, decisionCursor: 10, decision: 'CHANGES_REQUESTED' },
});
const facts = (decision, cursor) => ({
  headSha: 'aaaa1111',
  review: { decisionCursor: cursor, decision, reviewer: 'someone' },
});

describe('F280 — a plain COMMENTED review is not a decision', () => {
  // Codex P2 on #1394, and the same boundary sol drew in the contract review: the advertised
  // behaviour of review_decision is approve / request-changes / dismiss. The predicate only
  // compared decisionCursor, so any review submission — including an ordinary COMMENTED —
  // was reported as a decision change. Observed live on #1394 as
  // "review CHANGES_REQUESTED → COMMENTED (chatgpt-codex-connector[bot])".
  it('does not fire the decision event for a COMMENTED review', () => {
    assert.deepEqual(matchGitHubWaitPredicates(when, baseline, facts('COMMENTED', 11)), []);
  });

  for (const verdict of ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']) {
    it(`still fires for ${verdict}`, () => {
      const matches = matchGitHubWaitPredicates(when, baseline, facts(verdict, 11));
      assert.equal(matches.length, 1, `${verdict} is a real decision and must wake the tracker`);
    });
  }
});
