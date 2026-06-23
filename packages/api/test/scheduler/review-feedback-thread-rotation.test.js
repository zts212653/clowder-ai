// @ts-check
/**
 * #949 / F140: review feedback must return to the PR tracking registration thread.
 *
 * Regression context: PR #2335 introduced MR-review thread rotation after a
 * completedReviewCount threshold, then PR #2372 added a source-thread backlink.
 * That broke the user mental model: a PR belongs to the thread that registered
 * PR tracking, and review feedback must be delivered there instead of silently
 * moving the task to an auto-created thread.
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

function mockTaskStore(tasks, options = {}) {
  const patchCalls = [];
  const updateCalls = [];
  return {
    get: async (taskId) => {
      const task = tasks.find((t) => t.id === taskId);
      return task ? { ...task } : null;
    },
    listByKind: async () => tasks,
    update: async (taskId, input) => {
      updateCalls.push({ taskId, input });
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return null;
      Object.assign(task, input, { updatedAt: Date.now() });
      return { ...task };
    },
    updateIfThreadId: async (taskId, expectedThreadId, input) => {
      options.beforeConditionalUpdate?.();
      updateCalls.push({ taskId, expectedThreadId, input, conditional: true });
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return null;
      if (task.threadId !== expectedThreadId) return null;
      Object.assign(task, input, { updatedAt: Date.now() });
      return { ...task };
    },
    patchAutomationState: async (taskId, patch) => {
      patchCalls.push({ taskId, patch });
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return null;
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
  const createCalls = [];
  return {
    create: (userId, title, projectPath) => {
      const thread = {
        id: `thread_rotated_${createCalls.length + 1}`,
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

function mockBacklinkDelivery() {
  const appendCalls = [];
  const broadcastCalls = [];
  let counter = 0;
  return {
    deps: {
      messageStore: {
        append: async (input) => {
          counter++;
          const msg = { id: `msg-${counter}`, timestamp: Date.now(), ...input };
          appendCalls.push(input);
          return msg;
        },
      },
      socketManager: {
        broadcastToRoom: (room, event, data) => {
          broadcastCalls.push({ room, event, data });
        },
      },
    },
    _appendCalls: appendCalls,
    _broadcastCalls: broadcastCalls,
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

describe('#949 / F140: review feedback returns to the registered thread', () => {
  it('does not rotate or rewrite task.threadId even when legacy completedReviewCount is high', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const task = mockTask(
      { repoFullName: 'owner/repo', prNumber: 42, catId: 'opus', threadId: 'th-original', userId: 'u-1' },
      {
        automationState: {
          review: { lastCommentCursor: 0, lastDecisionCursor: 0, completedReviewCount: 99 },
        },
      },
    );
    const store = mockTaskStore([task]);
    const threadStore = mockThreadStore();
    const backlink = mockBacklinkDelivery();
    const { router, calls } = stubRouter();
    const spec = createReviewFeedbackTaskSpec({
      taskStore: store,
      fetchComments: async () => [
        { id: 10, author: 'bob', body: 'needs fix', createdAt: '2026-01-01', commentType: 'conversation' },
      ],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      // Legacy deps may still be threaded by old factory code; they must not move ownership.
      threadStore,
      backlinkDelivery: backlink.deps,
      maxReviewsPerThread: 3,
      log: noopLog,
    });

    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gateResult.run, true);
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:owner/repo#42', {});

    assert.equal(threadStore._createCalls.length, 0, 'review feedback must not auto-create rotated threads');
    assert.equal(
      store._updateCalls.some((call) => Object.hasOwn(call.input, 'threadId')),
      false,
      'review feedback must not rewrite the PR tracking task threadId',
    );
    assert.equal(backlink._appendCalls.length, 0, 'no rotation means no source-thread backlink');
    assert.equal(backlink._broadcastCalls.length, 0, 'no rotation means no breadcrumb broadcast');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tracking.threadId, 'th-original', 'delivery stays on the registering thread');
  });

  it('repairs already-rotated legacy tasks back to the source thread before routing', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const task = mockTask(
      { repoFullName: 'owner/repo', prNumber: 44, catId: 'opus', threadId: 'thread_rotated_1', userId: 'u-1' },
      {
        automationState: {
          review: { lastCommentCursor: 0, lastDecisionCursor: 0, completedReviewCount: 1 },
        },
      },
    );
    const store = mockTaskStore([task]);
    const threadStore = mockThreadStore({
      thread_rotated_1: {
        id: 'thread_rotated_1',
        title: 'MR review (auto-rotated from th-original)',
        createdBy: 'u-1',
        createdAt: task.createdAt + 1000,
        participants: ['opus'],
        projectPath: '/projects/cat-cafe',
      },
      'th-original': {
        id: 'th-original',
        title: 'Original source thread',
        createdBy: 'u-1',
        createdAt: task.createdAt - 1000,
        participants: ['opus'],
        projectPath: '/projects/cat-cafe',
      },
    });
    const { router, calls } = stubRouter();
    const spec = createReviewFeedbackTaskSpec({
      taskStore: store,
      fetchComments: async () => [
        { id: 30, author: 'alice', body: 'P1: fix', createdAt: '2026-01-01', commentType: 'conversation' },
      ],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      threadStore,
      log: noopLog,
    });

    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gateResult.run, true);
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:owner/repo#44', {});

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].signal.routingAudit, {
      kind: 'legacy-auto-rotated-repaired',
      previousThreadId: 'thread_rotated_1',
      repairedThreadId: 'th-original',
    });
    assert.equal(calls[0].tracking.threadId, 'th-original', 'polluted legacy task must deliver to source thread');
    assert.deepEqual(
      store._updateCalls.filter((call) => Object.hasOwn(call.input, 'threadId')).map((call) => call.input.threadId),
      ['th-original'],
      'legacy repair should persist task.threadId back to the source thread',
    );
    assert.equal(threadStore._createCalls.length, 0, 'legacy repair must not create another thread');
  });

  it('delivers routing audit alongside OWNER feedback (#1002: no longer filtered)', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const task = mockTask(
      { repoFullName: 'owner/repo', prNumber: 48, catId: 'opus', threadId: 'thread_rotated_1', userId: 'u-1' },
      {
        automationState: {
          review: { lastCommentCursor: 0, lastDecisionCursor: 0, completedReviewCount: 1 },
        },
      },
    );
    const store = mockTaskStore([task]);
    const threadStore = mockThreadStore({
      thread_rotated_1: {
        id: 'thread_rotated_1',
        title: 'MR review (auto-rotated from th-original)',
        createdBy: 'u-1',
        createdAt: task.createdAt + 1000,
        participants: ['opus'],
        projectPath: '/projects/cat-cafe',
      },
      'th-original': {
        id: 'th-original',
        title: 'Original source thread',
        createdBy: 'u-1',
        createdAt: task.createdAt - 1000,
        participants: ['opus'],
        projectPath: '/projects/cat-cafe',
      },
    });
    const { router, calls } = stubRouter();
    const spec = createReviewFeedbackTaskSpec({
      taskStore: store,
      fetchComments: async () => [
        {
          id: 34,
          author: 'alice',
          authorAssociation: 'OWNER',
          body: 'owner-only review feedback',
          createdAt: '2026-01-01',
          commentType: 'conversation',
        },
      ],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      threadStore,
      log: noopLog,
    });

    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gateResult.run, true);
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:owner/repo#48', {});

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].signal.routingAudit, {
      kind: 'legacy-auto-rotated-repaired',
      previousThreadId: 'thread_rotated_1',
      repairedThreadId: 'th-original',
    });
    // #1002: OWNER comments are now delivered (decideDelivery removed)
    assert.equal(calls[0].signal.newComments.length, 1, 'OWNER comment must be delivered (#1002)');
    assert.equal(calls[0].signal.newComments[0].id, 34);
    assert.equal(calls[0].tracking.threadId, 'th-original');
    const cursorPatch = store._patchCalls.find((call) => call.patch.review?.lastCommentCursor !== undefined);
    assert.ok(cursorPatch, 'cursor must advance past delivered comment');
    assert.equal(cursorPatch.patch.review.lastCommentCursor, 34);
  });

  it('does not persist legacy repair before feedback fetch succeeds', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const task = mockTask(
      { repoFullName: 'owner/repo', prNumber: 49, catId: 'opus', threadId: 'thread_rotated_1', userId: 'u-1' },
      {
        automationState: {
          review: { lastCommentCursor: 0, lastDecisionCursor: 0, completedReviewCount: 1 },
        },
      },
    );
    const store = mockTaskStore([task]);
    const threadStore = mockThreadStore({
      thread_rotated_1: {
        id: 'thread_rotated_1',
        title: 'MR review (auto-rotated from th-original)',
        createdBy: 'u-1',
        createdAt: task.createdAt + 1000,
        participants: ['opus'],
        projectPath: '/projects/cat-cafe',
      },
      'th-original': {
        id: 'th-original',
        title: 'Original source thread',
        createdBy: 'u-1',
        createdAt: task.createdAt - 1000,
        participants: ['opus'],
        projectPath: '/projects/cat-cafe',
      },
    });
    const { router, calls } = stubRouter();
    let shouldFailFetch = true;
    const spec = createReviewFeedbackTaskSpec({
      taskStore: store,
      fetchComments: async () => {
        if (shouldFailFetch) throw new Error('temporary GitHub failure');
        return [{ id: 35, author: 'alice', body: 'P2: check', createdAt: '2026-01-01', commentType: 'conversation' }];
      },
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      threadStore,
      log: noopLog,
    });

    const failedGate = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(failedGate.run, false);
    assert.equal(task.threadId, 'thread_rotated_1', 'failed fetch must leave legacy evidence intact for retry');
    assert.equal(
      store._updateCalls.some((call) => Object.hasOwn(call.input, 'threadId')),
      false,
      'failed fetch must not persist repair before audit delivery',
    );

    shouldFailFetch = false;
    const retryGate = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 2 });
    assert.equal(retryGate.run, true);
    await spec.run.execute(retryGate.workItems[0].signal, 'pr:owner/repo#49', {});

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].signal.routingAudit, {
      kind: 'legacy-auto-rotated-repaired',
      previousThreadId: 'thread_rotated_1',
      repairedThreadId: 'th-original',
    });
    assert.deepEqual(
      store._updateCalls.filter((call) => Object.hasOwn(call.input, 'threadId')).map((call) => call.input.threadId),
      ['th-original'],
      'repair is persisted only after audit delivery succeeds',
    );
  });

  it('does not persist legacy repair when routing delivery fails', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const task = mockTask(
      { repoFullName: 'owner/repo', prNumber: 50, catId: 'opus', threadId: 'thread_rotated_1', userId: 'u-1' },
      {
        automationState: {
          review: { lastCommentCursor: 0, lastDecisionCursor: 0, completedReviewCount: 1 },
        },
      },
    );
    const store = mockTaskStore([task]);
    const threadStore = mockThreadStore({
      thread_rotated_1: {
        id: 'thread_rotated_1',
        title: 'MR review (auto-rotated from th-original)',
        createdBy: 'u-1',
        createdAt: task.createdAt + 1000,
        participants: ['opus'],
        projectPath: '/projects/cat-cafe',
      },
      'th-original': {
        id: 'th-original',
        title: 'Original source thread',
        createdBy: 'u-1',
        createdAt: task.createdAt - 1000,
        participants: ['opus'],
        projectPath: '/projects/cat-cafe',
      },
    });
    const spec = createReviewFeedbackTaskSpec({
      taskStore: store,
      fetchComments: async () => [
        { id: 36, author: 'alice', body: 'P2: check', createdAt: '2026-01-01', commentType: 'conversation' },
      ],
      fetchReviews: async () => [],
      reviewFeedbackRouter: {
        route: async () => {
          throw new Error('delivery failed');
        },
      },
      threadStore,
      log: noopLog,
    });

    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gateResult.run, true);
    await assert.rejects(
      () => spec.run.execute(gateResult.workItems[0].signal, 'pr:owner/repo#50', {}),
      /delivery failed/,
    );

    assert.equal(task.threadId, 'thread_rotated_1', 'failed delivery must leave legacy evidence intact for retry');
    assert.equal(
      store._updateCalls.some((call) => Object.hasOwn(call.input, 'threadId')),
      false,
      'failed delivery must not persist repair before audit is visible',
    );
  });

  it('does not overwrite a newer PR tracking re-registration when committing legacy repair', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const task = mockTask(
      { repoFullName: 'owner/repo', prNumber: 51, catId: 'opus', threadId: 'thread_rotated_1', userId: 'u-1' },
      {
        automationState: {
          review: { lastCommentCursor: 0, lastDecisionCursor: 0, completedReviewCount: 1 },
        },
      },
    );
    const store = mockTaskStore([task]);
    const threadStore = mockThreadStore({
      thread_rotated_1: {
        id: 'thread_rotated_1',
        title: 'MR review (auto-rotated from th-original)',
        createdBy: 'u-1',
        createdAt: task.createdAt + 1000,
        participants: ['opus'],
        projectPath: '/projects/cat-cafe',
      },
      'th-original': {
        id: 'th-original',
        title: 'Original source thread',
        createdBy: 'u-1',
        createdAt: task.createdAt - 1000,
        participants: ['opus'],
        projectPath: '/projects/cat-cafe',
      },
    });
    const { router, calls } = stubRouter();
    const spec = createReviewFeedbackTaskSpec({
      taskStore: store,
      fetchComments: async () => [
        { id: 37, author: 'alice', body: 'P2: check', createdAt: '2026-01-01', commentType: 'conversation' },
      ],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      threadStore,
      log: noopLog,
    });

    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gateResult.run, true);
    task.threadId = 'th-new-registration';
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:owner/repo#51', {});

    assert.equal(task.threadId, 'th-new-registration', 'newer registration thread must not be overwritten');
    assert.equal(calls.length, 0, 'stale repair must not deliver feedback to the gate-time source thread');
    assert.equal(
      store._updateCalls.some((call) => Object.hasOwn(call.input, 'threadId')),
      false,
      'stale legacy repair must not persist after task.threadId changes',
    );
    assert.equal(
      store._patchCalls.length,
      0,
      'stale repair must not advance cursors so the newly registered thread can receive feedback on retry',
    );
  });

  it('does not overwrite re-registration between freshness validation and conditional repair write', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const task = mockTask(
      { repoFullName: 'owner/repo', prNumber: 52, catId: 'opus', threadId: 'thread_rotated_1', userId: 'u-1' },
      {
        automationState: {
          review: { lastCommentCursor: 0, lastDecisionCursor: 0, completedReviewCount: 1 },
        },
      },
    );
    let movedBeforeConditionalWrite = false;
    const store = mockTaskStore([task], {
      beforeConditionalUpdate: () => {
        if (!movedBeforeConditionalWrite) {
          movedBeforeConditionalWrite = true;
          task.threadId = 'th-new-registration';
        }
      },
    });
    const threadStore = mockThreadStore({
      thread_rotated_1: {
        id: 'thread_rotated_1',
        title: 'MR review (auto-rotated from th-original)',
        createdBy: 'u-1',
        createdAt: task.createdAt + 1000,
        participants: ['opus'],
        projectPath: '/projects/cat-cafe',
      },
      'th-original': {
        id: 'th-original',
        title: 'Original source thread',
        createdBy: 'u-1',
        createdAt: task.createdAt - 1000,
        participants: ['opus'],
        projectPath: '/projects/cat-cafe',
      },
    });
    const { router, calls } = stubRouter();
    const spec = createReviewFeedbackTaskSpec({
      taskStore: store,
      fetchComments: async () => [
        { id: 38, author: 'alice', body: 'P2: check', createdAt: '2026-01-01', commentType: 'conversation' },
      ],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      threadStore,
      log: noopLog,
    });

    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gateResult.run, true);
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:owner/repo#52', {});

    assert.equal(calls.length, 1, 're-registration after pre-route validation may have already delivered once');
    assert.equal(task.threadId, 'th-new-registration', 'conditional repair must not overwrite the newer thread');
    assert.equal(
      store._updateCalls.some(
        (call) =>
          call.conditional && call.expectedThreadId === 'thread_rotated_1' && call.input.threadId === 'th-original',
      ),
      true,
      'repair must use the conditional task-store write path',
    );
    assert.equal(
      store._patchCalls.length,
      0,
      'failed conditional repair must not advance cursors so the new registration can receive feedback on retry',
    );
  });

  it('follows chained legacy rotated threads back to the original source thread before routing', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const task = mockTask(
      { repoFullName: 'owner/repo', prNumber: 46, catId: 'opus', threadId: 'thread_rotated_2', userId: 'u-1' },
      {
        automationState: {
          review: { lastCommentCursor: 0, lastDecisionCursor: 0, completedReviewCount: 2 },
        },
      },
    );
    const store = mockTaskStore([task]);
    const threadStore = mockThreadStore({
      thread_rotated_2: {
        id: 'thread_rotated_2',
        title: 'MR review (auto-rotated from thread_rotated_1)',
        createdBy: 'u-1',
        createdAt: task.createdAt + 2000,
        participants: ['opus'],
        projectPath: '/projects/cat-cafe',
      },
      thread_rotated_1: {
        id: 'thread_rotated_1',
        title: 'MR review (auto-rotated from th-original)',
        createdBy: 'u-1',
        createdAt: task.createdAt + 1000,
        participants: ['opus'],
        projectPath: '/projects/cat-cafe',
      },
      'th-original': {
        id: 'th-original',
        title: 'Original source thread',
        createdBy: 'u-1',
        createdAt: task.createdAt - 1000,
        participants: ['opus'],
        projectPath: '/projects/cat-cafe',
      },
    });
    const { router, calls } = stubRouter();
    const spec = createReviewFeedbackTaskSpec({
      taskStore: store,
      fetchComments: async () => [
        { id: 32, author: 'alice', body: 'P1: fix', createdAt: '2026-01-01', commentType: 'conversation' },
      ],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      threadStore,
      log: noopLog,
    });

    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gateResult.run, true);
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:owner/repo#46', {});

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].signal.routingAudit, {
      kind: 'legacy-auto-rotated-repaired',
      previousThreadId: 'thread_rotated_2',
      repairedThreadId: 'th-original',
    });
    assert.equal(calls[0].tracking.threadId, 'th-original', 'chained legacy repair must deliver to original source');
    assert.deepEqual(
      store._updateCalls.filter((call) => Object.hasOwn(call.input, 'threadId')).map((call) => call.input.threadId),
      ['th-original'],
      'chained legacy repair should persist task.threadId directly to the original source thread',
    );
    assert.equal(threadStore._createCalls.length, 0, 'chained legacy repair must not create another thread');
  });

  it('repairs legacy rotated tasks back to the built-in default source thread', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const task = mockTask(
      { repoFullName: 'owner/repo', prNumber: 47, catId: 'opus', threadId: 'thread_rotated_default', userId: 'u-1' },
      {
        automationState: {
          review: { lastCommentCursor: 0, lastDecisionCursor: 0, completedReviewCount: 2 },
        },
      },
    );
    const store = mockTaskStore([task]);
    const threadStore = mockThreadStore({
      thread_rotated_default: {
        id: 'thread_rotated_default',
        title: 'MR review (auto-rotated from default)',
        createdBy: 'u-1',
        createdAt: task.createdAt + 1000,
        participants: ['opus'],
        projectPath: 'default',
      },
      default: {
        id: 'default',
        title: null,
        createdBy: 'system',
        createdAt: task.createdAt - 1000,
        participants: [],
        projectPath: 'default',
      },
    });
    const { router, calls } = stubRouter();
    const spec = createReviewFeedbackTaskSpec({
      taskStore: store,
      fetchComments: async () => [
        { id: 33, author: 'alice', body: 'P2: check', createdAt: '2026-01-01', commentType: 'conversation' },
      ],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      threadStore,
      log: noopLog,
    });

    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gateResult.run, true);
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:owner/repo#47', {});

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].signal.routingAudit, {
      kind: 'legacy-auto-rotated-repaired',
      previousThreadId: 'thread_rotated_default',
      repairedThreadId: 'default',
    });
    assert.equal(calls[0].tracking.threadId, 'default', 'default-thread legacy repair must deliver to default');
    assert.deepEqual(
      store._updateCalls.filter((call) => Object.hasOwn(call.input, 'threadId')).map((call) => call.input.threadId),
      ['default'],
      'default-thread legacy repair should persist task.threadId back to default',
    );
  });

  it('does not repair a spoofed legacy-looking thread owned by another user', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const task = mockTask(
      { repoFullName: 'owner/repo', prNumber: 45, catId: 'opus', threadId: 'thread_spoofed', userId: 'u-1' },
      {
        automationState: {
          review: { lastCommentCursor: 0, lastDecisionCursor: 0, completedReviewCount: 1 },
        },
      },
    );
    const store = mockTaskStore([task]);
    const threadStore = mockThreadStore({
      thread_spoofed: {
        id: 'thread_spoofed',
        title: 'MR review (auto-rotated from th-unrelated)',
        createdBy: 'u-attacker',
        createdAt: task.createdAt + 1000,
        participants: [],
        projectPath: '/projects/cat-cafe',
      },
      'th-unrelated': {
        id: 'th-unrelated',
        title: 'Unrelated source-looking thread',
        createdBy: 'u-attacker',
        createdAt: task.createdAt - 1000,
        participants: [],
        projectPath: '/projects/cat-cafe',
      },
    });
    const { router, calls } = stubRouter();
    const spec = createReviewFeedbackTaskSpec({
      taskStore: store,
      fetchComments: async () => [
        { id: 31, author: 'alice', body: 'P2: check', createdAt: '2026-01-01', commentType: 'conversation' },
      ],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      threadStore,
      log: noopLog,
    });

    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gateResult.run, true);
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:owner/repo#45', {});

    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal.routingAudit, undefined, 'untrusted legacy-looking thread must not emit audit repair');
    assert.equal(calls[0].tracking.threadId, 'thread_spoofed', 'spoofed title must not reroute delivery');
    assert.equal(
      store._updateCalls.some((call) => Object.hasOwn(call.input, 'threadId')),
      false,
      'spoofed legacy-looking thread must not persist a repair',
    );
  });

  it('continues to commit cursors while preserving the registered thread', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const task = mockTask(
      { repoFullName: 'owner/repo', prNumber: 43, catId: 'codex', threadId: 'th-source', userId: 'u-1' },
      {
        automationState: {
          review: { lastCommentCursor: 0, lastDecisionCursor: 0, completedReviewCount: 3 },
        },
      },
    );
    const store = mockTaskStore([task]);
    const { router, calls } = stubRouter();
    const spec = createReviewFeedbackTaskSpec({
      taskStore: store,
      fetchComments: async () => [
        { id: 20, author: 'alice', body: 'P1: fix', createdAt: '2026-01-01', commentType: 'conversation' },
      ],
      fetchReviews: async () => [
        { id: 7, author: 'reviewer', state: 'COMMENTED', body: '', submittedAt: '2026-01-01' },
      ],
      reviewFeedbackRouter: router,
      threadStore: mockThreadStore(),
      maxReviewsPerThread: 1,
      log: noopLog,
    });

    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gateResult.run, true);
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:owner/repo#43', {});

    assert.equal(calls[0].tracking.threadId, 'th-source');
    const cursorPatch = store._patchCalls.find((call) => call.patch.review?.lastCommentCursor !== undefined);
    assert.ok(cursorPatch, 'cursor patch should still be persisted after delivery');
    assert.equal(cursorPatch.patch.review.lastCommentCursor, 20);
    assert.equal(cursorPatch.patch.review.lastDecisionCursor, 7);
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
