import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { TaskStore } = await import('../../dist/domains/cats/services/stores/ports/TaskStore.js');
const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
const { classifyGitHubReviewLoopBrake } = await import('../../dist/domains/github-signals/github-wait-renderer.js');

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
  test('commits the cursor once routing recorded the observation, even when cancellation arrives while routing', async () => {
    const taskStore = new TaskStore();
    const task = await createTracked(taskStore);
    const controller = new AbortController();
    const events = [];
    const spec = createReviewFeedbackTaskSpec(
      options(taskStore, {
        route: async () => {
          events.push('routed');
          controller.abort(new Error('scheduler timeout'));
          return { kind: 'skipped', reason: 'test' };
        },
      }),
    );

    await spec.run
      .execute(
        {
          repairedTask: task,
          repoFullName: 'owner/repo',
          prNumber: 7,
          newComments: [],
          newDecisions: [],
          headSha: 'aaa',
          inlineCommentCursor: 10,
          conversationCommentCursor: 20,
          decisionCursor: 31,
          commitCursor: async () => {
            events.push('cursor-persisted');
          },
        },
        task.subjectKey,
        { assignedCatId: null, signal: controller.signal },
      )
      .catch(() => {});

    assert.deepEqual(events, ['routed', 'cursor-persisted']);
  });

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

  test('only a router-confirmed typed outcome admits the wake', async () => {
    const taskStore = new TaskStore();
    await createTracked(taskStore);
    const calls = [];
    const spec = createReviewFeedbackTaskSpec(
      options(
        taskStore,
        {
          route: async (...args) => {
            calls.push(args);
            return {
              kind: 'notified',
              threadId: 'thread_1',
              catId: 'codex-sol',
              messageId: 'msg_1',
              content: 'compact wait',
            };
          },
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
        },
      ),
    );
    const gate = await spec.admission.gate();
    assert.equal(gate.run, true);
    await spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {});
    // One route == one admission == one wake. The old trigger `reason`/`suggestedSkill` policy was
    // never read by production; the observable fact is the confirmed typed outcome itself.
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0].headSha, 'aaa');
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

  test('PR terminal truth is routed through the wait lifecycle even when CI collection is unavailable', async () => {
    const taskStore = new TaskStore();
    await createTracked(taskStore);
    const routerCalls = [];
    const triggerCalls = [];
    const spec = createReviewFeedbackTaskSpec(
      options(
        taskStore,
        {
          route: async (signal) => {
            routerCalls.push(signal);
            return {
              kind: 'notified',
              threadId: 'thread_1',
              catId: 'codex-sol',
              messageId: 'terminal_msg',
              content: 'compact terminal wait',
            };
          },
        },
        {
          fetchPrMetadata: async () => ({ headSha: 'aaa', prState: 'merged' }),
        },
      ),
    );

    const gate = await spec.admission.gate();
    assert.equal(gate.run, true);
    assert.equal(gate.workItems.length, 1);
    assert.equal(gate.workItems[0].signal.subjectState, 'merged');
    await spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {});
    // The route IS the admission, so one confirmed terminal observation is one owner wake.
    assert.equal(routerCalls.length, 1);
    assert.equal(routerCalls[0].subjectState, 'merged');
  });

  test('a comment posted in the poll where the PR merges is collected with the terminal truth', async () => {
    const taskStore = new TaskStore();
    await createTracked(taskStore);
    const spec = createReviewFeedbackTaskSpec(
      options(
        taskStore,
        { route: async () => ({ kind: 'skipped', reason: 'test' }) },
        {
          fetchPrMetadata: async () => ({ headSha: 'aaa', prState: 'merged' }),
          fetchComments: async () => [
            {
              id: 21,
              author: 'maintainer',
              body: 'thanks, merging',
              createdAt: '2026-09-15T00:00:00Z',
              commentType: 'conversation',
            },
          ],
        },
      ),
    );

    const gate = await spec.admission.gate();
    assert.equal(gate.workItems.length, 1);
    const { signal } = gate.workItems[0];
    assert.equal(signal.subjectState, 'merged');
    assert.deepEqual(
      signal.newComments.map((comment) => comment.id),
      [21],
      'a terminal PR is the last poll — skipping its comments loses them for good',
    );
  });

  test('the fourth formal changes-requested review pauses one automatic owner wake, while the fifth continues', async () => {
    const taskStore = new TaskStore();
    await createTracked(taskStore);
    const calls = [];
    const history = [1, 2, 3, 4].map((id) => ({
      id: 27 + id,
      author: `reviewer-${id}`,
      state: 'CHANGES_REQUESTED',
      body: '',
      submittedAt: `2026-09-0${id}T00:00:00Z`,
      commitId: 'aaa',
    }));
    const spec = createReviewFeedbackTaskSpec(
      options(
        taskStore,
        {
          route: async (signal) => ({
            kind: 'notified',
            threadId: 'thread_1',
            catId: 'codex-sol',
            messageId: 'msg_1',
            content: signal.reviewLoopBrake?.kind ?? 'none',
          }),
        },
        {
          fetchPrMetadata: async () => ({ headSha: 'aaa', prState: 'open', authorLogin: 'pr-author' }),
          fetchReviews: async (_repo, _pr, sinceId) =>
            sinceId === undefined ? history : history.filter((r) => r.id > sinceId),
          invokeTrigger: { trigger: async (...args) => calls.push(args) },
        },
      ),
    );
    const gate = await spec.admission.gate();
    assert.equal(gate.workItems[0].signal.reviewLoopBrake.kind, 'pause_once');
    await spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {});
    assert.equal(calls.length, 0);

    const fifth = { ...history.at(-1), id: 32, author: 'reviewer-5' };
    const continued = classifyGitHubReviewLoopBrake([...history, fifth], [fifth.id], 'pr-author');
    assert.equal(continued.kind, 'continue');
  });

  test('review-history failure warns open and preserves automatic owner wake', async () => {
    const taskStore = new TaskStore();
    await createTracked(taskStore);
    const calls = [];
    const fresh = {
      id: 31,
      author: 'reviewer-4',
      state: 'CHANGES_REQUESTED',
      body: '',
      submittedAt: '2026-09-04T00:00:00Z',
      commitId: 'aaa',
    };
    const spec = createReviewFeedbackTaskSpec(
      options(
        taskStore,
        {
          route: async (...args) => {
            calls.push(args);
            return {
              kind: 'notified',
              threadId: 'thread_1',
              catId: 'codex-sol',
              messageId: 'msg_1',
              content: 'warn-open',
            };
          },
        },
        {
          fetchPrMetadata: async () => ({ headSha: 'aaa', prState: 'open', authorLogin: 'pr-author' }),
          fetchReviews: async (_repo, _pr, sinceId) => {
            if (sinceId === undefined) throw new Error('history unavailable');
            return [fresh];
          },
        },
      ),
    );
    const gate = await spec.admission.gate();
    assert.equal(gate.workItems[0].signal.reviewLoopBrake.kind, 'warn_open');
    await spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {});
    assert.equal(calls.length, 1);
  });
});
