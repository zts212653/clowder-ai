/**
 * #1392 AC-7: normal registration names a subject, not a predicate list.
 *
 * The failure this closes is not theoretical. A PR author reported a published dependency in a
 * conversation comment while HEAD never moved, and a registration watching only `pr_head_changed`
 * stayed healthy, unexpired and silent. An agent cannot poll, so it never discovers that it asked for
 * the wrong thing — it just stops hearing anything and has no way to tell that apart from quiet.
 *
 * Two boundaries are asserted as firmly as the happy path. The bare default arms only conditions that
 * need no audience, because an open comment audience is a product decision the maintainer has not
 * signed off and inventing one here would be exactly the silent widening this issue exists to remove.
 * And the audience, when there is one, is supplied by the caller — never derived from who opened the
 * PR, and never inflated from an empty list.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { expandGitHubPrTrackingGoal } = await import('../../shared/dist/types/github-wait.js');

const kinds = (expansion) => expansion.when.map((predicate) => predicate.kind).sort();

describe('#1392 AC-7 registration entry', () => {
  it('a registration that names no conditions still arms everything the PR raises about itself', () => {
    const expansion = expandGitHubPrTrackingGoal();

    assert.equal(expansion.ok, true);
    assert.deepEqual(kinds(expansion), [
      'pr_became_conflicting',
      'pr_ci_terminal',
      'pr_head_changed',
      'pr_review_decision_changed',
    ]);
  });

  it('the bare default arms no comment condition, because it has no audience to arm one with', () => {
    const expansion = expandGitHubPrTrackingGoal();

    assert.equal(
      expansion.when.some((predicate) => predicate.kind.endsWith('comment_added')),
      false,
      'an unsigned open audience must not be invented here',
    );
  });

  it('naming who you wait on arms both comment surfaces with exactly that audience', () => {
    const expansion = expandGitHubPrTrackingGoal({ kind: 'await_reply_from', authorLogins: ['pr-author'] });

    assert.equal(expansion.ok, true);
    assert.deepEqual(kinds(expansion), [
      'pr_became_conflicting',
      'pr_ci_terminal',
      'pr_conversation_comment_added',
      'pr_head_changed',
      'pr_inline_comment_added',
      'pr_review_decision_changed',
    ]);
    for (const predicate of expansion.when) {
      if (predicate.kind.endsWith('comment_added')) {
        assert.deepEqual(predicate.authorLogins, ['pr-author']);
      }
    }
  });

  it('an audience of blanks is refused rather than quietly widened to everyone', () => {
    const expansion = expandGitHubPrTrackingGoal({ kind: 'await_reply_from', authorLogins: ['  ', ''] });

    assert.equal(expansion.ok, false);
    assert.match(expansion.error, /not widened to everyone/);
  });

  it('the expansion stays within the catalog capacity and never repeats a kind', () => {
    const expansion = expandGitHubPrTrackingGoal({ kind: 'await_reply_from', authorLogins: ['a', 'b'] });
    const seen = kinds(expansion);

    assert.equal(new Set(seen).size, seen.length, 'a duplicate kind would be rejected downstream');
    assert.ok(seen.length <= 8, 'the expansion must fit the cap it shares with explicit when[]');
  });

  it('the same input always expands the same way', () => {
    const goal = { kind: 'await_reply_from', authorLogins: ['pr-author'] };

    assert.deepEqual(expandGitHubPrTrackingGoal(goal), expandGitHubPrTrackingGoal(goal));
    assert.deepEqual(expandGitHubPrTrackingGoal(), expandGitHubPrTrackingGoal());
  });
});
