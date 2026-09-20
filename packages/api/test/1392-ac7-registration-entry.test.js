/**
 * #1392 AC-7: normal registration names a subject; the server decides who may wake you.
 *
 * The failure this closes is not theoretical. A PR author reported a published dependency in a
 * conversation comment while HEAD never moved, and a registration watching only `pr_head_changed`
 * stayed healthy, unexpired and silent. An agent cannot poll, so it never discovers that it asked for
 * the wrong thing — it just stops hearing anything and has no way to tell that apart from quiet.
 *
 * An earlier build closed half of it: the bare default armed the four conditions a PR raises about
 * itself and no comment condition at all, because no default comment audience had been approved.
 * That shape was rejected — a registration that succeeds while listening to no comments is the
 * original silent failure wearing a new hat — and the product owner has since settled the table
 * these cases encode (#1392 §4, 2026-09-20).
 *
 * The two boundaries asserted as firmly as the happy path are now different ones: a perspective is
 * only claimed when it can be proved, and a perspective that cannot be proved delivers everything
 * flagged rather than quietly filtering on a rule nobody verified.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  commentAudienceForPerspective,
  describeGitHubNotificationCoverage,
  expandGitHubIssueTracking,
  expandGitHubPrTrackingGoal,
  resolveGitHubNotificationPerspective,
} = await import('../../shared/dist/types/github-wait.js');

const kinds = (expansion) => expansion.when.map((predicate) => predicate.kind).sort();
const audiences = (expansion) =>
  expansion.when.filter((predicate) => predicate.kind.endsWith('comment_added')).map((predicate) => predicate.audience);

const AUTHOR = { role: 'subject_author', selfLogin: 'mindfn' };
const REVIEWER = {
  role: 'maintainer_or_reviewer',
  selfLogin: 'mindfn',
  subjectAuthorLogin: 'someone-else',
  ground: 'review_requested',
};
const UNRESOLVED = { role: 'unresolved', missing: ['self'] };

describe('#1392 AC-7 perspective — a role is claimed only when it can be proved', () => {
  it('we are the author when GitHub says the subject is ours', () => {
    const perspective = resolveGitHubNotificationPerspective({
      selfLogin: 'mindfn',
      subjectAuthorLogin: 'mindfn',
    });

    assert.deepEqual(perspective, { role: 'subject_author', selfLogin: 'mindfn' });
  });

  it('GitHub logins are compared case-insensitively, as GitHub treats them', () => {
    const perspective = resolveGitHubNotificationPerspective({
      selfLogin: 'MindFn',
      subjectAuthorLogin: 'mindfn',
    });

    assert.equal(perspective.role, 'subject_author');
  });

  it('a checkable ground makes us a reviewer, and the ground is carried', () => {
    const perspective = resolveGitHubNotificationPerspective({
      selfLogin: 'mindfn',
      subjectAuthorLogin: 'zts212653',
      reviewerGround: 'review_submitted',
    });

    assert.deepEqual(perspective, {
      role: 'maintainer_or_reviewer',
      selfLogin: 'mindfn',
      subjectAuthorLogin: 'zts212653',
      ground: 'review_submitted',
    });
  });

  /*
   * The reviewer default is narrow — only the subject author's words reach you. Handing that
   * narrowness to anyone who merely is not the author would turn a passer-by's registration into
   * near-silence, and near-silence is indistinguishable from nothing happening. "Not the author" is
   * an absence; a role has to be a positive fact GitHub states.
   */
  it('being merely "not the author" is not a reviewer ground', () => {
    const perspective = resolveGitHubNotificationPerspective({
      selfLogin: 'mindfn',
      subjectAuthorLogin: 'a-stranger',
    });

    assert.deepEqual(perspective, { role: 'unresolved', missing: ['reviewer_ground'] });
  });

  it('an unknown identity names exactly what is missing, and invents nothing', () => {
    assert.deepEqual(resolveGitHubNotificationPerspective({}), {
      role: 'unresolved',
      missing: ['self', 'subject_author'],
    });
    assert.deepEqual(resolveGitHubNotificationPerspective({ subjectAuthorLogin: 'zts212653' }), {
      role: 'unresolved',
      missing: ['self'],
    });
    assert.deepEqual(resolveGitHubNotificationPerspective({ selfLogin: '   ' }), {
      role: 'unresolved',
      missing: ['self', 'subject_author'],
    });
  });
});

