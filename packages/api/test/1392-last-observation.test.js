import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { GitHubWaitLifecycleService } = await import('../dist/domains/github-signals/GitHubWaitLifecycleService.js');
const { CiCdRouter, REVIEW_FINAL_OBSERVATION_GRACE_MS } = await import('../dist/infrastructure/email/CiCdRouter.js');
const { ReviewFeedbackRouter } = await import('../dist/infrastructure/email/ReviewFeedbackRouter.js');
const { createReviewFeedbackTaskSpec } = await import('../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');

const HEAD = 'aaaa1111';
const SUBJECT = 'pr:owner/repo#7';
const log = { info() {}, warn() {}, error() {} };
const fromMaintainer = { kind: 'pr_conversation_comment_added', authorLogins: ['maintainer'] };

function comment(id) {
  return { id, author: 'maintainer', body: 'thanks', createdAt: '2026-09-15T00:00:00Z', commentType: 'conversation' };
}

function prAwait(generation, when, conversationCursor) {
  return {
    v: 1,
    generation,
    subjectRef: SUBJECT,
    ownerFence: { kind: 'containing_task', generation },
    baseline: {
      capturedAt: 100,
      headSha: HEAD,
      review: { inlineCommentCursor: 10, conversationCommentCursor: conversationCursor, decisionCursor: 40 },
      ci: { bucket: 'pass', fingerprint: `${HEAD}:pass` },
    },
    // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
    continuation: { when, then: 'Answer the maintainer.' },
    createdAt: 100,
  };
}

/** The production PR chain: one task, one lifecycle, and the real CI and review collectors around it. */
async function chain({ automationState, clock = { now: 1_000_000 }, github }) {
  const taskStore = new TaskStore();
  const messageStore = new MessageStore();
  const task = await taskStore.create({
    kind: 'pr_tracking',
    subjectKey: SUBJECT,
    threadId: 'thread_1',
    title: 'PR tracking: owner/repo#7',
    ownerCatId: 'opus',
    why: 'test',
    createdBy: 'opus',
    userId: 'user_1',
    automationState,
  });
  const outboxWakes = [];
  const lifecycle = new GitHubWaitLifecycleService({
    taskStore,
    deliveryDeps: { messageStore },
    log,
    wakeOwner: (delivered) => {
      outboxWakes.push(delivered.outcome.outcomeId);
    },
  });
  const ci = new CiCdRouter({
    taskStore,
    deliveryDeps: { messageStore },
    waitLifecycle: lifecycle,
    log,
    now: () => clock.now,
  });
  const wakes = [];
  const spec = createReviewFeedbackTaskSpec({
    taskStore,
    fetchPrMetadata: async () => ({ headSha: HEAD, prState: github.prState }),
    fetchComments: async (_repo, _pr, cursors) => {
      github.commentFetches += 1;
      return github.comments.filter((c) => c.id > cursors[c.commentType]);
    },
    fetchReviews: async () => [],
    reviewFeedbackRouter: new ReviewFeedbackRouter({ deliveryDeps: { messageStore }, waitLifecycle: lifecycle, log }),
    invokeTrigger: { trigger: async (...args) => wakes.push({ messageId: args[4], reason: args[6].reason }) },
    log,
  });
  const reviewPoll = async () => {
    const gate = await spec.admission.gate();
    for (const item of gate.run ? gate.workItems : []) {
      await spec.run.execute(item.signal, item.subjectKey, {});
    }
    return gate;
  };
  const ciPoll = (prState) =>
    ci.route({
      repoFullName: 'owner/repo',
      prNumber: 7,
      headSha: HEAD,
      prState,
      aggregateBucket: 'pass',
      checks: [{ name: 'tests', bucket: 'pass' }],
    });
  const contents = () => messageStore.getByThread('thread_1').map((message) => message.content);
  return { taskStore, task, ciPoll, reviewPoll, wakes, contents, clock, outboxWakes };
}

/*
 * #1392 AC-2 across collectors. CI and review poll the same task on their own schedules. A comment
 * posted just before a merge is visible only to the review collector, and only until the task is
 * done: after that no collector polls it again. So whichever collector sees the merge first, the
 * wait must not end before the review collector has made its final observation.
 */
