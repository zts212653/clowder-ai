import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { GitHubWaitLifecycleService } = await import('../dist/domains/github-signals/GitHubWaitLifecycleService.js');
const { ConflictRouter } = await import('../dist/infrastructure/email/ConflictRouter.js');
const { ReviewFeedbackRouter } = await import('../dist/infrastructure/email/ReviewFeedbackRouter.js');

async function setup(when, baseline = {}) {
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
        baseline: { capturedAt: 100, headSha: 'aaa1111', conflict: { mergeState: 'MERGEABLE' }, ...baseline },
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
  return { router, messageStore, taskStore, task, waitLifecycle };
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
    assert.match(result.content, /PR became conflicting/);
    assert.equal(messageStore.getByThread('thread_1').length, 1);
  });

  /*
   * codex R28: "notified" is not authorization to rewrite the branch.
   *
   * This router emits `pr_head_changed` on EVERY poll, so a tracker that subscribed to
   * head_changed and excluded conflict still returns `notified` on a conflicting poll. The
   * caller read that as permission to run F140 auto-resolve, which rebases and pushes. The
   * matched kinds are what authorize a write, so they have to reach the caller.
   */
  test('a head-only match reports its kinds, so no caller can read it as a conflict', async () => {
    const { router } = await setup([{ kind: 'pr_head_changed' }]);
    const result = await router.route({
      repoFullName: 'owner/repo',
      prNumber: 7,
      headSha: 'bbb2222',
      mergeState: 'CONFLICTING',
    });
    assert.equal(result.kind, 'notified', 'the head wake it DID subscribe to must still fire');
    assert.deepEqual(result.matchedKinds, ['pr_head_changed']);
    assert.ok(!result.matchedKinds.includes('pr_became_conflicting'), 'the branch rewrite is not authorized');
  });

  test('a conflict subscriber does authorize the rewrite', async () => {
    const { router } = await setup([{ kind: 'pr_became_conflicting' }, { kind: 'pr_head_changed' }]);
    const result = await router.route({
      repoFullName: 'owner/repo',
      prNumber: 7,
      headSha: 'ccc3333',
      mergeState: 'CONFLICTING',
    });
    assert.equal(result.kind, 'notified');
    assert.ok(result.matchedKinds.includes('pr_became_conflicting'));
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

  test('UNKNOWN base status preserves the last authoritative behind baseline', async () => {
    const { router, taskStore, task, messageStore } = await setup([{ kind: 'pr_base_behind' }], {
      base: { isBehind: true },
    });

    const unknown = await router.route({
      repoFullName: 'owner/repo',
      prNumber: 7,
      headSha: 'aaa1111',
      mergeState: 'UNKNOWN',
      mergeStateStatus: 'UNKNOWN',
    });
    assert.equal(unknown.kind, 'skipped');
    assert.equal((await taskStore.get(task.id)).automationState.await.baseline.base.isBehind, true);

    const stillBehind = await router.route({
      repoFullName: 'owner/repo',
      prNumber: 7,
      headSha: 'aaa1111',
      mergeState: 'UNKNOWN',
      mergeStateStatus: 'BEHIND',
      isBehind: true,
    });
    assert.equal(stillBehind.kind, 'skipped', 'an UNKNOWN poll must not manufacture a second behind transition');
    assert.equal(messageStore.getByThread('thread_1').length, 0);
  });

  test('compare ancestry reports behind even when merge readiness is DIRTY', async () => {
    const { router, messageStore } = await setup([{ kind: 'pr_base_behind' }], {
      base: { isBehind: false },
    });

    const result = await router.route({
      repoFullName: 'owner/repo',
      prNumber: 7,
      headSha: 'aaa1111',
      mergeState: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
      isBehind: true,
    });
    assert.equal(result.kind, 'notified');
    assert.match(result.content, /base branch advanced/);
    assert.equal(messageStore.getByThread('thread_1').length, 1);
  });

  test('compare ancestry clears behind even when merge readiness is BLOCKED', async () => {
    const { router, taskStore, task, messageStore } = await setup([{ kind: 'pr_base_behind' }], {
      base: { isBehind: true },
    });

    const caughtUp = await router.route({
      repoFullName: 'owner/repo',
      prNumber: 7,
      headSha: 'aaa1111',
      mergeState: 'UNKNOWN',
      mergeStateStatus: 'BLOCKED',
      isBehind: false,
    });
    assert.equal(caughtUp.kind, 'skipped');
    assert.equal((await taskStore.get(task.id)).automationState.await.baseline.base.isBehind, false);

    const behindAgain = await router.route({
      repoFullName: 'owner/repo',
      prNumber: 7,
      headSha: 'aaa1111',
      mergeState: 'UNKNOWN',
      mergeStateStatus: 'DIRTY',
      isBehind: true,
    });
    assert.equal(behindAgain.kind, 'notified', 'a real caught-up transition must permit a later behind wake');
    assert.equal(messageStore.getByThread('thread_1').length, 1);
  });

  test('a replacement HEAD that is already behind does not impersonate a base-advance event', async () => {
    const { router, taskStore, task, messageStore } = await setup([{ kind: 'pr_base_behind' }], {
      base: { isBehind: false },
    });

    const replaced = await router.route({
      repoFullName: 'owner/repo',
      prNumber: 7,
      headSha: 'bbb2222',
      mergeState: 'MERGEABLE',
      mergeStateStatus: 'BEHIND',
      isBehind: true,
    });
    assert.equal(replaced.kind, 'skipped');
    assert.equal(messageStore.getByThread('thread_1').length, 0);
    const baseline = (await taskStore.get(task.id)).automationState.await.baseline;
    assert.equal(baseline.headSha, 'bbb2222');
    assert.equal(baseline.base.isBehind, true, 'the new HEAD ancestry is still retained as the next baseline');
  });

  test('a faster review poll cannot pair a replacement HEAD with the previous HEAD base fact', async () => {
    const { router, taskStore, task, messageStore, waitLifecycle } = await setup([{ kind: 'pr_base_behind' }], {
      base: { isBehind: false },
    });
    const review = new ReviewFeedbackRouter({
      deliveryDeps: { messageStore },
      waitLifecycle,
      log: { info() {}, warn() {}, error() {} },
    });

    const reviewResult = await review.route(
      {
        repoFullName: 'owner/repo',
        prNumber: 7,
        headSha: 'bbb2222',
        newComments: [],
        newDecisions: [],
        inlineCommentCursor: 0,
        conversationCommentCursor: 0,
        decisionCursor: 0,
      },
      { taskId: task.id },
    );
    assert.equal(reviewResult.kind, 'skipped');
    const afterReview = (await taskStore.get(task.id)).automationState.await.baseline;
    assert.equal(afterReview.headSha, 'bbb2222');
    assert.equal(afterReview.base, undefined, 'a base fact cannot survive the HEAD it described');

    const conflictResult = await router.route({
      repoFullName: 'owner/repo',
      prNumber: 7,
      headSha: 'bbb2222',
      mergeState: 'MERGEABLE',
      mergeStateStatus: 'BEHIND',
      isBehind: true,
    });
    assert.equal(conflictResult.kind, 'skipped', 'the later ancestry read establishes a baseline, not a base advance');
    assert.equal(messageStore.getByThread('thread_1').length, 0);
    assert.equal((await taskStore.get(task.id)).automationState.await.baseline.base.isBehind, true);
  });
});