describe('#1392 AC-7 registration entry — the PR default', () => {
  /*
   * The headline case, and the one the maintainer rejected the previous build over: naming nothing
   * must still subscribe you to what people say, not only to what the machinery reports.
   */
  it('a registration that names no conditions arms both comment surfaces too', () => {
    const expansion = expandGitHubPrTrackingGoal(AUTHOR);

    assert.equal(expansion.ok, true);
    assert.deepEqual(kinds(expansion), [
      'pr_became_conflicting',
      'pr_ci_terminal',
      'pr_conversation_comment_added',
      'pr_head_changed',
      'pr_inline_comment_added',
      'pr_review_decision_changed',
    ]);
  });

  it('as the PR author you hear every reply that is not your own', () => {
    const expansion = expandGitHubPrTrackingGoal(AUTHOR);

    for (const audience of audiences(expansion)) {
      assert.deepEqual(audience, { mode: 'everyone_but_self', selfLogin: 'mindfn' });
    }
    assert.equal(audiences(expansion).length, 2, 'both surfaces, or inline review findings stay silent');
  });

  it('as a reviewer you hear the PR author, and the surfaces agree with each other', () => {
    const expansion = expandGitHubPrTrackingGoal(REVIEWER);

    for (const audience of audiences(expansion)) {
      assert.deepEqual(audience, { mode: 'subject_author_only', subjectAuthorLogin: 'someone-else' });
    }
  });

  it('an unresolved perspective still arms comments, carrying what could not be established', () => {
    const expansion = expandGitHubPrTrackingGoal(UNRESOLVED);

    assert.equal(audiences(expansion).length, 2, 'refusing to arm would be the silence this issue exists to remove');
    for (const audience of audiences(expansion)) {
      assert.deepEqual(audience, { mode: 'unresolved_identity', missing: ['self'] });
    }
  });

  /*
   * #1392 R2: the second assertion here used to require `audience === undefined`, on the premise
   * that a derived rule must never shadow a list the caller wrote. The accepted table says the
   * opposite — a list is a narrowing of the rule, not a replacement for it — and the old premise is
   * what let a named passer-by reach a maintainer, and a caller who named themselves be woken by
   * their own comment. Both are armed now, and both have to admit a comment.
   */
  it('naming who you wait on narrows the derived audience on both surfaces', () => {
    const expansion = expandGitHubPrTrackingGoal(AUTHOR, { kind: 'await_reply_from', authorLogins: ['pr-author'] });

    assert.equal(expansion.ok, true);
    for (const predicate of expansion.when) {
      if (!predicate.kind.endsWith('comment_added')) continue;
      assert.deepEqual(predicate.authorLogins, ['pr-author'], 'the caller’s narrowing is armed');
      assert.ok(predicate.audience, 'and so is the derived rule it narrows');
    }
  });

  it('an audience of blanks is refused rather than quietly widened to everyone', () => {
    const expansion = expandGitHubPrTrackingGoal(AUTHOR, { kind: 'await_reply_from', authorLogins: ['  ', ''] });

    assert.equal(expansion.ok, false);
    assert.match(expansion.error, /not widened to everyone/);
  });

  it('the expansion stays within the catalog capacity and never repeats a kind', () => {
    for (const perspective of [AUTHOR, REVIEWER, UNRESOLVED]) {
      const seen = kinds(expandGitHubPrTrackingGoal(perspective));
      assert.equal(new Set(seen).size, seen.length, 'a duplicate kind would be rejected downstream');
      assert.ok(seen.length <= 8, 'the expansion must fit the cap it shares with explicit when[]');
    }
  });

  it('the same input always expands the same way', () => {
    const first = expandGitHubPrTrackingGoal(REVIEWER);
    const second = expandGitHubPrTrackingGoal(REVIEWER);

    assert.deepEqual(first, second);
  });
});

