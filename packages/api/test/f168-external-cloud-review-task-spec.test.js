import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createReviewFeedbackTaskSpec } from '../dist/infrastructure/email/ReviewFeedbackTaskSpec.js';

const cloudLogin = 'chatgpt-codex-connector[bot]';
const headSha = 'head-current';

function makeTask() {
  return {
    id: 'task-1',
    kind: 'pr_tracking',
    status: 'active',
    subjectKey: 'pr:owner/repo#10',
    threadId: 'thread-1',
    ownerCatId: 'codex-sol',
    userId: 'user-1',
    automationState: {
      review: {
        lastCommentCursor: 0,
        lastInlineCommentCursor: 0,
        lastConversationCommentCursor: 0,
        lastDecisionCursor: 0,
      },
      await: {
        v: 1,
        generation: 1,
        subjectRef: 'pr:owner/repo#10',
        ownerFence: { kind: 'containing_task', generation: 1 },
        baseline: {
          capturedAt: 1_000,
          headSha,
          review: {
            inlineCommentCursor: 0,
            conversationCommentCursor: 0,
            decisionCursor: 0,
            resultTriggerCommentId: 70,
            resultTriggerHeadSha: headSha,
          },
        },
        continuation: {
          when: [{ kind: 'pr_review_result_available', triggerCommentId: 70 }],
          // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract field.
          then: 'Consume the exact cloud review.',
        },
        expiresAt: 120_000,
        createdAt: 1_000,
        provenance: 'explicit_registration',
      },
    },
  };
}

function makeTaskStore(task) {
  const patches = [];
  return {
    patches,
    async listByKind() {
      return [task];
    },
    async patchAutomationState(_id, patch) {
      patches.push(patch);
      task.automationState = {
        ...task.automationState,
        ...patch,
        review: patch.review ? { ...task.automationState.review, ...patch.review } : task.automationState.review,
      };
      return task;
    },
    async update() {
      return task;
    },
  };
}

function cloudReview() {
  return {
    id: 71,
    author: cloudLogin,
    state: 'COMMENTED',
    body: '',
    submittedAt: '2026-07-14T19:00:00.000Z',
    commitId: headSha,
  };
}

function cloudFinding() {
  return {
    id: 72,
    reviewId: 71,
    author: cloudLogin,
    body: 'P1: fix this',
    createdAt: '2026-07-14T19:00:01.000Z',
    commitId: headSha,
    commentType: 'inline',
  };
}

function makeHarness(
  coordinatorResult,
  {
    comments = [cloudFinding()],
    reviews = [cloudReview()],
    routerResult = {
      kind: 'notified',
      threadId: 'thread-1',
      catId: 'codex-sol',
      messageId: 'wait-message',
      content: 'compact matched delta',
    },
  } = {},
) {
  const task = makeTask();
  const taskStore = makeTaskStore(task);
  const coordinatorCalls = [];
  const routerCalls = [];
  const triggerCalls = [];
  const warnCalls = [];
  const spec = createReviewFeedbackTaskSpec({
    taskStore,
    fetchPrMetadata: async () => ({ headSha, prState: 'open' }),
    fetchComments: async () => comments,
    fetchReviews: async () => reviews,
    reviewFeedbackRouter: {
      async route(signal, tracking) {
        routerCalls.push({ signal, tracking });
        return routerResult;
      },
    },
    externalReviewCoordinator: {
      async recordCloud(observation, tracking) {
        coordinatorCalls.push({ observation, tracking });
        return typeof coordinatorResult === 'function' ? coordinatorResult(observation) : coordinatorResult;
      },
    },
    knownCloudReviewerLogins: [cloudLogin],
    cloudReviewTimeoutMs: 60_000,
    now: () => 2_000,
    invokeTrigger: {
      async trigger(...args) {
        triggerCalls.push(args);
      },
    },
    log: {
      info() {},
      warn(...args) {
        warnCalls.push(args);
      },
      error() {},
    },
  });
  return { spec, taskStore, coordinatorCalls, routerCalls, triggerCalls, warnCalls };
}

describe('F168/F280 ReviewFeedbackTaskSpec cloud-review integration', () => {
  it('records blocking cloud state while the typed matcher remains state-only', async () => {
    const harness = makeHarness(
      { kind: 'state_only', reason: 'cloud_review_blocking' },
      { routerResult: { kind: 'state_only', reason: 'predicate_not_matched' } },
    );

    const gate = await harness.spec.admission.gate();
    assert.equal(gate.run, true);
    assert.equal(harness.coordinatorCalls[0].observation.status, 'blocking');
    await harness.spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {});

    assert.equal(harness.routerCalls.length, 1);
    assert.equal(harness.triggerCalls.length, 0);
    assert.equal(harness.taskStore.patches.at(-1).review.lastCommentCursor, 72);
    assert.equal(harness.taskStore.patches.at(-1).review.lastDecisionCursor, 71);
  });

  it('routes a clean exact-head result only through the typed wait lifecycle', async () => {
    const harness = makeHarness(
      { kind: 'state_only', reason: 'explicit_wait_required' },
      { comments: [], reviews: [cloudReview()] },
    );

    const gate = await harness.spec.admission.gate();
    assert.equal(gate.run, true);
    assert.deepEqual(
      gate.workItems[0].signal.newDecisions.map((review) => review.id),
      [71],
    );
    assert.equal('externalReadyNotification' in gate.workItems[0].signal, false);

    await harness.spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {});
    assert.equal(harness.routerCalls.length, 1);
    assert.equal(harness.triggerCalls.length, 1);
    assert.equal(harness.triggerCalls[0][6].reason, 'github_wait_satisfied');
  });

  it('coalesces cloud and ordinary feedback into one matcher pass and one wake', async () => {
    const humanComment = {
      id: 73,
      author: 'human-reviewer',
      body: 'ordinary source body',
      createdAt: '2026-07-14T19:00:02.000Z',
      commitId: headSha,
      commentType: 'inline',
    };
    const harness = makeHarness(
      { kind: 'state_only', reason: 'explicit_wait_required' },
      { comments: [humanComment], reviews: [cloudReview()] },
    );

    const gate = await harness.spec.admission.gate();
    assert.equal(gate.run, true);
    assert.equal(gate.workItems[0].signal.newComments[0].author, 'human-reviewer');
    await harness.spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {});

    assert.equal(harness.routerCalls.length, 1);
    assert.equal(harness.triggerCalls.length, 1);
  });

  it('preserves typed matching when the repository has no F168 config', async () => {
    const harness = makeHarness({ kind: 'not_tracked' });
    const gate = await harness.spec.admission.gate();
    assert.equal(gate.run, true);
    await harness.spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {});
    assert.equal(harness.routerCalls.length, 1);
    assert.equal(harness.triggerCalls.length, 1);
  });

  it('preserves typed matching when cloud bookkeeping fails', async () => {
    const harness = makeHarness(() => {
      throw new Error('community projection unavailable');
    });

    const gate = await harness.spec.admission.gate();
    assert.equal(gate.run, true);
    await harness.spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {});

    assert.equal(harness.routerCalls.length, 1);
    assert.equal(harness.triggerCalls.length, 1);
    assert.equal(harness.warnCalls.length, 1);
    assert.match(String(harness.warnCalls[0][1]), /cloud-review bookkeeping failed/i);
  });
});
