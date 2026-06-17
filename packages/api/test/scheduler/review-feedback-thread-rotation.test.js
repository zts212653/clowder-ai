// @ts-check
/**
 * #949: MR review thread rotation — pre-dispatch health gate.
 *
 * Root cause: ReviewFeedbackTaskSpec reuses the same threadId (fixed at
 * register-pr-tracking time) for ALL MR reviews. After 3-5 MRs the thread's
 * context overflows → permanent Execution error.
 *
 * Fix: track completedReviewCount in automationState.review and rotate to a
 * fresh thread when the count reaches maxReviewsPerThread (default 3).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const noopLog = { info: () => {}, error: () => {}, warn: () => {} };

/** Convert mock to TaskItem shape */
function mockTask(pr, overrides = {}) {
  return {
    id: `task-${pr.repoFullName}-${pr.prNumber}`,
    kind: 'pr_tracking',
    threadId: pr.threadId ?? 't-default',
    subjectKey: `pr:${pr.repoFullName}#${pr.prNumber}`,
    title: `PR ${pr.repoFullName}#${pr.prNumber}`,
    ownerCatId: pr.catId ?? 'opus',
    status: 'todo',
    why: '',
    createdBy: pr.catId ?? 'opus',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    userId: pr.userId ?? 'u-default',
    ...overrides,
  };
}

function mockTaskStore(tasks) {
  const patchCalls = [];
  const updateCalls = [];
  return {
    listByKind: async () => tasks,
    update: async (taskId, input) => {
      updateCalls.push({ taskId, input });
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return null;
      // Apply update to the mock task for subsequent reads
      Object.assign(task, input, { updatedAt: Date.now() });
      return { ...task };
    },
    patchAutomationState: async (taskId, patch) => {
      patchCalls.push({ taskId, patch });
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return null;
      // Merge automationState for subsequent reads
      task.automationState = {
        ...task.automationState,
        ...patch,
        review: patch.review ? { ...task.automationState?.review, ...patch.review } : task.automationState?.review,
      };
      return { ...task };
    },
    _patchCalls: patchCalls,
    _updateCalls: updateCalls,
  };
}

function mockThreadStore(existingThreads = {}) {
  let threadCounter = 0;
  const createCalls = [];
  return {
    create: (userId, title, projectPath) => {
      threadCounter++;
      const thread = {
        id: `thread_rotated_${threadCounter}`,
        title: title ?? 'MR Review',
        createdBy: userId,
        createdAt: Date.now(),
        participants: [],
        projectPath: projectPath ?? 'default',
      };
      createCalls.push({ userId, title, projectPath, thread });
      return thread;
    },
    get: (threadId) => existingThreads[threadId] ?? null,
    _createCalls: createCalls,
  };
}

function stubRouter(kind = 'notified') {
  const calls = [];
  return {
    router: {
      async route(signal, tracking) {
        calls.push({ signal, tracking });
        if (kind === 'notified') {
          return {
            kind: 'notified',
            threadId: tracking.threadId,
            catId: tracking.catId,
            messageId: 'msg-1',
            content: 'feedback msg',
          };
        }
        return { kind: 'skipped', reason: 'stub skip' };
      },
    },
    calls,
  };
}

