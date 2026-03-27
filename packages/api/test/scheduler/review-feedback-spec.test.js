// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const noopLog = { info: () => {}, error: () => {}, warn: () => {} };

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

const mockEntry = {
  repoFullName: 'owner/repo',
  prNumber: 42,
  catId: 'opus',
  threadId: 'th-1',
  userId: 'u-1',
  registeredAt: 1000,
};

describe('ReviewFeedbackTaskSpec', () => {
  it('has correct id and profile (KD-11)', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const { router } = stubRouter();
    const spec = createReviewFeedbackTaskSpec({
      prTrackingStore: { listAll: async () => [] },
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
      prTrackingStore: { listAll: async () => [] },
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
      prTrackingStore: { listAll: async () => [mockEntry] },
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
      prTrackingStore: { listAll: async () => [mockEntry] },
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
      prTrackingStore: { listAll: async () => [mockEntry] },
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
    r1.workItems[0].signal.commitCursor();

    // Second gate: same comment, should be filtered out
    const r2 = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 2 });
    assert.equal(r2.run, false);
  });

  it('cursor only advances in execute, not gate (KD-10 / LL-039)', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const { router } = stubRouter();
    const spec = createReviewFeedbackTaskSpec({
      prTrackingStore: { listAll: async () => [mockEntry] },
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
      prTrackingStore: { listAll: async () => [] },
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
      entry: mockEntry,
      newComments: [{ id: 1, author: 'alice', body: 'hi', createdAt: '2026-01-01', commentType: 'conversation' }],
      newDecisions: [],
      commitCursor: () => {
        cursorCommitted = true;
      },
    };
    await spec.run.execute(signal, 'pr-owner/repo#42');

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
      prTrackingStore: { listAll: async () => [] },
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
      entry: mockEntry,
      newComments: [],
      newDecisions: [{ id: 1, author: 'bob', state: 'CHANGES_REQUESTED', body: 'fix it', submittedAt: '2026-01-01' }],
      commitCursor: () => {},
    };
    await spec.run.execute(signal, 'pr-owner/repo#42');

    assert.equal(triggerCalls[0][6].priority, 'urgent');
  });

  it('gate filters out echo comments via isEchoComment predicate', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const { router } = stubRouter();
    const spec = createReviewFeedbackTaskSpec({
      prTrackingStore: { listAll: async () => [mockEntry] },
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
      prTrackingStore: { listAll: async () => [mockEntry] },
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
      prTrackingStore: { listAll: async () => [mockEntry] },
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
      prTrackingStore: { listAll: async () => [mockEntry] },
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
      prTrackingStore: { listAll: async () => [] },
      fetchComments: async () => [],
      fetchReviews: async () => [],
      reviewFeedbackRouter: router,
      log: noopLog,
    });

    let cursorCommitted = false;
    const signal = {
      entry: mockEntry,
      newComments: [],
      newDecisions: [],
      commitCursor: () => {
        cursorCommitted = true;
      },
    };
    await spec.run.execute(signal, 'pr-owner/repo#42');

    assert.equal(cursorCommitted, false, 'cursor should not advance when delivery skipped');
  });

  // ── F140 double-consume fix: shared feedback filter tests ──

  it('self-authored ordinary comment is filtered (Rule A)', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const { router } = stubRouter();
    const self = 'zts212653';
    const spec = createReviewFeedbackTaskSpec({
      prTrackingStore: { listAll: async () => [mockEntry] },
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
      prTrackingStore: { listAll: async () => [mockEntry] },
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
      prTrackingStore: { listAll: async () => [mockEntry] },
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
      prTrackingStore: { listAll: async () => [mockEntry] },
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

  it('non-authoritative bot comment is NOT filtered (Rule B negative)', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const { router } = stubRouter();
    const authBot = 'chatgpt-codex-connector[bot]';
    const spec = createReviewFeedbackTaskSpec({
      prTrackingStore: { listAll: async () => [mockEntry] },
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
