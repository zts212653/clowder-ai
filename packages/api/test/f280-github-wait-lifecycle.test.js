import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { MemoryWaitLifecycleEventLog } = await import('../dist/domains/ball-custody/WaitLifecycleEventLog.js');
const { GitHubWaitLifecycleService } = await import('../dist/domains/github-signals/GitHubWaitLifecycleService.js');
const { WaitLifecycleRecoverySweep } = await import('../dist/domains/ball-custody/WaitLifecycleRecoverySweep.js');
const { PrWaitMigrationService } = await import('../dist/domains/ball-custody/PrWaitMigrationService.js');
const { CiCdRouter, classifyCiWaitBucket } = await import('../dist/infrastructure/email/CiCdRouter.js');
const { ReviewFeedbackRouter } = await import('../dist/infrastructure/email/ReviewFeedbackRouter.js');
const { REVIEW_LOOP_BRAKE_NEXT_STEP } = await import('../dist/domains/github-signals/github-wait-renderer.js');

function activeState(when = [{ kind: 'pr_head_changed' }]) {
  return {
    ci: { headSha: 'aaaa1111', lastFingerprint: 'aaaa1111:pending', lastBucket: 'pending' },
    review: {
      lastInlineCommentCursor: 20,
      lastConversationCommentCursor: 30,
      lastDecisionCursor: 40,
    },
    await: {
      v: 1,
      generation: 3,
      subjectRef: 'pr:owner/repo#7',
      ownerFence: { kind: 'containing_task', generation: 3 },
      baseline: {
        capturedAt: 100,
        headSha: 'aaaa1111',
        review: {
          inlineCommentCursor: 20,
          conversationCommentCursor: 30,
          decisionCursor: 40,
        },
        ci: { bucket: 'pending', fingerprint: 'aaaa1111:pending' },
        conflict: { mergeState: 'MERGEABLE' },
      },
      continuation: {
        when,
        // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
        then: 'Re-lock the exact HEAD.',
      },
      expiresAt: 10_000,
      createdAt: 100,
      provenance: 'explicit_registration',
    },
  };
}

async function harness(when) {
  const taskStore = new TaskStore();
  const messageStore = new MessageStore();
  const eventLog = new MemoryWaitLifecycleEventLog();
  const task = await taskStore.create({
    kind: 'pr_tracking',
    subjectKey: 'pr:owner/repo#7',
    threadId: 'thread_1',
    title: 'PR tracking: owner/repo#7',
    ownerCatId: 'codex-sol',
    why: 'test',
    createdBy: 'codex-sol',
    userId: 'user_1',
    automationState: activeState(when),
  });
  const lifecycle = new GitHubWaitLifecycleService({
    taskStore,
    deliveryDeps: { messageStore },
    eventLog,
    now: () => 500,
    log: { info() {}, warn() {}, error() {} },
  });
  return { taskStore, messageStore, eventLog, task, lifecycle };
}