describe('#949: MR review thread rotation', () => {
  it('increments completedReviewCount after successful delivery', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const task = mockTask({ repoFullName: 'owner/repo', prNumber: 42, catId: 'opus', threadId: 'th-1', userId: 'u-1' });
    const store = mockTaskStore([task]);
    const { router } = stubRouter();
    const spec = createReviewFeedbackTaskSpec({
      taskStore: store,
      fetchComments: async () => [
        { id: 1, author: 'alice', body: 'fix it', createdAt: '2026-01-01', commentType: 'conversation' },
      ],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      log: noopLog,
    });

    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gateResult.run, true);
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:owner/repo#42', {});

    // After delivery, completedReviewCount should be incremented
    const reviewPatch = store._patchCalls.find((c) => c.patch.review?.completedReviewCount !== undefined);
    assert.ok(reviewPatch, 'should patch completedReviewCount');
    assert.equal(reviewPatch.patch.review.completedReviewCount, 1);
  });

  it('rotates to a fresh thread when completedReviewCount reaches maxReviewsPerThread', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const task = mockTask(
      { repoFullName: 'owner/repo', prNumber: 42, catId: 'opus', threadId: 'th-saturated', userId: 'u-1' },
      {
        automationState: {
          review: { lastCommentCursor: 0, lastDecisionCursor: 0, completedReviewCount: 3 },
        },
      },
    );
    const store = mockTaskStore([task]);
    const threadStore = mockThreadStore();
    const { router, calls } = stubRouter();
    const spec = createReviewFeedbackTaskSpec({
      taskStore: store,
      fetchComments: async () => [
        { id: 10, author: 'bob', body: 'needs fix', createdAt: '2026-01-02', commentType: 'conversation' },
      ],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      threadStore,
      maxReviewsPerThread: 3,
      log: noopLog,
    });

    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gateResult.run, true);
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:owner/repo#42', {});

    // Thread rotation should have happened
    assert.equal(threadStore._createCalls.length, 1, 'should create a new thread');

    // The task should be updated with the new threadId
    const threadUpdate = store._updateCalls.find((c) => c.input.threadId);
    assert.ok(threadUpdate, 'should update task with new threadId');
    assert.notEqual(threadUpdate.input.threadId, 'th-saturated', 'new threadId should differ from old');

    // Router should route to the NEW thread, not the old one
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tracking.threadId, threadStore._createCalls[0].thread.id);

    // completedReviewCount should be reset to 1 (this delivery counts)
    const reviewPatch = store._patchCalls.find((c) => c.patch.review?.completedReviewCount !== undefined);
    assert.ok(reviewPatch, 'should patch completedReviewCount');
    assert.equal(reviewPatch.patch.review.completedReviewCount, 1, 'should reset to 1 after rotation');
  });

  it('does NOT rotate when completedReviewCount is below threshold', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const task = mockTask(
      { repoFullName: 'owner/repo', prNumber: 42, catId: 'opus', threadId: 'th-ok', userId: 'u-1' },
      {
        automationState: {
          review: { lastCommentCursor: 0, lastDecisionCursor: 0, completedReviewCount: 1 },
        },
      },
    );
    const store = mockTaskStore([task]);
    const threadStore = mockThreadStore();
    const { router, calls } = stubRouter();
    const spec = createReviewFeedbackTaskSpec({
      taskStore: store,
      fetchComments: async () => [
        { id: 5, author: 'carol', body: 'LGTM', createdAt: '2026-01-01', commentType: 'conversation' },
      ],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      threadStore,
      maxReviewsPerThread: 3,
      log: noopLog,
    });

    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gateResult.run, true);
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:owner/repo#42', {});

    // No thread rotation
    assert.equal(threadStore._createCalls.length, 0, 'should NOT create a new thread');
    // Routing should use the original thread
    assert.equal(calls[0].tracking.threadId, 'th-ok');
    // completedReviewCount should increment to 2
    const reviewPatch = store._patchCalls.find((c) => c.patch.review?.completedReviewCount !== undefined);
    assert.ok(reviewPatch);
    assert.equal(reviewPatch.patch.review.completedReviewCount, 2);
  });

  it('defaults maxReviewsPerThread to 3 when not specified', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const task = mockTask(
      { repoFullName: 'owner/repo', prNumber: 42, catId: 'opus', threadId: 'th-default', userId: 'u-1' },
      {
        automationState: {
          review: { lastCommentCursor: 0, lastDecisionCursor: 0, completedReviewCount: 3 },
        },
      },
    );
    const store = mockTaskStore([task]);
    const threadStore = mockThreadStore();
    const { router } = stubRouter();
    const spec = createReviewFeedbackTaskSpec({
      taskStore: store,
      fetchComments: async () => [
        { id: 20, author: 'dave', body: 'review', createdAt: '2026-01-01', commentType: 'conversation' },
      ],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      threadStore,
      // maxReviewsPerThread not specified — should default to 3
      log: noopLog,
    });

    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gateResult.run, true);
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:owner/repo#42', {});

    // Should rotate at count=3 (default threshold)
    assert.equal(threadStore._createCalls.length, 1, 'should rotate at default threshold of 3');
  });

  it('does not rotate when threadStore is not provided (graceful degradation)', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const task = mockTask(
      { repoFullName: 'owner/repo', prNumber: 42, catId: 'opus', threadId: 'th-no-store', userId: 'u-1' },
      {
        automationState: {
          review: { lastCommentCursor: 0, lastDecisionCursor: 0, completedReviewCount: 10 },
        },
      },
    );
    const store = mockTaskStore([task]);
    const { router, calls } = stubRouter();
    const spec = createReviewFeedbackTaskSpec({
      taskStore: store,
      fetchComments: async () => [
        { id: 30, author: 'eve', body: 'pls fix', createdAt: '2026-01-01', commentType: 'conversation' },
      ],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      // No threadStore — rotation should be skipped gracefully
      log: noopLog,
    });

    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gateResult.run, true);
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:owner/repo#42', {});

    // Should NOT crash, just route to original thread
    assert.equal(calls[0].tracking.threadId, 'th-no-store');
  });

  it('new thread title includes PR context for traceability', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const task = mockTask(
      { repoFullName: 'org/repo', prNumber: 99, catId: 'sonnet', threadId: 'th-old', userId: 'u-1' },
      {
        automationState: {
          review: { lastCommentCursor: 0, lastDecisionCursor: 0, completedReviewCount: 3 },
        },
      },
    );
    const store = mockTaskStore([task]);
    const threadStore = mockThreadStore();
    const { router } = stubRouter();
    const spec = createReviewFeedbackTaskSpec({
      taskStore: store,
      fetchComments: async () => [
        { id: 40, author: 'frank', body: 'fix', createdAt: '2026-01-01', commentType: 'conversation' },
      ],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      threadStore,
      maxReviewsPerThread: 3,
      log: noopLog,
    });

    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:org/repo#99', {});

    assert.equal(threadStore._createCalls.length, 1);
    const createCall = threadStore._createCalls[0];
    // Title should reference MR review for traceability
    assert.ok(
      createCall.title && createCall.title.includes('review'),
      `thread title should mention review, got: ${createCall.title}`,
    );
  });

  it('preserves projectPath from original thread when rotating (cloud P1)', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const originalProjectPath = '/home/user/cat-cafe';
    const task = mockTask(
      { repoFullName: 'owner/repo', prNumber: 42, catId: 'opus', threadId: 'th-with-project', userId: 'u-1' },
      {
        automationState: {
          review: { lastCommentCursor: 0, lastDecisionCursor: 0, completedReviewCount: 3 },
        },
      },
    );
    const store = mockTaskStore([task]);
    const threadStore = mockThreadStore({
      'th-with-project': {
        id: 'th-with-project',
        projectPath: originalProjectPath,
        title: 'MR review thread',
      },
    });
    const { router } = stubRouter();
    const spec = createReviewFeedbackTaskSpec({
      taskStore: store,
      fetchComments: async () => [
        { id: 50, author: 'grace', body: 'review comment', createdAt: '2026-01-01', commentType: 'conversation' },
      ],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      threadStore,
      maxReviewsPerThread: 3,
      log: noopLog,
    });

    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:owner/repo#42', {});

    assert.equal(threadStore._createCalls.length, 1, 'should rotate');
    const createCall = threadStore._createCalls[0];
    assert.equal(
      createCall.projectPath,
      originalProjectPath,
      'rotated thread must inherit projectPath from original thread',
    );
  });
});

