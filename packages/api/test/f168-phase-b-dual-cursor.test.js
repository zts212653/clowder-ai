/**
 * F168 Phase B — Task 4: IssueCommentTaskSpec dual-cursor TDD tests
 *
 * Tests the semantic separation of:
 *   - Collection cursor (lastCommentCursor): advances on successful event-log append
 *   - Delivery cursor (lastDeliveredCursor): advances only on successful owner notification
 *
 * With no eventLog injected: existing single-cursor behavior is unchanged.
 * With eventLog injected: collection and delivery cursors are independent.
 *
 * RED tests written first; GREEN after implementation.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

let createIssueCommentTaskSpec;
try {
  const mod = await import('../dist/infrastructure/email/IssueCommentTaskSpec.js');
  createIssueCommentTaskSpec = mod.createIssueCommentTaskSpec;
} catch {
  // GREEN phase: file will be updated
}

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeTaskStore({ persisted = {} } = {}) {
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

function makeIssueCommentRouter({ failRoute = false } = {}) {
  const calls = [];
  return {
    calls,
    async route(signal, tracking) {
      calls.push({ signal, tracking });
      if (failRoute) return { kind: 'skipped', reason: 'route failed (stub)' };
      return {
        kind: 'notified',
        threadId: tracking.threadId,
        catId: tracking.catId,
        messageId: 'msg-1',
        content: 'stub notification',
      };
    },
  };
}

function makeEventLog() {
  const events = [];
  const appendCalls = [];
  return {
    events,
    appendCalls,
    async append(event) {
      const duplicate = appendCalls.some((c) => c.sourceEventId === event.sourceEventId);
      appendCalls.push({ sourceEventId: event.sourceEventId, event });
      if (duplicate) return { appended: false };
      events.push(event);
      return { appended: true, sequence: events.length - 1 };
    },
    async read(subjectKey) {
      return events.filter((e) => e.subjectKey === subjectKey);
    },
    async listSubjects() {
      return [...new Set(events.map((e) => e.subjectKey))];
    },
  };
}

function makeBaseSpec(overrides = {}) {
  const taskStore = overrides.taskStore ?? makeTaskStore();
  const router = overrides.router ?? makeIssueCommentRouter();
  const comments = overrides.comments ?? [];
  const spec = createIssueCommentTaskSpec({
    taskStore,
    issueCommentRouter: router,
    fetchComments: async () => comments,
    fetchIssueState: async () => 'open',
    log: { info: () => {}, error: () => {}, warn: () => {} },
    ...overrides.extra,
  });
  return { spec, taskStore, router };
}

function makeTask(overrides = {}) {
  return {
    id: 'task-1',
    kind: 'issue_tracking',
    status: 'active',
    subjectKey: 'issue:owner/repo#42',
    threadId: 'thread-1',
    ownerCatId: 'cat1',
    userId: 'user1',
    automationState: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function runGate(spec) {
  return spec.admission.gate();
}

async function runExecute(spec, gateResult) {
  if (gateResult.run === false) return;
  for (const { signal, subjectKey } of gateResult.workItems) {
    await spec.run.execute(signal, subjectKey, {});
  }
}

// ---------------------------------------------------------------------------
// Tests: backward-compat — no eventLog injected
// ---------------------------------------------------------------------------

describe('IssueCommentTaskSpec: no eventLog — backward compat', () => {
  it('without eventLog: gate skips when no new comments', async () => {
    assert.ok(createIssueCommentTaskSpec, 'module must be importable');
    const taskStore = makeTaskStore();
    taskStore.addTask(makeTask());
    const { spec } = makeBaseSpec({ taskStore, comments: [] });
    const result = await runGate(spec);
    assert.strictEqual(result.run, false);
  });

  it('without eventLog: route notified → commitCursor advances lastCommentCursor', async () => {
    assert.ok(createIssueCommentTaskSpec);
    const taskStore = makeTaskStore();
    taskStore.addTask(makeTask());
    const router = makeIssueCommentRouter({ failRoute: false });
    const comments = [{ id: 100, author: 'bob', body: 'hello', createdAt: '2026-01-01T00:00:00Z' }];
    const { spec } = makeBaseSpec({ taskStore, router, comments });

    const gate = await runGate(spec);
    assert.strictEqual(gate.run, true);
    assert.strictEqual(gate.workItems.length, 1);

    await runExecute(spec, gate);

    const cursorPatch = taskStore.patches.find((p) => p.patch.issue?.lastCommentCursor !== undefined);
    assert.ok(cursorPatch, 'lastCommentCursor should be persisted');
    assert.strictEqual(cursorPatch.patch.issue.lastCommentCursor, 100);
  });
});

// ---------------------------------------------------------------------------
// Tests: WITH eventLog injected — dual-cursor semantic
// ---------------------------------------------------------------------------

describe('IssueCommentTaskSpec: with eventLog — dual-cursor', () => {
  it('event log append: sourceEventId is comment:{repo}#{issueNumber}:{commentId}', async () => {
    assert.ok(createIssueCommentTaskSpec);
    const taskStore = makeTaskStore();
    taskStore.addTask(makeTask());
    const eventLog = makeEventLog();
    const comments = [{ id: 201, author: 'alice', body: 'hi', createdAt: '2026-01-01T00:00:00Z' }];
    const { spec } = makeBaseSpec({
      taskStore,
      comments,
      extra: { eventLog },
    });

    const gate = await runGate(spec);
    assert.strictEqual(gate.run, true);

    const appendCall = eventLog.appendCalls.find((c) => c.sourceEventId.includes('201'));
    assert.ok(appendCall, 'should have appended event for comment 201');
    assert.match(appendCall.sourceEventId, /^comment:owner\/repo#42:201$/);
  });

  it('event log append: event kind is issue.commented, classification is informational', async () => {
    assert.ok(createIssueCommentTaskSpec);
    const taskStore = makeTaskStore();
    taskStore.addTask(makeTask());
    const eventLog = makeEventLog();
    const comments = [{ id: 202, author: 'alice', body: 'hi', createdAt: '2026-01-01T00:00:00Z' }];
    const { spec } = makeBaseSpec({ taskStore, comments, extra: { eventLog } });

    await runGate(spec);

    const event = eventLog.events.find((e) => e.payload?.commentId === 202);
    assert.ok(event, 'event should be in log');
    assert.strictEqual(event.kind, 'issue.commented');
    assert.strictEqual(event.classification, 'informational');
    assert.strictEqual(event.subjectKey, 'issue:owner/repo#42');
  });

  it('collection cursor advances on append SUCCESS — independent of route outcome', async () => {
    assert.ok(createIssueCommentTaskSpec);
    const taskStore = makeTaskStore();
    taskStore.addTask(makeTask());
    const router = makeIssueCommentRouter({ failRoute: true }); // route FAILS
    const eventLog = makeEventLog();
    const comments = [{ id: 300, author: 'alice', body: 'hi', createdAt: '2026-01-01T00:00:00Z' }];
    const { spec } = makeBaseSpec({ taskStore, router, comments, extra: { eventLog } });

    const gate = await runGate(spec);
    assert.strictEqual(gate.run, true);

    // Collection cursor should advance BEFORE route is called (happens in gate)
    const collectionPatch = taskStore.patches.find((p) => p.patch.issue?.lastCommentCursor !== undefined);
    assert.ok(collectionPatch, 'lastCommentCursor must advance even when route will fail');
    assert.strictEqual(collectionPatch.patch.issue.lastCommentCursor, 300);

    // Execute (route fails)
    await runExecute(spec, gate);

    // Delivery cursor must NOT advance to the comment's position (300) when route fails.
    // Note: Cloud R17 P1 defensive seed may produce a patch with lastDeliveredCursor=0
    // (collectionCursor before any comments), which is correct — it closes the crash window
    // without counting as "advancing past the undelivered comment".
    const deliveryPatch300 = taskStore.patches.find((p) => p.patch.issue?.lastDeliveredCursor === 300);
    assert.strictEqual(
      deliveryPatch300,
      undefined,
      'lastDeliveredCursor must NOT advance to comment 300 when route fails',
    );
  });

  it('route success: both collection AND delivery cursors advance', async () => {
    assert.ok(createIssueCommentTaskSpec);
    const taskStore = makeTaskStore();
    taskStore.addTask(makeTask());
    const router = makeIssueCommentRouter({ failRoute: false });
    const eventLog = makeEventLog();
    const comments = [{ id: 400, author: 'alice', body: 'hi', createdAt: '2026-01-01T00:00:00Z' }];
    const { spec } = makeBaseSpec({ taskStore, router, comments, extra: { eventLog } });

    const gate = await runGate(spec);
    await runExecute(spec, gate);

    const collectionPatch = taskStore.patches.find((p) => p.patch.issue?.lastCommentCursor !== undefined);
    assert.ok(collectionPatch, 'lastCommentCursor must advance');
    assert.strictEqual(collectionPatch.patch.issue.lastCommentCursor, 400);

    // Find the commit patch (value=400), not the one-time seed patch (value=0 for unseeded task).
    const deliveryPatch = taskStore.patches.find((p) => p.patch.issue?.lastDeliveredCursor === 400);
    assert.ok(deliveryPatch, 'lastDeliveredCursor must advance to 400 on route success');
  });

  it('retry: second gate cycle retries delivery, does NOT re-append to event log', async () => {
    assert.ok(createIssueCommentTaskSpec);
    const taskStore = makeTaskStore();
    // Task has collection cursor=500 (collected), delivery cursor=0 (not delivered)
    taskStore.addTask(
      makeTask({
        automationState: {
          issue: { lastCommentCursor: 500, lastDeliveredCursor: 0 },
        },
      }),
    );
    const router = makeIssueCommentRouter({ failRoute: false }); // now succeeds
    const eventLog = makeEventLog();
    // No new comments (id > 500); comment 500 is "undelivered" (deliveryCursor=0)
    // Simulate fetching the undelivered comment again
    const comments = [{ id: 500, author: 'alice', body: 'hi', createdAt: '2026-01-01T00:00:00Z' }];
    const { spec } = makeBaseSpec({ taskStore, router, comments, extra: { eventLog } });

    const gate = await runGate(spec);
    assert.strictEqual(gate.run, true, 'gate must run: pending delivery exists');

    await runExecute(spec, gate);

    // Event log append was called but returned appended:false (already in log conceptually)
    const appendCall = eventLog.appendCalls.find((c) => c.sourceEventId.includes('500'));
    assert.ok(appendCall, 'idempotent append must be attempted');
    // Since the eventLog stub returns appended:false for duplicates,
    // the collection cursor should NOT advance again (already at 500)
    const newCollectionPatches = taskStore.patches.filter((p) => p.patch.issue?.lastCommentCursor === 500);
    // Should be 0 new collection patches (cursor already at 500, no update needed)
    assert.strictEqual(
      newCollectionPatches.length,
      0,
      'collection cursor must NOT be re-advanced on idempotent append',
    );

    // Delivery cursor should advance (retry succeeded)
    const deliveryPatch = taskStore.patches.find((p) => p.patch.issue?.lastDeliveredCursor !== undefined);
    assert.ok(deliveryPatch, 'delivery cursor must advance on successful retry');
    assert.strictEqual(deliveryPatch.patch.issue.lastDeliveredCursor, 500);
  });

  it('event in log: event subjectKey matches task.subjectKey', async () => {
    assert.ok(createIssueCommentTaskSpec);
    const taskStore = makeTaskStore();
    taskStore.addTask(makeTask({ subjectKey: 'issue:org/myrepo#99' }));
    const eventLog = makeEventLog();
    const comments = [{ id: 700, author: 'bob', body: 'test', createdAt: '2026-01-01T00:00:00Z' }];
    const { spec } = makeBaseSpec({ taskStore, comments, extra: { eventLog } });

    await runGate(spec);

    const event = eventLog.events[0];
    assert.ok(event, 'event must be in log');
    assert.strictEqual(event.subjectKey, 'issue:org/myrepo#99');
    assert.match(event.sourceEventId, /^comment:org\/myrepo#99:700$/);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // P1-A: Delivery policy — OWNER/MEMBER comments must NOT be routed
  // (R1 finding: decideDelivery() never called in production path)
  // ─────────────────────────────────────────────────────────────────────────

  it('delivery policy: OWNER comment is silent-logged and NOT routed', async () => {
    assert.ok(createIssueCommentTaskSpec);
    const taskStore = makeTaskStore();
    taskStore.addTask(makeTask({ id: 'task-delivery-policy', subjectKey: 'issue:owner/repo#42' }));
    const router = makeIssueCommentRouter({ failRoute: false });
    const eventLog = makeEventLog();
    const comments = [
      // External user — should be delivered (wake-owner)
      {
        id: 51,
        author: 'external-user',
        body: 'Please help!',
        createdAt: '2026-01-01T00:00:00Z',
        authorAssociation: 'NONE',
      },
      // Repo owner — should be silent-logged (OWNER association)
      {
        id: 52,
        author: 'repo-owner',
        body: 'Looking into it.',
        createdAt: '2026-01-01T01:00:00Z',
        authorAssociation: 'OWNER',
      },
    ];
    const { spec } = makeBaseSpec({ taskStore, router, comments, extra: { eventLog } });

    const gate = await runGate(spec);

    // Both comments should still be COLLECTED (appended to event log)
    const collected = eventLog.events.map((e) => e.payload.commentId);
    assert.ok(collected.includes(51), 'external comment must be collected in event log');
    assert.ok(collected.includes(52), 'OWNER comment must also be collected (silent log)');

    // But delivery should only include the external comment
    assert.strictEqual(gate.run, true, 'gate should run — there is deliverable content');
    const workItemCommentIds = gate.workItems.flatMap((wi) => wi.signal.newComments.map((c) => c.id));
    assert.ok(workItemCommentIds.includes(51), 'external comment (id=51) must be in work items for delivery');
    assert.ok(!workItemCommentIds.includes(52), 'OWNER comment (id=52) must NOT be in work items (silent-log)');

    // After execute: router should only receive the external comment
    await runExecute(spec, gate);
    const routedCommentIds = router.calls.flatMap((call) => call.signal.newComments.map((c) => c.id));
    assert.ok(routedCommentIds.includes(51), 'router must receive external comment');
    assert.ok(!routedCommentIds.includes(52), 'router must NOT receive OWNER comment');
  });

  it('delivery policy: MEMBER comment is silent-logged and NOT routed', async () => {
    assert.ok(createIssueCommentTaskSpec);
    const taskStore = makeTaskStore();
    taskStore.addTask(makeTask({ id: 'task-member-policy', subjectKey: 'issue:owner/repo#42' }));
    const router = makeIssueCommentRouter({ failRoute: false });
    const eventLog = makeEventLog();
    const comments = [
      {
        id: 61,
        author: 'org-member',
        body: 'I can reproduce',
        createdAt: '2026-01-01T00:00:00Z',
        authorAssociation: 'MEMBER',
      },
      {
        id: 62,
        author: 'community',
        body: 'Me too!',
        createdAt: '2026-01-01T01:00:00Z',
        authorAssociation: 'CONTRIBUTOR',
      },
    ];
    const { spec } = makeBaseSpec({ taskStore, router, comments, extra: { eventLog } });

    const gate = await runGate(spec);

    const workItemCommentIds = gate.workItems.flatMap((wi) => wi.signal.newComments.map((c) => c.id));
    assert.ok(!workItemCommentIds.includes(61), 'MEMBER comment (id=61) must be silent-logged');
    assert.ok(workItemCommentIds.includes(62), 'CONTRIBUTOR comment (id=62) must be delivered');
  });

  it('delivery policy: undefined authorAssociation defaults to wake-owner (conservative)', async () => {
    assert.ok(createIssueCommentTaskSpec);
    const taskStore = makeTaskStore();
    taskStore.addTask(makeTask({ id: 'task-undefined-assoc', subjectKey: 'issue:owner/repo#42' }));
    const router = makeIssueCommentRouter({ failRoute: false });
    const eventLog = makeEventLog();
    // Comments without authorAssociation (legacy IssueComment objects, polling path fallback)
    const comments = [
      { id: 71, author: 'somebody', body: 'hello', createdAt: '2026-01-01T00:00:00Z' }, // no authorAssociation field
    ];
    const { spec } = makeBaseSpec({ taskStore, router, comments, extra: { eventLog } });

    const gate = await runGate(spec);

    // undefined → wake-owner (conservative default, no accidental silencing)
    const workItemCommentIds = gate.workItems.flatMap((wi) => wi.signal.newComments.map((c) => c.id));
    assert.ok(workItemCommentIds.includes(71), 'comment with no authorAssociation must default to wake-owner');
  });

  it('delivery policy: collection still includes ALL comments even when some are silent-logged', async () => {
    // Event log (collection) should record OWNER/MEMBER activity — just not wake the owner.
    // Silent-log ≠ discard.
    assert.ok(createIssueCommentTaskSpec);
    const taskStore = makeTaskStore();
    taskStore.addTask(makeTask({ id: 'task-collect-all', subjectKey: 'issue:owner/repo#42' }));
    const eventLog = makeEventLog();
    const comments = [
      {
        id: 81,
        author: 'repo-owner',
        body: 'internal note',
        createdAt: '2026-01-01T00:00:00Z',
        authorAssociation: 'OWNER',
      },
    ];
    const { spec } = makeBaseSpec({ taskStore, comments, extra: { eventLog } });

    await runGate(spec);

    // Comment must be in event log even though it's silent-logged for delivery
    const inLog = eventLog.events.some((e) => e.payload.commentId === 81);
    assert.ok(inLog, 'OWNER comment must still be appended to event log (silent-log ≠ discard)');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cloud P1: event log payload must include authorAssociation for state
  // machine replay (awaiting_external → in_progress vs stay silent)
  // ─────────────────────────────────────────────────────────────────────────

  it('event log payload includes authorAssociation so projector can identify maintainer vs external (Cloud P1)', async () => {
    assert.ok(createIssueCommentTaskSpec);
    const taskStore = makeTaskStore();
    taskStore.addTask(makeTask({ id: 'task-payload-assoc', subjectKey: 'issue:owner/repo#42' }));
    const eventLog = makeEventLog();
    const comments = [
      {
        id: 901,
        author: 'repo-owner',
        body: 'Looking into this.',
        createdAt: '2026-01-01T00:00:00Z',
        authorAssociation: 'OWNER',
      },
      {
        id: 902,
        author: 'external-user',
        body: 'Please help!',
        createdAt: '2026-01-01T01:00:00Z',
        authorAssociation: 'NONE',
      },
    ];
    const { spec } = makeBaseSpec({ taskStore, comments, extra: { eventLog } });

    await runGate(spec);

    // Event log payloads MUST include authorAssociation — state machine uses it
    // to decide awaiting_external → in_progress vs stay silent on replay/rebuild
    const ownerEvent = eventLog.events.find((e) => e.payload.commentId === 901);
    const externalEvent = eventLog.events.find((e) => e.payload.commentId === 902);

    assert.ok(ownerEvent, 'OWNER comment must be in event log');
    assert.strictEqual(
      ownerEvent.payload.authorAssociation,
      'OWNER',
      'OWNER comment payload must include authorAssociation=OWNER for state machine correctness',
    );

    assert.ok(externalEvent, 'external comment must be in event log');
    assert.strictEqual(
      externalEvent.payload.authorAssociation,
      'NONE',
      'external comment payload must include authorAssociation=NONE',
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cloud P2: delivery cursor must advance past silent/echo-only batches to
  // prevent permanent polling churn on issues with only maintainer activity
  // ─────────────────────────────────────────────────────────────────────────

  it('delivery cursor advances past all-silent comment batch to prevent polling churn (Cloud P2)', async () => {
    assert.ok(createIssueCommentTaskSpec);
    const taskStore = makeTaskStore();
    taskStore.addTask(makeTask({ id: 'task-silent-churn', subjectKey: 'issue:owner/repo#42' }));
    const router = makeIssueCommentRouter({ failRoute: false });
    const eventLog = makeEventLog();

    // Only OWNER comments — delivery policy silences all of them
    const silentComments = [
      {
        id: 1001,
        author: 'repo-owner',
        body: 'Internal note A',
        createdAt: '2026-01-01T00:00:00Z',
        authorAssociation: 'OWNER',
      },
      {
        id: 1002,
        author: 'repo-owner',
        body: 'Internal note B',
        createdAt: '2026-01-01T01:00:00Z',
        authorAssociation: 'OWNER',
      },
    ];
    const { spec } = makeBaseSpec({ taskStore, router, comments: silentComments, extra: { eventLog } });

    // First poll: gate runs (silent comments present), pendingDelivery empty
    const gate = await runGate(spec);
    // No deliverable items → workItems empty (or gate.run false)
    const workItemCommentIds = (gate.workItems ?? []).flatMap((wi) => wi.signal.newComments.map((c) => c.id));
    assert.ok(!workItemCommentIds.includes(1001), 'silent OWNER comment must NOT be delivered');
    assert.ok(!workItemCommentIds.includes(1002), 'silent OWNER comment must NOT be delivered');

    // Delivery cursor MUST advance to 1002 — even though nothing was delivered.
    // Without this, the next poll re-fetches the same OWNER comments forever.
    // Find the patch with value=1002 (not the one-time seed patch with value=0).
    const deliveryPatch = taskStore.patches.find((p) => p.patch.issue?.lastDeliveredCursor === 1002);
    assert.ok(deliveryPatch, 'delivery cursor must advance to 1002 — the max silent comment ID (Cloud P2)');

    // Verify: router was NOT called (nothing was delivered)
    assert.strictEqual(router.calls.length, 0, 'router must not be called for silent-only batches');
  });

  it('collection cursor advances for duplicate appends (appended:false) to prevent polling churn (Cloud R3 P2)', async () => {
    // Scenario: webhook already collected c1 (id=10) and c2 (id=20) — both return appended:false.
    // The polling path's collectionCursor is still 0 (webhook doesn't advance it).
    // Expected: cursor advances to 20 (both comments are already safely in event log).
    // Without fix: cursor stays at 0, next poll fetches from 0 again → unbounded churn.
    assert.ok(createIssueCommentTaskSpec);
    const taskStore = makeTaskStore();
    taskStore.addTask(makeTask());
    const router = makeIssueCommentRouter();

    // Event log that returns appended:false for all appends (already collected by webhook)
    const deduplicatingEventLog = {
      events: [],
      appendCalls: [],
      async append(event) {
        deduplicatingEventLog.appendCalls.push({ sourceEventId: event.sourceEventId, event });
        // Simulate already-present (webhook pre-collected): dedup returns appended:false
        return { appended: false };
      },
      async read(subjectKey) {
        return deduplicatingEventLog.events.filter((e) => e.subjectKey === subjectKey);
      },
      async listSubjects() {
        return [];
      },
    };

    const comments = [
      {
        id: 10,
        author: 'owner-cat',
        authorAssociation: 'OWNER',
        body: 'triage note',
        createdAt: '2026-01-01T00:00:00Z',
      },
      { id: 20, author: 'owner-cat', authorAssociation: 'OWNER', body: 'follow up', createdAt: '2026-01-01T01:00:00Z' },
    ];
    const { spec } = makeBaseSpec({ taskStore, router, comments, extra: { eventLog: deduplicatingEventLog } });

    await runGate(spec);

    // Collection cursor MUST advance to max(duplicate comment IDs) = 20
    // These comments are already in the event log (webhook-collected), so it's safe to advance.
    const collectionPatch = taskStore.patches.find((p) => p.patch.issue?.lastCommentCursor !== undefined);
    assert.ok(collectionPatch, 'collection cursor must advance for duplicate-only batches');
    assert.strictEqual(
      collectionPatch.patch.issue.lastCommentCursor,
      20,
      'cursor must advance to 20 (max duplicate ID) even though appended:false',
    );
  });

  it('collection cursor does not advance past a failed event-log append (Cloud R2 P1)', async () => {
    // Setup: two comments — id=101 (append will throw) and id=202 (append would succeed)
    // After the catch+break fix: cursor stays at 0 because c101 throws first.
    // Without the fix: catch swallows the error, c202 succeeds, cursor advances to 202,
    // and c101 is permanently lost from the event log.
    assert.ok(createIssueCommentTaskSpec);
    const taskStore = makeTaskStore();
    taskStore.addTask(makeTask());
    const router = makeIssueCommentRouter();

    // Event log that throws on specific sourceEventId
    const failingEventLog = {
      events: [],
      appendCalls: [],
      async append(event) {
        failingEventLog.appendCalls.push({ sourceEventId: event.sourceEventId, event });
        if (event.sourceEventId.includes(':101')) {
          throw new Error('simulated Redis transient error for comment 101');
        }
        failingEventLog.events.push(event);
        return { appended: true, sequence: failingEventLog.events.length - 1 };
      },
      async read(subjectKey) {
        return failingEventLog.events.filter((e) => e.subjectKey === subjectKey);
      },
      async listSubjects() {
        return [...new Set(failingEventLog.events.map((e) => e.subjectKey))];
      },
    };

    const comments = [
      { id: 101, author: 'external-user', authorAssociation: 'NONE', body: 'help!', createdAt: '2026-01-01T00:00:00Z' },
      {
        id: 202,
        author: 'external-user',
        authorAssociation: 'NONE',
        body: 'follow up',
        createdAt: '2026-01-01T01:00:00Z',
      },
    ];
    const { spec } = makeBaseSpec({ taskStore, router, comments, extra: { eventLog: failingEventLog } });

    await runGate(spec);

    // Collection cursor must NOT advance past the failed comment (must stay at 0)
    const collectionPatch = taskStore.patches.find((p) => p.patch.issue?.lastCommentCursor !== undefined);
    assert.strictEqual(
      collectionPatch,
      undefined,
      'collection cursor must NOT advance when the first append fails — c101 thrown, loop must break',
    );

    // c202 must NOT be in the event log (loop broke before reaching it)
    const c202Event = failingEventLog.events.find((e) => e.payload?.commentId === 202);
    assert.strictEqual(c202Event, undefined, 'c202 must not be appended after c101 failure (loop broke)');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cloud R4 P1-1: projector must be applied after each successful append
  // so awaiting_external → in_progress transitions and lastExternalActivityAt
  // are updated without a full rebuild.
  // ─────────────────────────────────────────────────────────────────────────

  it('collection calls projector.apply for each appended event (Cloud R4 P1-1)', async () => {
    assert.ok(createIssueCommentTaskSpec);
    const taskStore = makeTaskStore();
    taskStore.addTask(makeTask({ id: 'task-projector-call', subjectKey: 'issue:owner/repo#42' }));
    const eventLog = makeEventLog();

    const projectorApplyCalls = [];
    const projector = {
      async apply(event) {
        projectorApplyCalls.push(event);
      },
    };

    const comments = [
      {
        id: 301,
        author: 'external-user',
        body: 'Please fix this!',
        createdAt: '2026-01-01T00:00:00Z',
        authorAssociation: 'NONE',
      },
      {
        id: 302,
        author: 'repo-owner',
        body: 'Looking into it.',
        createdAt: '2026-01-01T01:00:00Z',
        authorAssociation: 'OWNER',
      },
    ];
    const { spec } = makeBaseSpec({ taskStore, comments, extra: { eventLog, projector } });

    await runGate(spec);

    // Projector must be called for EACH comment, regardless of delivery policy
    assert.strictEqual(projectorApplyCalls.length, 2, 'projector.apply must be called for each appended comment');

    const call301 = projectorApplyCalls.find((e) => e.payload.commentId === 301);
    assert.ok(call301, 'projector.apply must be called for comment 301 (external)');
    assert.strictEqual(call301.payload.authorAssociation, 'NONE', 'projector event must include authorAssociation');
    assert.strictEqual(call301.kind, 'issue.commented', 'projector event must have kind=issue.commented');

    const call302 = projectorApplyCalls.find((e) => e.payload.commentId === 302);
    assert.ok(call302, 'projector.apply must be called for comment 302 (OWNER, silent-logged for delivery)');
    assert.strictEqual(call302.payload.authorAssociation, 'OWNER');
  });

  it('collection skips projector.apply for duplicate appends (appended:false) — temporal ordering (Cloud R8 P1-1 revises R4 P1-1)', async () => {
    // Cloud R8 P1-1 revision: when webhook already appended the event (appended:false),
    // projector.apply must NOT be called. Applying out of temporal order can undo
    // case.awaiting_external → restore in_progress incorrectly. Projection repair
    // should use rebuildAll() which replays in log order, not out-of-order single-event replay.
    assert.ok(createIssueCommentTaskSpec);
    const taskStore = makeTaskStore();
    taskStore.addTask(makeTask({ id: 'task-projector-repair', subjectKey: 'issue:owner/repo#42' }));
    const deduplicatingEventLog = {
      events: [],
      appendCalls: [],
      async append(event) {
        deduplicatingEventLog.appendCalls.push(event);
        return { appended: false }; // already in log (webhook path)
      },
      async read() {
        return [];
      },
      async listSubjects() {
        return [];
      },
    };
    const projectorApplyCalls = [];
    const projector = {
      async apply(event) {
        projectorApplyCalls.push(event);
      },
    };
    const comments = [
      { id: 303, author: 'user', body: 'test', createdAt: '2026-01-01T00:00:00Z', authorAssociation: 'NONE' },
    ];
    const { spec } = makeBaseSpec({ taskStore, comments, extra: { eventLog: deduplicatingEventLog, projector } });

    await runGate(spec);

    // Projector must NOT be called for appended:false (temporal ordering preserved)
    assert.strictEqual(
      projectorApplyCalls.length,
      0,
      'projector.apply must NOT be called when appended:false — out-of-order projection corrupts awaiting_external (Cloud R8 P1-1)',
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cloud R4 P1-2: delivery must only include comments that were
  // successfully collected (appended + projected). Comments after a failed
  // append must not be delivered.
  // ─────────────────────────────────────────────────────────────────────────

  it('delivery excludes comments after a failed collection (Cloud R4 P1-2)', async () => {
    // Comments: 100 (succeeds), 101 (append throws), 102 (never reached)
    // Expected: delivery only includes 100; 101 and 102 must not be routed.
    assert.ok(createIssueCommentTaskSpec);
    const taskStore = makeTaskStore();
    taskStore.addTask(makeTask({ id: 'task-delivery-truncation', subjectKey: 'issue:owner/repo#42' }));
    const router = makeIssueCommentRouter();

    const failingAt101EventLog = {
      events: [],
      appendCalls: [],
      async append(event) {
        failingAt101EventLog.appendCalls.push(event);
        if (event.payload.commentId === 101) throw new Error('transient Redis failure');
        failingAt101EventLog.events.push(event);
        return { appended: true, sequence: failingAt101EventLog.events.length - 1 };
      },
      async read() {
        return [];
      },
      async listSubjects() {
        return [];
      },
    };

    const comments = [
      { id: 100, author: 'user-a', body: 'first', createdAt: '2026-01-01T00:00:00Z', authorAssociation: 'NONE' },
      { id: 101, author: 'user-b', body: 'second', createdAt: '2026-01-01T01:00:00Z', authorAssociation: 'NONE' },
      { id: 102, author: 'user-c', body: 'third', createdAt: '2026-01-01T02:00:00Z', authorAssociation: 'NONE' },
    ];
    const { spec } = makeBaseSpec({ taskStore, router, comments, extra: { eventLog: failingAt101EventLog } });

    const gate = await runGate(spec);

    const deliveredIds = (gate.workItems ?? []).flatMap((wi) => wi.signal.newComments.map((c) => c.id));
    assert.ok(deliveredIds.includes(100), 'comment 100 (collected successfully) must be deliverable');
    assert.ok(!deliveredIds.includes(101), 'comment 101 (collection failed) must NOT be delivered');
    assert.ok(!deliveredIds.includes(102), 'comment 102 (unreached after break) must NOT be delivered');
  });

  it('silent-batch delivery cursor does not advance past failed collection boundary (Cloud R4 P1-2 variant)', async () => {
    // All collected comments are OWNER (silent-log) but collection fails midway.
    // Comments: c10 (OWNER, ok), c11 (throws), c12 (OWNER, unreached)
    // Expected: delivery cursor advances to 10 (max successful silent), NOT 12.
    assert.ok(createIssueCommentTaskSpec);
    const taskStore = makeTaskStore();
    taskStore.addTask(makeTask({ id: 'task-silent-truncation', subjectKey: 'issue:owner/repo#42' }));
    const router = makeIssueCommentRouter();

    const failingAt11EventLog = {
      events: [],
      appendCalls: [],
      async append(event) {
        failingAt11EventLog.appendCalls.push(event);
        if (event.payload.commentId === 11) throw new Error('transient failure');
        failingAt11EventLog.events.push(event);
        return { appended: true, sequence: failingAt11EventLog.events.length - 1 };
      },
      async read() {
        return [];
      },
      async listSubjects() {
        return [];
      },
    };

    const comments = [
      { id: 10, author: 'owner', body: 'note', createdAt: '2026-01-01T00:00:00Z', authorAssociation: 'OWNER' },
      { id: 11, author: 'owner', body: 'fails', createdAt: '2026-01-01T01:00:00Z', authorAssociation: 'OWNER' },
      { id: 12, author: 'owner', body: 'unreached', createdAt: '2026-01-01T02:00:00Z', authorAssociation: 'OWNER' },
    ];
    const { spec } = makeBaseSpec({ taskStore, router, comments, extra: { eventLog: failingAt11EventLog } });

    await runGate(spec);

    // Find the patch with value=10 (not the one-time seed patch with value=0).
    const deliveryPatch = taskStore.patches.find((p) => p.patch.issue?.lastDeliveredCursor === 10);
    // Cursor must advance only to 10 (max successfully collected silent comment)
    assert.ok(
      deliveryPatch,
      'delivery cursor must advance to 10 (max collected) for silent successfully-collected comments',
    );
    assert.strictEqual(
      deliveryPatch.patch.issue.lastDeliveredCursor,
      10,
      'delivery cursor must only advance to 10 (max collected), not 12 (uncollected)',
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cloud R6 P1-2: closed issue with collection failure must NOT mark task done
  // ─────────────────────────────────────────────────────────────────────────

  it('closed issue with collection failure does NOT mark task done (Cloud R6 P1-2)', async () => {
    // Scenario: issue is closed, but the first comment's append throws (transient Redis error).
    // processedComments stays empty → pendingDelivery.length === 0.
    // WITHOUT fix: the "no pending, close immediately" branch marks task done — permanently
    //   stopping retries even though the failure was transient and the cursor is still before
    //   the failed comment.
    // WITH fix: detect collection failure (processedComments.length < allPending.length) →
    //   skip done-marking, let next polling cycle retry from the same cursor position.
    assert.ok(createIssueCommentTaskSpec);
    const taskStore = makeTaskStore();
    taskStore.addTask(makeTask({ id: 'task-closed-fail', subjectKey: 'issue:owner/repo#42', status: 'active' }));

    // Event log that always throws — simulates transient Redis failure
    const failingEventLog = {
      async append() {
        throw new Error('simulated transient Redis failure');
      },
      async read() {
        return [];
      },
      async listSubjects() {
        return [];
      },
    };

    const comments = [
      {
        id: 100,
        author: 'external',
        body: 'final comment before issue closed',
        authorAssociation: 'NONE',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];
    const { spec } = makeBaseSpec({
      taskStore,
      comments,
      extra: {
        eventLog: failingEventLog,
        fetchIssueState: async () => 'closed',
      },
    });

    await runGate(spec);

    // Task MUST NOT be marked done — collection failed, so the comment was not logged.
    // The cursor is still at 0 (before the failed comment), so the next poll can retry.
    const taskAfter = taskStore.tasks.get('task-closed-fail');
    assert.notStrictEqual(
      taskAfter?.status,
      'done',
      'collection failure on closed issue must NOT mark task done — must allow retry',
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cloud R15 P1: closed issue — partial collection with deliverable comments
  // must NOT mark task done until all pending comments are collected.
  // ─────────────────────────────────────────────────────────────────────────

  it('closed issue with partial collection failure and deliverable batch must NOT mark task done until collection completes (Cloud R15 P1)', async () => {
    // Scenario: closed issue has 2 new comments (C1=100, C2=101).
    //   C1 appends OK → processedComments=[C1], pendingDelivery=[C1].
    //   C2 append throws → loop breaks. processedComments.length (1) < allPending.length (2).
    //
    // WITHOUT fix: pendingDelivery.length > 0, so commitCursor fires on delivery success,
    //   advancing delivery cursor to 100 AND marking task done. C2 is permanently lost.
    //
    // WITH fix: commitCursor checks processedComments.length < allPending.length.
    //   If incomplete: advance delivery cursor but DO NOT mark done — next poll retries C2.
    assert.ok(createIssueCommentTaskSpec);
    const taskStore = makeTaskStore();
    taskStore.addTask(makeTask({ id: 'task-partial-closed', subjectKey: 'issue:owner/repo#200', status: 'active' }));

    // Event log: C1 (id=100) appends OK, C2 (id=101) throws
    let appendCallCount = 0;
    const partialEventLog = {
      async append() {
        appendCallCount++;
        if (appendCallCount === 1) return { appended: true, sequence: 0 }; // C1 OK
        throw new Error('simulated transient failure on C2'); // C2 fails
      },
      async read() {
        return [];
      },
      async listSubjects() {
        return [];
      },
    };

    const comments = [
      {
        id: 100,
        author: 'external',
        body: 'first comment',
        authorAssociation: 'NONE',
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 101,
        author: 'external',
        body: 'second comment',
        authorAssociation: 'NONE',
        createdAt: '2026-01-01T01:00:00Z',
      },
    ];

    const { spec } = makeBaseSpec({
      taskStore,
      comments,
      extra: {
        eventLog: partialEventLog,
        fetchIssueState: async () => 'closed',
        // Router returns notified so commitCursor fires
      },
    });

    const gateResult = await runGate(spec);
    // commitCursor is called inside execute → must NOT mark done when collection is partial
    await runExecute(spec, gateResult);

    const taskAfter = taskStore.tasks.get('task-partial-closed');
    assert.notStrictEqual(
      taskAfter?.status,
      'done',
      'closed issue with partial collection failure must NOT mark task done — C2 must be retried on next poll',
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cloud R8 P1-1: duplicate comment (appended:false) must NOT call projector
  // Applying stale events out of temporal order corrupts awaiting_external state.
  // ─────────────────────────────────────────────────────────────────────────

  it('duplicate comment (appended:false) must NOT call projector — temporal ordering preserved (Cloud R8 P1-1)', async () => {
    // Scenario: the webhook already appended comment 303; the poller's append()
    // returns appended:false (duplicate). Applying the event to the projector again
    // out of temporal order can revert awaiting_external → in_progress even though
    // no new external activity occurred (the owner's case.awaiting_external event
    // came AFTER comment 303 in the log; replaying 303 again undoes it).
    assert.ok(createIssueCommentTaskSpec);
    const taskStore = makeTaskStore();
    taskStore.addTask(makeTask({ id: 'task-dup-no-project', subjectKey: 'issue:owner/repo#42' }));

    const deduplicatingEventLog = {
      events: [],
      appendCalls: [],
      async append(event) {
        deduplicatingEventLog.appendCalls.push(event);
        return { appended: false }; // already in log (webhook already appended)
      },
      async read() {
        return [];
      },
      async listSubjects() {
        return [];
      },
    };

    const projectorApplyCalls = [];
    const projector = {
      async apply(event) {
        projectorApplyCalls.push(event);
      },
    };

    const comments = [
      { id: 303, author: 'user', body: 'duplicate', createdAt: '2026-01-01T00:00:00Z', authorAssociation: 'NONE' },
    ];
    const { spec } = makeBaseSpec({ taskStore, comments, extra: { eventLog: deduplicatingEventLog, projector } });

    await runGate(spec);

    // Projector must NOT be called for duplicates (appended:false) — Cloud R8 P1-1
    assert.strictEqual(
      projectorApplyCalls.length,
      0,
      'projector.apply must NOT be called when append() returns appended:false — applying out of temporal order corrupts awaiting_external',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cloud R17 P1: one-time delivery cursor seed before collection advance
// ─────────────────────────────────────────────────────────────────────────────
// Root cause: /api/callbacks/register-issue-tracking only seeds lastCommentCursor.
// When collection advances lastCommentCursor before delivery cursor is persisted
// (crash/exit), the next poll falls back lastDeliveredCursor ?? collectionCursor
// to the POST-advance value — silently losing the undelivered comment.
// Fix: before advancing collection, seed lastDeliveredCursor to the current
// (PRE-advance) collectionCursor so the fallback lands on the safe old value.
describe('IssueCommentTaskSpec: one-time delivery cursor seed before collection advance (Cloud R17 P1)', () => {
  it('seeds lastDeliveredCursor to pre-advance value before advancing collection, closing crash-window for manually-registered tasks', async () => {
    // Task registered via /api/callbacks/register-issue-tracking (manual endpoint):
    // only lastCommentCursor is seeded, lastDeliveredCursor is absent.
    assert.ok(createIssueCommentTaskSpec);
    const taskStore = makeTaskStore();
    taskStore.addTask(
      makeTask({
        id: 'task-unseeded-delivery',
        subjectKey: 'issue:owner/repo#99',
        automationState: {
          issue: { lastCommentCursor: 50 }, // lastDeliveredCursor intentionally absent
        },
      }),
    );

    const comment51 = {
      id: 51,
      author: 'alice',
      body: 'question',
      createdAt: '2026-01-01T00:00:00Z',
      authorAssociation: 'NONE',
    };
    const eventLog = makeEventLog();
    const router = makeIssueCommentRouter({ failRoute: false });
    // fetchComments returns comment51 only when fetched since ≤ 50 (correct fetch range)
    const spec = createIssueCommentTaskSpec({
      taskStore,
      issueCommentRouter: router,
      fetchComments: async (_repo, _issue, since) => (since <= 50 ? [comment51] : []),
      fetchIssueState: async () => 'open',
      log: { info: () => {}, error: () => {}, warn: () => {} },
      eventLog,
    });

    const gate = await spec.admission.gate();
    // Gate must produce work: comment 51 is pending delivery
    assert.ok(gate.run, 'gate must run when comment 51 is pending');

    // Cloud R17 P1: verify delivery cursor was seeded to 50 (pre-advance collectionCursor)
    // BEFORE collection cursor was advanced to 51.
    // This closes the crash window: if the process exits after advancing
    // lastCommentCursor=51 but before commitCursor() sets lastDeliveredCursor=51,
    // the next poll reads lastDeliveredCursor=50 and retries comment 51 — not lost.
    const deliverySeedPatchIdx = taskStore.patches.findIndex((p) => p.patch.issue?.lastDeliveredCursor === 50);
    const collectionAdvancePatchIdx = taskStore.patches.findIndex((p) => p.patch.issue?.lastCommentCursor === 51);

    assert.ok(
      deliverySeedPatchIdx >= 0,
      'lastDeliveredCursor must be seeded to 50 (pre-advance collectionCursor) before collection advances',
    );
    assert.ok(
      collectionAdvancePatchIdx >= 0,
      'lastCommentCursor must be advanced to 51 after new comment is collected',
    );
    assert.ok(
      deliverySeedPatchIdx < collectionAdvancePatchIdx,
      `delivery cursor seed (patch[${deliverySeedPatchIdx}]) must be persisted BEFORE collection advance (patch[${collectionAdvancePatchIdx}])`,
    );
  });
});

// ---------------------------------------------------------------------------
// F168 Phase B dead-code cleanup (PR-3): execute() guard for null/undefined routing metadata
// Dead semantic fallbacks removed: ?? '' at lines :442/:443/:465
// R13+R14 ensure auto-registered tasks always have ownerCatId and userId set.
// The old ?? '' silently passed empty strings, masking misconfigured tasks.
// After cleanup: null ownerCatId or undefined userId → warn + skip, not silent empty-string call.
// ---------------------------------------------------------------------------
describe('F168 dead-code cleanup: execute() guard — null/undefined ownerCatId / userId', () => {
  it('execute: null ownerCatId must warn and NOT call route() (dead ?? "" removed, F168 PR-3)', async () => {
    const warnCalls = [];
    const taskStore = makeTaskStore();
    const router = makeIssueCommentRouter();
    taskStore.addTask(
      makeTask({
        id: 'task-null-catid',
        subjectKey: 'issue:owner/repo#99',
        ownerCatId: null, // simulates pre-R13 task missing ownerCatId
        userId: 'user-ok',
      }),
    );
    const spec = createIssueCommentTaskSpec({
      taskStore,
      issueCommentRouter: router,
      fetchComments: async () => [{ id: 200, author: 'external', body: 'hi', authorAssociation: 'NONE' }],
      fetchIssueState: async () => 'open',
      log: {
        info: () => {},
        error: () => {},
        warn: (...args) => warnCalls.push(args),
      },
    });
    const gate = await spec.admission.gate();
    assert.ok(gate.run, 'gate must produce a work item (comment 200 is new)');
    for (const { signal, subjectKey } of gate.workItems) {
      await spec.run.execute(signal, subjectKey, {});
    }
    assert.strictEqual(
      router.calls.length,
      0,
      'route() must NOT be called when ownerCatId is null — guard must return early',
    );
    assert.ok(warnCalls.length > 0, 'warn() must be called when ownerCatId is null');
  });

  it('execute: undefined userId must warn and NOT call route() (dead ?? "" removed, F168 PR-3)', async () => {
    const warnCalls = [];
    const taskStore = makeTaskStore();
    const router = makeIssueCommentRouter();
    taskStore.addTask(
      makeTask({
        id: 'task-no-userid',
        subjectKey: 'issue:owner/repo#98',
        ownerCatId: 'opus',
        userId: undefined, // simulates pre-R13 task missing userId
      }),
    );
    const spec = createIssueCommentTaskSpec({
      taskStore,
      issueCommentRouter: router,
      fetchComments: async () => [{ id: 201, author: 'external', body: 'hey', authorAssociation: 'NONE' }],
      fetchIssueState: async () => 'open',
      log: {
        info: () => {},
        error: () => {},
        warn: (...args) => warnCalls.push(args),
      },
    });
    const gate = await spec.admission.gate();
    assert.ok(gate.run, 'gate must produce a work item (comment 201 is new)');
    for (const { signal, subjectKey } of gate.workItems) {
      await spec.run.execute(signal, subjectKey, {});
    }
    assert.strictEqual(
      router.calls.length,
      0,
      'route() must NOT be called when userId is undefined — guard must return early',
    );
    assert.ok(warnCalls.length > 0, 'warn() must be called when userId is undefined');
  });
});
