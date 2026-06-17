/**
 * F168 Phase B — Task 5: case.routed auto-tracking registration tests
 *
 * TDD: RED tests first.
 *
 * Core invariant: when a case.routed event is appended (appended:true),
 * the system automatically registers an issue_tracking / pr_tracking task
 * in the TaskStore. On rebuild (appended:false for duplicate), NO task is created.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

let registerRoutingTracking;
try {
  const mod = await import('../dist/domains/community/community-auto-tracking.js');
  registerRoutingTracking = mod.registerRoutingTracking;
} catch {
  // GREEN: module will be created
}

// ---------------------------------------------------------------------------
// Minimal in-memory task store stub
// ---------------------------------------------------------------------------

function makeTaskStore() {
  const tasks = new Map();
  return {
    tasks,
    async upsertBySubject(input) {
      const existing = [...tasks.values()].find((t) => t.subjectKey === input.subjectKey);
      if (existing) return existing;
      const task = {
        id: `task-${Math.random().toString(36).slice(2)}`,
        status: 'active',
        ...input,
      };
      tasks.set(task.id, task);
      return task;
    },
    async listByKind(kind) {
      return [...tasks.values()].filter((t) => t.kind === kind);
    },
  };
}

function makeCommunityEvent(kind, subjectKey, payload = {}) {
  return {
    sourceEventId: `${kind}-test-1`,
    subjectKey,
    kind,
    classification: 'state-changing',
    payload,
    at: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerRoutingTracking: case.routed → issue_tracking', () => {
  it('registers issue_tracking task when case.routed for issue subjectKey', async () => {
    assert.ok(registerRoutingTracking, 'module must be importable');
    const taskStore = makeTaskStore();
    const event = makeCommunityEvent('case.routed', 'issue:owner/repo#42', {
      ownerThreadId: 'thread-abc',
      catId: 'cat1',
      ownerRole: 'developer',
    });

    await registerRoutingTracking(event, taskStore);

    const issueTasks = await taskStore.listByKind('issue_tracking');
    assert.strictEqual(issueTasks.length, 1, 'one issue_tracking task must be created');
    const task = issueTasks[0];
    assert.strictEqual(task.subjectKey, 'issue:owner/repo#42');
    assert.strictEqual(task.threadId, 'thread-abc');
    assert.strictEqual(task.ownerCatId, 'cat1');
  });

  it('registers pr_tracking task when case.routed for pr subjectKey', async () => {
    assert.ok(registerRoutingTracking);
    const taskStore = makeTaskStore();
    const event = makeCommunityEvent('case.routed', 'pr:owner/repo#7', {
      ownerThreadId: 'thread-def',
      catId: 'cat2',
    });

    await registerRoutingTracking(event, taskStore);

    const prTasks = await taskStore.listByKind('pr_tracking');
    assert.strictEqual(prTasks.length, 1, 'one pr_tracking task must be created');
    assert.strictEqual(prTasks[0].subjectKey, 'pr:owner/repo#7');
    assert.strictEqual(prTasks[0].threadId, 'thread-def');
  });

  it('is idempotent — second call does NOT create duplicate task', async () => {
    assert.ok(registerRoutingTracking);
    const taskStore = makeTaskStore();
    const event = makeCommunityEvent('case.routed', 'issue:owner/repo#99', {
      ownerThreadId: 'thread-xyz',
      catId: 'cat3',
    });

    await registerRoutingTracking(event, taskStore);
    await registerRoutingTracking(event, taskStore); // second call

    const issueTasks = await taskStore.listByKind('issue_tracking');
    assert.strictEqual(issueTasks.length, 1, 'must not create duplicate tasks');
  });

  it('ignores non-routed events (e.g. case.triaged)', async () => {
    assert.ok(registerRoutingTracking);
    const taskStore = makeTaskStore();
    const event = makeCommunityEvent('case.triaged', 'issue:owner/repo#10', {
      ownerThreadId: 'thread-123',
      catId: 'cat1',
    });

    await registerRoutingTracking(event, taskStore);

    const allTasks = await taskStore.listByKind('issue_tracking');
    assert.strictEqual(allTasks.length, 0, 'non-routed events must not create tracking tasks');
  });

  it('skips registration when payload lacks threadId or catId', async () => {
    assert.ok(registerRoutingTracking);
    const taskStore = makeTaskStore();
    // No ownerThreadId, no catId
    const event = makeCommunityEvent('case.routed', 'issue:owner/repo#55', {});

    await registerRoutingTracking(event, taskStore);

    const issueTasks = await taskStore.listByKind('issue_tracking');
    assert.strictEqual(issueTasks.length, 0, 'must not create task without threadId or catId');
  });
});

describe('registerRoutingTracking: cursor seeding (Cloud R2 P2)', () => {
  it('seeds lastCommentCursor from fetchCommentCursor to avoid replaying historical comments', async () => {
    // Without cursor seeding: cursor = 0 on first poll → fetches ALL historical comments.
    // With cursor seeding: cursor = value returned by fetchCommentCursor (current high-water mark).
    assert.ok(registerRoutingTracking);
    const taskStore = makeTaskStore();
    const event = makeCommunityEvent('case.routed', 'issue:owner/repo#88', {
      ownerThreadId: 'thread-seeded',
      catId: 'cat-seeded',
    });

    // fetchCommentCursor stub: returns current latest comment ID (42)
    const fetchCommentCursor = async () => 42;

    await registerRoutingTracking(event, taskStore, { fetchCommentCursor });

    const issueTasks = await taskStore.listByKind('issue_tracking');
    assert.strictEqual(issueTasks.length, 1, 'task must be created');
    const task = issueTasks[0];
    assert.ok(task.automationState?.issue, 'automationState.issue must be present');
    assert.strictEqual(
      task.automationState.issue.lastCommentCursor,
      42,
      'lastCommentCursor must be seeded to current latest comment ID (42)',
    );
  });

  it('seeds lastDeliveredCursor to same value as lastCommentCursor to prevent losing undelivered comments on transient routing failure (Cloud R14 P1)', async () => {
    // Bug scenario without fix:
    //   1. Task auto-registered with lastCommentCursor=42, lastDeliveredCursor=undefined.
    //   2. New comment id=43 arrives. Collection succeeds → lastCommentCursor advances to 43.
    //      Routing returns non-notified → lastDeliveredCursor never advances (stays undefined).
    //   3. Next poll: persistedDeliveryCursor = lastDeliveredCursor ?? collectionCursor = 43.
    //      fetchSince = min(43, 43) = 43; allPending = comments.filter(c.id > 43) → empty.
    //      Comment 43 silently dropped and never delivered again.
    //
    // Fix: seed lastDeliveredCursor = lastCommentCursor = initialCommentCursor at registration.
    //   On the next poll after a routing failure:
    //     persistedDeliveryCursor = lastDeliveredCursor = 42 (defined, fallback not triggered)
    //     fetchSince = min(43, 42) = 42; comment 43 re-fetched and retried. ✓
    assert.ok(registerRoutingTracking);
    const taskStore = makeTaskStore();
    const event = makeCommunityEvent('case.routed', 'issue:owner/repo#882', {
      ownerThreadId: 'thread-seeded-delivery',
      catId: 'cat-seeded-delivery',
    });

    const fetchCommentCursor = async () => 42;
    await registerRoutingTracking(event, taskStore, { fetchCommentCursor });

    const issueTasks = await taskStore.listByKind('issue_tracking');
    assert.strictEqual(issueTasks.length, 1, 'task must be created');
    const task = issueTasks[0];
    assert.ok(task.automationState?.issue, 'automationState.issue must be present');
    assert.strictEqual(
      task.automationState.issue.lastDeliveredCursor,
      42,
      'lastDeliveredCursor must be seeded to same value as lastCommentCursor (42) — prevents "undelivered on transient failure" silent drop',
    );
  });

  it('still creates task when fetchCommentCursor is not provided (no cursor seed, backward compat)', async () => {
    assert.ok(registerRoutingTracking);
    const taskStore = makeTaskStore();
    const event = makeCommunityEvent('case.routed', 'issue:owner/repo#89', {
      ownerThreadId: 'thread-noopt',
      catId: 'cat-noopt',
    });

    // No opts provided — backward-compatible
    await registerRoutingTracking(event, taskStore);

    const issueTasks = await taskStore.listByKind('issue_tracking');
    assert.strictEqual(issueTasks.length, 1, 'task must be created even without cursor seeding');
    const task = issueTasks[0];
    // No cursor seeded — automationState may be undefined or have no issue cursor
    const cursor = task.automationState?.issue?.lastCommentCursor;
    assert.ok(cursor === undefined || cursor === 0, 'cursor must be 0 or undefined when not seeded');
  });
});

describe('registerRoutingTracking: rebuild safety', () => {
  it('appended:false path (rebuild) should NOT call registerRoutingTracking', async () => {
    // This test verifies the CALLER pattern, not the function itself:
    // The function is only called when appended:true. Rebuild replays events
    // with the same sourceEventId → dedup → appended:false → function NOT called.
    // We model this by calling the function conditionally on appended:true.
    assert.ok(registerRoutingTracking);

    const taskStore = makeTaskStore();
    const event = makeCommunityEvent('case.routed', 'issue:owner/repo#77', {
      ownerThreadId: 'thread-rebuild',
      catId: 'cat-rebuild',
    });

    // Simulate: first ingest → appended:true → register
    const firstAppended = true;
    if (firstAppended) await registerRoutingTracking(event, taskStore);

    // Simulate: rebuild → appended:false → do NOT register
    const rebuildAppended = false;
    if (rebuildAppended) await registerRoutingTracking(event, taskStore);

    const tasks = await taskStore.listByKind('issue_tracking');
    assert.strictEqual(tasks.length, 1, 'rebuild must not create extra tasks');
  });
});
