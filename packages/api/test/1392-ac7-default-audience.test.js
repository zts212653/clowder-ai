/**
 * #1392 AC-7: the accepted default audience, at the layer that decides whether a cat wakes up.
 *
 * The table these cases encode was settled by the product owner on 2026-09-20 and is quoted in the
 * issue body: as the PR author you hear every reply that is not your own, bots included; as a
 * maintainer or reviewer you hear the PR author's replies, with bots and identifiable pure summon
 * commands filtered; on an issue you hear every comment that is not your own; and when identity
 * cannot be resolved nothing is dropped quietly.
 *
 * Two things are deliberately proved here rather than at the expansion helper. First, filtering
 * happens at delivery and never at collection: a comment nobody is woken for still moves the cursor
 * past it, so the next poll does not replay it. Second, the narrow reviewer audience does not eat
 * real replies — a body that merely contains a mention is not a summon, and a mention of a person is
 * never one.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const catalog = await import('../dist/domains/github-signals/GitHubWaitPredicateCatalog.js');
const { isBotComment, isPureSummonCommand, matchGitHubWaitPredicates } = catalog;

const HEAD = 'aaaa1111';
const SELF = 'mindfn';
const AUTHOR = 'zts212653';

const baseline = (overrides = {}) => ({
  capturedAt: 100,
  headSha: HEAD,
  review: { inlineCommentCursor: 50, conversationCommentCursor: 900, decisionCursor: 30 },
  ...overrides,
});

const authorAudience = { mode: 'everyone_but_self', selfLogin: SELF };
const reviewerAudience = { mode: 'subject_author_only', subjectAuthorLogin: AUTHOR };
const unknownAudience = { mode: 'unresolved_identity', missing: ['self', 'subject_author'] };

const surfaces = (audience) => [
  { kind: 'pr_conversation_comment_added', audience },
  { kind: 'pr_inline_comment_added', audience },
];

const comment = (overrides) => ({
  id: 901,
  author: AUTHOR,
  commentType: 'conversation',
  body: 'Please split this.',
  ...overrides,
});

const matchPr = (audience, ...comments) =>
  matchGitHubWaitPredicates(surfaces(audience), baseline(), {
    headSha: HEAD,
    review: { decisionCursor: 30, comments },
  });

describe('#1392 AC-7 — the PR author hears everyone but themselves', () => {
  it('a reviewer’s conversation reply wakes the author', () => {
    assert.equal(matchPr(authorAudience, comment({ author: 'some-reviewer' })).length, 1);
  });

  it('an inline review finding wakes the author — #1377’s channel', () => {
    const matched = matchPr(authorAudience, comment({ id: 51, commentType: 'inline', author: 'some-reviewer' }));

    assert.equal(matched.length, 1);
    assert.equal(matched[0].kind, 'pr_inline_comment_added');
  });

  /*
   * The accepted table says "bots included" for this perspective, and it is the load-bearing half:
   * the cloud reviewer's verdict arrives as a bot comment, and an author who did not hear it would
   * be waiting on a reply that had already come.
   */
  it('a bot’s reply wakes the author, by both of GitHub’s own markers', () => {
    assert.equal(matchPr(authorAudience, comment({ author: 'chatgpt-codex-connector[bot]' })).length, 1);
    assert.equal(matchPr(authorAudience, comment({ author: 'some-app', actorType: 'Bot' })).length, 1);
  });

  it('our own comment wakes nobody, on either surface', () => {
    assert.equal(matchPr(authorAudience, comment({ author: SELF })).length, 0);
    assert.equal(matchPr(authorAudience, comment({ id: 51, commentType: 'inline', author: SELF })).length, 0);
  });

  it('our own comment is recognised however GitHub cases it', () => {
    assert.equal(matchPr(authorAudience, comment({ author: 'MindFn' })).length, 0);
  });
});

