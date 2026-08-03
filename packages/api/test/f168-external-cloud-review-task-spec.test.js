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
      eventWait: {
        v: 1,
        invocationId: 'invocation-1',
        threadId: 'thread-1',
        ownerCatId: 'codex-sol',
        subjectKey: 'pr:owner/repo#10',
        expectedSignal: 'review_posted',
        triggerHeadSha: headSha,
        coverage: {
          status: 'covered',
          kind: 'github_review_trigger_eyes',
          triggerCommentId: 70,
          observedAt: 1_000,
        },
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

function makeHarness(coordinatorResult, { comments = [cloudFinding()], reviews = [cloudReview()] } = {}) {
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
        return {
          kind: 'notified',
          threadId: tracking.threadId,
          catId: tracking.catId,
          messageId: 'ordinary-message',
          content: 'ordinary feedback',
        };
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

describe('F168 ReviewFeedbackTaskSpec cloud-review integration', () => {
  it('records blocking cloud feedback as state-only and advances its cursor without local wake', async () => {
    const harness = makeHarness({ kind: 'state_only', reason: 'cloud_review_blocking' });

    const gate = await harness.spec.admission.gate();

    assert.equal(gate.run, false);
    assert.equal(harness.coordinatorCalls[0].observation.status, 'blocking');
    assert.equal(harness.routerCalls.length, 0);
    assert.equal(harness.triggerCalls.length, 0);
    assert.equal(harness.taskStore.patches.at(-1).review.lastCommentCursor, 72);
    assert.equal(harness.taskStore.patches.at(-1).review.lastDecisionCursor, 71);
  });

  it('turns a clean current-head cloud verdict into one reviewer wake without ordinary feedback delivery', async () => {
    const harness = makeHarness(
      {
        kind: 'notified',
        threadId: 'thread-1',
        catId: 'codex-sol',
        messageId: 'ready-message',
        content: 'current HEAD is ready',
        headSha,
      },
      { comments: [], reviews: [cloudReview()] },
    );

    const gate = await harness.spec.admission.gate();
    assert.equal(gate.run, true);
    assert.equal(gate.workItems[0].signal.newComments.length, 0);
    assert.equal(gate.workItems[0].signal.newDecisions.length, 0);
    assert.equal(gate.workItems[0].signal.externalReadyNotification.messageId, 'ready-message');

    await harness.spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {});

    assert.equal(harness.routerCalls.length, 0);
    assert.equal(harness.triggerCalls.length, 1);
    assert.equal(harness.triggerCalls[0][6].reason, 'github_external_review_ready');
    assert.equal(harness.triggerCalls[0][6].coalesceKey, 'external-review:owner/repo#10:head-current');
    assert.equal(harness.taskStore.patches.at(-1).review.lastDecisionCursor, 71);
  });

  it('triggers both external-ready and ordinary feedback when they share one poll batch', async () => {
    const humanComment = {
      id: 73,
      author: 'human-reviewer',
      body: 'Please keep this ordinary feedback visible.',
      createdAt: '2026-07-14T19:00:02.000Z',
      commitId: headSha,
      commentType: 'inline',
    };
    const harness = makeHarness(
      {
        kind: 'notified',
        threadId: 'thread-1',
        catId: 'codex-sol',
        messageId: 'ready-message',
        content: 'current HEAD is ready',
        headSha,
      },
      { comments: [humanComment], reviews: [cloudReview()] },
    );

    const gate = await harness.spec.admission.gate();
    assert.equal(gate.run, true);
    assert.equal(gate.workItems[0].signal.newComments[0].author, 'human-reviewer');
    assert.equal(gate.workItems[0].signal.externalReadyNotification.messageId, 'ready-message');

    await harness.spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {});

    assert.equal(harness.routerCalls.length, 1);
    assert.equal(harness.triggerCalls.length, 2);
    assert.deepEqual(harness.triggerCalls.map((call) => call[6].reason).sort(), [
      'github_external_review_ready',
      'github_review_feedback',
    ]);
    assert.deepEqual(harness.triggerCalls.map((call) => call[4]).sort(), ['ordinary-message', 'ready-message']);
  });

  it('preserves ordinary delivery when the repository is not configured for F168', async () => {
    const harness = makeHarness({ kind: 'not_tracked' });

    const gate = await harness.spec.admission.gate();
    assert.equal(gate.run, true);
    assert.equal(gate.workItems[0].signal.newComments.length, 1);
    assert.equal(gate.workItems[0].signal.newDecisions.length, 1);

    await harness.spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {});

    assert.equal(harness.routerCalls.length, 1);
    assert.equal(harness.triggerCalls.length, 1);
    assert.equal(harness.triggerCalls[0][6].reason, 'github_review_feedback');
  });

  it('preserves ordinary feedback when cloud-review bookkeeping fails', async () => {
    const humanComment = {
      id: 73,
      reviewId: 74,
      author: 'human-reviewer',
      body: 'Please keep this ordinary feedback visible.',
      createdAt: '2026-07-14T19:00:02.000Z',
      commitId: headSha,
      commentType: 'inline',
    };
    const humanReview = {
      id: 74,
      author: 'human-reviewer',
      state: 'COMMENTED',
      body: 'Ordinary review decision',
      submittedAt: '2026-07-14T19:00:03.000Z',
      commitId: headSha,
    };
    const harness = makeHarness(
      () => {
        throw new Error('community projection unavailable');
      },
      { comments: [cloudFinding(), humanComment], reviews: [cloudReview(), humanReview] },
    );

    const gate = await harness.spec.admission.gate();

    assert.equal(gate.run, true);
    assert.ok(gate.workItems[0].signal.newComments.some((comment) => comment.author === 'human-reviewer'));
    assert.ok(gate.workItems[0].signal.newDecisions.some((review) => review.author === 'human-reviewer'));
    await harness.spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {});

    assert.equal(harness.routerCalls.length, 1);
    assert.equal(harness.triggerCalls[0][6].reason, 'github_review_feedback');
    assert.equal(harness.warnCalls.length, 1);
    assert.match(String(harness.warnCalls[0][1]), /cloud-review bookkeeping failed/i);
  });
});
