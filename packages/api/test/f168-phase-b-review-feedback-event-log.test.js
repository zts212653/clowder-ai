/**
 * F168 Phase B — R3-P1: ReviewFeedbackTaskSpec event log append (polling fallback path)
 *
 * AC #1 requires dual-path into event log for pr.review_submitted:
 *   webhook (PR-1) + polling fallback (this file).
 *
 * Without event log append in ReviewFeedbackTaskSpec:
 *   - Projector never sees pr.review_submitted events from polling
 *   - awaiting_external → in_progress restoration ONLY works via webhook
 *   - If webhook is missed, state machine does not restore even though notification was delivered
 *
 * Fix: append each fresh comment/review to event log with classification='informational'
 * and authorAssociation in payload BEFORE the delivery filter, so projector can process
 * state transitions.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

let createReviewFeedbackTaskSpec;
try {
  const mod = await import('../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
  createReviewFeedbackTaskSpec = mod.createReviewFeedbackTaskSpec;
} catch {
  // GREEN phase: implementation will be updated
}

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function makeTaskStore(task) {
  const tasks = new Map([[task.id, task]]);
  return {
    async listByKind(kind) {
      return [...tasks.values()].filter((t) => t.kind === kind && t.status !== 'done');
    },
    async update(id, patch) {
      const t = tasks.get(id);
      if (t) tasks.set(id, { ...t, ...patch });
    },
    async patchAutomationState(id, patch) {
      const t = tasks.get(id);
      if (t) {
        const merged = { ...t.automationState };
        for (const [k, v] of Object.entries(patch)) {
          merged[k] = { ...(merged[k] ?? {}), ...v };
        }
        tasks.set(id, { ...t, automationState: merged });
      }
    },
  };
}

function makeEventLog(appendResult = { appended: true }) {
  const appendCalls = [];
  return {
    appendCalls,
    async read() {
      return [];
    },
    async append(event) {
      appendCalls.push(event);
      return appendResult;
    },
  };
}

function makeProjector() {
  const applyCalls = [];
  return {
    applyCalls,
    async apply(event) {
      applyCalls.push(event);
    },
  };
}

function makeRouter() {
  const calls = [];
  return {
    calls,
    async route(signal, tracking) {
      calls.push({ signal, tracking });
      return {
        kind: 'notified',
        threadId: tracking.threadId,
        catId: tracking.catId,
        messageId: 'msg-1',
        content: 'stub',
      };
    },
  };
}

function makePrTask(id = 'pr-task-1') {
  return {
    id,
    kind: 'pr_tracking',
    status: 'active',
    subjectKey: 'pr:owner/repo#10',
    threadId: 'thread-1',
    ownerCatId: 'cat1',
    userId: 'user1',
    automationState: {},
  };
}

const log = { info: () => {}, error: () => {}, warn: () => {} };

async function runGate(spec) {
  return spec.admission.gate();
}

// ---------------------------------------------------------------------------
// Tests: event log append for individual PR reviews/comments
// ---------------------------------------------------------------------------

describe('ReviewFeedbackTaskSpec: event log append — polling fallback (R3-P1)', () => {
  it('appends pr.review_submitted informational event for each new review', async () => {
    assert.ok(createReviewFeedbackTaskSpec, 'module must be importable');
    const taskStore = makeTaskStore(makePrTask());
    const eventLog = makeEventLog({ appended: true });
    const projector = makeProjector();

    const reviews = [
      {
        id: 101,
        author: 'external-reviewer',
        state: 'CHANGES_REQUESTED',
        body: 'Please fix',
        submittedAt: '2026-01-01T00:00:00Z',
        authorAssociation: 'CONTRIBUTOR',
      },
    ];

    const spec = createReviewFeedbackTaskSpec({
      id: 'event-log-reviews',
      taskStore,
      reviewFeedbackRouter: makeRouter(),
      fetchComments: async () => [],
      fetchReviews: async () => reviews,
      eventLog,
      projector,
      log,
    });

    await runGate(spec);

    const reviewAppend = eventLog.appendCalls.find(
      (e) => e.kind === 'pr.review_submitted' && e.payload?.reviewId === 101,
    );
    assert.ok(reviewAppend, 'review 101 must be appended to event log');
    assert.strictEqual(reviewAppend.classification, 'informational');
    assert.strictEqual(reviewAppend.payload.authorAssociation, 'CONTRIBUTOR');
    assert.strictEqual(reviewAppend.subjectKey, 'pr:owner/repo#10');
    // R4-P1-A: must match webhook handler format review:{repo}#{pr}:{reviewId}
    assert.strictEqual(reviewAppend.sourceEventId, 'review:owner/repo#10:101');
  });

  it('appends pr.review_submitted informational event for each new comment', async () => {
    assert.ok(createReviewFeedbackTaskSpec);
    const taskStore = makeTaskStore(makePrTask());
    const eventLog = makeEventLog({ appended: true });
    const projector = makeProjector();

    const comments = [
      {
        id: 201,
        author: 'external-user',
        body: 'Question here',
        createdAt: '2026-01-01T00:00:00Z',
        commentType: 'inline',
        authorAssociation: 'NONE',
      },
    ];

    const spec = createReviewFeedbackTaskSpec({
      id: 'event-log-comments',
      taskStore,
      reviewFeedbackRouter: makeRouter(),
      fetchComments: async () => comments,
      fetchReviews: async () => [],
      eventLog,
      projector,
      log,
    });

    await runGate(spec);

    const commentAppend = eventLog.appendCalls.find(
      (e) => e.kind === 'pr.review_submitted' && e.payload?.commentId === 201,
    );
    assert.ok(commentAppend, 'comment 201 must be appended to event log');
    assert.strictEqual(commentAppend.classification, 'informational');
    assert.strictEqual(commentAppend.payload.authorAssociation, 'NONE');
    assert.strictEqual(commentAppend.sourceEventId, 'prcomment:owner/repo#10:inline:201');
  });

  it('preserves legacy comment identity while migrating split cursors', async () => {
    assert.ok(createReviewFeedbackTaskSpec);
    const task = {
      ...makePrTask(),
      automationState: {
        review: {
          lastCommentCursor: 500,
          lastDecisionCursor: 0,
        },
      },
    };
    const taskStore = makeTaskStore(task);
    const appendCalls = [];
    const eventLog = {
      async read(subjectKey) {
        assert.strictEqual(subjectKey, 'pr:owner/repo#10');
        return [
          {
            sourceEventId: 'prcomment:owner/repo#10:201',
            subjectKey,
            kind: 'pr.review_submitted',
            classification: 'informational',
            payload: { commentId: 201, commentType: 'inline' },
            at: Date.parse('2026-01-01T00:00:00Z'),
          },
        ];
      },
      async append(event) {
        appendCalls.push(event);
        return { appended: true, sequence: appendCalls.length - 1 };
      },
    };
    const projector = makeProjector();

    const spec = createReviewFeedbackTaskSpec({
      id: 'legacy-comment-identity-migration',
      taskStore,
      reviewFeedbackRouter: makeRouter(),
      fetchComments: async () => [
        {
          id: 201,
          author: 'inline-author',
          body: 'already projected before migration',
          createdAt: '2026-01-01T00:00:00Z',
          commentType: 'inline',
          authorAssociation: 'NONE',
        },
        {
          id: 201,
          author: 'conversation-author',
          body: 'same numeric ID from the independent source',
          createdAt: '2026-01-02T00:00:00Z',
          commentType: 'conversation',
          authorAssociation: 'NONE',
        },
      ],
      fetchReviews: async () => [],
      eventLog,
      projector,
      log,
    });

    const gate = await runGate(spec);

    assert.equal(gate.run, true);
    assert.deepEqual(
      appendCalls.map((event) => event.sourceEventId),
      ['prcomment:owner/repo#10:conversation:201'],
      'migration must suppress only the exact legacy source while retaining same-ID comments from the other source',
    );
    assert.deepEqual(
      projector.applyCalls.map((event) => event.sourceEventId),
      ['prcomment:owner/repo#10:conversation:201'],
      'legacy duplicates must not be projected again out of temporal order',
    );
  });

  it('preserves legacy comment identity after unregister and split-cursor re-registration', async () => {
    assert.ok(createReviewFeedbackTaskSpec);
    const task = {
      ...makePrTask(),
      automationState: {
        review: {
          lastCommentCursor: 0,
          lastInlineCommentCursor: 0,
          lastConversationCommentCursor: 0,
          lastDecisionCursor: 0,
        },
      },
    };
    const taskStore = makeTaskStore(task);
    const appendCalls = [];
    const eventLog = {
      async read(subjectKey) {
        assert.strictEqual(subjectKey, 'pr:owner/repo#10');
        return [
          {
            sourceEventId: 'prcomment:owner/repo#10:201',
            subjectKey,
            kind: 'pr.review_submitted',
            classification: 'informational',
            payload: { commentId: 201, commentType: 'inline' },
            at: Date.parse('2026-01-01T00:00:00Z'),
          },
        ];
      },
      async append(event) {
        appendCalls.push(event);
        return { appended: true, sequence: appendCalls.length - 1 };
      },
    };
    const projector = makeProjector();
    const spec = createReviewFeedbackTaskSpec({
      id: 'legacy-comment-identity-reregister',
      taskStore,
      reviewFeedbackRouter: makeRouter(),
      fetchComments: async () => [
        {
          id: 201,
          author: 'inline-author',
          body: 'already projected before unregister',
          createdAt: '2026-01-01T00:00:00Z',
          commentType: 'inline',
          authorAssociation: 'NONE',
        },
      ],
      fetchReviews: async () => [],
      eventLog,
      projector,
      log,
    });

    const gate = await runGate(spec);

    assert.equal(gate.run, true);
    assert.deepEqual(appendCalls, [], 're-registration replay must reuse the permanent legacy event identity');
    assert.deepEqual(projector.applyCalls, [], 're-registration replay must not project legacy activity again');
  });

  it('calls projector.apply when event is newly appended (appended=true)', async () => {
    assert.ok(createReviewFeedbackTaskSpec);
    const taskStore = makeTaskStore(makePrTask());
    const eventLog = makeEventLog({ appended: true });
    const projector = makeProjector();

    const reviews = [
      {
        id: 301,
        author: 'contributor',
        state: 'COMMENTED',
        body: 'Looks good',
        submittedAt: '2026-01-01T00:00:00Z',
        authorAssociation: 'CONTRIBUTOR',
      },
    ];

    const spec = createReviewFeedbackTaskSpec({
      id: 'projector-apply',
      taskStore,
      reviewFeedbackRouter: makeRouter(),
      fetchComments: async () => [],
      fetchReviews: async () => reviews,
      eventLog,
      projector,
      log,
    });

    await runGate(spec);

    assert.ok(
      projector.applyCalls.some((e) => e.payload?.reviewId === 301),
      'projector.apply must be called for newly appended review',
    );
  });

  it('duplicate review (appended=false) — projector NOT called, cursor advances normally (Cloud R8 P1-2)', async () => {
    // Cloud R8 P1-2: appended=false means the event is already in the log (duplicate webhook/poll).
    // Applying it again out of temporal order corrupts projection state (e.g. restores in_progress
    // after awaiting_external). Projector must NOT be called for duplicates.
    // The review is still counted as processed and cursor advances — it was already projected in a
    // prior cycle, so advancing past it is safe.
    assert.ok(createReviewFeedbackTaskSpec);
    const taskStore = makeTaskStore(makePrTask());
    // Event already in log — appended: false (duplicate)
    const eventLog = makeEventLog({ appended: false });
    const projector = makeProjector();

    const reviews = [
      {
        id: 401,
        author: 'external',
        state: 'APPROVED',
        body: 'LGTM',
        submittedAt: '2026-01-01T00:00:00Z',
        authorAssociation: 'COLLABORATOR',
      },
    ];

    const spec = createReviewFeedbackTaskSpec({
      id: 'duplicate-review-no-projector',
      taskStore,
      reviewFeedbackRouter: makeRouter(),
      fetchComments: async () => [],
      fetchReviews: async () => reviews,
      eventLog,
      projector,
      log,
    });

    await runGate(spec);

    assert.strictEqual(
      projector.applyCalls.length,
      0,
      'projector.apply must NOT be called when appended=false — temporal ordering preserved (Cloud R8 P1-2)',
    );
  });

  it('OWNER review is appended to event log AND delivered (#1002)', async () => {
    assert.ok(createReviewFeedbackTaskSpec);
    const taskStore = makeTaskStore(makePrTask());
    const eventLog = makeEventLog({ appended: true });
    const projector = makeProjector();

    const reviews = [
      {
        id: 501,
        author: 'repo-owner',
        state: 'APPROVED',
        body: 'LGTM from owner',
        submittedAt: '2026-01-01T00:00:00Z',
        authorAssociation: 'OWNER',
      },
    ];

    const spec = createReviewFeedbackTaskSpec({
      id: 'owner-still-appended',
      taskStore,
      reviewFeedbackRouter: makeRouter(),
      fetchComments: async () => [],
      fetchReviews: async () => reviews,
      eventLog,
      projector,
      log,
    });

    const gate = await runGate(spec);

    // #1002 fix: OWNER review IS now delivered (decideDelivery removed)
    const deliveredIds = (gate.run ? (gate.workItems ?? []) : []).flatMap((wi) =>
      wi.signal.newDecisions.map((d) => d.id),
    );
    assert.ok(deliveredIds.includes(501), 'OWNER review must be delivered (#1002 fix)');

    // AND appended to event log (state machine must see it)
    const ownerAppend = eventLog.appendCalls.find((e) => e.payload?.reviewId === 501);
    assert.ok(ownerAppend, 'OWNER review must still be appended to event log');
    assert.strictEqual(ownerAppend.payload.authorAssociation, 'OWNER');
  });

  it('gracefully skips event log when eventLog is not configured', async () => {
    assert.ok(createReviewFeedbackTaskSpec);
    const taskStore = makeTaskStore(makePrTask());

    const reviews = [
      {
        id: 601,
        author: 'external',
        state: 'COMMENTED',
        body: 'Q',
        submittedAt: '2026-01-01T00:00:00Z',
        authorAssociation: 'NONE',
      },
    ];

    // No eventLog/projector configured
    const spec = createReviewFeedbackTaskSpec({
      id: 'no-event-log',
      taskStore,
      reviewFeedbackRouter: makeRouter(),
      fetchComments: async () => [],
      fetchReviews: async () => reviews,
      log,
    });

    // Should not throw — existing behavior preserved
    const gate = await runGate(spec);
    assert.ok(gate.run !== undefined, 'gate must return a result');
  });
});

// ---------------------------------------------------------------------------
// Tests: safe cursor tracking when projection fails (R4-P1-B)
// ---------------------------------------------------------------------------

describe('ReviewFeedbackTaskSpec: safe cursor on projection failure (R4-P1-B)', () => {
  it('cursor does NOT advance past a review that failed projection — retried next poll', async () => {
    assert.ok(createReviewFeedbackTaskSpec);

    const patchCalls = [];
    const taskStore = {
      async listByKind(kind) {
        const task = makePrTask();
        return kind === 'pr_tracking' ? [task] : [];
      },
      async update() {},
      async patchAutomationState(id, patch) {
        patchCalls.push({ id, patch });
      },
    };

    // eventLog always throws — simulates transient Redis failure
    const throwingEventLog = {
      appendCalls: [],
      async append(event) {
        throwingEventLog.appendCalls.push(event);
        throw new Error('Redis connection refused');
      },
    };

    const reviews = [
      {
        id: 700,
        author: 'contributor',
        state: 'CHANGES_REQUESTED',
        body: 'Fix pls',
        submittedAt: '2026-01-01T00:00:00Z',
        authorAssociation: 'CONTRIBUTOR',
      },
    ];

    // Single-review case: if review 700 fails projection, cursor should stay at initial (0)
    const spec = createReviewFeedbackTaskSpec({
      id: 'cursor-on-failure',
      taskStore,
      reviewFeedbackRouter: makeRouter(),
      fetchComments: async () => [],
      fetchReviews: async () => reviews,
      eventLog: throwingEventLog,
      projector: makeProjector(),
      log,
    });

    const gate = await runGate(spec);

    // Even though review 700 is external/deliverable, gate must reflect the failed projection.
    // The workItem's commitCursor must use cursor=0 (initial), not cursor=700.
    // We verify by calling commitCursor and checking the patchAutomationState call.
    if (gate.run && gate.workItems?.length > 0) {
      await gate.workItems[0].signal.commitCursor();
      const lastPatch = patchCalls[patchCalls.length - 1];
      // lastDecisionCursor must be 0 (initial), NOT 700 (the failed review id)
      assert.strictEqual(
        lastPatch?.patch?.review?.lastDecisionCursor,
        0,
        'cursor must not advance past the review that failed projection (should be initial value 0)',
      );
    } else {
      // If gate didn't run (all skipped via allSkipped path), check the persistFirst cursor
      const skippedPatch = patchCalls.find((p) => p.patch?.review?.lastDecisionCursor !== undefined);
      if (skippedPatch) {
        assert.strictEqual(
          skippedPatch.patch.review.lastDecisionCursor,
          0,
          'allSkipped cursor must not advance past failed-projection review',
        );
      }
      // If gate.run is false with no workItems and no patchCalls, that's also acceptable
      // (implies hadNewItems=false, which can't happen since we provided reviews)
    }
  });

  it('cursor advances normally when no projection failures occur', async () => {
    assert.ok(createReviewFeedbackTaskSpec);
    const patchCalls = [];
    const taskStore = {
      async listByKind(kind) {
        return kind === 'pr_tracking' ? [makePrTask()] : [];
      },
      async update() {},
      async patchAutomationState(id, patch) {
        patchCalls.push({ id, patch });
      },
    };
    const eventLog = makeEventLog({ appended: true });
    const projector = makeProjector();

    const reviews = [
      {
        id: 800,
        author: 'external',
        state: 'COMMENTED',
        body: 'ok',
        submittedAt: '2026-01-01T00:00:00Z',
        authorAssociation: 'NONE',
      },
    ];

    const spec = createReviewFeedbackTaskSpec({
      id: 'cursor-normal-success',
      taskStore,
      reviewFeedbackRouter: makeRouter(),
      fetchComments: async () => [],
      fetchReviews: async () => reviews,
      eventLog,
      projector,
      log,
    });

    const gate = await runGate(spec);
    assert.ok(gate.run, 'gate should run — external review is deliverable');

    await gate.workItems[0].signal.commitCursor();
    const lastPatch = patchCalls[patchCalls.length - 1];
    assert.strictEqual(
      lastPatch?.patch?.review?.lastDecisionCursor,
      800,
      'cursor must advance to review id=800 when projection succeeds',
    );
  });

  it('first failed review stops loop — subsequent reviews not attempted', async () => {
    assert.ok(createReviewFeedbackTaskSpec);

    let appendCallCount = 0;
    const throwOnFirstEventLog = {
      async append() {
        appendCallCount++;
        throw new Error('fail');
      },
    };

    const reviews = [
      {
        id: 900,
        author: 'ext',
        state: 'COMMENTED',
        body: '',
        submittedAt: '2026-01-01T00:00:00Z',
        authorAssociation: 'NONE',
      },
      {
        id: 901,
        author: 'ext2',
        state: 'APPROVED',
        body: '',
        submittedAt: '2026-01-01T01:00:00Z',
        authorAssociation: 'NONE',
      },
    ];

    const spec = createReviewFeedbackTaskSpec({
      id: 'break-on-first-fail',
      taskStore: makeTaskStore(makePrTask()),
      reviewFeedbackRouter: makeRouter(),
      fetchComments: async () => [],
      fetchReviews: async () => reviews,
      eventLog: throwOnFirstEventLog,
      log,
    });

    await runGate(spec);

    // Loop should break after first failure — only 1 append attempt, not 2
    assert.strictEqual(appendCallCount, 1, 'loop must stop after first projection failure (break on first fail)');
  });

  it('duplicate review (appended=false) — projector guard skips apply, cursor advances, review delivered (Cloud R8 P1-2 revises R6-P1)', async () => {
    // Cloud R8 P1-2 revises R6-P1: the old "repair path" concept is gone.
    // When appended=false the event is already in the log with its original temporal position —
    // there is nothing to repair. Calling projector.apply again out of order would corrupt state.
    // New invariant: appended=false → projector.apply NOT called (guard at call site).
    // The event is still counted as processed → cursor advances past it → review is delivered.
    // (If the projection is truly out of sync, use rebuildAll() for log-order replay.)
    assert.ok(createReviewFeedbackTaskSpec);

    const patchCalls = [];
    const taskStore = {
      async listByKind(kind) {
        return kind === 'pr_tracking' ? [makePrTask()] : [];
      },
      async update() {},
      async patchAutomationState(id, patch) {
        patchCalls.push({ id, patch });
      },
    };

    // append returns appended:false (duplicate) — projector would throw if called (proving it isn't)
    const duplicateEventLog = {
      async append() {
        return { appended: false };
      },
    };
    const applyCalls = [];
    const observableProjector = {
      async apply(event) {
        applyCalls.push(event);
        throw new Error('projector should never be called for duplicates');
      },
    };

    const reviews = [
      {
        id: 750,
        author: 'external',
        state: 'CHANGES_REQUESTED',
        body: 'Fix',
        submittedAt: '2026-01-01T00:00:00Z',
        authorAssociation: 'NONE',
      },
    ];

    const spec = createReviewFeedbackTaskSpec({
      id: 'duplicate-review-cursor-advance',
      taskStore,
      reviewFeedbackRouter: makeRouter(),
      fetchComments: async () => [],
      fetchReviews: async () => reviews,
      eventLog: duplicateEventLog,
      projector: observableProjector,
      log,
    });

    const gate = await runGate(spec);

    // Guard: projector.apply must NOT have been called at all
    assert.strictEqual(applyCalls.length, 0, 'projector.apply must NOT be called when appended=false (Cloud R8 P1-2)');

    // Review 750 must be delivered (duplicate = already projected in prior cycle, safe to notify)
    const deliveredIds = (gate.workItems ?? []).flatMap((wi) => wi.signal.newDecisions.map((d) => d.id));
    assert.ok(deliveredIds.includes(750), 'duplicate review must still be delivered (projection already correct)');

    // Cursor must advance past review 750 after commitCursor
    if (gate.workItems?.length > 0) {
      await gate.workItems[0].signal.commitCursor();
    }
    const cursorPatch = patchCalls.find((p) => p.patch?.review?.lastDecisionCursor !== undefined);
    if (cursorPatch) {
      assert.strictEqual(
        cursorPatch.patch.review.lastDecisionCursor,
        750,
        'cursor must advance to 750 for duplicate review (no error, processed normally)',
      );
    }
  });

  it('delivery excludes reviews after the break point — no duplicate notification next poll (R5-P2)', async () => {
    // R5-P2: when review 902 succeeds but review 903 fails, this poll must only deliver
    // review 902. Review 903 must NOT be notified — it will be retried next poll.
    // Without this fix, items after the break are still in newDecisions (built from full
    // freshNewReviews), causing duplicate notifications on the next poll.
    assert.ok(createReviewFeedbackTaskSpec);

    const routerCalls = [];
    const router = {
      async route(signal) {
        routerCalls.push(signal);
        return { kind: 'notified', threadId: 'thread-1', catId: 'cat1', messageId: 'msg-1', content: 'stub' };
      },
    };

    let appendCount = 0;
    const failOnSecondEventLog = {
      async append() {
        appendCount++;
        if (appendCount >= 2) throw new Error('fail on second review');
        return { appended: true };
      },
    };

    const reviews = [
      {
        id: 902,
        author: 'external1',
        state: 'CHANGES_REQUESTED',
        body: 'Fix A',
        submittedAt: '2026-01-01T00:00:00Z',
        authorAssociation: 'NONE',
      },
      {
        id: 903,
        author: 'external2',
        state: 'APPROVED',
        body: 'LGTM',
        submittedAt: '2026-01-01T01:00:00Z',
        authorAssociation: 'NONE',
      },
    ];

    const spec = createReviewFeedbackTaskSpec({
      id: 'delivery-truncation-on-break',
      taskStore: makeTaskStore(makePrTask()),
      reviewFeedbackRouter: router,
      fetchComments: async () => [],
      fetchReviews: async () => reviews,
      eventLog: failOnSecondEventLog,
      log,
    });

    const gate = await runGate(spec);

    // Gate should run (review 902 is deliverable)
    assert.ok(gate.run, 'gate should run — review 902 succeeded');

    // Only review 902 should have been delivered; review 903 must be excluded
    const deliveredReviewIds = gate.workItems.flatMap((wi) => wi.signal.newDecisions.map((d) => d.id));
    assert.ok(deliveredReviewIds.includes(902), 'review 902 must be delivered (succeeded)');
    assert.ok(!deliveredReviewIds.includes(903), 'review 903 must NOT be delivered — it failed, will retry next poll');
  });
});

describe('ReviewFeedbackTaskSpec: stale cursor advancement (Cloud R16 P2)', () => {
  it('advances comment cursor past stale items to prevent infinite polling churn when all new items are stale', async () => {
    // Bug scenario without fix:
    //   1. PR has head SHA "new-sha". GitHub has old comments with commitId="old-sha" (stale feedback).
    //   2. These comments have id > cursor (new since last poll), so they land in allNewComments.
    //   3. freshNewComments = allNewComments.filter(not stale) = [] (all stale).
    //   4. Event-log loop processes nothing → maxSafeCommentCursor stays at 0 (== commentCursor).
    //   5. advanceCursor is called with maxCommentId = maxSafeCommentCursor = 0.
    //   6. Cursor stays at 0 on the next poll → same stale comments returned → infinite churn.
    //
    // Fix: also advance maxSafeCommentCursor past stale items — they are recognized and
    // deliberately not delivered (delivery policy filter, not a collection failure).
    assert.ok(createReviewFeedbackTaskSpec, 'module must be importable');

    const persistedCommentCursors = [];
    const tasks = new Map();
    const task = {
      id: 'pr-task-stale-r16',
      kind: 'pr_tracking',
      status: 'active',
      subjectKey: 'pr:owner/repo#500',
      threadId: 'thread-stale',
      ownerCatId: 'cat1',
      userId: 'user1',
      automationState: {
        review: {
          lastCommentCursor: 0,
          lastInlineCommentCursor: 0,
          lastConversationCommentCursor: 0,
          lastDecisionCursor: 0,
        },
      },
    };
    tasks.set(task.id, task);

    const taskStore = {
      async listByKind(kind) {
        return [...tasks.values()].filter((t) => t.kind === kind && t.status !== 'done');
      },
      async update(id, patch) {
        const t = tasks.get(id);
        if (t) tasks.set(id, { ...t, ...patch });
      },
      async patchAutomationState(id, patch) {
        const t = tasks.get(id);
        if (t) {
          const merged = { ...t.automationState };
          for (const [k, v] of Object.entries(patch)) {
            merged[k] = { ...(merged[k] ?? {}), ...v };
          }
          tasks.set(id, { ...t, automationState: merged });
          // Capture what cursor value was persisted
          if (patch.review?.lastCommentCursor !== undefined) {
            persistedCommentCursors.push(patch.review.lastCommentCursor);
          }
        }
      },
    };

    // All comments are stale: commitId does not match the PR's current headSha
    const staleComments = [
      {
        id: 100,
        author: 'reviewer',
        body: 'comment on old commit',
        createdAt: '2026-01-01T00:00:00Z',
        commitId: 'old-sha',
        commentType: 'inline',
        authorAssociation: 'NONE',
      },
      {
        id: 101,
        author: 'reviewer',
        body: 'another stale comment',
        createdAt: '2026-01-01T01:00:00Z',
        commitId: 'old-sha',
        commentType: 'inline',
        authorAssociation: 'NONE',
      },
    ];

    const spec = createReviewFeedbackTaskSpec({
      id: 'stale-cursor-r16-p2',
      taskStore,
      reviewFeedbackRouter: makeRouter(),
      fetchPrMetadata: async () => ({ headSha: 'current-sha', prState: 'open' }),
      fetchComments: async () => staleComments,
      fetchReviews: async () => [],
      eventLog: makeEventLog({ appended: true }),
      log,
    });

    const result = await runGate(spec);

    // Gate should not produce deliverable work items (all stale, nothing to notify)
    const workItemCount = result.run ? (result.workItems?.length ?? 0) : 0;
    assert.strictEqual(workItemCount, 0, 'no deliverable items — all stale comments, nothing to route');

    // BUG: without fix, persistedCommentCursors = [0] (cursor never advanced, infinite churn)
    // FIX: cursor must advance to max(stale ids) = 101
    assert.ok(persistedCommentCursors.length > 0, 'advanceCursor must be called to persist the advanced cursor');
    const maxPersisted = Math.max(...persistedCommentCursors);
    assert.strictEqual(
      maxPersisted,
      101,
      'comment cursor must advance to max stale comment id (101) to prevent infinite polling churn',
    );
  });
});

describe('ReviewFeedbackTaskSpec: stale cursor must not advance past failed fresh item (Cloud R18 P1)', () => {
  it('mixed batch: stale item with higher id does NOT advance cursor past a failed fresh item', async () => {
    // Bug scenario without fix (R18 P1):
    //   allNewComments = [id=10 (fresh, fails to append), id=11 (stale, commitId='old-sha')]
    //   Fresh loop: id=10 throws on append → break → maxSafeCommentCursor stays at 9 (commentCursor)
    //   Stale loop (without fix): id=11 is stale → maxSafeCommentCursor advances to 11
    //   → advanceCursor persists 11; next poll starts from 12; id=10 fresh item NEVER retried
    //
    // Fix: stale loop must be gated by the break boundary from the fresh loop.
    //   commentBreakBeforeId = 10 (set in fresh loop catch block)
    //   Stale loop: id=11 >= commentBreakBeforeId=10 → skip → cursor stays at 9
    //   → id=10 will be retried on next poll
    assert.ok(createReviewFeedbackTaskSpec, 'module must be importable');

    const persistedCommentCursors = [];
    const tasks = new Map();
    const task = {
      id: 'pr-task-r18-mixed',
      kind: 'pr_tracking',
      status: 'active',
      subjectKey: 'pr:owner/repo#600',
      threadId: 'thread-r18',
      ownerCatId: 'cat1',
      userId: 'user1',
      automationState: {
        review: {
          lastCommentCursor: 9,
          lastInlineCommentCursor: 9,
          lastConversationCommentCursor: 9,
          lastDecisionCursor: 0,
        },
      },
    };
    tasks.set(task.id, task);

    const taskStore = {
      async listByKind(kind) {
        return [...tasks.values()].filter((t) => t.kind === kind && t.status !== 'done');
      },
      async update(id, patch) {
        const t = tasks.get(id);
        if (t) tasks.set(id, { ...t, ...patch });
      },
      async patchAutomationState(id, patch) {
        const t = tasks.get(id);
        if (t) {
          const merged = { ...t.automationState };
          for (const [k, v] of Object.entries(patch)) {
            merged[k] = { ...(merged[k] ?? {}), ...v };
          }
          tasks.set(id, { ...t, automationState: merged });
          if (patch.review?.lastCommentCursor !== undefined) {
            persistedCommentCursors.push(patch.review.lastCommentCursor);
          }
        }
      },
    };

    // Mixed batch: id=10 is fresh (current-sha), id=11 is stale (old-sha)
    const mixedComments = [
      {
        id: 10,
        author: 'external-reviewer',
        body: 'fresh comment on current commit',
        createdAt: '2026-01-02T00:00:00Z',
        commitId: 'current-sha',
        commentType: 'inline',
        authorAssociation: 'NONE',
      },
      {
        id: 11,
        author: 'another-reviewer',
        body: 'stale comment on old commit',
        createdAt: '2026-01-02T01:00:00Z',
        commitId: 'old-sha',
        commentType: 'inline',
        authorAssociation: 'NONE',
      },
    ];

    // eventLog that throws on append for id=10 (fresh item), succeeds for anything else
    const throwingEventLog = {
      async append(event) {
        if (event.payload?.commentId === 10) {
          throw new Error('simulated append failure for id=10');
        }
        return { appended: true };
      },
    };

    const spec = createReviewFeedbackTaskSpec({
      id: 'r18-mixed-batch',
      taskStore,
      reviewFeedbackRouter: makeRouter(),
      fetchPrMetadata: async () => ({ headSha: 'current-sha', prState: 'open' }),
      fetchComments: async () => mixedComments,
      fetchReviews: async () => [],
      eventLog: throwingEventLog,
      log,
    });

    await runGate(spec);

    // R18 P1: cursor must NOT advance past the failed fresh item (id=10).
    // Without the fix, the stale loop advances to id=11 (stale, higher id than break boundary).
    // With the fix, the stale loop skips id=11 because 11 >= commentBreakBeforeId=10.
    // Cursor must stay at 9 (the pre-poll value) — do not persist anything above 9.
    const maxPersisted = persistedCommentCursors.length > 0 ? Math.max(...persistedCommentCursors) : 9;
    assert.ok(
      maxPersisted < 10,
      `cursor must NOT advance past failed fresh item id=10 (got ${maxPersisted}); id=10 must be retried next poll`,
    );
  });
});