describe('#1392 AC-7 — a maintainer hears the PR author, and not the noise around them', () => {
  it('the PR author’s reply wakes the maintainer, on both surfaces', () => {
    assert.equal(matchPr(reviewerAudience, comment({ author: AUTHOR })).length, 1);
    assert.equal(matchPr(reviewerAudience, comment({ id: 51, commentType: 'inline', author: AUTHOR })).length, 1);
  });

  it('a bystander’s comment does not wake the maintainer', () => {
    assert.equal(matchPr(reviewerAudience, comment({ author: 'bystander' })).length, 0);
  });

  it('a bot’s comment does not wake the maintainer, even one opening the PR', () => {
    assert.equal(matchPr(reviewerAudience, comment({ author: AUTHOR, actorType: 'Bot' })).length, 0);
    assert.equal(
      matchPr(
        { mode: 'subject_author_only', subjectAuthorLogin: 'dependabot[bot]' },
        comment({ author: 'dependabot[bot]' }),
      ).length,
      0,
    );
  });

  it('the author summoning a bot does not wake the maintainer', () => {
    assert.equal(matchPr(reviewerAudience, comment({ author: AUTHOR, body: '@codex review' })).length, 0);
  });

  /*
   * The guard that keeps the summon rule from eating the conversation. A reply that mentions a bot
   * and then says something is a reply; the mention does not make it machine noise, and nothing here
   * reads the prose to decide whether it was worth having.
   */
  it('a mention with substantive text beside it is a reply, not a summon', () => {
    const bodies = [
      '@codex review — but note the base branch moved since your last pass',
      'Pushed the fix. @codex review',
      '@codex review\nAlso: the flake is unrelated.',
    ];

    for (const body of bodies) {
      assert.equal(matchPr(reviewerAudience, comment({ author: AUTHOR, body })).length, 1, body);
    }
  });

  it('mentioning a person is never a summon, however terse', () => {
    assert.equal(matchPr(reviewerAudience, comment({ author: AUTHOR, body: '@maintainer please look' })).length, 1);
  });

  it('the summon rule itself only recognises what it can prove', () => {
    assert.equal(isPureSummonCommand('@codex review'), true);
    assert.equal(isPureSummonCommand('  @Codex Review  '), true);
    assert.equal(isPureSummonCommand('@chatgpt-codex-connector[bot] review'), true);
    assert.equal(isPureSummonCommand('@maintainer please look'), false);
    assert.equal(isPureSummonCommand('@codex review the base branch moved again'), false);
    assert.equal(isPureSummonCommand('LGTM @codex'), false);
    assert.equal(isPureSummonCommand(''), false);
    assert.equal(isPureSummonCommand(undefined), false);
  });

  it('bot recognition uses GitHub’s own facts, not a vendor name list', () => {
    assert.equal(isBotComment({ id: 1, author: 'anything', actorType: 'Bot' }), true);
    assert.equal(isBotComment({ id: 1, author: 'renovate[bot]' }), true);
    assert.equal(isBotComment({ id: 1, author: 'codexy-human', actorType: 'User' }), false);
  });
});

describe('#1392 AC-7 — an unknown identity delivers everything, and says so', () => {
  it('every comment matches, including one that looks like ours', () => {
    assert.equal(matchPr(unknownAudience, comment({ author: 'anyone' })).length, 1);
    assert.equal(matchPr(unknownAudience, comment({ author: SELF })).length, 1);
    assert.equal(matchPr(unknownAudience, comment({ author: AUTHOR, body: '@codex review' })).length, 1);
  });

  it('each delta is flagged, so a wake cannot be read as proof the rule was applied', () => {
    const [matched] = matchPr(unknownAudience, comment({ author: 'anyone' }));

    assert.equal(matched.identityUnknown, true);
  });

  it('a resolved audience never flags, so the flag means exactly one thing', () => {
    const [matched] = matchPr(authorAudience, comment({ author: 'some-reviewer' }));

    assert.equal(matched.identityUnknown, undefined);
  });
});

describe('#1392 AC-7 — the issue default', () => {
  const issueBaseline = { capturedAt: 100, issue: { lastCommentCursor: 900, state: 'open', authorLogin: AUTHOR } };
  const matchIssue = (audience, ...comments) =>
    matchGitHubWaitPredicates([{ kind: 'issue_comment_added', audience }], issueBaseline, {
      issue: { state: 'open', comments },
    });

  it('someone else’s comment wakes us', () => {
    assert.equal(matchIssue(authorAudience, { id: 901, author: AUTHOR }).length, 1);
  });

  it('our own comment does not', () => {
    assert.equal(matchIssue(authorAudience, { id: 901, author: SELF }).length, 0);
  });

  it('a comment from before we registered is history, not news', () => {
    assert.equal(matchIssue(authorAudience, { id: 900, author: AUTHOR }).length, 0);
  });

  it('a bot comment still wakes us — the issue default excludes only ourselves', () => {
    assert.equal(matchIssue(authorAudience, { id: 901, author: 'renovate[bot]' }).length, 1);
  });
});

