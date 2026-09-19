/**
 * #1392 AC-3 / AC-6: review comments reach the owner.
 *
 * On main, ReviewFeedbackRouter received `newComments` and only used them to advance collector
 * cursors — they never entered the facts a predicate is matched against, and there was no comment
 * predicate to match. That is both of #1392's comment failures from one line: "conversation
 * comments collected but no matching predicate — data collected, no notification", and inline
 * review comments dropped silently.
 *
 * The journey tests end at the MessageStore, not at the matcher: a predicate can be green while
 * the owner hears nothing, which is exactly how this stayed hidden.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const catalog = await import('../dist/domains/github-signals/GitHubWaitPredicateCatalog.js');
const { matchGitHubWaitPredicates, canonicalizeGitHubWaitPredicates } = catalog;

const HEAD = 'aaaa1111';

function baseline(overrides = {}) {
  return {
    capturedAt: 100,
    headSha: HEAD,
    review: { inlineCommentCursor: 50, conversationCommentCursor: 900, decisionCursor: 30 },
    ...overrides,
  };
}

const comment = (id, commentType, author = 'reviewer') => ({ id, author, commentType });

/** AC-3: every PR comment predicate names its audience. The default author here is `reviewer`. */
const conversation = (authorLogins = ['reviewer']) => ({ kind: 'pr_conversation_comment_added', authorLogins });
const inline = (authorLogins = ['reviewer']) => ({ kind: 'pr_inline_comment_added', authorLogins });

describe('#1392 comment predicates — matching', () => {
  it('a new conversation comment matches pr_conversation_comment_added', () => {
    const matched = matchGitHubWaitPredicates([conversation()], baseline(), {
      headSha: HEAD,
      review: { decisionCursor: 30, comments: [comment(901, 'conversation')] },
    });
    assert.equal(matched.length, 1);
    assert.equal(matched[0].kind, 'pr_conversation_comment_added');
  });

  it('a new inline review comment matches pr_inline_comment_added', () => {
    const matched = matchGitHubWaitPredicates([inline()], baseline(), {
      headSha: HEAD,
      review: { decisionCursor: 30, comments: [comment(51, 'inline')] },
    });
    assert.equal(matched.length, 1, 'inline review comments are #1392’s headline silent failure');
    assert.equal(matched[0].kind, 'pr_inline_comment_added');
  });

  it('a comment at or below the registration cursor is history, not news', () => {
    const matched = matchGitHubWaitPredicates([inline(), conversation()], baseline(), {
      headSha: HEAD,
      review: { decisionCursor: 30, comments: [comment(50, 'inline'), comment(900, 'conversation')] },
    });
    assert.equal(matched.length, 0);
  });

  it('inline and conversation cursors are separate frontiers that cannot eat each other', () => {
    // Inline id 60 is far below the conversation frontier (900). Compared against the wrong cursor it
    // would be dropped as "old".
    const matched = matchGitHubWaitPredicates([inline()], baseline(), {
      headSha: HEAD,
      review: { decisionCursor: 30, comments: [comment(60, 'inline')] },
    });
    assert.equal(matched.length, 1);
  });

  it('a comment of one surface does not satisfy the other surface’s predicate', () => {
    const matched = matchGitHubWaitPredicates([conversation()], baseline(), {
      headSha: HEAD,
      review: { decisionCursor: 30, comments: [comment(60, 'inline')] },
    });
    assert.equal(matched.length, 0);
  });
});

