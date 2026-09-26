import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * #1392: an outcome's delivery key must belong to the task that produced it.
 *
 * `outcomeId` is `wait:<subject>:g<generation>:<reason>` and was used verbatim as the delivery
 * idempotency key. A tracking task that ends and is re-registered in the same thread is a NEW task
 * whose generations count from 1 again, so its outcomes reuse the old task's keys. The message
 * store treats a repeated key as a replay and hands back the OLD message: the new notification is
 * recorded as delivered and never appears. (On a queue that also compares the envelope, the same
 * collision is a permanent conflict instead.)
 *
 * Real lifecycle and real in-memory stores; only the observations, and the one failed write that
 * stands in for a process dying mid-delivery, are hand-built.
 */
const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { GitHubWaitLifecycleService } = await import('../dist/domains/github-signals/GitHubWaitLifecycleService.js');

const SUBJECT = 'pr:owner/repo#7';
const THREAD = 'thread_1';
const HEAD = 'aaaa1111aaaa1111';
const log = { info() {}, warn() {}, error() {} };

function prAwait() {
  return {
    v: 1,
    generation: 1,
    subjectRef: SUBJECT,
    ownerFence: { kind: 'containing_task', generation: 1 },
    baseline: {
      capturedAt: 100,
      headSha: HEAD,
      review: { inlineCommentCursor: 10, conversationCommentCursor: 30, decisionCursor: 40 },
      ci: { bucket: 'pending', fingerprint: `${HEAD}:pending` },
      conflict: { mergeState: 'MERGEABLE' },
    },
    // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
    continuation: { when: [{ kind: 'pr_ci_terminal' }], then: 'Continue.' },
    createdAt: 100,
  };
}

async function registerTask(taskStore) {
  return taskStore.create({
    kind: 'pr_tracking',
    subjectKey: SUBJECT,
    threadId: THREAD,
    title: 'PR tracking: owner/repo#7',
    ownerCatId: 'opus',
    why: 'test',
    createdBy: 'opus',
    userId: 'user_1',
    automationState: {
      ci: { headSha: HEAD, lastFingerprint: `${HEAD}:pending`, lastBucket: 'pending' },
      await: prAwait(),
    },
  });
}

const ciPass = (lifecycle, taskId) =>
  lifecycle.observe({
    taskId,
    facts: { headSha: HEAD, ci: { bucket: 'pass', fingerprint: `${HEAD}:pass`, blockerCount: 0 } },
    collectorPatch: { ci: { headSha: HEAD, lastFingerprint: `${HEAD}:pass`, lastBucket: 'pass' } },
  });

describe('#1392 — a re-registered task’s notifications are not swallowed by the old task’s', () => {
  it('the same PR re-tracked in the same thread gets its own first notification delivered', async () => {
    const taskStore = new TaskStore();
    const messageStore = new MessageStore();
    const lifecycle = new GitHubWaitLifecycleService({ taskStore, deliveryDeps: { messageStore }, log });

    const first = await registerTask(taskStore);
    const firstResult = await ciPass(lifecycle, first.id);
    assert.equal(firstResult.kind, 'notified', 'the first task delivers its generation-1 outcome');
    // Unregistering tracking deletes the task (callbacks.ts), which is what frees the subject.
    assert.equal(await taskStore.delete(first.id), true);

    const second = await registerTask(taskStore);
    assert.notEqual(second.id, first.id, 'a re-registration after unregistering is a new task');
    const secondResult = await ciPass(lifecycle, second.id);

    assert.equal(secondResult.kind, 'notified');
    assert.notEqual(
      secondResult.messageId,
      firstResult.messageId,
      'the new task’s notification must be a new message, not the old one handed back as a replay',
    );
    assert.equal(messageStore.getByThread(THREAD).length, 2, 'both notifications are in the thread');
  });

  // Delivery is two writes: store the notification, then mark the outcome delivered. A process that
  // dies between them leaves the outcome `pending`, and the next poll delivers it again. That retry
  // is what the key's idempotency is for: it must reach the stored notification, not add a copy.
  it('a retry after the notification was stored but before it was marked delivered adds no copy', async () => {
    const taskStore = new TaskStore();
    const messageStore = new MessageStore();
    const replace = taskStore.replaceAutomationStateIfGeneration.bind(taskStore);
    let dieBeforeMarking = true;
    taskStore.replaceAutomationStateIfGeneration = (taskId, input) => {
      if (dieBeforeMarking && input.automationState?.waitOutcome?.delivery === 'delivered') {
        dieBeforeMarking = false;
        throw new Error('process died before marking the outcome delivered');
      }
      return replace(taskId, input);
    };

    const task = await registerTask(taskStore);
    const lifecycle = new GitHubWaitLifecycleService({ taskStore, deliveryDeps: { messageStore }, log });
    await assert.rejects(ciPass(lifecycle, task.id), /before marking the outcome delivered/);
    const stored = messageStore.getByThread(THREAD);
    assert.equal(stored.length, 1, 'the notification was stored before the process died');
    assert.equal((await taskStore.get(task.id)).automationState.waitOutcome.delivery, 'pending');

    const restarted = new GitHubWaitLifecycleService({ taskStore, deliveryDeps: { messageStore }, log });
    await ciPass(restarted, task.id);

    assert.equal((await taskStore.get(task.id)).automationState.waitOutcome.delivery, 'delivered');
    assert.deepEqual(
      messageStore.getByThread(THREAD).map((message) => message.id),
      [stored[0].id],
      'the retry reuses the key, so the store hands back the stored notification instead of adding a copy',
    );
  });
});