describe('#1392 AC-7 — the advanced path keeps its exact allowlist', () => {
  it('an explicit audience is honoured verbatim and role filtering is not slipped in', () => {
    const when = [{ kind: 'pr_conversation_comment_added', authorLogins: ['chatgpt-codex-connector[bot]'] }];
    const matched = matchGitHubWaitPredicates(when, baseline(), {
      headSha: HEAD,
      review: {
        decisionCursor: 30,
        comments: [comment({ author: 'chatgpt-codex-connector[bot]', body: '@codex review' })],
      },
    });

    assert.equal(matched.length, 1, 'a bot and a summons the caller explicitly asked for still wake them');
  });

  it('an author outside the named allowlist still reaches nobody', () => {
    const when = [{ kind: 'pr_conversation_comment_added', authorLogins: ['someone'] }];
    const matched = matchGitHubWaitPredicates(when, baseline(), {
      headSha: HEAD,
      review: { decisionCursor: 30, comments: [comment({ author: AUTHOR })] },
    });

    assert.equal(matched.length, 0);
  });
});

/**
 * #1392 AC-7 criterion: collection stays unconditional and filtering happens at delivery.
 *
 * These drive the real chain — collector signal → wait lifecycle → MessageStore — because a
 * predicate can be green while the owner hears nothing, which is how the original comment failure
 * stayed hidden for three rounds. They also pin the half that a matcher test cannot see: a comment
 * nobody was woken for must still move the cursor past itself, or the next poll replays it forever.
 */
