import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { matchGitHubTrackingEvents } = await import('../dist/domains/github-signals/GitHubTrackingEvent.js');

const PR_AUTHOR = 'PrAuthor';
const ME = 'RegisteringCat';

const baseline = Object.freeze({
  capturedAt: 100,
  headSha: 'aaaa1111',
  review: { inlineCommentCursor: 0, conversationCommentCursor: 10, decisionCursor: 0 },
});

const comment = (id, author) => ({
  type: 'pr_conversation_comment_added',
  id,
  source: 'pr_conversation_comment',
  author,
  summary: `conversation comment #${id} by ${author}`,
});

const when = [{ kind: 'pr_conversation_comment_added' }];

describe('F280 A30 — a non-author only hears the PR author', () => {
  // The operator's journey B: "有且只有 A 的 comment 回复通知到它". Expressing the role
  // difference as a subscription default (bot_interaction: 'author') cannot say this — a
  // maintainer stays subscribed to conversation_comment and therefore hears every third
  // party. The audience decision has to reach the filter itself.
  it('A30: a third party does not wake a non-author tracker', () => {
    const matches = matchGitHubTrackingEvents(when, baseline, [comment(11, 'SomeoneElse')], {
      audience: { selfLogin: ME, prAuthorLogin: PR_AUTHOR },
    });
    assert.deepEqual(matches, [], 'a maintainer must not be woken by an unrelated third party');
  });

  it('A26: the PR author still wakes a non-author tracker', () => {
    const matches = matchGitHubTrackingEvents(when, baseline, [comment(12, PR_AUTHOR)], {
      audience: { selfLogin: ME, prAuthorLogin: PR_AUTHOR },
    });
    assert.equal(matches.length, 1, 'muting the real signal is worse than any noise');
  });

  it('the PR author hears everyone except themselves', () => {
    const matches = matchGitHubTrackingEvents(when, baseline, [comment(13, 'SomeoneElse'), comment(14, PR_AUTHOR)], {
      audience: { selfLogin: PR_AUTHOR, prAuthorLogin: PR_AUTHOR },
    });
    assert.equal(matches.length, 1, 'the author hears third parties');
    assert.match(matches[0].delta, /SomeoneElse/);
  });
});

/*
 * #1394 stopped ASKING a caller for its audience; it did not delete `authorLogins`, and it did
 * not rewrite the waits already on disk with one. Those kinds now travel through the event
 * matcher, and the first cut of that matcher keyed only on `predicate.kind` — so a stored
 * allowlist stopped meaning anything while the stored state went on claiming it.
 *
 * The damage runs BOTH ways, which is why the role default cannot simply be stacked on top:
 * an author tracker heard every author the allowlist excluded, and a non-author tracker heard
 * NOBODY, because the role branch drops anyone who is not the PR author.
 */
describe('a persisted authorLogins allowlist is still the exact audience', () => {
  const allowMaintainer = [{ kind: 'pr_conversation_comment_added', authorLogins: ['Maintainer'] }];

  it('does not widen: an author tracker hears the allowlisted author and nobody else', () => {
    const matches = matchGitHubTrackingEvents(
      allowMaintainer,
      baseline,
      [comment(21, 'Maintainer'), comment(22, 'SomeoneElse')],
      { audience: { selfLogin: PR_AUTHOR, prAuthorLogin: PR_AUTHOR } },
    );
    assert.equal(matches.length, 1);
    assert.match(matches[0].delta, /Maintainer/);
  });

  it('does not silence: a non-author tracker still hears its allowlisted author', () => {
    const matches = matchGitHubTrackingEvents(allowMaintainer, baseline, [comment(23, 'Maintainer')], {
      audience: { selfLogin: ME, prAuthorLogin: PR_AUTHOR },
    });
    assert.equal(matches.length, 1, 'an explicit allowlist replaces the role default, it does not stack with it');
  });

  it('matches case-insensitively, exactly as the typed catalog does', () => {
    const matches = matchGitHubTrackingEvents(allowMaintainer, baseline, [comment(24, 'MAINTAINER')], {
      audience: { selfLogin: ME, prAuthorLogin: PR_AUTHOR },
    });
    assert.equal(matches.length, 1);
  });

  it('never overrides self-echo suppression', () => {
    const own = { ...comment(25, ME), self: true };
    const matches = matchGitHubTrackingEvents(
      [{ kind: 'pr_conversation_comment_added', authorLogins: [ME] }],
      baseline,
      [own],
      {
        audience: { selfLogin: ME, prAuthorLogin: PR_AUTHOR },
      },
    );
    assert.deepEqual(matches, [], 'nothing a caller wrote may wake the cat with its own comment');
  });

  it('applies to issue comments too, which have no role branch to hide behind', () => {
    const issueBaseline = { capturedAt: 100, issue: { lastCommentCursor: 10, state: 'open' } };
    const issueComment = (id, author) => ({
      type: 'issue_comment_added',
      id,
      source: 'issue_comment',
      author,
      summary: `issue comment #${id} by ${author}`,
    });
    const matches = matchGitHubTrackingEvents(
      [{ kind: 'issue_comment_added', authorLogins: ['Maintainer'] }],
      issueBaseline,
      [issueComment(31, 'Maintainer'), issueComment(32, 'SomeoneElse')],
      {},
    );
    assert.equal(matches.length, 1);
    assert.match(matches[0].delta, /Maintainer/);
  });

  it('a union of two predicates on one kind is the union of their audiences', () => {
    const matches = matchGitHubTrackingEvents(
      [
        { kind: 'pr_conversation_comment_added', authorLogins: ['Maintainer'] },
        { kind: 'pr_conversation_comment_added', authorLogins: ['SecondReviewer'] },
      ],
      baseline,
      [comment(41, 'Maintainer'), comment(42, 'SecondReviewer'), comment(43, 'SomeoneElse')],
      { audience: { selfLogin: PR_AUTHOR, prAuthorLogin: PR_AUTHOR } },
    );
    assert.equal(matches.length, 2);
  });
});

