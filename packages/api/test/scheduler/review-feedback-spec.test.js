// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const noopLog = { info: () => {}, error: () => {}, warn: () => {} };

/** Convert old PrTrackingEntry-style mock to TaskItem shape for #320 unified model */
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
  return {
    listByKind: async () => tasks,
    patchAutomationState: async (taskId, patch) => {
      patchCalls.push({ taskId, patch });
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return null;
      // Return merged copy — do NOT mutate shared mock objects
      return {
        ...task,
        automationState: {
          ...task.automationState,
          ...patch,
          review: patch.review ? { ...task.automationState?.review, ...patch.review } : task.automationState?.review,
        },
      };
    },
    _patchCalls: patchCalls,
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

const mockTaskItem = mockTask({
  repoFullName: 'owner/repo',
  prNumber: 42,
  catId: 'opus',
  threadId: 'th-1',
  userId: 'u-1',
});

describe('ReviewFeedbackTaskSpec', () => {
  it('has correct id and profile (KD-11)', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const { router } = stubRouter();
    const spec = createReviewFeedbackTaskSpec({
      taskStore: mockTaskStore([]),
      fetchComments: async () => [],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      log: noopLog,
    });
    assert.equal(spec.id, 'review-feedback');
    assert.equal(spec.profile, 'poller');
  });

  it('gate returns run:false when no tracked PRs', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const { router } = stubRouter();
    const spec = createReviewFeedbackTaskSpec({
      taskStore: mockTaskStore([]),
      fetchComments: async () => [],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      log: noopLog,
    });
    const result = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, false);
  });

  it('gate returns workItems for PRs with new comments', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const { router } = stubRouter();
    const spec = createReviewFeedbackTaskSpec({
      taskStore: mockTaskStore([mockTaskItem]),
      fetchComments: async () => [
        { id: 1, author: 'alice', body: 'hi', createdAt: '2026-01-01', commentType: 'conversation' },
      ],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      log: noopLog,
    });
    const result = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, true);
    assert.equal(result.workItems.length, 1);
    assert.equal(result.workItems[0].signal.newComments.length, 1);
  });

  it('gate returns workItems for PRs with new review decisions', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const { router } = stubRouter();
    const spec = createReviewFeedbackTaskSpec({
      taskStore: mockTaskStore([mockTaskItem]),
      fetchComments: async () => [],
      fetchReviews: async () => [{ id: 1, author: 'alice', state: 'APPROVED', body: '', submittedAt: '2026-01-01' }],
      reviewFeedbackRouter: router,
      log: noopLog,
    });
    const result = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, true);
    assert.equal(result.workItems[0].signal.newDecisions.length, 1);
  });

  it('cursor dedup: same comment ID not included twice (AC-A8)', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const { router } = stubRouter();
    const spec = createReviewFeedbackTaskSpec({
      taskStore: mockTaskStore([mockTaskItem]),
      fetchComments: async () => [
        { id: 1, author: 'alice', body: 'hi', createdAt: '2026-01-01', commentType: 'conversation' },
      ],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      log: noopLog,
    });

    // First gate: has new comment
    const r1 = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(r1.run, true);
    // Simulate execute → commitCursor
    await r1.workItems[0].signal.commitCursor();

    // Second gate: same comment, should be filtered out
    const r2 = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 2 });
    assert.equal(r2.run, false);
  });

  it('cursor only advances in execute, not gate (KD-10 / LL-039)', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const { router } = stubRouter();
    const spec = createReviewFeedbackTaskSpec({
      taskStore: mockTaskStore([mockTaskItem]),
      fetchComments: async () => [
        { id: 1, author: 'alice', body: 'hi', createdAt: '2026-01-01', commentType: 'conversation' },
      ],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      log: noopLog,
    });

    // Gate runs but we DON'T call commitCursor (simulating execute failure)
    const r1 = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(r1.run, true);
    // Don't commit cursor

    // Next gate should still see the same comment
    const r2 = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 2 });
    assert.equal(r2.run, true);
    assert.equal(r2.workItems[0].signal.newComments.length, 1);
  });

  it('execute delegates to router and triggers (AC-A5)', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const { router, calls } = stubRouter();
    const triggerCalls = [];
    const spec = createReviewFeedbackTaskSpec({
      taskStore: mockTaskStore([]),
      fetchComments: async () => [],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      invokeTrigger: {
        trigger(...args) {
          triggerCalls.push(args);
        },
      },
      log: noopLog,
    });

    let cursorCommitted = false;
    const signal = {
      task: mockTaskItem,
      repoFullName: 'owner/repo',
      prNumber: 42,
      newComments: [{ id: 1, author: 'alice', body: 'hi', createdAt: '2026-01-01', commentType: 'conversation' }],
      newDecisions: [],
      commitCursor: () => {
        cursorCommitted = true;
      },
    };
    await spec.run.execute(signal, 'pr:owner/repo#42');

    assert.equal(calls.length, 1);
    assert.equal(cursorCommitted, true);
    assert.equal(triggerCalls.length, 1);
    assert.equal(triggerCalls[0][6].priority, 'normal');
  });

  it('execute uses urgent priority for CHANGES_REQUESTED', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const { router } = stubRouter();
    const triggerCalls = [];
    const spec = createReviewFeedbackTaskSpec({
      taskStore: mockTaskStore([]),
      fetchComments: async () => [],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      invokeTrigger: {
        trigger(...args) {
          triggerCalls.push(args);
        },
      },
      log: noopLog,
    });

    const signal = {
      task: mockTaskItem,
      repoFullName: 'owner/repo',
      prNumber: 42,
      newComments: [],
      newDecisions: [{ id: 1, author: 'bob', state: 'CHANGES_REQUESTED', body: 'fix it', submittedAt: '2026-01-01' }],
      commitCursor: () => {},
    };
    await spec.run.execute(signal, 'pr:owner/repo#42');

    assert.equal(triggerCalls[0][6].priority, 'urgent');
  });

  it('gate filters out echo comments via isEchoComment predicate', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const { router } = stubRouter();
    const spec = createReviewFeedbackTaskSpec({
      taskStore: mockTaskStore([mockTaskItem]),
      fetchComments: async () => [
        {
          id: 1,
          author: 'zts212653',
          body: '@codex review\n\nPlease review latest commit abc123',
          createdAt: '2026-01-01',
          commentType: 'conversation',
        },
        {
          id: 2,
          author: 'alice',
          body: 'Looks good, minor nit on line 42',
          createdAt: '2026-01-01',
          commentType: 'conversation',
        },
      ],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      log: noopLog,
      isEchoComment: (c) => /^@\w+\s+review\b/i.test(c.body),
    });
    const result = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, true);
    assert.equal(result.workItems[0].signal.newComments.length, 1);
    assert.equal(result.workItems[0].signal.newComments[0].author, 'alice');
  });

  it('gate skips PR entirely when all comments are echo', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const { router } = stubRouter();
    const spec = createReviewFeedbackTaskSpec({
      taskStore: mockTaskStore([mockTaskItem]),
      fetchComments: async () => [
        {
          id: 1,
          author: 'zts212653',
          body: '@codex review\n\nPlease review latest commit abc123',
          createdAt: '2026-01-01',
          commentType: 'conversation',
        },
      ],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      log: noopLog,
      isEchoComment: (c) => /^@\w+\s+review\b/i.test(c.body),
    });
    const result = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, false);
  });

  it('echo filter still advances cursor for filtered comments', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const { router } = stubRouter();
    let fetchCount = 0;
    const spec = createReviewFeedbackTaskSpec({
      taskStore: mockTaskStore([mockTaskItem]),
      fetchComments: async () => {
        fetchCount++;
        return [
          {
            id: 10,
            author: 'zts212653',
            body: '@codex review\n\nPlease review abc',
            createdAt: '2026-01-01',
            commentType: 'conversation',
          },
        ];
      },
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      log: noopLog,
      isEchoComment: (c) => /^@\w+\s+review\b/i.test(c.body),
    });

    // First gate: echo comment filtered, run=false, but cursor should advance past it
    const r1 = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(r1.run, false);

    // Second gate: same echo comment should not reappear (cursor advanced)
    const r2 = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 2 });
    assert.equal(r2.run, false);
  });

  it('echo filter with author check does not filter external reviewer comments (P1 regression)', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const { router } = stubRouter();
    const selfLogin = 'zts212653';
    const spec = createReviewFeedbackTaskSpec({
      taskStore: mockTaskStore([mockTaskItem]),
      fetchComments: async () => [
        {
          id: 1,
          author: 'external-reviewer',
          body: '@opus review this PR please',
          createdAt: '2026-01-01',
          commentType: 'conversation',
        },
        {
          id: 2,
          author: selfLogin,
          body: '@codex review\n\nPlease review latest commit abc123',
          createdAt: '2026-01-01',
          commentType: 'conversation',
        },
      ],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      log: noopLog,
      // Author + body: only OUR account's trigger comments are echo
      isEchoComment: (c) =>
        c.author === selfLogin && c.commentType === 'conversation' && /^@\w+\s+review\b/i.test(c.body),
    });
    const result = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, true);
    // External reviewer's comment MUST pass through — not filtered
    assert.equal(result.workItems[0].signal.newComments.length, 1);
    assert.equal(result.workItems[0].signal.newComments[0].author, 'external-reviewer');
  });

  it('execute does not commit cursor when router skips', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const { router } = stubRouter('skipped');
    const spec = createReviewFeedbackTaskSpec({
      taskStore: mockTaskStore([]),
      fetchComments: async () => [],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      log: noopLog,
    });

    let cursorCommitted = false;
    const signal = {
      task: mockTaskItem,
      repoFullName: 'owner/repo',
      prNumber: 42,
      newComments: [],
      newDecisions: [],
      commitCursor: () => {
        cursorCommitted = true;
      },
    };
    await spec.run.execute(signal, 'pr:owner/repo#42');

    assert.equal(cursorCommitted, false, 'cursor should not advance when delivery skipped');
  });

  // ── F140 double-consume fix: shared feedback filter tests ──

  it('self-authored ordinary comment is filtered (Rule A)', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const { router } = stubRouter();
    const self = 'zts212653';
    const spec = createReviewFeedbackTaskSpec({
      taskStore: mockTaskStore([mockTaskItem]),
      fetchComments: async () => [
        { id: 1, author: self, body: 'LGTM, looks good to me', createdAt: '2026-01-01', commentType: 'conversation' },
        { id: 2, author: 'alice', body: 'Please fix the typo', createdAt: '2026-01-01', commentType: 'conversation' },
      ],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      log: noopLog,
      isEchoComment: (c) => c.author === self,
    });
    const result = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, true);
    assert.equal(result.workItems[0].signal.newComments.length, 1);
    assert.equal(result.workItems[0].signal.newComments[0].author, 'alice');
  });

  it('self-authored review decision is filtered (Rule A + isEchoReview)', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const { router } = stubRouter();
    const self = 'zts212653';
    const spec = createReviewFeedbackTaskSpec({
      taskStore: mockTaskStore([mockTaskItem]),
      fetchComments: async () => [],
      fetchReviews: async () => [
        { id: 1, author: self, state: 'COMMENTED', body: 'Looks fine', submittedAt: '2026-01-01' },
        { id: 2, author: 'bob', state: 'APPROVED', body: 'Ship it', submittedAt: '2026-01-01' },
      ],
      reviewFeedbackRouter: router,
      log: noopLog,
      isEchoReview: (r) => r.author === self,
    });
    const result = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, true);
    assert.equal(result.workItems[0].signal.newDecisions.length, 1);
    assert.equal(result.workItems[0].signal.newDecisions[0].author, 'bob');
  });

  it('external human "@opus review ..." is NOT filtered (Rule A negative)', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const { router } = stubRouter();
    const self = 'zts212653';
    const spec = createReviewFeedbackTaskSpec({
      taskStore: mockTaskStore([mockTaskItem]),
      fetchComments: async () => [
        {
          id: 1,
          author: 'external-dev',
          body: '@opus review this change',
          createdAt: '2026-01-01',
          commentType: 'conversation',
        },
      ],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      log: noopLog,
      isEchoComment: (c) => c.author === self,
    });
    const result = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, true);
    assert.equal(result.workItems[0].signal.newComments.length, 1);
    assert.equal(result.workItems[0].signal.newComments[0].author, 'external-dev');
  });

  it('authoritative bot (codex) comment + review are filtered in F140 (Rule B)', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const { router } = stubRouter();
    const bot = 'chatgpt-codex-connector[bot]';
    const spec = createReviewFeedbackTaskSpec({
      taskStore: mockTaskStore([mockTaskItem]),
      fetchComments: async () => [
        {
          id: 1,
          author: bot,
          body: "Codex Review: Didn't find any major issues.",
          createdAt: '2026-01-01',
          commentType: 'conversation',
        },
      ],
      fetchReviews: async () => [
        { id: 1, author: bot, state: 'COMMENTED', body: 'Codex Review', submittedAt: '2026-01-01' },
      ],
      reviewFeedbackRouter: router,
      log: noopLog,
      isEchoComment: (c) => c.author === bot,
      isEchoReview: (r) => r.author === bot,
    });
    const result = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, false, 'all-bot batch should be skipped');
  });

  // ── F140 Phase C: review intent routing ──

  it('CHANGES_REQUESTED triggers with suggestedSkill=receive-review (Phase C)', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const triggered = [];
    const spec = createReviewFeedbackTaskSpec({
      taskStore: mockTaskStore([mockTaskItem]),
      fetchComments: async () => [],
      fetchReviews: async () => [
        { id: 1, author: 'reviewer', state: 'CHANGES_REQUESTED', body: 'Fix the bug', submittedAt: '2026-01-01' },
      ],
      reviewFeedbackRouter: {
        async route() {
          return { kind: 'notified', threadId: 't1', catId: 'opus', messageId: 'm1', content: 'review' };
        },
      },
      invokeTrigger: { trigger: (...args) => triggered.push(args) },
      log: noopLog,
    });
    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gateResult.run, true);
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:owner/repo#42', {});
    assert.equal(triggered.length, 1);
    const policy = triggered[0][6];
    assert.equal(policy.priority, 'urgent');
    assert.equal(policy.suggestedSkill, 'receive-review');
  });

  it('APPROVED triggers with suggestedSkill=merge-gate (Phase C)', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const triggered = [];
    const spec = createReviewFeedbackTaskSpec({
      taskStore: mockTaskStore([mockTaskItem]),
      fetchComments: async () => [],
      fetchReviews: async () => [
        { id: 1, author: 'reviewer', state: 'APPROVED', body: 'LGTM', submittedAt: '2026-01-01' },
      ],
      reviewFeedbackRouter: {
        async route() {
          return { kind: 'notified', threadId: 't1', catId: 'opus', messageId: 'm1', content: 'approved' };
        },
      },
      invokeTrigger: { trigger: (...args) => triggered.push(args) },
      log: noopLog,
    });
    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gateResult.run, true);
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:owner/repo#42', {});
    assert.equal(triggered.length, 1);
    const policy = triggered[0][6];
    assert.equal(policy.priority, 'normal');
    assert.equal(policy.suggestedSkill, 'merge-gate');
  });

  it('COMMENTED-only triggers with no suggestedSkill (Phase C)', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const triggered = [];
    const spec = createReviewFeedbackTaskSpec({
      taskStore: mockTaskStore([mockTaskItem]),
      fetchComments: async () => [],
      fetchReviews: async () => [
        { id: 1, author: 'reviewer', state: 'COMMENTED', body: 'Interesting approach', submittedAt: '2026-01-01' },
      ],
      reviewFeedbackRouter: {
        async route() {
          return { kind: 'notified', threadId: 't1', catId: 'opus', messageId: 'm1', content: 'comment' };
        },
      },
      invokeTrigger: { trigger: (...args) => triggered.push(args) },
      log: noopLog,
    });
    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gateResult.run, true);
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:owner/repo#42', {});
    assert.equal(triggered.length, 1);
    const policy = triggered[0][6];
    assert.equal(policy.priority, 'normal');
    assert.equal(policy.suggestedSkill, undefined);
  });

  // ── #406: restart cursor persistence ──

  it('gate seeds cursor from automationState.review on fresh instance (#406)', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const { router } = stubRouter();
    // Task has persisted cursor at comment=5, decision=3
    const taskWithCursors = mockTask(
      { repoFullName: 'owner/repo', prNumber: 42, catId: 'opus', threadId: 'th-1', userId: 'u-1' },
      {
        automationState: {
          review: { lastCommentCursor: 5, lastDecisionCursor: 3 },
        },
      },
    );
    const spec = createReviewFeedbackTaskSpec({
      taskStore: mockTaskStore([taskWithCursors]),
      // Comments with id <= 5 should be skipped (below persisted cursor)
      fetchComments: async () => [
        { id: 3, author: 'old', body: 'old comment', createdAt: '2026-01-01', commentType: 'conversation' },
        { id: 5, author: 'old', body: 'last seen', createdAt: '2026-01-01', commentType: 'conversation' },
        { id: 8, author: 'alice', body: 'new comment', createdAt: '2026-01-02', commentType: 'conversation' },
      ],
      fetchReviews: async () => [
        { id: 2, author: 'old', state: 'COMMENTED', body: 'old', submittedAt: '2026-01-01' },
        { id: 3, author: 'old', state: 'APPROVED', body: 'old', submittedAt: '2026-01-01' },
      ],
      reviewFeedbackRouter: router,
      log: noopLog,
    });
    const result = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, true);
    // Only comment id=8 is new (above cursor 5)
    assert.equal(result.workItems[0].signal.newComments.length, 1);
    assert.equal(result.workItems[0].signal.newComments[0].id, 8);
    // Reviews id=2,3 are at/below cursor 3 → none new
    assert.equal(result.workItems[0].signal.newDecisions.length, 0);
  });

  it('gate excludes done tasks — no work items, no fetch (#406 regression)', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const { router } = stubRouter();
    let fetchCalled = false;
    const doneTask = mockTask(
      { repoFullName: 'owner/repo', prNumber: 99, catId: 'opus', threadId: 'th-done', userId: 'u-1' },
      { status: 'done' },
    );
    const spec = createReviewFeedbackTaskSpec({
      taskStore: mockTaskStore([doneTask]),
      fetchComments: async () => {
        fetchCalled = true;
        return [{ id: 1, author: 'alice', body: 'new', createdAt: '2026-01-01', commentType: 'conversation' }];
      },
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      log: noopLog,
    });
    const result = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, false, 'done task must be excluded from gate');
    assert.equal(fetchCalled, false, 'should not even fetch comments for done tasks');
  });

  it('gate returns run:false when all items below persisted cursor (#406)', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const { router } = stubRouter();
    const taskWithCursors = mockTask(
      { repoFullName: 'owner/repo', prNumber: 42, catId: 'opus', threadId: 'th-1', userId: 'u-1' },
      {
        automationState: {
          review: { lastCommentCursor: 10, lastDecisionCursor: 5 },
        },
      },
    );
    const spec = createReviewFeedbackTaskSpec({
      taskStore: mockTaskStore([taskWithCursors]),
      fetchComments: async () => [
        { id: 3, author: 'old', body: 'old', createdAt: '2026-01-01', commentType: 'conversation' },
        { id: 8, author: 'old', body: 'old', createdAt: '2026-01-01', commentType: 'conversation' },
      ],
      fetchReviews: async () => [{ id: 2, author: 'old', state: 'APPROVED', body: '', submittedAt: '2026-01-01' }],
      reviewFeedbackRouter: router,
      log: noopLog,
    });
    const result = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, false, 'no new items above persisted cursor');
  });

  it('commitCursor persists to automationState.review via patchAutomationState (#406)', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const store = mockTaskStore([mockTaskItem]);
    const spec = createReviewFeedbackTaskSpec({
      taskStore: store,
      fetchComments: async () => [
        { id: 7, author: 'alice', body: 'new', createdAt: '2026-01-01', commentType: 'conversation' },
      ],
      fetchReviews: async () => [{ id: 4, author: 'bob', state: 'APPROVED', body: 'LGTM', submittedAt: '2026-01-01' }],
      reviewFeedbackRouter: {
        async route() {
          return { kind: 'notified', threadId: 'th-1', catId: 'opus', messageId: 'm1', content: 'fb' };
        },
      },
      log: noopLog,
    });
    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gateResult.run, true);
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:owner/repo#42', {});

    // Verify patchAutomationState was called with correct cursor values
    assert.equal(store._patchCalls.length, 1);
    const call = store._patchCalls[0];
    assert.equal(call.taskId, mockTaskItem.id);
    assert.equal(call.patch.review.lastCommentCursor, 7);
    assert.equal(call.patch.review.lastDecisionCursor, 4);
    assert.equal(typeof call.patch.review.lastNotifiedAt, 'number');
  });

  it('echo-skip path also persists cursor to automationState (#406)', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const store = mockTaskStore([mockTaskItem]);
    const spec = createReviewFeedbackTaskSpec({
      taskStore: store,
      fetchComments: async () => [
        { id: 10, author: 'self', body: '@codex review', createdAt: '2026-01-01', commentType: 'conversation' },
      ],
      fetchReviews: async () => [],
      reviewFeedbackRouter: {
        async route() {
          return { kind: 'skipped', reason: 'test' };
        },
      },
      log: noopLog,
      isEchoComment: (c) => c.author === 'self',
    });
    const result = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, false, 'all echo → skip');

    // Echo-skip should still persist cursor
    assert.equal(store._patchCalls.length, 1);
    assert.equal(store._patchCalls[0].patch.review.lastCommentCursor, 10);
  });

  it('echo-skip persist failure logs warning and allows retry next tick (#406 P2)', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const warnings = [];
    const failingStore = {
      listByKind: async () => [mockTaskItem],
      patchAutomationState: async () => {
        throw new Error('Redis unavailable');
      },
      _patchCalls: [],
    };
    const spec = createReviewFeedbackTaskSpec({
      taskStore: failingStore,
      fetchComments: async () => [
        { id: 10, author: 'self', body: '@codex review', createdAt: '2026-01-01', commentType: 'conversation' },
      ],
      fetchReviews: async () => [],
      reviewFeedbackRouter: {
        async route() {
          return { kind: 'skipped', reason: 'test' };
        },
      },
      log: { ...noopLog, warn: (...args) => warnings.push(args) },
      isEchoComment: (c) => c.author === 'self',
    });

    // First gate: persist fails, warn logged, memory NOT advanced
    const r1 = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(r1.run, false, 'echo-skip still returns run:false');
    assert.ok(warnings.length > 0, 'should log warning on persist failure');
    assert.ok(warnings[0][0].includes('echo-skip persist failed'), 'warning message identifies echo-skip');

    // Second gate: same echo comment retried (memory cursor was NOT advanced)
    warnings.length = 0;
    const r2 = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 2 });
    assert.equal(r2.run, false, 'echo comment still filtered on retry');
    assert.ok(warnings.length > 0, 'retry also attempts persist and logs');
  });

  it('commitCursor persist failure after delivery still advances memory cursor (no duplicate spam)', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const warnings = [];
    const failingStore = {
      listByKind: async () => [mockTaskItem],
      patchAutomationState: async () => {
        throw new Error('Redis unavailable');
      },
      _patchCalls: [],
    };
    const spec = createReviewFeedbackTaskSpec({
      taskStore: failingStore,
      fetchComments: async () => [
        { id: 7, author: 'alice', body: 'new review', createdAt: '2026-01-01', commentType: 'conversation' },
      ],
      fetchReviews: async () => [],
      reviewFeedbackRouter: {
        async route() {
          return { kind: 'notified', threadId: 'th-1', catId: 'opus', messageId: 'm1', content: 'fb' };
        },
      },
      log: { ...noopLog, warn: (...args) => warnings.push(args) },
    });

    // Gate + execute: delivery succeeds, persist fails
    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gateResult.run, true);
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:owner/repo#42', {});

    // Persist failed → warn logged
    assert.ok(warnings.length > 0, 'should log warning on persist failure');
    assert.ok(warnings[0][0].includes('cursor persist failed'), 'warning identifies cursor persist');

    // But memory cursor advanced → next gate does NOT re-deliver (no duplicate spam)
    const r2 = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 2 });
    assert.equal(r2.run, false, 'memory cursor prevents duplicate delivery');
  });

  it('non-authoritative bot comment is NOT filtered (Rule B negative)', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const { router } = stubRouter();
    const authBot = 'chatgpt-codex-connector[bot]';
    const spec = createReviewFeedbackTaskSpec({
      taskStore: mockTaskStore([mockTaskItem]),
      fetchComments: async () => [
        {
          id: 1,
          author: 'dependabot[bot]',
          body: 'Bumps lodash from 4.17.20 to 4.17.21',
          createdAt: '2026-01-01',
          commentType: 'conversation',
        },
      ],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      log: noopLog,
      // Only skip the authoritative bot, not all bots
      isEchoComment: (c) => c.author === authBot,
    });
    const result = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, true);
    assert.equal(result.workItems[0].signal.newComments.length, 1);
    assert.equal(result.workItems[0].signal.newComments[0].author, 'dependabot[bot]');
  });
});
