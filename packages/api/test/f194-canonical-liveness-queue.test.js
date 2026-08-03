/**
 * F194 Phase B step 2 — canonical liveness consistency regression for /queue.
 *
 * Locks the split-brain reproducer 砚砚 surfaced 2026-05-07: GET /queue.activeInvocations
 * must agree with /api/messages on canonical liveness rules (record + tracker + draft).
 *
 * Coverage:
 * - AC-B3: record running + tracker missing + fresh draft → /queue.activeInvocations
 *   includes the invocation (pre-F194 was tracker-only → empty).
 * - AC-B4: record running + tracker missing + no fresh draft + age past zombie grace
 *   → /queue.activeInvocations does NOT include the invocation (zombie).
 * - record-missing recovery (R1 P1-1): record absent + tracker slot anchors a fresh draft
 *   → /queue.activeInvocations surfaces it via tracker+draft.
 * - Helper exception fail-open: invocationRecordStore.listRunningByThread throws →
 *   handler logs + falls back to tracker-only enumeration (endpoint never 500s).
 * - Legacy fallback: when invocationRecordStore + draftStore are not wired (embedded
 *   modes / older callers), GET /queue still returns tracker.getActiveSlots() unchanged.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import Fastify from 'fastify';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { clearCodexAppServerLifecycle, recordCodexAppServerLifecycle } = await import(
  '../dist/domains/cats/services/agents/providers/CodexAppServerLifecycleRegistry.js'
);

const THREAD_ID = 't1';
const USER_ID = 'user-a';

function makeRecord(overrides = {}) {
  const now = overrides.updatedAt ?? Date.now();
  return {
    id: overrides.id ?? 'inv-1',
    threadId: overrides.threadId ?? THREAD_ID,
    userId: overrides.userId ?? USER_ID,
    userMessageId: 'msg-1',
    targetCats: overrides.targetCats ?? ['opus'],
    intent: 'execute',
    status: overrides.status ?? 'running',
    idempotencyKey: 'k',
    createdAt: overrides.createdAt ?? now,
    updatedAt: now,
    ...overrides,
  };
}

function makeDraft(overrides = {}) {
  const updatedAt = overrides.updatedAt ?? Date.now();
  return {
    userId: USER_ID,
    threadId: THREAD_ID,
    invocationId: overrides.invocationId ?? 'inv-1',
    catId: overrides.catId ?? 'opus',
    content: 'x',
    createdAt: overrides.createdAt ?? updatedAt,
    updatedAt,
  };
}

function makeRecordStore(records = []) {
  const byId = new Map(records.map((r) => [r.id, r]));
  return {
    create: () => {
      throw new Error('not implemented');
    },
    get: async (id) => byId.get(id) ?? null,
    update: () => {
      throw new Error('not implemented');
    },
    getByIdempotencyKey: () => null,
    listRunningByThread: (tid, uid) => {
      const out = [];
      for (const r of byId.values()) {
        if (r.status === 'running' && r.threadId === tid && r.userId === uid) out.push(r);
      }
      return out;
    },
  };
}

function makeDraftStore(drafts = []) {
  return {
    upsert: () => {},
    touch: () => {},
    delete: () => {},
    deleteByThread: () => {},
    getByThread: (uid, tid) => drafts.filter((d) => d.userId === uid && d.threadId === tid),
  };
}

function buildDeps(overrides = {}) {
  return {
    threadStore: {
      get: mock.fn(async (id) => ({ id, title: 'Test', createdBy: 'system' })),
    },
    invocationQueue: new InvocationQueue(),
    queueProcessor: {
      processNext: mock.fn(async () => ({ started: false })),
      isPaused: mock.fn(() => false),
      getPauseReason: mock.fn(() => undefined),
      clearPause: mock.fn(() => {}),
      releaseSlot: mock.fn(() => {}),
      releaseThread: mock.fn(() => {}),
    },
    invocationTracker: {
      has: mock.fn(() => false),
      getUserId: mock.fn(() => null),
      cancel: mock.fn(() => ({ cancelled: false, catIds: [] })),
      getActiveSlots: mock.fn(() => []),
    },
    socketManager: {
      broadcastAgentMessage: mock.fn(),
      broadcastToRoom: mock.fn(),
      emitToUser: mock.fn(),
    },
    ...overrides,
  };
}

async function makeApp(deps) {
  const { queueRoutes } = await import('../dist/routes/queue.js');
  const app = Fastify({ logger: false });
  await app.register(queueRoutes, deps);
  await app.ready();
  return app;
}

async function getQueue(app) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/threads/${THREAD_ID}/queue`,
    headers: { 'x-cat-cafe-user': USER_ID },
  });
  return { statusCode: res.statusCode, body: res.json() };
}

function bindForeignTrackerLifecycle(deps, slot, executionId) {
  deps.invocationTracker.getActiveSlots = mock.fn(() => [slot]);
  deps.invocationTracker.getUserId = mock.fn(() => 'user-b');
  deps.invocationTracker.getExecutionId = mock.fn(() => executionId);
  recordCodexAppServerLifecycle({
    threadId: THREAD_ID,
    catId: slot.catId,
    invocationId: executionId,
    lifecycle: {
      stage: 'failed',
      lastActivityAt: Date.now() - 500,
      recoveryAttempt: 0,
      failureReason: 'foreign-provider-failure',
      turnStartSent: true,
      turnAccepted: true,
      itemObserved: true,
    },
  });
}

describe('F194 Phase B — /queue canonical liveness regression', () => {
  let app;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it('AC-B3: record running + tracker missing + fresh draft → activeInvocations surfaces the invocation', async () => {
    const now = 1_000_000;
    const record = makeRecord({ id: 'inv-running', updatedAt: now - 60_000 });
    const draft = makeDraft({ invocationId: 'inv-running', updatedAt: now - 100, createdAt: now - 50_000 });
    const deps = buildDeps({
      invocationRecordStore: makeRecordStore([record]),
      draftStore: makeDraftStore([draft]),
    });

    const origNow = Date.now;
    Date.now = () => now;
    try {
      app = await makeApp(deps);
      const { statusCode, body } = await getQueue(app);
      assert.equal(statusCode, 200);
      // Pre-F194: tracker.getActiveSlots() = [] → activeInvocations: []
      // Post-F194: helper sees record+fresh-draft → activeInvocations contains opus
      assert.equal(body.activeInvocations.length, 1, 'split-brain canonical: invocation must surface');
      assert.equal(body.activeInvocations[0].catId, 'opus');
    } finally {
      Date.now = origNow;
    }
  });

  it('AC-B4: record running + tracker missing + no fresh draft + age past zombie grace → activeInvocations is empty', async () => {
    const now = 10_000_000;
    const record = makeRecord({
      id: 'inv-zombie',
      // record.updatedAt past 2× DraftStore TTL (600_000ms default zombie grace)
      updatedAt: now - 700_000,
      createdAt: now - 700_000,
    });
    const deps = buildDeps({
      invocationRecordStore: makeRecordStore([record]),
      draftStore: makeDraftStore([]),
    });
    // Override Date.now during this test so helper compares against the right "now"
    const origNow = Date.now;
    Date.now = () => now;
    try {
      app = await makeApp(deps);
      const { body } = await getQueue(app);
      assert.equal(body.activeInvocations.length, 0, 'zombie record must not surface as active');
    } finally {
      Date.now = origNow;
    }
  });

  it('record-missing recovery: tracker slot + fresh draft anchors slot → activeInvocations surfaces tracker+draft', async () => {
    const now = 1_000_000;
    const draft = makeDraft({ invocationId: 'inv-recovery', createdAt: now - 5_000, updatedAt: now - 100 });
    // tracker slot started before draft.createdAt → strongly anchors this draft
    const slot = { catId: 'opus', startedAt: now - 6_000 };
    const deps = buildDeps({
      invocationRecordStore: makeRecordStore([]), // record absent (race / startup window)
      draftStore: makeDraftStore([draft]),
    });
    deps.invocationTracker.getActiveSlots = mock.fn(() => [slot]);
    deps.invocationTracker.getUserId = mock.fn(() => USER_ID);

    const origNow = Date.now;
    Date.now = () => now;
    try {
      app = await makeApp(deps);
      const { body } = await getQueue(app);
      assert.equal(body.activeInvocations.length, 1, 'tracker+draft path must surface');
      assert.equal(body.activeInvocations[0].catId, 'opus');
      assert.equal(body.activeInvocations[0].startedAt, slot.startedAt);
    } finally {
      Date.now = origNow;
    }
  });

  it('helper exception → fail-open to tracker.getActiveSlots() (endpoint never 500s)', async () => {
    const slot = { catId: 'opus', startedAt: Date.now() - 1_000 };
    const deps = buildDeps({
      invocationRecordStore: {
        ...makeRecordStore([]),
        // throw on listRunningByThread to simulate Redis failure
        listRunningByThread: () => {
          throw new Error('redis down');
        },
      },
      draftStore: makeDraftStore([]),
    });
    deps.invocationTracker.getActiveSlots = mock.fn(() => [slot]);

    app = await makeApp(deps);
    const { statusCode, body } = await getQueue(app);
    assert.equal(statusCode, 200, 'helper throw must not break the endpoint');
    // Fallback returns tracker.getActiveSlots()
    assert.deepEqual(body.activeInvocations, [slot], 'fall-back tracker-only on helper exception');
  });

  it('F254 AC-D14a: helper-exception fallback omits lifecycle owned by another user', async () => {
    const slot = { catId: 'codex', startedAt: Date.now() - 1_000 };
    const foreignExecutionId = 'inv-f254-helper-fallback-foreign';
    const deps = buildDeps({
      invocationRecordStore: {
        ...makeRecordStore([]),
        listRunningByThread: () => {
          throw new Error('redis down');
        },
      },
      draftStore: makeDraftStore([]),
    });
    bindForeignTrackerLifecycle(deps, slot, foreignExecutionId);

    try {
      app = await makeApp(deps);
      const { statusCode, body } = await getQueue(app);
      assert.equal(statusCode, 200, 'system thread remains readable by the requesting user');
      assert.deepEqual(
        body.activeInvocations,
        [slot],
        'fail-open may preserve the bare slot but must not expose another user lifecycle',
      );
    } finally {
      clearCodexAppServerLifecycle(THREAD_ID, 'codex', foreignExecutionId);
    }
  });

  it('legacy fallback: when stores are not wired, activeInvocations comes from tracker (backward compat)', async () => {
    const slot = { catId: 'gpt52', startedAt: Date.now() - 1_000 };
    const deps = buildDeps({
      // intentionally no invocationRecordStore / draftStore
    });
    deps.invocationTracker.getActiveSlots = mock.fn(() => [slot]);

    app = await makeApp(deps);
    const { body } = await getQueue(app);
    assert.deepEqual(body.activeInvocations, [slot]);
  });

  it('F254 AC-D14a: legacy fallback omits lifecycle owned by another user', async () => {
    const slot = { catId: 'codex', startedAt: Date.now() - 1_000 };
    const foreignExecutionId = 'inv-f254-legacy-fallback-foreign';
    const deps = buildDeps();
    bindForeignTrackerLifecycle(deps, slot, foreignExecutionId);

    try {
      app = await makeApp(deps);
      const { statusCode, body } = await getQueue(app);
      assert.equal(statusCode, 200, 'system thread remains readable by the requesting user');
      assert.deepEqual(
        body.activeInvocations,
        [slot],
        'legacy fallback may preserve the bare slot but must not expose another user lifecycle',
      );
    } finally {
      clearCodexAppServerLifecycle(THREAD_ID, 'codex', foreignExecutionId);
    }
  });

  it('F254 AC-D14a: active app-server lifecycle survives F5 through /queue hydration', async () => {
    const slot = { catId: 'codex', startedAt: Date.now() - 1_000 };
    const lifecycle = {
      stage: 'active',
      lastActivityAt: Date.now() - 500,
      recoveryAttempt: 0,
      threadId: 'codex-thread-1',
      turnId: 'turn-1',
      turnStartSent: true,
      turnAccepted: true,
      itemObserved: true,
    };
    recordCodexAppServerLifecycle({
      threadId: THREAD_ID,
      catId: 'codex',
      invocationId: 'inv-f254-lifecycle',
      lifecycle,
    });
    const deps = buildDeps();
    deps.invocationTracker.getActiveSlots = mock.fn(() => [slot]);
    deps.invocationTracker.getUserId = mock.fn(() => USER_ID);
    deps.invocationTracker.getExecutionId = mock.fn(() => 'inv-f254-lifecycle');

    try {
      app = await makeApp(deps);
      const { body } = await getQueue(app);
      assert.deepEqual(body.activeInvocations, [
        { ...slot, executionId: 'inv-f254-lifecycle', appServerLifecycle: lifecycle },
      ]);
    } finally {
      clearCodexAppServerLifecycle(THREAD_ID, 'codex', 'inv-f254-lifecycle');
    }
  });

  it('F254 AC-D14a: /queue keeps cleanup lifecycle only for the owning active execution', async () => {
    const slot = { catId: 'codex', startedAt: Date.now() - 1_000 };
    const ownerInvocationId = 'inv-f254-closing-owner';
    let activeExecutionId = ownerInvocationId;
    const deps = buildDeps();
    deps.invocationTracker.getActiveSlots = mock.fn(() => [slot]);
    deps.invocationTracker.getUserId = mock.fn(() => USER_ID);
    deps.invocationTracker.getExecutionId = mock.fn(() => activeExecutionId);
    const closing = {
      stage: 'closing',
      lastActivityAt: Date.now() - 100,
      recoveryAttempt: 0,
      threadId: 'codex-thread-closing',
      turnId: 'turn-closing',
      turnStartSent: true,
      turnAccepted: true,
      itemObserved: true,
    };

    recordCodexAppServerLifecycle({
      threadId: THREAD_ID,
      catId: 'codex',
      invocationId: ownerInvocationId,
      lifecycle: closing,
    });

    try {
      app = await makeApp(deps);
      const duringCleanup = await getQueue(app);
      assert.deepEqual(
        duringCleanup.body.activeInvocations,
        [{ ...slot, executionId: ownerInvocationId, appServerLifecycle: closing }],
        'F5 during bounded cleanup must hydrate the canonical closing snapshot',
      );

      const cleanupFailed = { ...closing, stage: 'closed', lastActivityAt: Date.now(), cleanupError: 'close failed' };
      recordCodexAppServerLifecycle({
        threadId: THREAD_ID,
        catId: 'codex',
        invocationId: ownerInvocationId,
        lifecycle: cleanupFailed,
      });
      const afterCleanupFailure = await getQueue(app);
      assert.deepEqual(
        afterCleanupFailure.body.activeInvocations,
        [{ ...slot, executionId: ownerInvocationId, appServerLifecycle: cleanupFailed }],
        'cleanup failure remains attributable while the owning execution is still active',
      );

      activeExecutionId = 'inv-f254-replacement';
      const afterReplacement = await getQueue(app);
      assert.deepEqual(
        afterReplacement.body.activeInvocations,
        [{ ...slot, executionId: activeExecutionId }],
        'a replacement execution must never inherit the previous execution lifecycle',
      );
    } finally {
      clearCodexAppServerLifecycle(THREAD_ID, 'codex', ownerInvocationId);
    }
  });

  it('F254 AC-D14a: canonical parent→child liveness hydrates only the current execution owner', async () => {
    const now = 2_000_000;
    const parentExecutionId = 'inv-f254-canonical-parent';
    const childTurnId = 'inv-f254-canonical-child';
    const replacementExecutionId = 'inv-f254-canonical-replacement';
    const foreignExecutionId = 'inv-f254-canonical-foreign';
    const canonicalStartedAt = now - 2_000;
    const slot = { catId: 'codex', startedAt: now - 3_000 };
    const record = makeRecord({
      id: parentExecutionId,
      targetCats: ['codex'],
      createdAt: now - 4_000,
      updatedAt: now - 100,
    });
    const draft = makeDraft({
      invocationId: childTurnId,
      catId: 'codex',
      createdAt: canonicalStartedAt,
      updatedAt: now - 50,
    });
    let activeExecutionId = parentExecutionId;
    let trackerUserId = USER_ID;
    const deps = buildDeps({
      invocationRecordStore: makeRecordStore([record]),
      draftStore: makeDraftStore([draft]),
      invocationRegistry: {
        getRecord: mock.fn(async (id) =>
          id === childTurnId
            ? {
                parentInvocationId: parentExecutionId,
                threadId: THREAD_ID,
                userId: USER_ID,
                catId: 'codex',
                createdAt: canonicalStartedAt,
              }
            : null,
        ),
        getLatestId: mock.fn(() => childTurnId),
      },
    });
    deps.invocationTracker.getActiveSlots = mock.fn(() => [slot]);
    deps.invocationTracker.getUserId = mock.fn(() => trackerUserId);
    deps.invocationTracker.getExecutionId = mock.fn(() => activeExecutionId);
    const closing = {
      stage: 'closing',
      lastActivityAt: now - 25,
      recoveryAttempt: 0,
      threadId: 'codex-thread-canonical',
      turnId: 'turn-canonical',
      turnStartSent: true,
      turnAccepted: true,
      itemObserved: true,
    };

    recordCodexAppServerLifecycle({
      threadId: THREAD_ID,
      catId: 'codex',
      invocationId: parentExecutionId,
      lifecycle: closing,
    });

    const origNow = Date.now;
    Date.now = () => now;
    try {
      app = await makeApp(deps);
      const duringCleanup = await getQueue(app);
      assert.deepEqual(duringCleanup.body.activeInvocations, [
        {
          catId: 'codex',
          startedAt: canonicalStartedAt,
          executionId: parentExecutionId,
          turnInvocationId: childTurnId,
          appServerLifecycle: closing,
        },
      ]);

      activeExecutionId = replacementExecutionId;
      const afterReplacement = await getQueue(app);
      assert.deepEqual(
        afterReplacement.body.activeInvocations,
        [{ catId: 'codex', startedAt: canonicalStartedAt, executionId: replacementExecutionId }],
        'a replacement tracker owner must inherit neither the previous child nor its lifecycle snapshot',
      );

      trackerUserId = 'user-b';
      activeExecutionId = foreignExecutionId;
      const withForeignTrackerOwner = await getQueue(app);
      assert.deepEqual(
        withForeignTrackerOwner.body.activeInvocations,
        [
          {
            catId: 'codex',
            startedAt: canonicalStartedAt,
            executionId: parentExecutionId,
            turnInvocationId: childTurnId,
            appServerLifecycle: closing,
          },
        ],
        'a tracker slot owned by another user must not replace the canonical lifecycle owner',
      );
    } finally {
      Date.now = origNow;
      clearCodexAppServerLifecycle(THREAD_ID, 'codex', parentExecutionId);
    }
  });

  it('cloud R15 P2: duplicate catId entries deduped (keep earliest startedAt per cat)', async () => {
    // Reproduces cloud Codex P2 (comment 3211748989, line 153): when canonical
    // liveness yields multiple LiveInvocation entries for the same cat (e.g.,
    // concurrent running records during recovery windows), the route must dedup
    // by catId before returning. Web client uses replaceThreadTargetCats which
    // is cat-level state; duplicate cats produce inconsistent UI.
    const now = 1_000_000;
    // Two records, both running, both targeting 'opus' — produces two helper outputs with same catId
    const r1 = makeRecord({ id: 'inv-opus-a', updatedAt: now - 60_000, createdAt: now - 60_000 });
    const r2 = makeRecord({ id: 'inv-opus-b', updatedAt: now - 30_000, createdAt: now - 30_000 });
    const draft1 = makeDraft({ invocationId: 'inv-opus-a', updatedAt: now - 100, createdAt: now - 60_000 });
    const draft2 = makeDraft({ invocationId: 'inv-opus-b', updatedAt: now - 100, createdAt: now - 30_000 });
    const deps = buildDeps({
      invocationRecordStore: makeRecordStore([r1, r2]),
      draftStore: makeDraftStore([draft1, draft2]),
    });

    const origNow = Date.now;
    Date.now = () => now;
    try {
      app = await makeApp(deps);
      const { body } = await getQueue(app);
      // Without fix: 2 entries for 'opus', frontend would show duplicated target cat
      // With fix: dedup by catId, keep earliest startedAt
      const opusSlots = body.activeInvocations.filter((s) => s.catId === 'opus');
      assert.equal(opusSlots.length, 1, 'duplicate catId entries must dedup to a single cat slot');
      // Earliest startedAt wins (r1 createdAt=now-60_000 < r2 createdAt=now-30_000)
      assert.equal(opusSlots[0].startedAt, now - 60_000, 'kept slot must have earliest startedAt');
    } finally {
      Date.now = origNow;
    }
  });

  it('null catId is filtered (no phantom UI cat slot — 砚砚 R5 P2)', async () => {
    // Construct a record without targetCats so helper produces null catId
    const now = 1_000_000;
    const record = makeRecord({ id: 'inv-no-cat', targetCats: [], updatedAt: now - 60_000 });
    const deps = buildDeps({
      invocationRecordStore: makeRecordStore([record]),
      draftStore: makeDraftStore([]),
    });

    const origNow = Date.now;
    Date.now = () => now;
    try {
      app = await makeApp(deps);
      const { body } = await getQueue(app);
      // helper returns 1 active with catId=null (record-only/pending), but the route
      // filters null catId so no phantom cat slot is emitted to the frontend
      assert.equal(body.activeInvocations.length, 0, 'null catId entries must be filtered');
    } finally {
      Date.now = origNow;
    }
  });
});
