/**
 * F194 Phase B → F117 KD-23 — canonical liveness consistency for /queue.
 *
 * GET /queue.activeInvocations lists a member only when someone verifiably runs its turn: this
 * process's tracker slot, a live CLI owner, or (only while no complete owner snapshot can tell) a
 * running child. Drafts and timestamps are not liveness.
 *
 * Coverage:
 * - AC-B3: a running record with only a draft is not processing.
 * - AC-B4: a running record nobody holds is not processing, however recently it was updated.
 * - Pre-start window: a tracker slot whose record is not running yet surfaces as the member.
 * - Helper exception fail-open: invocationRecordStore.listRunningByThread throws →
 *   handler logs + falls back to tracker-only enumeration (endpoint never 500s).
 * - Legacy fallback: when invocationRecordStore is not wired (embedded modes / older callers),
 *   GET /queue still returns tracker.getActiveSlots() unchanged.
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
const UNDECLARED_FRESHNESS_CARRIER_CAPABILITY = {
  provider: 'other',
  carrier: 'other',
  activeInvocationGuidance: 'undeclared',
  deliverySemantics: 'undeclared',
};

function withUndeclaredCapability(slot) {
  return { ...slot, freshnessCarrierCapability: UNDECLARED_FRESHNESS_CARRIER_CAPABILITY };
}

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

  it('AC-B3 (F117 KD-23): a running record with only a draft is not processing', async () => {
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
      assert.deepEqual(body.activeInvocations, [], 'a streamed draft does not prove anyone still runs the turn');
    } finally {
      Date.now = origNow;
    }
  });
  it('AC-B4 (F117 KD-23): a running record nobody holds is not processing, however recently it was updated', async () => {
    const now = 10_000_000;
    const record = makeRecord({ id: 'inv-unheld', updatedAt: now - 1_000, createdAt: now - 2_000 });
    const deps = buildDeps({
      invocationRecordStore: makeRecordStore([record]),
      draftStore: makeDraftStore([]),
    });
    const origNow = Date.now;
    Date.now = () => now;
    try {
      app = await makeApp(deps);
      const { body } = await getQueue(app);
      assert.equal(body.activeInvocations.length, 0, 'no grace window: a fresh record is not an owner');
    } finally {
      Date.now = origNow;
    }
  });
  it('F117 KD-23: a slot whose record is not running yet surfaces as the member (pre-start window)', async () => {
    const now = 1_000_000;
    const slot = { catId: 'opus', startedAt: now - 6_000 };
    const deps = buildDeps({
      invocationRecordStore: makeRecordStore([]), // the record turns running only after startAll
    });
    deps.invocationTracker.getActiveSlots = mock.fn(() => [slot]);
    deps.invocationTracker.getUserId = mock.fn(() => USER_ID);
    deps.invocationTracker.getExecutionId = mock.fn(() => 'inv-prestart');

    const origNow = Date.now;
    Date.now = () => now;
    try {
      app = await makeApp(deps);
      const { body } = await getQueue(app);
      assert.equal(body.activeInvocations.length, 1, 'the slot this process holds is the member');
      assert.equal(body.activeInvocations[0].catId, 'opus');
      assert.equal(body.activeInvocations[0].executionId, 'inv-prestart');
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
    assert.deepEqual(
      body.activeInvocations,
      [withUndeclaredCapability(slot)],
      'fall-back tracker-only on helper exception',
    );
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
        [withUndeclaredCapability(slot)],
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
    assert.deepEqual(body.activeInvocations, [withUndeclaredCapability(slot)]);
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
        [withUndeclaredCapability(slot)],
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
        withUndeclaredCapability({ ...slot, executionId: 'inv-f254-lifecycle', appServerLifecycle: lifecycle }),
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
        [withUndeclaredCapability({ ...slot, executionId: ownerInvocationId, appServerLifecycle: closing })],
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
        [withUndeclaredCapability({ ...slot, executionId: ownerInvocationId, appServerLifecycle: cleanupFailed })],
        'cleanup failure remains attributable while the owning execution is still active',
      );

      activeExecutionId = 'inv-f254-replacement';
      const afterReplacement = await getQueue(app);
      assert.deepEqual(
        afterReplacement.body.activeInvocations,
        [withUndeclaredCapability({ ...slot, executionId: activeExecutionId })],
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
    // F117 KD-23: the child turn is known from the tracker's bound activeRun, or from a durable running
    // child when nothing verifies an owner; drafts and the registry namespace bridge are gone.
    const activeRun = {
      threadId: THREAD_ID,
      targetId: 'codex',
      invocationId: childTurnId,
      responseMessageId: 'response-canonical',
      inputEntryIds: [],
      inputMessageIds: [],
      privateInputEntryIds: [],
      startedAt: canonicalStartedAt,
    };
    let activeExecutionId = parentExecutionId;
    let trackerUserId = USER_ID;
    const deps = buildDeps({
      invocationRecordStore: makeRecordStore([record]),
      turnExecutionStore: {
        listByParent: async (parentId) =>
          parentId === parentExecutionId
            ? [
                {
                  invocationId: childTurnId,
                  parentInvocationId: parentExecutionId,
                  threadId: THREAD_ID,
                  userId: USER_ID,
                  catId: 'codex',
                  executionKind: 'ordinary',
                  startedAt: canonicalStartedAt,
                  status: 'running',
                },
              ]
            : [],
      },
    });
    deps.invocationTracker.getActiveSlots = mock.fn(() => [
      activeExecutionId === parentExecutionId ? { ...slot, activeRun } : slot,
    ]);
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
        withUndeclaredCapability({
          catId: 'codex',
          startedAt: canonicalStartedAt,
          executionId: parentExecutionId,
          turnInvocationId: childTurnId,
          activeRun,
          appServerLifecycle: closing,
        }),
      ]);

      activeExecutionId = replacementExecutionId;
      const afterReplacement = await getQueue(app);
      assert.deepEqual(
        afterReplacement.body.activeInvocations,
        [
          withUndeclaredCapability({
            catId: 'codex',
            startedAt: slot.startedAt,
            executionId: replacementExecutionId,
          }),
        ],
        'a replacement tracker owner must inherit neither the previous child nor its lifecycle snapshot',
      );

      trackerUserId = 'user-b';
      activeExecutionId = foreignExecutionId;
      const withForeignTrackerOwner = await getQueue(app);
      assert.deepEqual(
        withForeignTrackerOwner.body.activeInvocations,
        [
          withUndeclaredCapability({
            catId: 'codex',
            startedAt: canonicalStartedAt,
            executionId: parentExecutionId,
            turnInvocationId: childTurnId,
            appServerLifecycle: closing,
          }),
        ],
        'a tracker slot owned by another user must not replace the canonical lifecycle owner',
      );
    } finally {
      Date.now = origNow;
      clearCodexAppServerLifecycle(THREAD_ID, 'codex', parentExecutionId);
    }
  });

  it('cloud R15 P2: duplicate catId entries dedup to one slot, strongest evidence first, then earliest start', async () => {
    // Reproduces cloud Codex P2 (comment 3211748989, line 153): canonical liveness can yield several
    // entries for one cat (e.g. concurrent running records during recovery windows). The web client's
    // replaceThreadTargetCats is cat-level state, so the route must return one slot per cat.
    const now = 1_000_000;
    const r1 = makeRecord({ id: 'inv-opus-a', updatedAt: now - 60_000, createdAt: now - 60_000 });
    const r2 = makeRecord({ id: 'inv-opus-b', updatedAt: now - 30_000, createdAt: now - 30_000 });
    const child = (id, parent, startedAt) => ({
      invocationId: id,
      parentInvocationId: parent,
      threadId: THREAD_ID,
      userId: USER_ID,
      catId: 'opus',
      executionKind: 'ordinary',
      startedAt,
      status: 'running',
    });
    const children = {
      'inv-opus-a': [child('child-a', 'inv-opus-a', now - 60_000)],
      'inv-opus-b': [child('child-b', 'inv-opus-b', now - 30_000)],
    };
    const deps = buildDeps({
      invocationRecordStore: makeRecordStore([r1, r2]),
      turnExecutionStore: { listByParent: async (parentId) => children[parentId] ?? [] },
    });

    const origNow = Date.now;
    Date.now = () => now;
    try {
      app = await makeApp(deps);
      // Both members stand only on unverified running children: the earliest start wins.
      let opusSlots = (await getQueue(app)).body.activeInvocations.filter((s) => s.catId === 'opus');
      assert.equal(opusSlots.length, 1, 'duplicate catId entries must dedup to a single cat slot');
      assert.equal(opusSlots[0].executionId, 'inv-opus-a');
      assert.equal(opusSlots[0].startedAt, now - 60_000, 'kept slot must have earliest startedAt');

      // This process holds the later record's slot: verified evidence outranks the older child.
      deps.invocationTracker.getActiveSlots = mock.fn(() => [{ catId: 'opus', startedAt: now - 35_000 }]);
      deps.invocationTracker.getUserId = mock.fn(() => USER_ID);
      deps.invocationTracker.getExecutionId = mock.fn(() => 'inv-opus-b');
      opusSlots = (await getQueue(app)).body.activeInvocations.filter((s) => s.catId === 'opus');
      assert.equal(opusSlots.length, 1);
      assert.equal(opusSlots[0].executionId, 'inv-opus-b', 'the slot this process holds is the one shown');
      assert.equal(opusSlots[0].startedAt, now - 30_000, 'before a run is bound, the running child names the start');
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
