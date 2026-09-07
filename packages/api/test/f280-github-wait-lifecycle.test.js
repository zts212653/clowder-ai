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
const { ConflictRouter } = await import('../dist/infrastructure/email/ConflictRouter.js');
const { createCiCdCheckTaskSpec } = await import('../dist/infrastructure/email/CiCdCheckTaskSpec.js');
const { createConflictCheckTaskSpec } = await import('../dist/infrastructure/email/ConflictCheckTaskSpec.js');
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

/*
 * sol R30/R31: a re-published outcome is not an evaluated observation.
 *
 * #1394 installs outcome N and await N+1 atomically (auto-renew), so "outcome N still pending
 * while N+1 is live" is an ordinary, long-lived state — not a rare race. On that state observe()
 * returned the OLD outcome without reading the events it was handed, and the caller committed
 * its source cursor past them. The two offending lines predate this PR; the state that puts them
 * on the main path does not, which is why provenance-by-line was the wrong test.
 *
 * The state is PRODUCED HERE, not hand-written: the first delivery fails, so production code
 * leaves pending N beside active N+1 exactly as it would in a connector outage. An earlier
 * version of this test assembled that shape by hand and invented `reason: 'predicate_matched'`
 * — a value the state machine never emits — which is a JS fixture handing a fake shape a
 * certificate the type system would have refused.
 */