/*
 * codex R29 asked for stale-commit feedback to be dropped. The defect it names is real — an old
 * CHANGES_REQUESTED surfacing after a force-push reads as a verdict on code the reviewer never
 * saw — but dropping it is the wrong cure: reviewers write against the commit that existed when
 * they read it, and HEAD routinely moves before our next poll, so muting on that basis discards
 * ordinary review feedback. That is the silent-mute class A26 ranks above any noise, and F280
 * 2.4 states it directly: current HEAD never decides who gets woken.
 *
 * Delivered and LABELLED is the answer that loses nothing and misleads nobody.
 */
describe('F280 — stale-commit feedback is labelled, never muted', () => {
  const HEAD = 'aaaa1111';
  const OLD = 'bbbb2222';
  const inline = (id, commitId) => ({
    type: 'pr_inline_comment_added',
    id,
    source: 'pr_inline_comment',
    author: 'Maintainer',
    commitBearing: true,
    ...(commitId === undefined ? {} : { commitId }),
    summary: `inline comment #${id}`,
  });
  const inlineWhen = [{ kind: 'pr_inline_comment_added' }];
  const inlineBaseline = {
    capturedAt: 100,
    headSha: HEAD,
    review: { inlineCommentCursor: 0, conversationCommentCursor: 0, decisionCursor: 0 },
  };
  const match = (events, when = inlineWhen, base = inlineBaseline) => matchGitHubTrackingEvents(when, base, events, {});

  it('an artifact about an older commit still wakes the owner', () => {
    const matches = match([inline(31, OLD)]);
    assert.equal(matches.length, 1, 'muting real review feedback is the failure A26 ranks first');
  });

  it('and it says which commit it was written against', () => {
    assert.match(match([inline(31, OLD)])[0].delta, /written against bbbb222; HEAD is now aaaa111/);
  });

  it('an artifact about the current commit carries no note', () => {
    assert.equal(match([inline(32, HEAD)])[0].delta, 'inline comment #32');
  });

  it('an artifact whose commit we cannot see is not labelled stale', () => {
    // Labelling it would be guessing, and the label is a claim about provenance.
    assert.equal(match([inline(33, undefined)])[0].delta, 'inline comment #33');
  });

  it('a non commit-bearing surface is untouched', () => {
    const conversation = { ...comment(34, 'Maintainer'), commitId: OLD };
    const matches = match([conversation], [{ kind: 'pr_conversation_comment_added' }], baseline);
    assert.equal(matches.length, 1);
    assert.ok(!/written against/.test(matches[0].delta));
  });

  it('the HEAD observed IN this batch decides, not the held frontier', () => {
    // 2.5b holds the baseline frontier back on purpose, and a push can land in the same poll as
    // the review that predates it.
    const pushed = { type: 'pr_head_changed', source: 'pr_head', id: 'cccc3333', summary: 'HEAD changed' };
    const when = [{ kind: 'pr_inline_comment_added' }, { kind: 'pr_head_changed' }];
    const matches = match([pushed, inline(35, HEAD)], when);
    const note = matches.find((m) => m.kind === 'pr_inline_comment_added')?.delta;
    assert.match(note, /written against aaaa111; HEAD is now cccc333/);
  });
});

