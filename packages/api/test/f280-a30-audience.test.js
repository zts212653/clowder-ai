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
});
