import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { connectorDeliveryHarness } = await import('./helpers/connector-delivery-harness.js');
const { GitHubWaitLifecycleService } = await import('../dist/domains/github-signals/GitHubWaitLifecycleService.js');
const { ConflictRouter } = await import('../dist/infrastructure/email/ConflictRouter.js');

async function setup(when) {
  const taskStore = new TaskStore();
  const harness = connectorDeliveryHarness();
  const task = await taskStore.create({
    kind: 'pr_tracking',
    subjectKey: 'pr:owner/repo#7',
    threadId: 'thread_1',
    title: 'PR wait',
    ownerCatId: 'codex-sol',
    why: 'test',
    createdBy: 'codex-sol',
    userId: 'user_1',
    automationState: {
      conflict: { mergeState: 'MERGEABLE' },
      await: {
        v: 1,
        generation: 1,
        subjectRef: 'pr:owner/repo#7',
        ownerFence: { kind: 'containing_task', generation: 1 },
        baseline: { capturedAt: 100, headSha: 'aaa1111', conflict: { mergeState: 'MERGEABLE' } },
        continuation: {
          when,
          // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract field.
          then: 'Rebase the exact HEAD.',
        },
        expiresAt: 10_000,
        createdAt: 100,
      },
    },
  });
  const waitLifecycle = new GitHubWaitLifecycleService({
    taskStore,
    deliveryDeps: harness.deliveryDeps,
    now: () => 500,
    log: { info() {}, warn() {}, error() {} },
  });
  const router = new ConflictRouter({
    taskStore,
    deliveryDeps: harness.deliveryDeps,
    waitLifecycle,
    log: { info() {}, warn() {}, error() {} },
  });
  return { router, harness, taskStore, task };
}

describe('ConflictRouter F280 typed waits', () => {
  test('conflict terminalizes for a declared waiter, and announces only when asked', async () => {
    const { router, harness, task } = await setup([{ kind: 'pr_became_conflicting' }]);
    const result = await router.route({
      repoFullName: 'owner/repo',
      prNumber: 7,
      headSha: 'aaa1111',
      mergeState: 'CONFLICTING',
    });

    // Phase C AC-C1 needs the authorization without the announcement: the outcome is durable here,
    // so an auto-resolver may act on it, and nothing has been said to the owner yet.
    assert.equal(result.kind, 'matched_pending');
    assert.equal(result.taskId, task.id);
    assert.equal(result.outcome.reason, 'matched');
    assert.equal(harness.deliveries('thread_1').length, 0, 'nothing is announced before it is asked for');

    const published = await router.publish(result.taskId, result.outcome);
    assert.equal(published.kind, 'notified');
    assert.match(published.content, /mergeable → conflicting/);
    assert.equal(harness.deliveries('thread_1').length, 1, 'and then exactly once');
  });

  test('a repaired conflict is settled without ever announcing it', async () => {
    const { router, harness, task } = await setup([{ kind: 'pr_became_conflicting' }]);
    const result = await router.route({
      repoFullName: 'owner/repo',
      prNumber: 7,
      headSha: 'aaa1111',
      mergeState: 'CONFLICTING',
    });
    assert.equal(result.kind, 'matched_pending');

    assert.equal(await router.settleWithoutWake(result.taskId, result.outcome, 'auto-resolved:rebase'), true);
    assert.equal(harness.deliveries('thread_1').length, 0, 'a repaired conflict never reaches the owner');

    // The outbox is settled, so a later flush cannot resurrect it as a late wake.
    const late = await router.publish(result.taskId, result.outcome);
    assert.notEqual(late.kind, 'notified');
    assert.equal(harness.deliveries('thread_1').length, 0, 'and it stays settled');
    assert.ok(task.id);
  });

  test('conflict remains state-only for a new-HEAD waiter', async () => {
    const { router, harness, taskStore, task } = await setup([{ kind: 'pr_head_changed' }]);
    const result = await router.route({
      repoFullName: 'owner/repo',
      prNumber: 7,
      headSha: 'aaa1111',
      mergeState: 'CONFLICTING',
    });
    assert.equal(result.kind, 'skipped');
    assert.equal(harness.deliveries('thread_1').length, 0);
    assert.equal((await taskStore.get(task.id)).automationState.conflict.mergeState, 'CONFLICTING');
  });

  test('UNKNOWN remains retryable and does not consume the generation', async () => {
    const { router, taskStore, task } = await setup([{ kind: 'pr_became_conflicting' }]);
    assert.equal(
      (
        await router.route({
          repoFullName: 'owner/repo',
          prNumber: 7,
          headSha: 'aaa1111',
          mergeState: 'UNKNOWN',
        })
      ).kind,
      'skipped',
    );
    assert.equal((await taskStore.get(task.id)).automationState.await.generation, 1);
  });
});