const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { GitHubWaitLifecycleService } = await import('../dist/domains/github-signals/GitHubWaitLifecycleService.js');

async function nonAuthorTracker() {
  const taskStore = new TaskStore();
  const messageStore = new MessageStore();
  const task = await taskStore.create({
    kind: 'pr_tracking',
    subjectKey: 'pr:owner/repo#7',
    threadId: 'thread_1',
    title: 'PR tracking: owner/repo#7',
    ownerCatId: 'cat',
    why: 'test',
    createdBy: 'cat',
    userId: 'user_1',
    automationState: {
      review: { lastConversationCommentCursor: 10 },
      await: {
        v: 1,
        generation: 1,
        subjectRef: 'pr:owner/repo#7',
        ownerFence: { kind: 'containing_task', generation: 1 },
        baseline: {
          capturedAt: 100,
          headSha: 'aaaa1111',
          prAuthorLogin: PR_AUTHOR,
          review: { inlineCommentCursor: 0, conversationCommentCursor: 10, decisionCursor: 0 },
        },
        // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
        continuation: { when, then: 'handle it' },
        createdAt: 100,
        autoRenew: true,
        provenance: 'explicit_registration',
      },
    },
  });
  const lifecycle = new GitHubWaitLifecycleService({
    taskStore,
    deliveryDeps: { messageStore },
    now: () => 500,
    log: { info() {}, warn() {}, error() {} },
    selfGitHubLogin: () => ME,
  });
  return { taskStore, messageStore, task, lifecycle };
}

describe('F280 A30 — the wiring, not just the filter', () => {
  // The filter existing is not the same as production using it. The first cut of this change
  // added `audience` to the matcher while every real call site passed only the turn clock, so
  // the parameter was absent, the default was permissive, and A30 stayed broken in production —
  // an optional field with a permissive default, the exact shape that caused this bug.
  it('a third party does not wake a non-author tracker through lifecycle.observe', async () => {
    const { lifecycle, messageStore, task } = await nonAuthorTracker();
    const result = await lifecycle.observe({
      taskId: task.id,
      facts: { headSha: 'aaaa1111' },
      events: [comment(11, 'SomeoneElse')],
    });
    assert.notEqual(result.kind, 'notified', `a third party must not wake a maintainer: ${result.kind}`);
    assert.equal(messageStore.getByThread('thread_1').length, 0);
  });

  it('the PR author still wakes a non-author tracker through lifecycle.observe', async () => {
    const { lifecycle, messageStore, task } = await nonAuthorTracker();
    const result = await lifecycle.observe({
      taskId: task.id,
      facts: { headSha: 'aaaa1111' },
      events: [comment(12, PR_AUTHOR)],
    });
    assert.equal(result.kind, 'notified', 'muting the real signal is worse than any noise');
    assert.equal(messageStore.getByThread('thread_1').length, 1);
  });

  /*
   * codex R28: the role survives a QUIET poll.
   *
   * `prAuthorLogin` is frozen at registration and no observation carries it, so a renewal that
   * rebuilds the baseline field-by-field silently drops it. The audience filter then fails open
   * by design (A26), and from the first no-match poll onward a maintainer is woken by every
   * third party — A30 broken again, through a path no single-observation test can see.
   *
   * The first poll must therefore MATCH NOTHING: a test that goes straight to the third-party
   * comment passes whether or not the renewal keeps the author.
   */
  it('a quiet poll does not erase the tracker role', async () => {
    const { lifecycle, messageStore, task, taskStore } = await nonAuthorTracker();

    const quiet = await lifecycle.observe({
      taskId: task.id,
      facts: { headSha: 'aaaa1111' },
      events: [comment(11, 'SomeoneElse')],
    });
    assert.notEqual(quiet.kind, 'notified');
    const renewed = (await taskStore.get(task.id)).automationState.await.baseline;
    assert.equal(renewed.prAuthorLogin, PR_AUTHOR, 'the renewed baseline must still know the PR author');

    const afterQuiet = await lifecycle.observe({
      taskId: task.id,
      facts: { headSha: 'aaaa1111' },
      events: [comment(20, 'SomeoneElse')],
    });
    assert.notEqual(afterQuiet.kind, 'notified', 'a third party must not wake a maintainer after a quiet poll');
    assert.equal(messageStore.getByThread('thread_1').length, 0);

    const author = await lifecycle.observe({
      taskId: task.id,
      facts: { headSha: 'aaaa1111' },
      events: [comment(21, PR_AUTHOR)],
    });
    assert.equal(author.kind, 'notified', 'and the author must still get through');
  });
});