describe('#1392 the last observation before a PR ends is not skipped', () => {
  it('CI sees the merge first: the review collector still delivers the final comment with it', async () => {
    const github = { prState: 'merged', comments: [comment(31)], commentFetches: 0 };
    const { taskStore, task, ciPoll, reviewPoll, wakes, contents } = await chain({
      github,
      automationState: {
        ci: { headSha: HEAD, lastFingerprint: `${HEAD}:pass`, lastBucket: 'pass' },
        review: { lastInlineCommentCursor: 10, lastConversationCommentCursor: 30, lastDecisionCursor: 40 },
        await: prAwait(1, [fromMaintainer], 30),
      },
    });

    const ciResult = await ciPoll('merged');

    assert.notEqual(ciResult.kind, 'lifecycle', 'CI cannot see the comment, so it does not end the wait');
    const deferred = await taskStore.get(task.id);
    assert.notEqual(deferred.status, 'done', 'the review collector still polls the task');
    assert.equal(deferred.automationState.ci.prState, 'merged', 'CI still records the merge it saw');
    assert.equal(contents().length, 0);

    await reviewPoll();

    assert.equal(github.commentFetches, 1, 'the review collector makes its final observation');
    assert.equal(contents().length, 1, 'one owner message');
    assert.match(contents()[0], /conversation comment #31 by maintainer/, 'the final comment is not lost');
    assert.match(contents()[0], /merged/);
    assert.equal((await taskStore.get(task.id)).status, 'done', 'and the merge still ends tracking');
    assert.deepEqual(
      wakes.map((wake) => wake.reason),
      ['github_pr_merged'],
    );
  });

  it('a wait CI can fully observe still ends on the CI poll that sees the merge', async () => {
    const github = { prState: 'merged', comments: [], commentFetches: 0 };
    const { taskStore, task, ciPoll, contents } = await chain({
      github,
      automationState: {
        ci: { headSha: HEAD, lastFingerprint: `${HEAD}:pending`, lastBucket: 'pending' },
        await: prAwait(1, [{ kind: 'pr_ci_terminal' }], 30),
      },
    });

    const ciResult = await ciPoll('merged');

    assert.equal(ciResult.kind, 'lifecycle');
    assert.equal((await taskStore.get(task.id)).status, 'done');
    assert.equal(contents().length, 1);
  });

  it('if the review collector never observes the merge, CI ends the wait after the grace period', async () => {
    const github = { prState: 'merged', comments: [], commentFetches: 0 };
    const { taskStore, task, ciPoll, contents, clock } = await chain({
      github,
      automationState: {
        ci: { headSha: HEAD, lastFingerprint: `${HEAD}:pass`, lastBucket: 'pass' },
        review: { lastInlineCommentCursor: 10, lastConversationCommentCursor: 30, lastDecisionCursor: 40 },
        await: prAwait(1, [fromMaintainer], 30),
      },
    });

    await ciPoll('merged');
    clock.now += REVIEW_FINAL_OBSERVATION_GRACE_MS - 1;
    await ciPoll('merged');
    assert.notEqual((await taskStore.get(task.id)).status, 'done', 'still inside the grace period');

    clock.now += 1;
    const ciResult = await ciPoll('merged');

    assert.equal(ciResult.kind, 'lifecycle', 'a missing review collector cannot keep a merged PR tracked forever');
    assert.equal((await taskStore.get(task.id)).status, 'done');
    assert.equal(contents().length, 1);
    assert.match(contents()[0], /merged/);
  });
});

/*
 * #1392 AC-1: after a renewal, outcome N can still be pending while N+1 is live. The review
 * collector must not move its cursor past an observation the lifecycle did not record — not even
 * when the same call re-delivered N and so has a message to show for itself.
 */
describe('#1392 the review cursor never passes an observation the wait did not record', () => {
  it('holds the cursor when every write loses, then delivers the comment on the next poll', async () => {
    const github = { prState: 'open', comments: [comment(32)], commentFetches: 0 };
    const pendingN = {
      v: 1,
      outcomeId: `wait:${SUBJECT}:g1:matched`,
      generation: 1,
      subjectRef: SUBJECT,
      ownerFence: { kind: 'containing_task', generation: 1 },
      reason: 'matched',
      at: 200,
      delivery: 'pending',
      matched: [{ kind: 'pr_conversation_comment_added', delta: 'conversation comment #31 by maintainer' }],
      nextStep: 'Answer the maintainer.',
      renewal: 'rearmed',
    };
    const { taskStore, task, reviewPoll, wakes, contents, outboxWakes } = await chain({
      github,
      automationState: {
        review: { lastInlineCommentCursor: 10, lastConversationCommentCursor: 31, lastDecisionCursor: 40 },
        waitOutcome: pendingN,
        await: prAwait(2, [fromMaintainer], 31),
      },
    });
    const replace = taskStore.replaceAutomationStateIfGeneration.bind(taskStore);
    let lostInstalls = 3;
    taskStore.replaceAutomationStateIfGeneration = (taskId, input) => {
      if (input.automationState?.waitOutcome?.generation === 2 && lostInstalls > 0) {
        lostInstalls -= 1;
        return null;
      }
      return replace(taskId, input);
    };

    await reviewPoll();

    const held = (await taskStore.get(task.id)).automationState;
    assert.equal(lostInstalls, 0, 'every install of the observation lost its race');
    assert.equal(held.review.lastConversationCommentCursor, 31, 'the cursor did not pass comment #32');
    assert.equal(held.await.generation, 2, 'N+1 is untouched');
    assert.equal(held.await.baseline.review.conversationCommentCursor, 31);
    assert.equal(contents().length, 1, 'N itself was flushed from the outbox');
    assert.match(contents()[0], /#31/);
    assert.deepEqual(outboxWakes, [pendingN.outcomeId], 'and its owner is woken by whoever flushed it');
    assert.equal(wakes.length, 0, 'the collector never wakes for a message that is not its poll’s result');

    await reviewPoll();

    assert.equal(github.commentFetches, 2, 'the next poll collects #32 again');
    assert.equal(contents().length, 2);
    assert.match(contents()[1], /conversation comment #32 by maintainer/, '#32 is delayed one poll, not lost');
    assert.equal((await taskStore.get(task.id)).automationState.review.lastConversationCommentCursor, 32);
    assert.equal(wakes.length, 1, 'the collector wakes for its own observation, once it is recorded');
  });
});
