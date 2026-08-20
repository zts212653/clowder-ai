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