describe('F280 — a pending re-publish never authorizes a cursor advance', () => {
  const comment = (id) => ({
    type: 'pr_conversation_comment_added',
    id,
    source: 'pr_conversation_comment',
    author: 'Maintainer',
    summary: `conversation comment #${id} by Maintainer`,
  });

  async function pendingThenRenewed() {
    const taskStore = new TaskStore();
    let failNextDelivery = true;
    const messageStore = new MessageStore();
    const flaky = {
      ...messageStore,
      append: async (message) => {
        if (failNextDelivery) {
          failNextDelivery = false;
          throw new Error('connector unavailable');
        }
        return messageStore.append(message);
      },
      getByThread: (threadId) => messageStore.getByThread(threadId),
    };
    const base = activeState([{ kind: 'pr_conversation_comment_added' }]);
    const task = await taskStore.create({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#7',
      threadId: 'thread_1',
      title: 'PR tracking: owner/repo#7',
      ownerCatId: 'codex-sol',
      why: 'test',
      createdBy: 'codex-sol',
      userId: 'user_1',
      // auto-renew is the state under test: it is what makes pending N coexist with active N+1.
      automationState: { ...base, await: { ...base.await, autoRenew: true } },
    });
    const lifecycle = new GitHubWaitLifecycleService({
      taskStore,
      deliveryDeps: { messageStore: flaky },
      now: () => 500,
      log: { info() {}, warn() {}, error() {} },
    });

    // Generation N matches on #31 and installs the renewed await, then delivery fails.
    await assert.rejects(
      () => lifecycle.observe({ taskId: task.id, facts: { headSha: 'aaaa1111' }, events: [comment(31)] }),
      /connector unavailable/,
    );
    const produced = (await taskStore.get(task.id)).automationState;
    assert.equal(produced.waitOutcome.delivery, 'pending', 'production left outcome N undelivered');
    assert.equal(produced.waitOutcome.reason, 'matched', 'and it carries the reason the state machine really emits');
    assert.equal(produced.await.generation, base.await.generation + 1, 'while generation N+1 is already live');
    return { taskStore, task, lifecycle, messageStore };
  }

  it('re-publishes generation N but reports the observation as unevaluated', async () => {
    const { taskStore, task, lifecycle } = await pendingThenRenewed();
    const frozen = (await taskStore.get(task.id)).automationState.await.baseline.review.conversationCommentCursor;

    const republished = await lifecycle.observe({
      taskId: task.id,
      facts: { headSha: 'aaaa1111' },
      events: [comment(32)],
    });

    assert.equal(republished.kind, 'notified', 'the undelivered outcome must still get out');
    assert.match(republished.content, /#31/, 'and what it delivers is generation N, not the new comment');
    assert.equal(
      republished.observationEvaluated,
      false,
      'the caller advances durable state on this flag; "notified" alone hid a silent loss',
    );
    const after = (await taskStore.get(task.id)).automationState;
    assert.equal(after.await.baseline.review.conversationCommentCursor, frozen, 'comment #32 was never evaluated');
  });

  it('and evaluates the same comment once the pending outcome is cleared', async () => {
    const { taskStore, task, lifecycle } = await pendingThenRenewed();

    await lifecycle.observe({ taskId: task.id, facts: { headSha: 'aaaa1111' }, events: [comment(32)] });
    const second = await lifecycle.observe({
      taskId: task.id,
      facts: { headSha: 'aaaa1111' },
      events: [comment(32)],
    });

    assert.equal(second.kind, 'notified');
    assert.equal(second.observationEvaluated, true, 'N+1 must eventually be evaluated, not merely re-reported');
    assert.match(second.content, /#32/);
    const after = (await taskStore.get(task.id)).automationState;
    assert.ok(
      after.await === undefined || after.await.baseline.review.conversationCommentCursor >= 32,
      'and the frontier finally moves past it',
    );
  });
});

/*
 * sol R32: two same-root boundaries the R31 fix left open.
 *
 * The disposition question — "did these events reach durable state" — is orthogonal to whether a
 * message went out, so putting it only on `notified` meant every other shape defaulted to
 * "evaluated". A CAS-exhausted observation installs NOTHING, and the caller still advanced past
 * it. And the R4 pause lived only in rendered prose, so a re-published outcome lost the very
 * suppression the brake exists to enforce.
 */
describe('F280 — the observation disposition covers every result shape', () => {
  const comment = (id) => ({
    type: 'pr_conversation_comment_added',
    id,
    source: 'pr_conversation_comment',
    author: 'Maintainer',
    summary: `conversation comment #${id} by Maintainer`,
  });

  it('a CAS-exhausted observation reports itself unevaluated', async () => {
    const { taskStore, task } = await harness([{ kind: 'pr_conversation_comment_added' }]);
    const messageStore = new MessageStore();
    // Every install loses the race — the production shape of three concurrent collectors.
    const contended = {
      ...taskStore,
      get: (id) => taskStore.get(id),
      replaceAutomationStateIfGeneration: async () => null,
      patchAutomationState: (...args) => taskStore.patchAutomationState(...args),
    };
    const lifecycle = new GitHubWaitLifecycleService({
      taskStore: contended,
      deliveryDeps: { messageStore },
      now: () => 500,
      log: { info() {}, warn() {}, error() {} },
    });

    const result = await lifecycle.observe({
      taskId: task.id,
      facts: { headSha: 'aaaa1111' },
      events: [comment(31)],
    });

    assert.equal(result.kind, 'deduped');
    assert.equal(result.reason, 'generation_changed_concurrently');
    assert.equal(
      result.observationEvaluated,
      false,
      'nothing was installed, so the caller has earned no cursor advance',
    );
    assert.equal(messageStore.getByThread('thread_1').length, 0);
  });

  /*
   * sol R33: the pending outcome is SHARED, so the pause must survive whichever poll picks it up.
   *
   * Review stamps "deliver but do not auto-wake" on outcome N. If the first connector delivery
   * fails, the next poll to re-publish N may be CI or conflict — adapters that never saw the
   * decision. When the rule lived only in the Review path, those two delivered a message that
   * literally says "Automatic re-request paused once" and then woke the owner anyway, cancelling
   * the brake because of which adapter happened to run next.
   */
  async function suppressedPending() {
    const { taskStore, task } = await harness([{ kind: 'pr_conversation_comment_added' }]);
    const live = (await taskStore.get(task.id)).automationState;
    await taskStore.replaceAutomationStateIfGeneration(task.id, {
      expectedGeneration: live.await.generation,
      expectedUpdatedAt: (await taskStore.get(task.id)).updatedAt,
      automationState: { ...live, await: { ...live.await, autoRenew: true } },
    });
    let failNextDelivery = true;
    const messageStore = new MessageStore();
    const flaky = {
      ...messageStore,
      append: async (message) => {
        if (failNextDelivery) {
          failNextDelivery = false;
          throw new Error('connector unavailable');
        }
        return messageStore.append(message);
      },
      getByThread: (threadId) => messageStore.getByThread(threadId),
    };
    const lifecycle = new GitHubWaitLifecycleService({
      taskStore,
      deliveryDeps: { messageStore: flaky },
      now: () => 500,
      log: { info() {}, warn() {}, error() {} },
    });
    await assert.rejects(
      () =>
        lifecycle.observe({
          taskId: task.id,
          facts: { headSha: 'aaaa1111' },
          events: [comment(31)],
          reviewLoopBrake: { kind: 'pause_once' },
        }),
      /connector unavailable/,
    );
    return { taskStore, task, lifecycle, flaky, messageStore };
  }

  it('a CI poll that re-publishes the suppressed outcome delivers it without waking', async () => {
    const { taskStore, lifecycle, flaky, messageStore } = await suppressedPending();
    const ci = new CiCdRouter({
      taskStore,
      deliveryDeps: { messageStore: flaky },
      waitLifecycle: lifecycle,
      log: { info() {}, warn() {}, error() {} },
    });

    const routed = await ci.route({
      repoFullName: 'owner/repo',
      prNumber: 7,
      headSha: 'aaaa1111',
      prState: 'open',
      aggregateBucket: 'fail',
      checks: [{ name: 'tests', bucket: 'fail' }],
    });

    assert.equal(routed.kind, 'notified', 'the undelivered outcome still has to get out');
    assert.equal(routed.autoWakeSuppressed, true, "and it carries Review's pause across the adapter boundary");
    assert.equal(routed.observationEvaluated, false, 'this CI poll evaluated nothing of its own');
    assert.ok(messageStore.getByThread('thread_1').length >= 1, 'the message is delivered, only the wake is held');
  });

  it('a conflict poll re-publishing it behaves the same way', async () => {
    const { taskStore, lifecycle, flaky } = await suppressedPending();
    const conflict = new ConflictRouter({
      taskStore,
      deliveryDeps: { messageStore: flaky },
      waitLifecycle: lifecycle,
      log: { info() {}, warn() {}, error() {} },
    });

    const routed = await conflict.route({
      repoFullName: 'owner/repo',
      prNumber: 7,
      headSha: 'aaaa1111',
      mergeState: 'CONFLICTING',
    });

    assert.equal(routed.kind, 'notified');
    assert.equal(routed.autoWakeSuppressed, true);
    assert.deepEqual(routed.matchedKinds, [], 'and an unevaluated re-publish authorizes no rewrite either');
  });

  it('control: an ordinary pending outcome re-published by CI is NOT suppressed', async () => {
    // Without the brake there is nothing to hold back — the guard must not become a blanket mute.
    const { taskStore, task } = await harness([{ kind: 'pr_conversation_comment_added' }]);
    const live = (await taskStore.get(task.id)).automationState;
    await taskStore.replaceAutomationStateIfGeneration(task.id, {
      expectedGeneration: live.await.generation,
      expectedUpdatedAt: (await taskStore.get(task.id)).updatedAt,
      automationState: { ...live, await: { ...live.await, autoRenew: true } },
    });
    let failNextDelivery = true;
    const messageStore = new MessageStore();
    const flaky = {
      ...messageStore,
      append: async (message) => {
        if (failNextDelivery) {
          failNextDelivery = false;
          throw new Error('connector unavailable');
        }
        return messageStore.append(message);
      },
      getByThread: (threadId) => messageStore.getByThread(threadId),
    };
    const lifecycle = new GitHubWaitLifecycleService({
      taskStore,
      deliveryDeps: { messageStore: flaky },
      now: () => 500,
      log: { info() {}, warn() {}, error() {} },
    });
    await assert.rejects(
      () => lifecycle.observe({ taskId: task.id, facts: { headSha: 'aaaa1111' }, events: [comment(31)] }),
      /connector unavailable/,
    );
    const ci = new CiCdRouter({
      taskStore,
      deliveryDeps: { messageStore: flaky },
      waitLifecycle: lifecycle,
      log: { info() {}, warn() {}, error() {} },
    });
    const routed = await ci.route({
      repoFullName: 'owner/repo',
      prNumber: 7,
      headSha: 'aaaa1111',
      prState: 'open',
      aggregateBucket: 'fail',
      checks: [{ name: 'tests', bucket: 'fail' }],
    });
    assert.equal(routed.kind, 'notified');
    assert.equal(routed.autoWakeSuppressed, false, 'no brake, no suppression');
  });

  it('carries the R4 pause on the outcome, so a re-publish keeps it', async () => {
    const { taskStore, task } = await harness([{ kind: 'pr_conversation_comment_added' }]);
    const live = (await taskStore.get(task.id)).automationState;
    await taskStore.replaceAutomationStateIfGeneration(task.id, {
      expectedGeneration: live.await.generation,
      expectedUpdatedAt: (await taskStore.get(task.id)).updatedAt,
      automationState: { ...live, await: { ...live.await, autoRenew: true } },
    });

    let failNextDelivery = true;
    const messageStore = new MessageStore();
    const flaky = {
      ...messageStore,
      append: async (message) => {
        if (failNextDelivery) {
          failNextDelivery = false;
          throw new Error('connector unavailable');
        }
        return messageStore.append(message);
      },
      getByThread: (threadId) => messageStore.getByThread(threadId),
    };
    const lifecycle = new GitHubWaitLifecycleService({
      taskStore,
      deliveryDeps: { messageStore: flaky },
      now: () => 500,
      log: { info() {}, warn() {}, error() {} },
    });

    // The fourth changes-requested review: the brake says deliver, but pause the auto wake once.
    await assert.rejects(
      () =>
        lifecycle.observe({
          taskId: task.id,
          facts: { headSha: 'aaaa1111' },
          events: [comment(31)],
          reviewLoopBrake: { kind: 'pause_once' },
        }),
      /connector unavailable/,
    );
    const stamped = (await taskStore.get(task.id)).automationState.waitOutcome;
    assert.equal(stamped.delivery, 'pending');
    assert.equal(stamped.autoWakeSuppressed, true, 'the pause belongs to the outcome, not to a later signal');

    // The re-publish succeeds, and the suppression rides along instead of being lost with the
    // signal that produced it.
    const router = new ReviewFeedbackRouter({
      deliveryDeps: { messageStore: flaky },
      waitLifecycle: lifecycle,
      log: { info() {}, warn() {}, error() {} },
    });
    const routed = await router.route(
      {
        repoFullName: 'owner/repo',
        prNumber: 7,
        headSha: 'aaaa1111',
        newComments: [],
        newDecisions: [],
        inlineCommentCursor: 20,
        conversationCommentCursor: 30,
        decisionCursor: 40,
      },
      { taskId: task.id },
    );

    assert.equal(routed.kind, 'notified', 'the outcome still has to be delivered');
    assert.equal(routed.observationEvaluated, false, 'but this observation was not the one evaluated');
    assert.equal(routed.autoWakeSuppressed, true, 'a connector hiccup must not cancel the R4 pause');
  });
});

/*
 * sol R34: the route SHAPE belongs to the delivered outcome too.
 *
 * R33 made the wake DECISION ride with the shared outcome, but the CI adapter still chose its
 * route arm from the CURRENT poll's PR state. So an unevaluated re-publish — a review outcome an
 * earlier connector failure left pending — turned into a "lifecycle" result the moment any later
 * poll saw the PR merged: the delivered content was a review comment while the wake claimed
 * `github_pr_merged`, and when the merge was our own identity the self-merge skip dropped the
 * wake entirely.
 *
 * These drive the REAL TaskSpec. sol R33's tests asserted router booleans, which stayed green
 * even with the TaskSpec waking unconditionally — the field being present is not the behaviour.
 */
describe('F280 — the delivered outcome owns the route shape', () => {
  const log = { info() {}, warn() {}, error() {} };
  const comment = (id) => ({
    type: 'pr_conversation_comment_added',
    id,
    source: 'pr_conversation_comment',
    author: 'Maintainer',
    summary: `conversation comment #${id} by Maintainer`,
  });

  /** Produces the pending-undelivered state the way production does: the first delivery fails. */
  async function pendingUndelivered({ brake = false } = {}) {
    const { taskStore, task } = await harness([{ kind: 'pr_conversation_comment_added' }]);
    const live = (await taskStore.get(task.id)).automationState;
    await taskStore.replaceAutomationStateIfGeneration(task.id, {
      expectedGeneration: live.await.generation,
      expectedUpdatedAt: (await taskStore.get(task.id)).updatedAt,
      automationState: { ...live, await: { ...live.await, autoRenew: true } },
    });
    let failNextDelivery = true;
    const messageStore = new MessageStore();
    const flaky = {
      ...messageStore,
      append: async (message) => {
        if (failNextDelivery) {
          failNextDelivery = false;
          throw new Error('connector unavailable');
        }
        return messageStore.append(message);
      },
      getByThread: (threadId) => messageStore.getByThread(threadId),
    };
    const lifecycle = new GitHubWaitLifecycleService({
      taskStore,
      deliveryDeps: { messageStore: flaky },
      now: () => 500,
      log,
    });
    await assert.rejects(
      () =>
        lifecycle.observe({
          taskId: task.id,
          facts: { headSha: 'aaaa1111' },
          events: [comment(31)],
          ...(brake ? { reviewLoopBrake: { kind: 'pause_once' } } : {}),
        }),
      /connector unavailable/,
    );
    return { taskStore, task, lifecycle, flaky, messageStore };
  }

  function recordingTrigger() {
    const calls = [];
    return {
      calls,
      trigger: async (threadId, catId, _userId, content, messageId, _extra, policy) => {
        calls.push({ threadId, catId, content, messageId, policy });
      },
    };
  }

  async function runCiSpec({ taskStore, task, lifecycle, messageStore, poll, isSelfMerge }) {
    const cicdRouter = new CiCdRouter({
      taskStore,
      deliveryDeps: { messageStore },
      waitLifecycle: lifecycle,
      log,
    });
    const invokeTrigger = recordingTrigger();
    const spec = createCiCdCheckTaskSpec({
      taskStore,
      cicdRouter,
      invokeTrigger,
      fetchPrStatus: async () => poll,
      ...(isSelfMerge ? { isSelfMerge } : {}),
      log,
    });
    await spec.run.execute(
      { task: await taskStore.get(task.id), repoFullName: 'owner/repo', prNumber: 7 },
      'pr:owner/repo#7',
      { assignedCatId: null },
    );
    return invokeTrigger.calls;
  }

  const mergedPoll = {
    repoFullName: 'owner/repo',
    prNumber: 7,
    headSha: 'aaaa1111',
    prState: 'merged',
    mergedByLogin: 'our-bot',
    aggregateBucket: 'pass',
    checks: [],
  };

  it('a self-merge does not swallow the wake for an outcome this poll never evaluated', async () => {
    const ctx = await pendingUndelivered();
    const calls = await runCiSpec({
      ...ctx,
      messageStore: ctx.flaky,
      poll: mergedPoll,
      isSelfMerge: (login) => login === 'our-bot',
    });

    assert.equal(ctx.messageStore.getByThread('thread_1').length, 1, 'the pending review outcome is delivered');
    // Before R34 this was 0: the poll's `merged` picked the lifecycle arm, and the self-merge skip
    // then dropped the wake for a message that has nothing to do with the merge.
    assert.equal(calls.length, 1, 'and its owner is admitted — the self-merge skip must not reach it');
    assert.equal(
      calls[0].policy.reason,
      'github_wait_satisfied',
      'a re-published review comment is not a merge announcement',
    );
    assert.equal(calls[0].policy.priority, 'normal', 'and this poll evaluated nothing to be urgent about');
  });

  it('control: a terminal state this poll DID evaluate still wakes as a merge', async () => {
    const { taskStore, task, lifecycle, messageStore } = await harness([{ kind: 'pr_head_changed' }]);
    const calls = await runCiSpec({ taskStore, task, lifecycle, messageStore, poll: mergedPoll });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].policy.reason, 'github_pr_merged', 'the lifecycle arm is intact for a real terminal');
  });

  it('control: the self-merge skip still applies to a terminal this poll evaluated', async () => {
    const { taskStore, task, lifecycle, messageStore } = await harness([{ kind: 'pr_head_changed' }]);
    const calls = await runCiSpec({
      taskStore,
      task,
      lifecycle,
      messageStore,
      poll: mergedPoll,
      isSelfMerge: (login) => login === 'our-bot',
    });

    assert.equal(calls.length, 0, 'the merger already knows; this is the case the skip exists for');
  });

  it('the R4 pause holds the wake through the real TaskSpec, not just a router boolean', async () => {
    const ctx = await pendingUndelivered({ brake: true });
    const calls = await runCiSpec({
      ...ctx,
      messageStore: ctx.flaky,
      poll: {
        repoFullName: 'owner/repo',
        prNumber: 7,
        headSha: 'aaaa1111',
        prState: 'open',
        aggregateBucket: 'fail',
        checks: [{ name: 'tests', bucket: 'fail' }],
      },
    });

    assert.equal(ctx.messageStore.getByThread('thread_1').length, 1, 'the message still gets out');
    // Revert CiCdCheckTaskSpec to an unconditional wake and this is the assertion that goes red.
    assert.equal(calls.length, 0, 'and the owner is not admitted, which is what the brake actually means');
  });

  it('a self-merge observed now does not mute a still-pending CLOSED outcome', async () => {
    // Audited, not reported: once the route arm stops coming from this poll, `mergedByLogin`
    // is the last current-poll fact still deciding something about a delivered outcome.
    const { taskStore, task } = await harness([{ kind: 'pr_head_changed' }]);
    let failNextDelivery = true;
    const messageStore = new MessageStore();
    const flaky = {
      ...messageStore,
      append: async (message) => {
        if (failNextDelivery) {
          failNextDelivery = false;
          throw new Error('connector unavailable');
        }
        return messageStore.append(message);
      },
      getByThread: (threadId) => messageStore.getByThread(threadId),
    };
    const lifecycle = new GitHubWaitLifecycleService({
      taskStore,
      deliveryDeps: { messageStore: flaky },
      now: () => 500,
      log,
    });
    // The PR was CLOSED, and telling its owner failed.
    await assert.rejects(
      () => lifecycle.observe({ taskId: task.id, facts: { headSha: 'aaaa1111' }, subjectState: 'closed' }),
      /connector unavailable/,
    );

    // It is reopened and merged by us; that must not cancel the closure nobody ever received.
    const calls = await runCiSpec({
      taskStore,
      task,
      lifecycle,
      messageStore: flaky,
      poll: mergedPoll,
      isSelfMerge: (login) => login === 'our-bot',
    });

    assert.equal(calls.length, 1, 'the pending closure still reaches its owner');
    assert.equal(calls[0].policy.reason, 'github_pr_closed', 'as the closure it is, not as this merge');
  });

  it('a conflict poll re-publishing an unevaluated outcome claims no conflict', async () => {
    const { taskStore, task, lifecycle, flaky, messageStore } = await pendingUndelivered();
    const conflictRouter = new ConflictRouter({
      taskStore,
      deliveryDeps: { messageStore: flaky },
      waitLifecycle: lifecycle,
      log,
    });
    const invokeTrigger = recordingTrigger();
    const spec = createConflictCheckTaskSpec({
      taskStore,
      conflictRouter,
      invokeTrigger,
      checkMergeable: async () => ({ mergeState: 'CONFLICTING', headSha: 'aaaa1111' }),
      log,
    });

    await spec.run.execute(
      {
        signal: { repoFullName: 'owner/repo', prNumber: 7, headSha: 'aaaa1111', mergeState: 'CONFLICTING' },
        task: await taskStore.get(task.id),
      },
      'pr:owner/repo#7',
      { assignedCatId: null },
    );

    assert.equal(messageStore.getByThread('thread_1').length, 1, 'the owed message is delivered');
    assert.equal(invokeTrigger.calls.length, 1, 'and the owner is woken for it');
    assert.equal(
      invokeTrigger.calls[0].policy.reason,
      'github_wait_satisfied',
      'but this poll established no conflict, so it announces none',
    );
    assert.equal(invokeTrigger.calls[0].policy.priority, 'normal', 'urgency is a claim, not a default');
  });
});

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
    assert.match(newHead.content, /HEAD changed to bbbb222/);
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

  // F280 section 4 / A18: PR merged -> notify AND end. The documented failure mode is
  // "永久空转" (tracking keeps polling a merged PR forever), so asserting the
  // notification alone would pass on the broken behaviour. The third assertion -- a later
  // observation produces nothing new -- is the one that actually catches it.
  it('A18: a merged PR notifies once and then stops tracking instead of spinning forever', async () => {
    const { lifecycle, messageStore, taskStore, task } = await harness([{ kind: 'pr_conversation_comment_added' }]);

    const merged = await lifecycle.observe({
      taskId: task.id,
      subjectState: 'merged',
      facts: { headSha: 'aaaa1111' },
    });

    // 1. it notified
    assert.equal(merged.kind, 'notified', `expected a notification, got ${JSON.stringify(merged)}`);
    const delivered = messageStore.getByThread('thread_1');
    assert.equal(delivered.length, 1, 'merged PR must wake the registering thread exactly once');
    assert.match(delivered[0].content, /merged/i, 'the notification must say the PR merged');

    // 2. it ended: no active wait survives a terminal subject state
    const after = await taskStore.get(task.id);
    assert.equal(after.automationState.await, undefined, 'a merged PR must not keep an active wait');
    assert.equal(after.status, 'done', 'a merged PR must close its tracking task');

    // 3. it does not spin: further activity on a merged PR produces nothing at all
    const afterMerge = await lifecycle.observe({
      taskId: task.id,
      facts: { headSha: 'aaaa1111', review: { conversationCommentCursor: 999 } },
      events: [
        {
          type: 'pr_conversation_comment_added',
          id: 999,
          source: 'conversation',
          at: 600,
          author: 'someone-else',
        },
      ],
    });
    assert.notEqual(afterMerge.kind, 'notified', 'a merged PR must never notify again');
    assert.equal(
      messageStore.getByThread('thread_1').length,
      1,
      'no further wake may arrive after the terminal notification',
    );
  });
});
