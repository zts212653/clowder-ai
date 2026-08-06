/**
 * F168/F280 — ReviewFeedbackTaskSpec collection policy tests
 *
 * Source collection is actor-neutral. An explicit typed wait is required before
 * a work item may reach the matcher, and only the predicate decides whether the
 * owner is awakened.
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
        baseline: { headSha: 'head-0' },
        continuation: {
          when: [{ kind: 'pr_review_decision_changed' }],
          // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract field.
          then: 'Continue the review.',
        },
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
      },
    },
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

describe('ReviewFeedbackTaskSpec: actor-neutral collection for explicit waits', () => {
  it('collects OWNER and CONTRIBUTOR review decisions without actor inference', async () => {
    assert.ok(createReviewFeedbackTaskSpec, 'module must be importable');
    const taskStore = makeTaskStore();
    taskStore.addTask(makePrTask());
    const router = makeReviewFeedbackRouter();

    const decisions = [
      // External reviewer — delivered
      {
        id: 101,
        author: 'external-reviewer',
        state: 'CHANGES_REQUESTED',
        body: 'Please fix line 42',
        submittedAt: '2026-01-01T00:00:00Z',
        authorAssociation: 'CONTRIBUTOR',
      },
      // Repo owner reviewing — now also delivered (#1002)
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

    assert.strictEqual(gate.run, true, 'explicit wait should send collected facts to the matcher');
    const decisionIds = gate.workItems.flatMap((wi) => wi.signal.newDecisions.map((d) => d.id));
    assert.ok(decisionIds.includes(101), 'CONTRIBUTOR review (id=101) must be collected');
    assert.ok(decisionIds.includes(102), 'OWNER review (id=102) must be collected');
  });

  it('collects MEMBER and external inline comments without actor inference', async () => {
    assert.ok(createReviewFeedbackTaskSpec);
    const taskStore = makeTaskStore();
    taskStore.addTask(makePrTask());
    const router = makeReviewFeedbackRouter();

    const comments = [
      // External user inline comment — delivered
      {
        id: 201,
        author: 'external-user',
        body: 'Why is this done this way?',
        createdAt: '2026-01-01T00:00:00Z',
        commentType: 'inline',
        authorAssociation: 'NONE',
      },
      // Org member inline comment — now also delivered (#1002)
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
    assert.ok(commentIds.includes(201), 'external comment (id=201) must be collected');
    assert.ok(commentIds.includes(202), 'MEMBER comment (id=202) must be collected');
  });

  it('collects facts with no authorAssociation without inventing a wake policy', async () => {
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
    assert.ok(decisionIds.includes(301), 'review with no authorAssociation must reach the typed matcher');
  });

  it('collects mixed reviewer activity for the typed matcher', async () => {
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

    assert.ok(commentIds.includes(401), 'external comment must be collected');
    assert.ok(commentIds.includes(402), 'OWNER comment must be collected');
    assert.ok(decisionIds.includes(501), 'COLLABORATOR review must be collected');
    assert.ok(decisionIds.includes(502), 'MEMBER review must be collected');
  });
});
