/**
 * F168 Phase B — R2-P1-A: ReviewFeedbackTaskSpec delivery policy tests
 *
 * Verifies that decideDelivery() is called in ReviewFeedbackTaskSpec for both
 * PR review decisions and inline/conversation comments — OWNER/MEMBER activity
 * must be silent-logged (not routed to owner thread).
 *
 * R2 finding: ReviewFeedbackTaskSpec routes ALL reviews/comments to workItems
 * unconditionally; OWNER/MEMBER maintainer activity still wakes the owner,
 * violating F168 Phase B's awaiting_external suppression spec.
 *
 * RED tests written first; GREEN after implementation.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

let createReviewFeedbackTaskSpec;
try {
  const mod = await import('../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
  createReviewFeedbackTaskSpec = mod.createReviewFeedbackTaskSpec;
} catch {
  // GREEN phase: file will be updated
}

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeTaskStore() {
  const tasks = new Map();
  const patches = [];
  return {
    tasks,
    patches,
    async listByKind(kind) {
      return [...tasks.values()].filter((t) => t.kind === kind && t.status !== 'done');
    },
    async update(id, patch) {
      const t = tasks.get(id);
      if (t) tasks.set(id, { ...t, ...patch });
    },
    async patchAutomationState(id, patch) {
      patches.push({ id, patch });
      const t = tasks.get(id);
      if (t) {
        const merged = { ...t.automationState };
        for (const [k, v] of Object.entries(patch)) {
          merged[k] = { ...(merged[k] ?? {}), ...v };
        }
        tasks.set(id, { ...t, automationState: merged });
      }
    },
    addTask(task) {
      tasks.set(task.id, task);
    },
  };
}

function makeReviewFeedbackRouter() {
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

function makePrTask(overrides = {}) {
  return {
    id: 'pr-task-1',
    kind: 'pr_tracking',
    status: 'active',
    subjectKey: 'pr:owner/repo#10',
    threadId: 'thread-1',
    ownerCatId: 'cat1',
    userId: 'user1',
    automationState: {},
    ...overrides,
  };
}

const makeLogger = () => ({ info: () => {}, error: () => {}, warn: () => {} });

async function runGate(spec) {
  return spec.admission.gate();
}

// ---------------------------------------------------------------------------
// Tests: delivery policy in ReviewFeedbackTaskSpec
// ---------------------------------------------------------------------------

describe('ReviewFeedbackTaskSpec: delivery policy — R2-P1-A', () => {
  it('OWNER review decision is filtered (silent-logged) and NOT routed', async () => {
    assert.ok(createReviewFeedbackTaskSpec, 'module must be importable');
    const taskStore = makeTaskStore();
    taskStore.addTask(makePrTask());
    const router = makeReviewFeedbackRouter();

    const decisions = [
      // External reviewer — should be delivered
      {
        id: 101,
        author: 'external-reviewer',
        state: 'CHANGES_REQUESTED',
        body: 'Please fix line 42',
        submittedAt: '2026-01-01T00:00:00Z',
        authorAssociation: 'CONTRIBUTOR',
      },
      // Repo owner reviewing own PR — should be silent-logged
      {
        id: 102,
        author: 'repo-owner',
        state: 'APPROVED',
        body: 'LGTM',
        submittedAt: '2026-01-01T01:00:00Z',
        authorAssociation: 'OWNER',
      },
    ];

    const spec = createReviewFeedbackTaskSpec({
      id: 'review-delivery-policy',
      taskStore,
      reviewFeedbackRouter: router,
      fetchComments: async () => [],
      fetchReviews: async () => decisions,
      log: makeLogger(),
    });

    const gate = await runGate(spec);

    assert.strictEqual(gate.run, true, 'gate should run — CONTRIBUTOR review is deliverable');
    const decisionIds = gate.workItems.flatMap((wi) => wi.signal.newDecisions.map((d) => d.id));
    assert.ok(decisionIds.includes(101), 'CONTRIBUTOR review (id=101) must be in work items');
    assert.ok(!decisionIds.includes(102), 'OWNER review (id=102) must be silent-logged, not delivered');
  });

  it('MEMBER inline comment is filtered (silent-logged) and NOT routed', async () => {
    assert.ok(createReviewFeedbackTaskSpec);
    const taskStore = makeTaskStore();
    taskStore.addTask(makePrTask());
    const router = makeReviewFeedbackRouter();

    const comments = [
      // External user inline comment — should be delivered
      {
        id: 201,
        author: 'external-user',
        body: 'Why is this done this way?',
        createdAt: '2026-01-01T00:00:00Z',
        commentType: 'inline',
        authorAssociation: 'NONE',
      },
      // Org member inline comment — should be silent-logged
      {
        id: 202,
        author: 'org-member',
        body: 'Internal note: see doc',
        createdAt: '2026-01-01T01:00:00Z',
        commentType: 'inline',
        authorAssociation: 'MEMBER',
      },
    ];

    const spec = createReviewFeedbackTaskSpec({
      id: 'member-comment-policy',
      taskStore,
      reviewFeedbackRouter: router,
      fetchComments: async () => comments,
      fetchReviews: async () => [],
      log: makeLogger(),
    });

    const gate = await runGate(spec);

    const commentIds = gate.workItems.flatMap((wi) => wi.signal.newComments.map((c) => c.id));
    assert.ok(commentIds.includes(201), 'external comment (id=201) must be delivered');
    assert.ok(!commentIds.includes(202), 'MEMBER comment (id=202) must be silent-logged');
  });

  it('undefined authorAssociation defaults to wake-owner (conservative)', async () => {
    assert.ok(createReviewFeedbackTaskSpec);
    const taskStore = makeTaskStore();
    taskStore.addTask(makePrTask());

    const decisions = [
      // Review without authorAssociation (legacy data / fetch fallback)
      { id: 301, author: 'someone', state: 'COMMENTED', body: 'Looks good', submittedAt: '2026-01-01T00:00:00Z' },
    ];

    const spec = createReviewFeedbackTaskSpec({
      id: 'undefined-assoc-policy',
      taskStore,
      reviewFeedbackRouter: makeReviewFeedbackRouter(),
      fetchComments: async () => [],
      fetchReviews: async () => decisions,
      log: makeLogger(),
    });

    const gate = await runGate(spec);

    const decisionIds = gate.workItems.flatMap((wi) => wi.signal.newDecisions.map((d) => d.id));
    assert.ok(decisionIds.includes(301), 'review with no authorAssociation must default to wake-owner');
  });

  it('mixed scenario: only external activity reaches router', async () => {
    assert.ok(createReviewFeedbackTaskSpec);
    const taskStore = makeTaskStore();
    taskStore.addTask(makePrTask());

    const comments = [
      {
        id: 401,
        author: 'external',
        body: 'Question',
        createdAt: '2026-01-01T00:00:00Z',
        commentType: 'conversation',
        authorAssociation: 'NONE',
      },
      {
        id: 402,
        author: 'admin',
        body: 'Internal',
        createdAt: '2026-01-01T01:00:00Z',
        commentType: 'conversation',
        authorAssociation: 'OWNER',
      },
    ];
    const decisions = [
      {
        id: 501,
        author: 'external-r',
        state: 'CHANGES_REQUESTED',
        body: 'Fix this',
        submittedAt: '2026-01-01T00:00:00Z',
        authorAssociation: 'COLLABORATOR',
      },
      {
        id: 502,
        author: 'member-r',
        state: 'APPROVED',
        body: 'LGTM',
        submittedAt: '2026-01-01T01:00:00Z',
        authorAssociation: 'MEMBER',
      },
    ];

    const spec = createReviewFeedbackTaskSpec({
      id: 'mixed-scenario',
      taskStore,
      reviewFeedbackRouter: makeReviewFeedbackRouter(),
      fetchComments: async () => comments,
      fetchReviews: async () => decisions,
      log: makeLogger(),
    });

    const gate = await runGate(spec);
    assert.strictEqual(gate.run, true);

    const commentIds = gate.workItems.flatMap((wi) => wi.signal.newComments.map((c) => c.id));
    const decisionIds = gate.workItems.flatMap((wi) => wi.signal.newDecisions.map((d) => d.id));

    assert.ok(commentIds.includes(401), 'external comment must be delivered');
    assert.ok(!commentIds.includes(402), 'OWNER comment must be silent-logged');
    assert.ok(decisionIds.includes(501), 'COLLABORATOR review must be delivered');
    assert.ok(!decisionIds.includes(502), 'MEMBER review must be silent-logged');
  });
});