describe('#1392 AC-7 registration entry — the issue default', () => {
  it('an issue registration that names nothing hears every comment that is not ours', () => {
    const when = expandGitHubIssueTracking({ selfLogin: 'mindfn' });

    assert.deepEqual(when, [
      { kind: 'issue_comment_added', audience: { mode: 'everyone_but_self', selfLogin: 'mindfn' } },
    ]);
  });

  /*
   * `issue_author_commented` would fire a second time on the very comment the audience already
   * matched, and two deltas for one comment reads as two events to whoever is woken.
   */
  it('the issue default arms one condition, so one comment is one event', () => {
    assert.equal(expandGitHubIssueTracking({ selfLogin: 'mindfn' }).length, 1);
  });

  it('an issue needs no reviewer ground — one accepted default covers it', () => {
    assert.deepEqual(
      expandGitHubIssueTracking({ selfLogin: 'mindfn', subjectAuthorLogin: 'someone-else' })[0].audience,
      {
        mode: 'everyone_but_self',
        selfLogin: 'mindfn',
      },
    );
  });

  it('without our own login the issue default flags rather than silently meaning "anyone"', () => {
    assert.deepEqual(expandGitHubIssueTracking({})[0].audience, {
      mode: 'unresolved_identity',
      missing: ['self'],
    });
  });
});

describe('#1392 AC-7 — the registration says what it armed', () => {
  it('the author default is described as what it is, including that bots are in it', () => {
    const expansion = expandGitHubPrTrackingGoal(AUTHOR);
    const coverage = describeGitHubNotificationCoverage(AUTHOR, expansion.when);

    assert.deepEqual(coverage.perspective, AUTHOR);
    assert.ok(coverage.armed.includes('pr_inline_comment_added'));
    assert.equal(coverage.commentFilters.length, 2);
    for (const line of coverage.commentFilters) {
      assert.match(line, /except mindfn \(you\), bots included/);
    }
  });

  it('the reviewer default names the filters it applies', () => {
    const coverage = describeGitHubNotificationCoverage(REVIEWER, expandGitHubPrTrackingGoal(REVIEWER).when);

    for (const line of coverage.commentFilters) {
      assert.match(line, /only from someone-else/);
      assert.match(line, /bots and pure summon commands filtered/);
    }
  });

  /*
   * An anomaly notification is not proof that normal coverage was established. If the answer read
   * like any other success, an owner would take an unfiltered firehose for a working rule.
   */
  it('an unresolved perspective says out loud that coverage is not established', () => {
    const coverage = describeGitHubNotificationCoverage(UNRESOLVED, expandGitHubPrTrackingGoal(UNRESOLVED).when);

    for (const line of coverage.commentFilters) {
      assert.match(line, /identity unknown \(self\)/);
      assert.match(line, /coverage is NOT established/);
    }
  });

  /*
   * #1392 R2: the reported coverage has to state both halves of what was armed. Printing only the
   * caller's list would describe a narrower audience than the one in force; printing only the
   * derived rule would describe a wider one. Either way the owner reads a filter they do not have.
   */
  it('a narrowed audience is reported as the rule plus the narrowing, not one of them', () => {
    const expansion = expandGitHubPrTrackingGoal(AUTHOR, { kind: 'await_reply_from', authorLogins: ['zts212653'] });
    const coverage = describeGitHubNotificationCoverage(AUTHOR, expansion.when);

    for (const line of coverage.commentFilters) {
      assert.match(line, /except mindfn \(you\)/, 'the derived rule that is still in force');
      assert.match(line, /narrowed to only zts212653 \(you named them\)/, 'and the narrowing on top of it');
    }
  });

  it('the advanced explicit path still reports a bare named list as the caller’s own', () => {
    const coverage = describeGitHubNotificationCoverage(AUTHOR, [
      { kind: 'pr_conversation_comment_added', authorLogins: ['zts212653'] },
    ]);

    assert.match(coverage.commentFilters[0], /audience you named/);
  });

  it('every audience mode is describable, so a new one cannot ship unexplained', () => {
    for (const perspective of [AUTHOR, REVIEWER, UNRESOLVED]) {
      const audience = commentAudienceForPerspective(perspective);
      const coverage = describeGitHubNotificationCoverage(perspective, [
        { kind: 'pr_conversation_comment_added', audience },
      ]);
      assert.equal(coverage.commentFilters.length, 1);
      assert.ok(coverage.commentFilters[0].length > 20);
    }
  });
});
