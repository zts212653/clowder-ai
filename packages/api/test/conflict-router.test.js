import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { GitHubWaitLifecycleService } = await import('../dist/domains/github-signals/GitHubWaitLifecycleService.js');
const { ConflictRouter } = await import('../dist/infrastructure/email/ConflictRouter.js');

async function setup(when) {
  const taskStore = new TaskStore();
  const messageStore = new MessageStore();
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
    deliveryDeps: { messageStore },
    now: () => 500,
    log: { info() {}, warn() {}, error() {} },
  });
  const router = new ConflictRouter({
    taskStore,
    deliveryDeps: { messageStore },
    waitLifecycle,
    log: { info() {}, warn() {}, error() {} },
  });
  return { router, messageStore, taskStore, task };
}

describe('ConflictRouter F280 typed waits', () => {
  test('conflict wakes only a waiter that declared the conflict predicate', async () => {
    const { router, messageStore } = await setup([{ kind: 'pr_became_conflicting' }]);
    const result = await router.route({
      repoFullName: 'owner/repo',
      prNumber: 7,
      headSha: 'aaa1111',
      mergeState: 'CONFLICTING',
    });
    assert.equal(result.kind, 'notified');
    assert.match(result.content, /mergeable → conflicting/);
    assert.equal(messageStore.getByThread('thread_1').length, 1);
  });

  test('conflict remains state-only for a new-HEAD waiter', async () => {
    const { router, messageStore, taskStore, task } = await setup([{ kind: 'pr_head_changed' }]);
    const result = await router.route({
      repoFullName: 'owner/repo',
      prNumber: 7,
      headSha: 'aaa1111',
      mergeState: 'CONFLICTING',
    });
    assert.equal(result.kind, 'skipped');
    assert.equal(messageStore.getByThread('thread_1').length, 0);
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
