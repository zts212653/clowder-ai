import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { TaskStore } = await import('../../dist/domains/cats/services/stores/ports/TaskStore.js');
const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');

async function createTracked(store) {
  return store.create({
    kind: 'pr_tracking',
    subjectKey: 'pr:owner/repo#7',
    threadId: 'thread_1',
    title: 'PR wait',
    ownerCatId: 'codex-sol',
    why: 'test',
    createdBy: 'codex-sol',
    userId: 'user_1',
    automationState: {
      review: { lastInlineCommentCursor: 10, lastConversationCommentCursor: 20, lastDecisionCursor: 30 },
      await: {
        v: 1,
        generation: 1,
        subjectRef: 'pr:owner/repo#7',
        ownerFence: { kind: 'containing_task', generation: 1 },
        baseline: {
          capturedAt: 100,
          headSha: 'aaa',
          review: { inlineCommentCursor: 10, conversationCommentCursor: 20, decisionCursor: 30 },
        },
        continuation: {
          when: [{ kind: 'pr_review_decision_changed' }],
          // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract field.
          then: 'continue',
        },
        expiresAt: Date.now() + 60_000,
        createdAt: 100,
      },
    },
  });
}

function options(taskStore, router, overrides = {}) {
  return {
    taskStore,
    fetchPrMetadata: async () => ({ headSha: 'aaa', prState: 'open' }),
    fetchComments: async () => [],
    fetchReviews: async () => [],
    reviewFeedbackRouter: router,
    log: { info() {}, warn() {}, error() {} },
    ...overrides,
  };
}

describe('review scheduler F280 adapter', () => {
  test('current facts are evaluated even when no raw source body is deliverable', async () => {
    const taskStore = new TaskStore();
    await createTracked(taskStore);
    const spec = createReviewFeedbackTaskSpec(
      options(taskStore, { route: async () => ({ kind: 'skipped', reason: 'not matched' }) }),
    );
    const gate = await spec.admission.gate();
    assert.equal(gate.run, true);
    assert.equal(gate.workItems.length, 1);
  });

  test('only router-confirmed typed outcome invokes with the unified reason', async () => {
    const taskStore = new TaskStore();
    await createTracked(taskStore);
    const calls = [];
    const spec = createReviewFeedbackTaskSpec(
      options(
        taskStore,
        {
          route: async () => ({
            kind: 'notified',
            threadId: 'thread_1',
            catId: 'codex-sol',
            messageId: 'msg_1',
            content: 'compact wait',
          }),
        },
        {
          fetchReviews: async () => [
            {
              id: 31,
              author: 'reviewer',
              state: 'APPROVED',
              body: 'SOURCE',
              submittedAt: '2026-07-30T00:00:00Z',
              commitId: 'aaa',
            },
          ],
          invokeTrigger: { trigger: async (...args) => calls.push(args) },
        },
      ),
    );
    const gate = await spec.admission.gate();
    assert.equal(gate.run, true);
    await spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {});
    assert.equal(calls.length, 1);
    assert.equal(calls[0][6].reason, 'github_wait_satisfied');
    assert.equal(calls[0][6].suggestedSkill, undefined);
  });

  test('plain @codex review advances the source frontier without forcing invocation', async () => {
    const taskStore = new TaskStore();
    const task = await createTracked(taskStore);
    const calls = [];
    const spec = createReviewFeedbackTaskSpec(
      options(
        taskStore,
        { route: async () => ({ kind: 'skipped', reason: 'predicates_not_matched' }) },
        {
          fetchComments: async () => [
            {
              id: 21,
              author: 'human',
              body: '@codex review',
              createdAt: '2026-07-30T00:00:00Z',
              commentType: 'conversation',
            },
          ],
          invokeTrigger: { trigger: async (...args) => calls.push(args) },
        },
      ),
    );
    const gate = await spec.admission.gate();
    await spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {});
    assert.equal(calls.length, 0);
    assert.equal((await taskStore.get(task.id)).automationState.review.lastConversationCommentCursor, 21);
  });
});