describe('#1392 AC-3 — positive audiences', () => {
  it('matches only the listed authors, compared case-insensitively', () => {
    const when = [{ kind: 'pr_conversation_comment_added', authorLogins: ['PR-Author'] }];
    const facts = {
      headSha: HEAD,
      review: {
        decisionCursor: 30,
        comments: [comment(901, 'conversation', 'bystander'), comment(902, 'conversation', 'pr-author')],
      },
    };
    const matched = matchGitHubWaitPredicates(when, baseline(), facts);
    assert.equal(matched.length, 1, 'the bystander is outside the frozen audience');
    assert.match(matched[0].delta, /pr-author/);
  });

  it('issue_comment_added honours an optional authorLogins audience', () => {
    const matched = matchGitHubWaitPredicates(
      [{ kind: 'issue_comment_added', authorLogins: ['Maintainer'] }],
      { capturedAt: 1, issue: { lastCommentCursor: 10, state: 'open' } },
      {
        issue: {
          state: 'open',
          comments: [
            { id: 11, author: 'someone' },
            { id: 12, author: 'maintainer' },
          ],
        },
      },
    );
    assert.equal(matched.length, 1);
  });

  it('the registration schema accepts both comment predicates with a named audience', () => {
    assert.doesNotThrow(() => canonicalizeGitHubWaitPredicates([conversation(['a']), inline(['b', 'c'])]));
  });

  /*
   * AC-3 as accepted (#1392 comment 5433764333): `pr_conversation_comment_added` uses REQUIRED
   * `authorLogins`. An omitted audience that quietly means "any author" is an open audience nobody
   * chose — the maintainer rejected exactly that on 2026-08-29 (#1394 comment 5462922571). If an
   * open audience is ever accepted, it has to be written out as such, not implied by a missing field.
   */
  for (const kind of ['pr_conversation_comment_added', 'pr_inline_comment_added']) {
    it(`${kind} without an audience is rejected, never read as "any author"`, () => {
      assert.throws(() => canonicalizeGitHubWaitPredicates([{ kind }]));
    });

    it(`${kind} with an empty audience is rejected`, () => {
      assert.throws(
        () => canonicalizeGitHubWaitPredicates([{ kind, authorLogins: [] }]),
        'an empty allowlist would match nobody and wait forever — that is the dead-wait failure',
      );
    });

    it(`${kind} rejects a blank login and stores the trimmed one`, () => {
      assert.throws(
        () => canonicalizeGitHubWaitPredicates([{ kind, authorLogins: [' '] }]),
        'a blank login is the same dead wait as an empty list',
      );
      const [canonical] = canonicalizeGitHubWaitPredicates([{ kind, authorLogins: [' maintainer '] }]);
      assert.deepEqual(canonical.authorLogins, ['maintainer'], 'padding would never equal a real login');
    });
  }

  it('issue_comment_added keeps its audience optional, as AC-3 states for issues', () => {
    const { canonicalizeGitHubIssueWaitPredicates } = catalog;
    assert.doesNotThrow(() => canonicalizeGitHubIssueWaitPredicates([{ kind: 'issue_comment_added' }]));
    assert.doesNotThrow(() =>
      canonicalizeGitHubIssueWaitPredicates([{ kind: 'issue_comment_added', authorLogins: ['maintainer'] }]),
    );
    assert.throws(() => canonicalizeGitHubIssueWaitPredicates([{ kind: 'issue_comment_added', authorLogins: [] }]));
    assert.throws(() => canonicalizeGitHubIssueWaitPredicates([{ kind: 'issue_comment_added', authorLogins: ['  '] }]));
  });
});

describe('#1392 AC-6 — the real chain delivers review comments to the owner', () => {
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

  it('end to end: an inline review comment wakes the owner', async () => {
    const { router, messageStore, task } = await tracked([inline(['reviewer'])]);
    const nit = {
      id: 51,
      author: 'reviewer',
      body: 'nit: rename this',
      createdAt: '2026-09-15T00:00:00Z',
      commentType: 'inline',
      filePath: 'src/a.ts',
    };

    const result = await router.route(signal([nit], { inline: 51, conversation: 900 }), { taskId: task.id });

    assert.equal(result.kind, 'notified', 'the inline comment must not be absorbed as a cursor move');
    const delivered = messageStore.getByThread('thread_1');
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].content, /inline/i);
  });

  it('end to end: a conversation comment wakes the owner', async () => {
    const { router, messageStore, task } = await tracked([conversation(['maintainer'])]);
    const reply = {
      id: 901,
      author: 'maintainer',
      body: 'Can you split this?',
      createdAt: '2026-09-15T00:00:00Z',
      commentType: 'conversation',
    };

    const result = await router.route(signal([reply], { inline: 50, conversation: 901 }), { taskId: task.id });

    assert.equal(result.kind, 'notified');
    assert.equal(messageStore.getByThread('thread_1').length, 1);
  });

  it('AC-3 end to end: a comment from outside the frozen audience reaches nobody', async () => {
    const { router, messageStore, task } = await tracked([conversation(['maintainer'])]);
    const bystander = {
      id: 901,
      author: 'bystander',
      body: '+1',
      createdAt: '2026-09-15T00:00:00Z',
      commentType: 'conversation',
    };

    await router.route(signal([bystander], { inline: 50, conversation: 901 }), { taskId: task.id });

    assert.equal(messageStore.getByThread('thread_1').length, 0, 'the owner named who they are waiting on');
  });

  it('the comment body is never copied into the delivered message', async () => {
    const { router, messageStore, task } = await tracked([conversation(['maintainer'])]);
    const SENTINEL = 'UNTRUSTED_BODY__1392_c3f1';
    await router.route(
      signal(
        [
          {
            id: 901,
            author: 'maintainer',
            body: SENTINEL,
            createdAt: '2026-09-15T00:00:00Z',
            commentType: 'conversation',
          },
        ],
        { inline: 50, conversation: 901 },
      ),
      { taskId: task.id },
    );
    assert.doesNotMatch(messageStore.getByThread('thread_1')[0].content, new RegExp(SENTINEL));
  });
});