describe('F280 GitHub wait lifecycle integration', () => {
  it('absorbs registration history and unrelated source activity without a message', async () => {
    const { lifecycle, messageStore, taskStore, task } = await harness([{ kind: 'pr_head_changed' }]);
    const sentinel = 'OLD_BODY_f280_history_must_not_wake';
    const result = await lifecycle.observe({
      taskId: task.id,
      facts: {
        headSha: 'aaaa1111',
        review: { decisionCursor: 99, decision: sentinel },
      },
      collectorPatch: { review: { lastDecisionCursor: 99 } },
    });

    assert.equal(result.kind, 'state_only');
    assert.equal(messageStore.getByThread('thread_1').length, 0);
    assert.equal((await taskStore.get(task.id)).automationState.await.generation, 3);
    assert.equal((await taskStore.get(task.id)).automationState.review.lastDecisionCursor, 99);
  });

  /*
   * The trap in making `expiresAt` optional: the unmatched branch used `at < active.expiresAt`.
   * With no deadline that is `at < undefined`, which is false, so an ordinary quiet poll fell
   * through to a transition, came back as `empty_match`, and was reported `deduped` — skipping
   * the collector patch. Nothing woke anyone, which is why it would have stayed invisible.
   */
  it('a wait with no expiresAt keeps a quiet poll state-only and still records collector progress', async () => {
    const { lifecycle, messageStore, taskStore, task } = await harness([{ kind: 'pr_head_changed' }]);
    const current = (await taskStore.get(task.id)).automationState;
    const { expiresAt: _omitted, ...noDeadline } = current.await;
    await taskStore.replaceAutomationStateIfGeneration(task.id, {
      expectedGeneration: current.await.generation,
      expectedUpdatedAt: (await taskStore.get(task.id)).updatedAt,
      automationState: { ...current, await: noDeadline },
    });

    const result = await lifecycle.observe({
      taskId: task.id,
      facts: { headSha: 'aaaa1111', review: { decisionCursor: 99 } },
      collectorPatch: { review: { lastDecisionCursor: 99 } },
    });

    assert.equal(result.kind, 'state_only', 'a quiet poll is not a dedup, deadline or no deadline');
    assert.equal(messageStore.getByThread('thread_1').length, 0);
    const after = (await taskStore.get(task.id)).automationState;
    assert.equal(after.await.generation, 3, 'still the same live generation');
    assert.equal(after.review.lastDecisionCursor, 99, 'the collector patch must still land');
  });

  /*
   * #1392 AC-1, the journey the whole issue is about: register once, and keep being told.
   * Before this, the first match consumed the wait and the owner had to re-register — the
   * "easy to forget, breaks the notification chain" failure #1392 opened with.
   */
  it('follows two consecutive HEAD updates without re-registration', async () => {
    const { lifecycle, messageStore, taskStore, task } = await harness([{ kind: 'pr_head_changed' }]);

    const first = await lifecycle.observe({ taskId: task.id, facts: { headSha: 'bbbb2222' } });
    assert.equal(first.kind, 'notified');
    const afterFirst = await taskStore.get(task.id);
    assert.equal(afterFirst.status, 'doing', 'a notification is not an exit');
    assert.equal(afterFirst.automationState.await.generation, 4);
    assert.equal(afterFirst.automationState.await.baseline.headSha, 'bbbb2222', 'N+1 watches from the new HEAD');
    assert.deepEqual(afterFirst.automationState.await.continuation.when, [{ kind: 'pr_head_changed' }]);
    assert.equal(
      afterFirst.automationState.waitOutcome.delivery,
      'delivered',
      'marking delivery must succeed even though the store already moved to N+1',
    );
    assert.match(first.content, /continu/i, 'the owner is told tracking continues');

    const second = await lifecycle.observe({ taskId: task.id, facts: { headSha: 'cccc3333' } });
    assert.equal(second.kind, 'notified', 'the second update is heard without registering again');
    assert.equal((await taskStore.get(task.id)).automationState.await.generation, 5);
    assert.equal(messageStore.getByThread('thread_1').length, 2);
  });

  it('does not deliver the same update twice across a renewal', async () => {
    const { lifecycle, messageStore, task } = await harness([{ kind: 'pr_head_changed' }]);

    await lifecycle.observe({ taskId: task.id, facts: { headSha: 'bbbb2222' } });
    const replay = await lifecycle.observe({ taskId: task.id, facts: { headSha: 'bbbb2222' } });

    assert.notEqual(replay.kind, 'notified', 'N+1 starts at the HEAD N reported, so the same HEAD is history');
    assert.equal(messageStore.getByThread('thread_1').length, 1);
  });

  /*
   * #1392 AC-1: auto-renew installs outcome N and await N+1 together, so "N still pending while N+1
   * is live" is an ordinary state — one failed delivery is enough, as is a second collector polling
   * while the first delivers. The next observation re-delivers N, but its own events belong to N+1,
   * and the issue and PR collectors have already moved their cursors past them. Returning right
   * after the re-delivery lost those events for good.
   */
  it('re-delivering a pending outcome does not swallow the observation that belongs to N+1', async () => {
    const taskStore = new TaskStore();
    const messageStore = new MessageStore();
    const task = await taskStore.create({
      kind: 'issue_tracking',
      subjectKey: 'issue:owner/repo#9',
      threadId: 'thread_issue',
      title: 'Issue tracking: owner/repo#9',
      ownerCatId: 'codex-sol',
      why: 'test',
      createdBy: 'codex-sol',
      userId: 'user_1',
      automationState: {
        issue: { lastCommentCursor: 100, lastDeliveredCursor: 100, issueState: 'open' },
        await: {
          v: 1,
          generation: 3,
          subjectRef: 'issue:owner/repo#9',
          ownerFence: { kind: 'containing_task', generation: 3 },
          baseline: { capturedAt: 100, issue: { lastCommentCursor: 100, state: 'open', authorLogin: 'author' } },
          // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
          continuation: { when: [{ kind: 'issue_comment_added' }], then: 'Reply to the issue.' },
          createdAt: 100,
        },
      },
    });
    const append = messageStore.append.bind(messageStore);
    let failures = 1;
    messageStore.append = (message) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('message store unavailable');
      }
      return append(message);
    };
    const lifecycle = new GitHubWaitLifecycleService({
      taskStore,
      deliveryDeps: { messageStore },
      now: () => 500,
      log: { info() {}, warn() {}, error() {} },
    });
    const poll = (id) =>
      lifecycle.observe({
        taskId: task.id,
        facts: { issue: { state: 'open', comments: [{ id, author: 'someone' }] } },
        collectorPatch: { issue: { lastCommentCursor: id } },
      });

    await assert.rejects(poll(101), /message store unavailable/);
    const stranded = (await taskStore.get(task.id)).automationState;
    assert.equal(stranded.waitOutcome.delivery, 'pending', 'N is installed but undelivered');
    assert.equal(stranded.await.generation, 4, 'and N+1 is already live beside it');

    // The collector cursor already passed #101, so this poll carries only #102.
    const second = await poll(102);

    const contents = messageStore.getByThread('thread_issue').map((message) => message.content);
    assert.equal(contents.length, 2, 'N is re-delivered and N+1 reports its own comment');
    assert.ok(contents.some((content) => /issue comment #101 added by someone/.test(content)));
    assert.ok(
      contents.some((content) => /issue comment #102 added by someone/.test(content)),
      '#102 is not lost',
    );
    assert.equal(second.kind, 'notified');
    assert.match(second.content, /#102/, 'the caller only ever sees its own observation’s result');
    assert.equal((await taskStore.get(task.id)).automationState.await.generation, 5);
  });

  /*
   * Same stranded state, now with other writers racing N+1's install. Re-delivering N is not a lost
   * race, so it must not spend the attempts the observation has for its own write. And when every
   * one of those writes loses, nothing of the observation was recorded: the result has to say so,
   * rather than hand back N's re-delivery as if this observation had been reported.
   */
  async function strandedIssueWait() {
    const taskStore = new TaskStore();
    const messageStore = new MessageStore();
    const task = await taskStore.create({
      kind: 'issue_tracking',
      subjectKey: 'issue:owner/repo#9',
      threadId: 'thread_issue',
      title: 'Issue tracking: owner/repo#9',
      ownerCatId: 'codex-sol',
      why: 'test',
      createdBy: 'codex-sol',
      userId: 'user_1',
      automationState: {
        issue: { lastCommentCursor: 101, lastDeliveredCursor: 101, issueState: 'open' },
        waitOutcome: {
          v: 1,
          outcomeId: 'wait:issue:owner/repo#9:g3:matched',
          generation: 3,
          subjectRef: 'issue:owner/repo#9',
          ownerFence: { kind: 'containing_task', generation: 3 },
          reason: 'matched',
          at: 400,
          delivery: 'pending',
          matched: [{ kind: 'issue_comment_added', delta: 'issue comment #101 added by someone' }],
          nextStep: 'Reply to the issue.',
          renewal: 'rearmed',
        },
        await: {
          v: 1,
          generation: 4,
          subjectRef: 'issue:owner/repo#9',
          ownerFence: { kind: 'containing_task', generation: 4 },
          baseline: { capturedAt: 400, issue: { lastCommentCursor: 101, state: 'open', authorLogin: 'author' } },
          // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
          continuation: { when: [{ kind: 'issue_comment_added' }], then: 'Reply to the issue.' },
          createdAt: 400,
        },
      },
    });
    const replace = taskStore.replaceAutomationStateIfGeneration.bind(taskStore);
    const races = { lostInstalls: 0 };
    taskStore.replaceAutomationStateIfGeneration = (taskId, input) => {
      if (input.automationState?.waitOutcome?.generation === 4 && races.lostInstalls > 0) {
        races.lostInstalls -= 1;
        return null;
      }
      return replace(taskId, input);
    };
    const outboxWakes = [];
    const lifecycle = new GitHubWaitLifecycleService({
      taskStore,
      deliveryDeps: { messageStore },
      now: () => 500,
      log: { info() {}, warn() {}, error() {} },
      wakeOwner: (delivered) => {
        outboxWakes.push(delivered.outcome.generation);
      },
    });
    const poll = (id) =>
      lifecycle.observe({
        taskId: task.id,
        facts: { issue: { state: 'open', comments: [{ id, author: 'someone' }] } },
        collectorPatch: { issue: { lastCommentCursor: id, lastDeliveredCursor: id } },
      });
    const contents = () => messageStore.getByThread('thread_issue').map((message) => message.content);
    return { taskStore, task, races, poll, contents, outboxWakes };
  }

  it('re-delivering N does not spend the attempts the observation needs for N+1', async () => {
    const { races, poll, contents } = await strandedIssueWait();
    races.lostInstalls = 2;

    const result = await poll(102);

    assert.equal(races.lostInstalls, 0);
    assert.equal(result.kind, 'notified');
    assert.match(result.content, /#102/, 'the third attempt installs N+1');
    assert.equal(contents().length, 2);
  });

  it('an observation whose every write loses is unrecorded, and never borrows N’s delivery', async () => {
    const { taskStore, task, races, poll, contents, outboxWakes } = await strandedIssueWait();
    races.lostInstalls = 3;

    const result = await poll(102);

    assert.equal(races.lostInstalls, 0);
    assert.equal(result.kind, 'unrecorded', 'the caller must be able to tell');
    assert.deepEqual(outboxWakes, [3], 'N’s flushed delivery is woken by the service that flushed it');
    const held = (await taskStore.get(task.id)).automationState;
    assert.equal(held.issue.lastDeliveredCursor, 101, 'nothing of the observation was recorded');
    assert.equal(held.await.generation, 4);
    assert.deepEqual(contents().length, 1);

    const retried = await poll(102);

    assert.equal(retried.kind, 'notified');
    assert.match(retried.content, /#102/, 'collected again, #102 is reported');
    assert.equal((await taskStore.get(task.id)).automationState.issue.lastDeliveredCursor, 102);
  });

  /*
   * #1392 AC-1: a push and a review can land in the same poll. N was installed on the old HEAD, so
   * its same-HEAD guard cannot see the review — and N+1 starts past the review's id. A review of
   * the pushed HEAD must therefore be reported by N; a late review of the old HEAD (which the
   * collector keeps out of `newDecisions`) is not an approval of the new HEAD and stays absorbed.
   */
  for (const { name, newDecisions, reported } of [
    { name: 'a review of the pushed HEAD is reported with the push, once', newDecisions: ['bbbb2222'], reported: true },
    { name: 'a late review of the old HEAD stays absorbed', newDecisions: [], reported: false },
  ]) {
    it(`same poll as a push: ${name}`, async () => {
      const { lifecycle, messageStore, taskStore, task } = await harness([
        { kind: 'pr_head_changed' },
        { kind: 'pr_review_decision_changed' },
      ]);
      const log = { info() {}, warn() {}, error() {} };
      const router = new ReviewFeedbackRouter({ deliveryDeps: { messageStore }, waitLifecycle: lifecycle, log });
      const review = (commitId) => ({
        id: 41,
        author: 'reviewer',
        state: 'APPROVED',
        body: '',
        submittedAt: '2026-09-15T00:00:00Z',
        commitId,
      });
      const poll = (decisions) =>
        router.route(
          {
            repoFullName: 'owner/repo',
            prNumber: 7,
            headSha: 'bbbb2222',
            newComments: [],
            newDecisions: decisions.map(review),
            inlineCommentCursor: 20,
            conversationCommentCursor: 30,
            decisionCursor: 41,
          },
          { taskId: task.id },
        );

      const first = await poll(newDecisions);
      assert.equal(first.kind, 'notified', 'the push itself is always reported');
      const matched = (await taskStore.get(task.id)).automationState.waitOutcome.matched.map((m) => m.kind);
      assert.deepEqual(
        matched.sort(),
        reported ? ['pr_head_changed', 'pr_review_decision_changed'] : ['pr_head_changed'],
      );

      const next = await poll([]);
      assert.notEqual(next.kind, 'notified', 'N+1 never replays what N reported or absorbed');
      assert.equal(messageStore.getByThread('thread_1').length, 1);
    });
  }

  /*
   * The state machine can only keep a one-delivery override out of N+1 if the lifecycle hands it
   * the registered continuation. The unit test proves the machine; this proves the wiring — drop
   * the continuation from the renewal plan and "pause once" silently becomes "pause forever".
   */
  it('pauses one delivery on the review-loop brake without pausing every later generation', async () => {
    const { lifecycle, taskStore, task } = await harness([{ kind: 'pr_head_changed' }]);

    const braked = await lifecycle.observe({
      taskId: task.id,
      facts: { headSha: 'bbbb2222' },
      reviewLoopBrake: { kind: 'pause_once', formalChangesRequested: 4 },
    });

    assert.equal(braked.outcome.nextStep, REVIEW_LOOP_BRAKE_NEXT_STEP, 'this delivery is paused');
    assert.equal(
      (await taskStore.get(task.id)).automationState.await.continuation.then,
      'Re-lock the exact HEAD.',
      'the next generation keeps the registered continuation',
    );
  });

  it('a merged PR ends tracking instead of renewing it', async () => {
    const { lifecycle, taskStore, task } = await harness([{ kind: 'pr_head_changed' }]);

    await lifecycle.observe({ taskId: task.id, facts: { headSha: 'aaaa1111' }, subjectState: 'merged' });

    const after = await taskStore.get(task.id);
    assert.equal(after.status, 'done');
    assert.equal(after.automationState.await, undefined);
  });

  /*
   * #1392 AC-2: a merge, a close and an explicit deadline end tracking; none of them discards the poll
   * it was noticed in. That poll is the last one — nothing will ever report what it observed later —
   * and what it observed may well predate the merge or the deadline.
   */
  for (const { name, observation, reason } of [
    { name: 'a merge', observation: { subjectState: 'merged' }, reason: 'subject_terminal' },
    { name: 'an expired deadline', observation: { at: 10_000 }, reason: 'expired' },
  ]) {
    it(`${name} still reports what its final poll matched`, async () => {
      const { lifecycle, messageStore, taskStore, task } = await harness([{ kind: 'pr_head_changed' }]);

      const result = await lifecycle.observe({ taskId: task.id, facts: { headSha: 'bbbb2222' }, ...observation });

      assert.equal(result.kind, 'notified');
      assert.equal(result.outcome.reason, reason, 'tracking still ends, for the same reason');
      assert.match(result.content, /HEAD aaaa111 → bbbb222/, 'the final poll’s match is not dropped');
      assert.equal((await taskStore.get(task.id)).status, 'done');
      assert.equal(messageStore.getByThread('thread_1').length, 1);
    });
  }

  /*
   * #1392 AC-6 end to end: the last comment before a merge is exactly the one an owner must not
   * miss, and after this delivery the task is done — nothing will ever report it later.
   */
  it('a merged PR still reports the awaited comment that arrived in the same poll', async () => {
    const { lifecycle, messageStore, taskStore, task } = await harness([
      { kind: 'pr_conversation_comment_added', authorLogins: ['maintainer'] },
    ]);
    const log = { info() {}, warn() {}, error() {} };
    const router = new ReviewFeedbackRouter({ deliveryDeps: { messageStore }, waitLifecycle: lifecycle, log });

    const result = await router.route(
      {
        repoFullName: 'owner/repo',
        prNumber: 7,
        headSha: 'aaaa1111',
        newComments: [
          {
            id: 31,
            author: 'maintainer',
            body: 'merging',
            createdAt: '2026-09-15T00:00:00Z',
            commentType: 'conversation',
          },
        ],
        newDecisions: [],
        inlineCommentCursor: 20,
        conversationCommentCursor: 31,
        decisionCursor: 40,
        subjectState: 'merged',
      },
      { taskId: task.id },
    );

    assert.equal(result.kind, 'notified');
    assert.match(result.content, /conversation comment #31 by maintainer/, 'the final comment is not dropped');
    assert.match(result.content, /merged/);
    assert.equal((await taskStore.get(task.id)).status, 'done', 'and tracking still ends');
  });

  it('keeps CI failure and mindfn COMMENTED state-only, then wakes once for the awaited new HEAD', async () => {
    const { lifecycle, messageStore, taskStore, task } = await harness([{ kind: 'pr_head_changed' }]);
    const log = { info() {}, warn() {}, error() {} };
    const ci = new CiCdRouter({
      taskStore,
      deliveryDeps: { messageStore },
      waitLifecycle: lifecycle,
      log,
    });
    const review = new ReviewFeedbackRouter({
      deliveryDeps: { messageStore },
      waitLifecycle: lifecycle,
      log,
    });

    const ciResult = await ci.route({
      repoFullName: 'owner/repo',
      prNumber: 7,
      headSha: 'aaaa1111',
      prState: 'open',
      aggregateBucket: 'fail',
      checks: [{ name: 'tests', bucket: 'fail' }],
    });
    assert.equal(ciResult.kind, 'skipped');

    const commented = await review.route(
      {
        repoFullName: 'owner/repo',
        prNumber: 7,
        headSha: 'aaaa1111',
        newComments: [],
        newDecisions: [
          {
            id: 99,
            author: 'mindfn',
            actorType: 'User',
            state: 'COMMENTED',
            body: 'UNTRUSTED_REVIEW_BODY_MUST_NOT_WAKE',
            submittedAt: '2026-08-04T00:00:00Z',
          },
        ],
        inlineCommentCursor: 20,
        conversationCommentCursor: 30,
        decisionCursor: 99,
      },
      { taskId: task.id },
    );
    assert.equal(commented.kind, 'skipped');
    assert.equal(messageStore.getByThread('thread_1').length, 0);
    assert.equal((await taskStore.get(task.id)).automationState.review.lastDecisionCursor, 99);
    assert.equal((await taskStore.get(task.id)).automationState.ci.lastBucket, 'fail');

    const newHead = await review.route(
      {
        repoFullName: 'owner/repo',
        prNumber: 7,
        headSha: 'bbbb2222',
        newComments: [],
        newDecisions: [],
        inlineCommentCursor: 20,
        conversationCommentCursor: 30,
        decisionCursor: 99,
      },
      { taskId: task.id },
    );
    assert.equal(newHead.kind, 'notified');
    assert.match(newHead.content, /HEAD aaaa111 → bbbb222/);
    assert.doesNotMatch(newHead.content, /mindfn|UNTRUSTED_REVIEW_BODY/);
    assert.equal(messageStore.getByThread('thread_1').length, 1);
  });

  it('consumes a generation once and publishes only compact baseline delta plus next step', async () => {
    const { lifecycle, messageStore, eventLog, taskStore, task } = await harness();
    const first = await lifecycle.observe({
      taskId: task.id,
      facts: { headSha: 'bbbb2222' },
    });
    const replay = await lifecycle.observe({
      taskId: task.id,
      facts: { headSha: 'bbbb2222' },
    });

    assert.equal(first.kind, 'notified');
    assert.notEqual(replay.kind, 'notified');
    const messages = messageStore.getByThread('thread_1');
    assert.equal(messages.length, 1);
    assert.match(messages[0].content, /HEAD aaaa111 → bbbb222/);
    assert.match(messages[0].content, /Next: Re-lock the exact HEAD/);
    assert.equal(messages[0].content.includes('OLD_BODY'), false);
    assert.deepEqual(messages[0].source?.meta?.waitContinuationCarrier, {
      v: 1,
      waitId: task.id,
      outcomeId: 'wait:pr:owner/repo#7:g3:matched',
      ownerFence: { kind: 'containing_task', generation: 3 },
    });
    assert.equal((await taskStore.get(task.id)).automationState.waitOutcome.delivery, 'delivered');
    const events = await eventLog.read(task.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'wait.terminated');
    assert.equal(events[0].reason, 'matched');
  });

  it('projects the fourth-review brake through the existing outcome without adding round state', async () => {
    const { lifecycle, taskStore, task } = await harness([{ kind: 'pr_review_decision_changed' }]);
    const result = await lifecycle.observe({
      taskId: task.id,
      facts: {
        headSha: 'aaaa1111',
        review: { decisionCursor: 41, decision: 'CHANGES_REQUESTED' },
      },
      collectorPatch: {
        review: {
          lastInlineCommentCursor: 20,
          lastConversationCommentCursor: 30,
          lastDecisionCursor: 41,
        },
      },
      reviewLoopBrake: { kind: 'pause_once', formalChangesRequested: 4 },
    });

    assert.equal(result.kind, 'notified');
    assert.match(result.content, /automatic re-request paused once/i);
    const state = (await taskStore.get(task.id)).automationState;
    assert.equal(state.waitOutcome.nextStep, REVIEW_LOOP_BRAKE_NEXT_STEP);
    const serialized = JSON.stringify(state).toLowerCase();
    for (const forbidden of ['reviewround', 'reviewreset', 'reviewlease', 'reviewverdict']) {
      assert.doesNotMatch(serialized, new RegExp(forbidden));
    }
  });

  it('a bot-authored CI terminal fact wakes only an explicit CI waiter', async () => {
    const { lifecycle, task } = await harness([{ kind: 'pr_ci_terminal' }]);
    const result = await lifecycle.observe({
      taskId: task.id,
      facts: {
        headSha: 'aaaa1111',
        ci: { bucket: 'pass', fingerprint: 'aaaa1111:pass', blockerCount: 0 },
      },
    });
    assert.equal(result.kind, 'notified');
    assert.match(result.content, /CI pending → pass/);
  });

  it('billing-only zero-runner jobs are state-only external infrastructure', () => {
    assert.equal(
      classifyCiWaitBucket({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 1,
        headSha: 'aaaa1111',
        prState: 'open',
        aggregateBucket: 'fail',
        checks: [
          {
            name: 'gate',
            bucket: 'fail',
            executionFailure: 'billing_spending_limit_zero_step',
          },
        ],
      }),
      'external_infrastructure',
    );
  });

  it('recovery replays silent terminal events and pending owner wakes idempotently', async () => {
    const taskStore = new TaskStore();
    const messageStore = new MessageStore();
    const eventLog = new MemoryWaitLifecycleEventLog();
    const lifecycle = new GitHubWaitLifecycleService({
      taskStore,
      deliveryDeps: { messageStore },
      eventLog,
      log: { info() {}, warn() {}, error() {} },
    });
    const silent = await taskStore.create({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#11',
      threadId: 'thread_silent',
      title: 'PR tracking: owner/repo#11',
      ownerCatId: 'codex-sol',
      why: 'silent recovery',
      createdBy: 'codex-sol',
      userId: 'user_1',
      automationState: {
        waitOutcome: {
          v: 1,
          outcomeId: 'wait:pr:owner/repo#11:g1:superseded',
          generation: 1,
          subjectRef: 'pr:owner/repo#11',
          ownerFence: { kind: 'containing_task', generation: 1 },
          reason: 'superseded',
          at: 500,
          delivery: 'not_applicable',
          actor: { kind: 'system' },
        },
      },
    });
    const pending = await taskStore.create({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#12',
      threadId: 'thread_pending',
      title: 'PR tracking: owner/repo#12',
      ownerCatId: 'codex-sol',
      why: 'pending recovery',
      createdBy: 'codex-sol',
      userId: 'user_1',
      automationState: {
        waitOutcome: {
          v: 1,
          outcomeId: 'wait:pr:owner/repo#12:g2:matched',
          generation: 2,
          subjectRef: 'pr:owner/repo#12',
          ownerFence: { kind: 'containing_task', generation: 2 },
          reason: 'matched',
          at: 600,
          delivery: 'pending',
          actor: { kind: 'system' },
          matched: [{ kind: 'pr_head_changed', delta: 'HEAD aaaaaaa → bbbbbbb' }],
          nextStep: 'Review the new HEAD.',
        },
      },
    });
    const sweep = new WaitLifecycleRecoverySweep(taskStore, lifecycle);

    assert.deepEqual(await sweep.run(), { recovered: 2 });
    assert.deepEqual(await sweep.run(), { recovered: 2 });

    assert.equal((await eventLog.read(silent.id)).length, 1);
    assert.equal((await eventLog.read(silent.id))[0].reason, 'superseded');
    assert.equal((await eventLog.read(pending.id)).length, 1);
    assert.equal(messageStore.getByThread('thread_silent').length, 0);
    assert.equal(messageStore.getByThread('thread_pending').length, 1);
    assert.equal((await taskStore.get(pending.id)).automationState.waitOutcome.delivery, 'delivered');
  });

  it('quarantines a legacy unfenced pending outcome and continues recovering a later fenced outcome', async () => {
    const taskStore = new TaskStore();
    const messageStore = new MessageStore();
    const warnings = [];
    const lifecycle = new GitHubWaitLifecycleService({
      taskStore,
      deliveryDeps: { messageStore },
      log: {
        info() {},
        warn(...args) {
          warnings.push(args);
        },
        error() {},
      },
    });
    const legacy = await taskStore.create({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#13',
      threadId: 'thread_legacy_unfenced',
      title: 'PR tracking: owner/repo#13',
      ownerCatId: 'codex-sol',
      why: 'pre-Gate-4 pending recovery',
      createdBy: 'codex-sol',
      userId: 'user_1',
      automationState: {
        waitOutcome: {
          v: 1,
          outcomeId: 'wait:pr:owner/repo#13:g4:matched',
          generation: 4,
          subjectRef: 'pr:owner/repo#13',
          reason: 'matched',
          at: 700,
          delivery: 'pending',
          actor: { kind: 'system' },
          matched: [{ kind: 'pr_head_changed', delta: 'HEAD ccccccc → ddddddd' }],
          nextStep: 'Review the new HEAD.',
        },
      },
    });
    const current = await taskStore.create({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#14',
      threadId: 'thread_current_fenced',
      title: 'PR tracking: owner/repo#14',
      ownerCatId: 'codex-sol',
      why: 'current pending recovery',
      createdBy: 'codex-sol',
      userId: 'user_1',
      automationState: {
        waitOutcome: {
          v: 1,
          outcomeId: 'wait:pr:owner/repo#14:g5:matched',
          generation: 5,
          subjectRef: 'pr:owner/repo#14',
          ownerFence: { kind: 'containing_task', generation: 5 },
          reason: 'matched',
          at: 800,
          delivery: 'pending',
          actor: { kind: 'system' },
          matched: [{ kind: 'pr_head_changed', delta: 'HEAD eeeeeee → fffffff' }],
          nextStep: 'Review the new HEAD.',
        },
      },
    });
    const sweep = new WaitLifecycleRecoverySweep(taskStore, lifecycle);

    assert.deepEqual(await sweep.run(), { recovered: 2 });

    assert.equal(messageStore.getByThread(legacy.threadId).length, 0);
    assert.equal((await taskStore.get(legacy.id)).automationState.waitOutcome.delivery, 'legacy_unfenced');
    assert.equal(messageStore.getByThread(current.threadId).length, 1);
    assert.equal((await taskStore.get(current.id)).automationState.waitOutcome.delivery, 'delivered');
    assert.ok(warnings.some((args) => args.some((value) => String(value).includes(legacy.id))));
  });

  it('isolates an unexpected task recovery failure from the remainder of the startup sweep', async () => {
    const taskStore = new TaskStore();
    const first = await taskStore.create({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#15',
      threadId: 'thread_first_recovery',
      title: 'PR tracking: owner/repo#15',
      ownerCatId: 'codex-sol',
      why: 'first recovery',
      createdBy: 'codex-sol',
      userId: 'user_1',
      automationState: {
        waitOutcome: {
          v: 1,
          outcomeId: 'wait:pr:owner/repo#15:g1:superseded',
          generation: 1,
          subjectRef: 'pr:owner/repo#15',
          ownerFence: { kind: 'containing_task', generation: 1 },
          reason: 'superseded',
          at: 900,
          delivery: 'not_applicable',
        },
      },
    });
    const second = await taskStore.create({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#16',
      threadId: 'thread_second_recovery',
      title: 'PR tracking: owner/repo#16',
      ownerCatId: 'codex-sol',
      why: 'second recovery',
      createdBy: 'codex-sol',
      userId: 'user_1',
      automationState: {
        waitOutcome: {
          v: 1,
          outcomeId: 'wait:pr:owner/repo#16:g1:superseded',
          generation: 1,
          subjectRef: 'pr:owner/repo#16',
          ownerFence: { kind: 'containing_task', generation: 1 },
          reason: 'superseded',
          at: 901,
          delivery: 'not_applicable',
        },
      },
    });
    const recoveredTaskIds = [];
    const warnings = [];
    const sweep = new WaitLifecycleRecoverySweep(
      taskStore,
      {
        async recoverOutcome(taskId) {
          recoveredTaskIds.push(taskId);
          if (taskId === first.id) throw new Error('corrupt persisted outcome');
          return { kind: 'state_only', reason: 'superseded' };
        },
      },
      {
        warn(...args) {
          warnings.push(args);
        },
      },
    );

    assert.deepEqual(await sweep.run(), { recovered: 1 });
    assert.deepEqual(recoveredTaskIds, [first.id, second.id]);
    assert.ok(warnings.some((args) => args.some((value) => value?.taskId === first.id)));
  });
});

describe('F280 legacy PR state migration', () => {
  it('atomically replaces active legacy state and clears done state without old own keys', async () => {
    const taskStore = new TaskStore();
    const active = await taskStore.create({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#8',
      threadId: 'thread_active',
      title: 'PR tracking: owner/repo#8',
      ownerCatId: 'codex-sol',
      why: 'legacy active',
      createdBy: 'codex-sol',
      userId: 'user_1',
      automationState: {
        intent: 'merge',
        wakePolicy: 'human_participant_activity',
        trackingInstructions: 'raw migration audit note',
        eventWait: undefined,
        ci: { headSha: 'old' },
      },
    });
    const done = await taskStore.create({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#9',
      threadId: 'thread_done',
      title: 'PR tracking: owner/repo#9',
      ownerCatId: 'codex-sol',
      why: 'legacy done',
      createdBy: 'codex-sol',
      userId: 'user_1',
      automationState: { intent: 'review', trackingInstructions: 'done note' },
    });
    await taskStore.update(done.id, { status: 'done' });

    const migration = new PrWaitMigrationService({
      taskStore,
      now: () => 1_000,
      readBaseline: async (_repo, _pr, _when) => ({
        baseline: {
          capturedAt: 1_000,
          headSha: 'livehead',
          ci: { bucket: 'pending', fingerprint: 'livehead:pending' },
          conflict: { mergeState: 'MERGEABLE' },
        },
        collectorState: {
          ci: { headSha: 'livehead', lastFingerprint: 'livehead:pending', lastBucket: 'pending' },
          conflict: { mergeState: 'MERGEABLE' },
        },
      }),
      log: { info() {}, warn() {} },
    });
    const report = await migration.migrateAll();
    assert.deepEqual(report, { migratedActive: 1, cleanedDone: 1, alreadyCurrent: 0 });

    const migrated = await taskStore.get(active.id);
    assert.deepEqual(
      migrated.automationState.await.continuation.when.map((predicate) => predicate.kind),
      ['pr_head_changed', 'pr_ci_terminal', 'pr_became_conflicting'],
    );
    assert.equal(migrated.automationState.await.baseline.headSha, 'livehead');
    assert.equal(migrated.why.includes('raw migration audit note'), true);
    const cleaned = await taskStore.get(done.id);
    assert.equal(cleaned.automationState.await, undefined);
    for (const task of [migrated, cleaned]) {
      for (const key of ['intent', 'wakePolicy', 'trackingInstructions', 'eventWait']) {
        assert.equal(Object.hasOwn(task.automationState, key), false, `${task.id} retained ${key}`);
      }
    }
  });
});
