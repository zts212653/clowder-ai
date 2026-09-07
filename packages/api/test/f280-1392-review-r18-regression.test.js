import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Focused regression for the three R18 review findings on the #1392 clean slice:
//   P1#1 — auto-renew delivery-confirm CAS must use the CURRENT active generation and keep `doing`.
//   P1#2 — a caller-supplied (visible) expiry must be a LOUD terminal, not silent not_applicable.
//   P2   — the renewal baseline must be a strict union of previous ∪ facts ∪ collector frontiers.
// AC-grouped on purpose (one describe per finding) — not the drifted 2689-line aggregate.

const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { MemoryWaitLifecycleEventLog } = await import('../dist/domains/ball-custody/WaitLifecycleEventLog.js');
const { GitHubWaitLifecycleService } = await import('../dist/domains/github-signals/GitHubWaitLifecycleService.js');

function baseState({ autoRenew = false, expiresAt, collectorReview, baselineReview } = {}) {
  return {
    ci: { headSha: 'aaaa1111', lastFingerprint: 'aaaa1111:pending', lastBucket: 'pending' },
    review: collectorReview ?? {
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
        review: baselineReview ?? {
          inlineCommentCursor: 20,
          conversationCommentCursor: 30,
          decisionCursor: 40,
        },
        ci: { bucket: 'pending', fingerprint: 'aaaa1111:pending' },
        conflict: { mergeState: 'MERGEABLE' },
      },
      continuation: {
        when: [{ kind: 'pr_head_changed' }],
        // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
        then: 'Re-lock the exact HEAD.',
      },
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(autoRenew ? { autoRenew: true } : {}),
      createdAt: 100,
      provenance: 'explicit_registration',
    },
  };
}

async function harness(automationState, { now = () => 500 } = {}) {
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
    automationState,
  });
  const lifecycle = new GitHubWaitLifecycleService({
    taskStore,
    deliveryDeps: { messageStore },
    eventLog,
    now,
    log: { info() {}, warn() {}, error() {} },
  });
  return { taskStore, messageStore, eventLog, task, lifecycle };
}

describe('#1392 R18 P1#1 — auto-renew confirms delivery once and keeps tracking live', () => {
  it('confirms the gen-N outcome at the current generation, stays doing, and never re-delivers', async () => {
    const { lifecycle, messageStore, taskStore, task } = await harness(baseState({ autoRenew: true }));

    const first = await lifecycle.observe({ taskId: task.id, facts: { headSha: 'bbbb2222' } });
    assert.equal(first.kind, 'notified');
    // AC-1 truthful rearm signal: the renewed wake tells the owner tracking continues
    assert.match(first.content, /re-armed for the next event/i);

    const afterRenew = await taskStore.get(task.id);
    // renewed to gen N+1 and the task must stay DOING so the poller keeps tracking
    assert.equal(afterRenew.automationState.await.generation, 4);
    assert.equal(afterRenew.status, 'doing');
    // the delivered gen-N outcome is CONFIRMED (not stuck pending after the CAS)
    assert.equal(afterRenew.automationState.waitOutcome.generation, 3);
    assert.equal(afterRenew.automationState.waitOutcome.delivery, 'delivered');
    assert.equal(afterRenew.automationState.waitOutcome.autoRenewed, true);

    // a second observe must NOT re-publish the already-delivered gen-N outcome
    const second = await lifecycle.observe({ taskId: task.id, facts: { headSha: 'bbbb2222' } });
    assert.notEqual(second.kind, 'notified');
    assert.equal(messageStore.getByThread('thread_1').length, 1);
  });
});

describe('#1392 R18 P1#2 — a caller-supplied expiry is a LOUD terminal', () => {
  it('notifies the owner that tracking expired and terminates, instead of silent not_applicable', async () => {
    const { lifecycle, messageStore, taskStore, task } = await harness(baseState({ expiresAt: 10_000 }), {
      now: () => 10_000,
    });

    const result = await lifecycle.observe({
      taskId: task.id,
      at: 10_000,
      facts: { headSha: 'aaaa1111' }, // no predicate match; the deadline is what fires
    });

    assert.equal(result.kind, 'notified');
    assert.match(result.content, /tracking expired/i);
    assert.match(result.content, /no longer armed/i);
    assert.doesNotMatch(result.content, /wait satisfied/i);

    const after = await taskStore.get(task.id);
    assert.equal(after.automationState.waitOutcome.reason, 'expired');
    assert.equal(after.automationState.waitOutcome.delivery, 'delivered');
    assert.equal(after.automationState.await, undefined);
    assert.equal(after.status, 'done');
    assert.equal(messageStore.getByThread('thread_1').length, 1);
  });
});

describe('#1392 R18 P2 — renewal baseline is a strict frontier union', () => {
  it('takes the larger same-batch comment id over a smaller explicit result cursor', async () => {
    const { lifecycle, taskStore, task } = await harness(baseState({ autoRenew: true }));

    await lifecycle.observe({
      taskId: task.id,
      facts: {
        headSha: 'bbbb2222',
        review: { resultConversationCommentCursor: 50, conversationComments: [{ id: 100 }] },
      },
    });

    const { baseline } = (await taskStore.get(task.id)).automationState.await;
    // union(prev 30, explicit 50, comment 100) = 100 — the explicit 50 must not shadow it
    assert.equal(baseline.review.conversationCommentCursor, 100);
  });

  it('absorbs collector review frontiers when a non-review signal triggers the renewal', async () => {
    const { lifecycle, taskStore, task } = await harness(
      baseState({
        autoRenew: true,
        collectorReview: { lastInlineCommentCursor: 20, lastConversationCommentCursor: 200, lastDecisionCursor: 40 },
        baselineReview: { inlineCommentCursor: 20, conversationCommentCursor: 30, decisionCursor: 40 },
      }),
    );

    // a head-change match carries NO review facts — the renewal must still fold the collector frontier
    await lifecycle.observe({ taskId: task.id, facts: { headSha: 'bbbb2222' } });

    const { baseline } = (await taskStore.get(task.id)).automationState.await;
    assert.equal(baseline.review.conversationCommentCursor, 200);
  });
});

describe('#1392 AC-1 — renderer states the truthful rearm outcome', () => {
  it('a single-fire (autoRenew off) match tells the owner tracking closed, not re-armed', async () => {
    const { lifecycle, task } = await harness(baseState({ autoRenew: false }));

    const result = await lifecycle.observe({ taskId: task.id, facts: { headSha: 'bbbb2222' } });

    assert.equal(result.kind, 'notified');
    assert.match(result.content, /single-fire/i);
    assert.doesNotMatch(result.content, /re-armed/i);
  });
});