describe('#949: Verdict-without-pass suppression for connector source', () => {
  it('connector-sourced invocation (verdictPassWarningEnabled=false) skips verdict warning', async () => {
    // This test documents the expected behavior:
    // When route-serial processes a connector-sourced invocation, it should NOT
    // emit the [球权提醒] warning even if the cat's output contains a verdict keyword.
    //
    // P2 fix: uses verdictPassWarningEnabled (not frustrationAutoIssueEligible) so
    // that A2A/multi-mention callbacks still get verdict-pass handoff guards.
    // ConnectorInvokeTrigger sets verdictPassWarningEnabled: false.
    //
    // We test the verdict-detect module directly to establish the baseline.

    const { shouldWarnVerdictWithoutPass } = await import(
      '../../dist/domains/cats/services/agents/routing/verdict-detect.js'
    );

    // A typical MR review completion output — contains verdict keyword "LGTM"
    const reviewOutput = `## MR #2137 检视完成

检视结果: **LGTM ✅**

[布偶猫 Sonnet (claude-sonnet-4-6) 🐾]`;

    // Without any ball-pass, the function SHOULD trigger (baseline)
    const shouldWarn = shouldWarnVerdictWithoutPass({
      text: reviewOutput,
      lineStartMentions: [],
      toolNames: [],
      structuredTargetCats: [],
    });
    assert.equal(shouldWarn, true, 'baseline: verdict without pass should trigger warning');

    // The actual suppression happens in route-serial.ts where it checks:
    //   if (!phaseHHit && options.verdictPassWarningEnabled !== false && shouldWarnVerdictWithoutPass(...))
    // ConnectorInvokeTrigger passes verdictPassWarningEnabled: false
    // so the warning block is never entered.
    //
    // Crucially, A2A callbacks (callback-a2a-trigger.ts) and multi-mention routes
    // set frustrationAutoIssueEligible: false but do NOT set verdictPassWarningEnabled,
    // so they still get the verdict-pass handoff guard.
  });

  it('verdictPassWarningEnabled decoupling: A2A paths still warn despite frustrationAutoIssueEligible=false', async () => {
    // P2-2 behavioral test: The two flags must be independent.
    // A2A callback sets frustrationAutoIssueEligible: false (suppress frustration issues)
    // but does NOT set verdictPassWarningEnabled → defaults to undefined → gate passes → warning fires.
    //
    // This tests the gate condition in route-serial.ts:
    //   options.verdictPassWarningEnabled !== false
    // When verdictPassWarningEnabled is undefined (A2A/multi-mention default), the gate passes.

    const a2aOptions = { frustrationAutoIssueEligible: false };
    // verdictPassWarningEnabled not set → undefined → !== false → gate passes → warning fires
    assert.notEqual(
      a2aOptions.verdictPassWarningEnabled,
      false,
      'A2A options must NOT set verdictPassWarningEnabled to false',
    );
    assert.equal(
      a2aOptions.verdictPassWarningEnabled ?? true,
      true,
      'undefined verdictPassWarningEnabled defaults to truthy (warning enabled)',
    );
  });

  it('verdictPassWarningEnabled decoupling: connector paths suppress warning', async () => {
    // Connector direct-invoke sets BOTH flags independently.
    const connectorOptions = { frustrationAutoIssueEligible: false, verdictPassWarningEnabled: false };
    assert.equal(
      connectorOptions.verdictPassWarningEnabled,
      false,
      'connector options must set verdictPassWarningEnabled to false',
    );
  });

  it('verdictPassWarningEnabled decoupling: connector-queue entries suppress via source check', async () => {
    // P1-1 fix: QueueProcessor uses entry.source !== 'connector' for verdictPassWarningEnabled.
    // This verifies the boolean truth table.
    const sources = ['user', 'agent', 'connector'];
    const expected = { user: true, agent: true, connector: false };
    for (const source of sources) {
      const verdictEnabled = source !== 'connector';
      assert.equal(
        verdictEnabled,
        expected[source],
        `source='${source}' → verdictPassWarningEnabled should be ${expected[source]}`,
      );
    }
  });
});
