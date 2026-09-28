/**
 * #1392 D1: one registration must be able to name every distinct condition its subject can raise.
 *
 * The cap was a hand-written four while the PR catalog defines eight kinds, so a caller wanting the
 * baseline set for their own PR — review decision, both comment surfaces, CI and conflict — was
 * rejected for asking for five valid, non-duplicate conditions. The only ways out were to drop a
 * signal they needed or register a second tracker, and a dropped signal is invisible to an agent
 * that cannot poll.
 *
 * Raising capacity is all this covers. Deduplication, unknown-kind rejection and required
 * parameters are unchanged, because "cover the whole notification surface" must not become a
 * licence to fabricate the anchors that precise waits depend on.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { githubWaitPredicatesSchema, githubIssueWaitPredicatesSchema } = await import(
  '../dist/domains/github-signals/GitHubWaitPredicateCatalog.js'
);

const LOGINS = { authorLogins: ['zts212653'] };

describe('#1392 D1 registration capacity', () => {
  it('accepts the five-condition baseline a PR author needs', () => {
    const parsed = githubWaitPredicatesSchema.safeParse([
      { kind: 'pr_review_decision_changed' },
      { kind: 'pr_conversation_comment_added', ...LOGINS },
      { kind: 'pr_inline_comment_added', ...LOGINS },
      { kind: 'pr_ci_terminal' },
      { kind: 'pr_became_conflicting' },
    ]);

    assert.equal(parsed.success, true, 'five distinct supported conditions must not be rejected for capacity');
  });

  it('accepts every distinct PR condition in the catalog in a single registration', () => {
    const parsed = githubWaitPredicatesSchema.safeParse([
      { kind: 'pr_head_changed' },
      { kind: 'pr_review_result_available' },
      { kind: 'pr_review_decision_changed' },
      { kind: 'pr_review_thread_changed', reviewThreadIds: ['RT_kwDO'] },
      { kind: 'pr_ci_terminal' },
      { kind: 'pr_became_conflicting' },
      { kind: 'pr_conversation_comment_added', ...LOGINS },
      { kind: 'pr_inline_comment_added', ...LOGINS },
    ]);

    assert.equal(parsed.success, true, 'capacity must be derived from the catalog, not a fixed number');
  });

  it('still rejects a duplicate kind', () => {
    const parsed = githubWaitPredicatesSchema.safeParse([{ kind: 'pr_ci_terminal' }, { kind: 'pr_ci_terminal' }]);

    assert.equal(parsed.success, false, 'duplicate kinds must stay rejected');
  });

  it('still rejects an unknown kind', () => {
    const parsed = githubWaitPredicatesSchema.safeParse([{ kind: 'pr_everything_please' }]);

    assert.equal(parsed.success, false, 'unknown kinds must stay rejected');
  });

  it('still rejects a precise wait whose required anchor is missing', () => {
    const parsed = githubWaitPredicatesSchema.safeParse([{ kind: 'pr_review_thread_changed' }]);

    assert.equal(
      parsed.success,
      false,
      'a precise wait must keep its anchor — broader capacity is not a licence to fabricate one',
    );
  });

  it('accepts every distinct issue condition in a single registration', () => {
    const parsed = githubIssueWaitPredicatesSchema.safeParse([
      { kind: 'issue_comment_added', ...LOGINS },
      { kind: 'issue_author_commented' },
    ]);

    assert.equal(parsed.success, true, 'the issue surface is capped by its own catalog the same way');
  });
});