describe('#1392 AC-7 — the real chain filters at delivery, never at collection', () => {
  async function tracked(when) {
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { GitHubWaitLifecycleService } = await import('../dist/domains/github-signals/GitHubWaitLifecycleService.js');
    const { ReviewFeedbackRouter } = await import('../dist/infrastructure/email/ReviewFeedbackRouter.js');
    const taskStore = new TaskStore();
    const messageStore = new MessageStore();
    const log = { info() {}, warn() {}, error() {} };
    const task = await taskStore.create({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#7',
      threadId: 'thread_1',
      title: 'PR tracking: owner/repo#7',
      ownerCatId: 'opus',
      why: 'test',
      createdBy: 'opus',
      userId: 'user_1',
      automationState: {
        review: { lastInlineCommentCursor: 50, lastConversationCommentCursor: 900, lastDecisionCursor: 30 },
        await: {
          v: 1,
          generation: 1,
          subjectRef: 'pr:owner/repo#7',
          ownerFence: { kind: 'containing_task', generation: 1 },
          baseline: baseline(),
          // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
          continuation: { when, then: 'Answer the reviewer.' },
          createdAt: 100,
        },
      },
    });
    const lifecycle = new GitHubWaitLifecycleService({
      taskStore,
      deliveryDeps: { messageStore },
      now: () => 500,
      log,
    });
    const router = new ReviewFeedbackRouter({ deliveryDeps: { messageStore }, waitLifecycle: lifecycle, log });
    return { router, messageStore, taskStore, task };
  }

  const signal = (newComments, cursors) => ({
    repoFullName: 'owner/repo',
    prNumber: 7,
    headSha: HEAD,
    newComments,
    newDecisions: [],
    inlineCommentCursor: cursors.inline,
    conversationCommentCursor: cursors.conversation,
    decisionCursor: 30,
  });

  const collected = (overrides) => ({
    id: 901,
    author: AUTHOR,
    body: 'Please split this.',
    createdAt: '2026-09-20T00:00:00Z',
    commentType: 'conversation',
    ...overrides,
  });

  it('end to end: a reply the author did not write wakes them', async () => {
    const { router, messageStore, task } = await tracked(surfaces(authorAudience));

    const result = await router.route(signal([collected({})], { inline: 50, conversation: 901 }), { taskId: task.id });

    assert.equal(result.kind, 'notified');
    const [delivered] = messageStore.getByThread('thread_1');
    assert.match(delivered.content, /conversation comment #901/, 'the wake names the surface and the comment');
    assert.match(delivered.content, new RegExp(`by ${AUTHOR}`), 'and who wrote it');
    assert.match(delivered.content, /github:pr-comment:901/, 'and how to go read it');
  });

  /*
   * The load-bearing layering case. The owner's own comment is collected — the PR collector has
   * never filtered it — and must not wake them, while the cursor must still move past it. If the
   * filter lived at collection instead, the cursor would stall and the same comment would be
   * re-judged on every poll.
   */
  it('end to end: our own comment wakes nobody and is not replayed next poll', async () => {
    const { router, messageStore, taskStore, task } = await tracked(surfaces(authorAudience));

    const first = await router.route(signal([collected({ author: SELF })], { inline: 50, conversation: 901 }), {
      taskId: task.id,
    });

    assert.notEqual(first.kind, 'notified', 'we are never woken for what we did ourselves');
    assert.equal(messageStore.getByThread('thread_1').length, 0);
    assert.equal(
      taskStore.get(task.id).automationState.review.lastConversationCommentCursor,
      901,
      'the frontier the next poll reads moved past the filtered comment',
    );

    const next = await router.route(signal([collected({ id: 902 })], { inline: 50, conversation: 902 }), {
      taskId: task.id,
    });

    assert.equal(next.kind, 'notified', 'filtering one comment must not leave the wait unable to fire again');
    assert.equal(messageStore.getByThread('thread_1').length, 1);
  });

  it('end to end: a bot summons from the PR author reaches no maintainer, but moves the frontier', async () => {
    const { router, messageStore, taskStore, task } = await tracked(surfaces(reviewerAudience));

    await router.route(signal([collected({ body: '@codex review' })], { inline: 50, conversation: 901 }), {
      taskId: task.id,
    });

    assert.equal(messageStore.getByThread('thread_1').length, 0);
    assert.equal(taskStore.get(task.id).automationState.review.lastConversationCommentCursor, 901);
  });

  it('end to end: an unknown identity wakes the owner and states that coverage is not established', async () => {
    const { router, messageStore, task } = await tracked(surfaces(unknownAudience));

    const result = await router.route(signal([collected({})], { inline: 50, conversation: 901 }), { taskId: task.id });

    assert.equal(result.kind, 'notified', 'an anomaly travels the normal notification path');
    const [delivered] = messageStore.getByThread('thread_1');
    assert.match(delivered.content, /identity or role unknown/i);
    assert.match(delivered.content, /coverage is NOT established/);
    assert.match(delivered.content, /github:pr-comment:901/, 'the source already acquired is kept');
  });

  it('end to end: a resolved audience says nothing about unknown identity', async () => {
    const { router, messageStore, task } = await tracked(surfaces(authorAudience));

    await router.route(signal([collected({})], { inline: 50, conversation: 901 }), { taskId: task.id });

    assert.doesNotMatch(messageStore.getByThread('thread_1')[0].content, /identity or role unknown/i);
  });

  /*
   * #1392 AC-1 + AC-7 together: the next generation must be armed with the same audience, or a
   * registration would silently loosen or tighten after its first wake. The owner registered once
   * and was told one rule; every later generation has to be that rule.
   */
  it('end to end: the renewed generation carries the same audience it was armed with', async () => {
    const { router, taskStore, task } = await tracked(surfaces(reviewerAudience));

    await router.route(signal([collected({})], { inline: 50, conversation: 901 }), { taskId: task.id });

    const renewed = taskStore.get(task.id).automationState.await;
    assert.equal(renewed.generation, 2, 'a wake installs the next generation');
    const armed = renewed.continuation.when.filter((predicate) => predicate.kind.endsWith('comment_added'));
    assert.equal(armed.length, 2);
    for (const predicate of armed) {
      assert.deepEqual(predicate.audience, reviewerAudience);
    }
  });

  /*
   * The body reaches the matcher now, because the summon rule needs it. It must still stop there:
   * copying untrusted prose into a woken cat's context is a separate hazard this issue never
   * licensed.
   */
  it('end to end: the comment body reaches the matcher and never the owner’s message', async () => {
    const SENTINEL = 'UNTRUSTED_BODY__1392_ac7';
    const { router, messageStore, task } = await tracked(surfaces(authorAudience));

    await router.route(signal([collected({ body: SENTINEL })], { inline: 50, conversation: 901 }), {
      taskId: task.id,
    });

    assert.equal(messageStore.getByThread('thread_1').length, 1);
    assert.ok(!messageStore.getByThread('thread_1')[0].content.includes(SENTINEL));
  });
});

/**
 * #1392 R1/R2/R4: the three defects the maintainer reproduced against `f2f4a9d1a` that live in the
 * audience layer. They are here, beside the table they violate, rather than in a fourth suite of
 * their own — each one is a wrong answer to a question this file already asks.
 *
 * R1 said the summon filter recognised a command by shape alone, so any short reply built from bare
 * words was eaten. R2 said an optional caller list REPLACED the derived audience instead of
 * narrowing it, which re-admitted bystanders and the owner's own comments. R4 said a known issue
 * identity still reported a missing PR-only role.
 */
const {
  expandGitHubPrTrackingGoal,
  resolveGitHubNotificationPerspective,
  resolveGitHubIssueNotificationPerspective,
  describeGitHubNotificationCoverage,
} = await import('../../shared/dist/types/github-wait.js');

const matchWhen = (when, ...comments) =>
  matchGitHubWaitPredicates(when, baseline(), { headSha: HEAD, review: { decisionCursor: 30, comments } });

const asAuthor = resolveGitHubNotificationPerspective({ selfLogin: SELF, subjectAuthorLogin: SELF });
const asMaintainer = resolveGitHubNotificationPerspective({
  selfLogin: SELF,
  subjectAuthorLogin: AUTHOR,
  reviewerGround: 'review_requested',
});

const expandOrThrow = (perspective, goal) => {
  const expansion = expandGitHubPrTrackingGoal(perspective, goal);
  assert.equal(expansion.ok, true, expansion.error);
  return expansion.when;
};

describe('#1392 R1 — a reply is not a summons just because it opens with a mention', () => {
  /*
   * The old rule accepted any trailing bare words, so it could not tell `@codex review` from
   * `@codex tests pass`. A command is recognised by its vocabulary, and when the vocabulary is not
   * there the comment is delivered: an owner can discard one extra wake, never recover a lost one.
   */
  const cases = [
    { body: '@codex review', summon: true, why: 'the command this repo actually issues' },
    { body: '@codex', summon: true, why: 'a bare handle carries nothing for a human' },
    { body: '@codex tests pass', summon: false, why: 'a test-result receipt, in bare words' },
    { body: '@codex looks good to me', summon: false, why: 'prose that happens to need no punctuation' },
    { body: '@codex review — but the base moved', summon: false, why: 'a command plus prose' },
    { body: '@maintainer please look', summon: false, why: 'not a summon handle at all' },
  ];

  for (const { body, summon, why } of cases) {
    it(`${JSON.stringify(body)} → ${summon ? 'summons' : 'delivered'} (${why})`, () => {
      assert.equal(isPureSummonCommand(body), summon);
    });
  }

  it('the maintainer hears the author’s "@codex tests pass" instead of it being filtered', () => {
    assert.equal(matchPr(reviewerAudience, comment({ author: AUTHOR, body: '@codex tests pass' })).length, 1);
  });

  it('and a real summons is still filtered, so the narrowing did not just give up', () => {
    assert.equal(matchPr(reviewerAudience, comment({ author: AUTHOR, body: '@codex review' })).length, 0);
  });
});

describe('#1392 R2 — a caller’s list narrows the accepted audience, it never replaces it', () => {
  it('naming a bystander does not make the maintainer hear bystanders', () => {
    const when = expandOrThrow(asMaintainer, { kind: 'await_reply_from', authorLogins: ['bystander'] });

    assert.equal(matchWhen(when, comment({ author: 'bystander' })).length, 0);
  });

  it('naming ourselves does not make the author hear their own comment', () => {
    const when = expandOrThrow(asAuthor, { kind: 'await_reply_from', authorLogins: [SELF] });

    assert.equal(matchWhen(when, comment({ author: SELF })).length, 0);
  });

  it('still narrows: the named reviewer wakes the author and an unnamed one does not', () => {
    const when = expandOrThrow(asAuthor, { kind: 'await_reply_from', authorLogins: ['some-reviewer'] });

    assert.equal(matchWhen(when, comment({ author: 'some-reviewer' })).length, 1);
    assert.equal(matchWhen(when, comment({ author: 'another-reviewer' })).length, 0);
  });

  it('the maintainer’s narrowing keeps the role rule: the named author, still without their summons', () => {
    const when = expandOrThrow(asMaintainer, { kind: 'await_reply_from', authorLogins: [AUTHOR] });

    assert.equal(matchWhen(when, comment({ author: AUTHOR })).length, 1);
    assert.equal(matchWhen(when, comment({ author: AUTHOR, body: '@codex review' })).length, 0);
  });

  /*
   * The advanced path is explicitly out of scope for the narrowing: a caller who writes `when[]`
   * by hand gets their list verbatim, including themselves if they asked for it.
   */
  it('an explicit when[] list is still used verbatim, with no role filter smuggled in', () => {
    const when = [
      { kind: 'pr_conversation_comment_added', authorLogins: [SELF] },
      { kind: 'pr_inline_comment_added', authorLogins: [SELF] },
    ];

    assert.equal(matchWhen(when, comment({ author: SELF })).length, 1);
  });

  /*
   * Narrowing can produce a combination nothing satisfies: the reviewer rule admits only the PR
   * author, and the caller named someone else. Stating the two rules separately would be true and
   * still leave the caller waiting for a wake that cannot arrive, so the receipt names it dead.
   */
  it('the receipt calls a dead narrowing dead instead of reporting two live rules', () => {
    const when = expandOrThrow(asMaintainer, { kind: 'await_reply_from', authorLogins: ['bystander'] });
    const coverage = describeGitHubNotificationCoverage(asMaintainer, when);

    assert.ok(coverage.commentFilters.length > 0, 'the comment surfaces must still be described');
    assert.ok(
      coverage.commentFilters.every((line) => line.includes('no comment can match both, so nothing will wake you')),
      `every surface must report the dead narrowing: ${JSON.stringify(coverage.commentFilters)}`,
    );
  });

  it('a narrowing that can still fire is never reported as dead', () => {
    const when = expandOrThrow(asAuthor, { kind: 'await_reply_from', authorLogins: ['some-reviewer'] });
    const coverage = describeGitHubNotificationCoverage(asAuthor, when);

    assert.ok(
      coverage.commentFilters.every((line) => !line.includes('nothing will wake you')),
      `a live narrowing must not be called dead: ${JSON.stringify(coverage.commentFilters)}`,
    );
  });
});

describe('#1392 R4 — a known issue identity does not report a missing PR role', () => {
  it('a resolved self login is a resolved issue perspective', () => {
    const perspective = resolveGitHubIssueNotificationPerspective({ selfLogin: 'maintainer' });

    assert.notEqual(perspective.role, 'unresolved');
    assert.equal(perspective.selfLogin, 'maintainer');
  });

  it('the reported coverage states the rule that is actually applied', () => {
    const perspective = resolveGitHubIssueNotificationPerspective({ selfLogin: 'maintainer' });
    const coverage = describeGitHubNotificationCoverage(perspective, [
      { kind: 'issue_comment_added', audience: { mode: 'everyone_but_self', selfLogin: 'maintainer' } },
    ]);

    assert.equal(coverage.perspective.role, perspective.role);
    assert.ok(coverage.commentFilters.some((line) => line.includes('except maintainer')));
    assert.ok(!JSON.stringify(coverage).includes('subject_author'));
  });

  it('an unknown self login is still honestly unresolved, naming only what is missing', () => {
    const perspective = resolveGitHubIssueNotificationPerspective({});

    assert.equal(perspective.role, 'unresolved');
    assert.deepEqual(perspective.missing, ['self']);
  });
});
