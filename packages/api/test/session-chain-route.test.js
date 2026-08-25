/**
 * Session Chain Route Tests
 * F24: GET /api/threads/:threadId/sessions, GET /api/sessions/:sessionId
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

/** Minimal mock threadStore for auth tests */
function mockThreadStore(threads = {}, indexedByUser = {}) {
  return {
    get: async (id) => threads[id] ?? null,
    list: async (userId) =>
      Object.values(threads).filter(
        (thread) =>
          thread.createdBy === userId || thread.id === 'default' || (indexedByUser[userId] ?? []).includes(thread.id),
      ),
    create: async () => {},
    update: async () => null,
    delete: async () => false,
  };
}

describe('Session Chain Routes', () => {
  let app;
  let SessionChainStore;
  let sessionChainRoutes;

  async function setup(
    threadStoreOverride,
    sealerOverride,
    runtimeSessionStoreOverride,
    isSessionSwitchBusy,
    invocationTrackerOverride,
    resolveSessionSealLiveness = async () => ({ catIds: [], complete: true }),
  ) {
    const storeMod = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const routeMod = await import('../dist/routes/session-chain.js');
    SessionChainStore = storeMod.SessionChainStore;
    sessionChainRoutes = routeMod.sessionChainRoutes;

    const store = new SessionChainStore();
    const threadStore =
      threadStoreOverride ??
      mockThreadStore({
        'thread-1': { id: 'thread-1', createdBy: 'user-1' },
        'unknown-thread': { id: 'unknown-thread', createdBy: 'user-1' },
      });
    app = Fastify();
    const mockSealer = sealerOverride ?? {
      requestSeal: async ({ sessionId, reason }) => {
        const session = store.get(sessionId);
        if (!session || session.status !== 'active') return { accepted: false, status: session?.status ?? 'sealed' };
        store.update(sessionId, { status: 'sealing', sealReason: reason, updatedAt: Date.now() });
        return { accepted: true, status: 'sealing', sessionId };
      },
      finalize: async ({ sessionId }) => {
        const session = store.get(sessionId);
        if (session?.status === 'sealing') {
          store.update(sessionId, { status: 'sealed', sealedAt: Date.now(), updatedAt: Date.now() });
        }
        return { sealed: true, clean: true };
      },
      reconcileStuck: async () => 0,
      reconcileAllStuck: async () => 0,
    };
    await app.register(sessionChainRoutes, {
      sessionChainStore: store,
      threadStore,
      sessionSealer: mockSealer,
      ...(runtimeSessionStoreOverride ? { runtimeSessionStore: runtimeSessionStoreOverride } : {}),
      ...(isSessionSwitchBusy ? { isSessionSwitchBusy } : {}),
      ...(invocationTrackerOverride ? { invocationTracker: invocationTrackerOverride } : {}),
      resolveSessionSealLiveness,
    });
    await app.ready();
    return store;
  }

  // --- P1: Auth / identity tests ---

  it('GET /api/threads/:threadId/sessions returns 401 without identity for untrusted browser origin', async () => {
    await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-1/sessions',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('GET /api/sessions/:sessionId returns 401 without identity for untrusted browser origin', async () => {
    const store = await setup();
    const record = store.create({ cliSessionId: 'cli-1', threadId: 'thread-1', catId: 'opus', userId: 'user-1' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}`,
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('GET /api/threads/:threadId/sessions returns 403 when user is not thread owner', async () => {
    await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-1/sessions',
      headers: { 'x-cat-cafe-user': 'other-user' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('GET /api/sessions/:sessionId returns 403 when user is not thread owner', async () => {
    const store = await setup();
    const record = store.create({ cliSessionId: 'cli-1', threadId: 'thread-1', catId: 'opus', userId: 'user-1' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}`,
      headers: { 'x-cat-cafe-user': 'other-user' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('GET /api/threads/default/sessions allows system-owned default thread', async () => {
    const store = await setup(
      mockThreadStore({
        default: { id: 'default', createdBy: 'system' },
      }),
    );
    store.create({ cliSessionId: 'cli-default-1', threadId: 'default', catId: 'opus', userId: 'default-user' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/default/sessions',
      headers: { 'x-cat-cafe-user': 'default-user' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.sessions.length, 1);
  });

  it('GET /api/threads/default/sessions filters default-thread sessions to the caller', async () => {
    const store = await setup(
      mockThreadStore({
        default: { id: 'default', createdBy: 'system' },
      }),
    );
    store.create({ cliSessionId: 'cli-default-owner', threadId: 'default', catId: 'opus', userId: 'owner-user' });
    store.create({ cliSessionId: 'cli-default-other', threadId: 'default', catId: 'codex', userId: 'other-user' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/default/sessions',
      headers: { 'x-cat-cafe-user': 'owner-user' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0].userId, 'owner-user');
  });

  it('GET /api/sessions/:sessionId allows records under system-owned default thread', async () => {
    const store = await setup(
      mockThreadStore({
        default: { id: 'default', createdBy: 'system' },
      }),
    );
    const record = store.create({
      cliSessionId: 'cli-default-2',
      threadId: 'default',
      catId: 'opus',
      userId: 'default-user',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}`,
      headers: { 'x-cat-cafe-user': 'default-user' },
    });
    assert.equal(res.statusCode, 200);
  });

  it('GET /api/sessions/:sessionId rejects other users on system-owned default thread', async () => {
    const store = await setup(
      mockThreadStore({
        default: { id: 'default', createdBy: 'system' },
      }),
    );
    const record = store.create({
      cliSessionId: 'cli-default-owner',
      threadId: 'default',
      catId: 'opus',
      userId: 'owner-user',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}`,
      headers: { 'x-cat-cafe-user': 'attacker-user' },
    });

    assert.equal(res.statusCode, 403);
  });

  it('GET /api/threads/:threadId/sessions rejects system-owned non-default threads', async () => {
    await setup(
      mockThreadStore({
        'system-thread': { id: 'system-thread', createdBy: 'system' },
      }),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/system-thread/sessions',
      headers: { 'x-cat-cafe-user': 'other-user' },
    });

    assert.equal(res.statusCode, 403);
  });

  it('GET /api/threads/:threadId/sessions allows a user-indexed system thread and filters records by user', async () => {
    const store = await setup(
      mockThreadStore(
        {
          thread_eval_friction: { id: 'thread_eval_friction', createdBy: 'system' },
        },
        { 'owner-user': ['thread_eval_friction'] },
      ),
    );
    store.create({
      cliSessionId: 'cli-indexed-owner',
      threadId: 'thread_eval_friction',
      catId: 'opus',
      userId: 'owner-user',
    });
    store.create({
      cliSessionId: 'cli-indexed-other',
      threadId: 'thread_eval_friction',
      catId: 'codex',
      userId: 'other-user',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/thread_eval_friction/sessions',
      headers: { 'x-cat-cafe-user': 'owner-user' },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      res.json().sessions.map((session) => session.cliSessionId),
      ['cli-indexed-owner'],
    );
  });

  // --- Normal happy-path tests (with identity) ---

  it('GET /api/threads/:threadId/sessions returns empty array for unknown thread', async () => {
    await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/unknown-thread/sessions',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.deepEqual(body.sessions, []);
  });

  it('GET /api/threads/:threadId/sessions returns all sessions', async () => {
    const store = await setup();
    store.create({ cliSessionId: 'cli-1', threadId: 'thread-1', catId: 'opus', userId: 'user-1' });
    store.create({ cliSessionId: 'cli-2', threadId: 'thread-1', catId: 'codex', userId: 'user-1' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-1/sessions',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.sessions.length, 2);
  });

  it('GET /api/threads/:threadId/sessions includes runtime sidecar summaries when present', async () => {
    const { RuntimeSessionStore } = await import(
      '../dist/domains/cats/services/runtime-session/RuntimeSessionStore.js'
    );
    const runtimeSessionStore = new RuntimeSessionStore();
    const store = await setup(undefined, undefined, runtimeSessionStore);
    const record = store.create({
      cliSessionId: 'cascade-new',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user-1',
    });
    runtimeSessionStore.upsert({
      sessionId: record.id,
      runtime: 'antigravity-desktop',
      runtimeSessionId: 'cascade-new',
      runtimeConversationId: 'conversation-new',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user-1',
      surface: 'cat-cafe-dispatch',
      identityHistory: [{ catId: 'opus', model: 'claude-opus-4-6', from: 1000, source: 'session_init' }],
      lifecycle: {
        state: 'active',
        startedAt: 1000,
        lastObservedAt: 2000,
        retryFragment: {
          kind: 'retry',
          retryReason: 'tool_conflict',
          nextRuntimeSessionId: 'cascade-next',
          detectedAt: 2000,
        },
        unexpectedRuntimeSessionSwitch: {
          detectedAt: 2000,
          previousSessionId: 'session-old',
          previousRuntimeSessionId: 'cascade-old',
          currentRuntimeSessionId: 'cascade-new',
          reason: 'missing_previous_runtime_session_id',
        },
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-1/sessions',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.sessions.length, 1);
    assert.deepEqual(body.sessions[0].runtimeSession, {
      runtime: 'antigravity-desktop',
      runtimeSessionId: 'cascade-new',
      runtimeConversationId: 'conversation-new',
      lifecycleState: 'active',
      lastObservedAt: 2000,
      retryFragment: {
        kind: 'retry',
        retryReason: 'tool_conflict',
        nextRuntimeSessionId: 'cascade-next',
        detectedAt: 2000,
      },
      unexpectedRuntimeSessionSwitch: {
        detectedAt: 2000,
        previousSessionId: 'session-old',
        previousRuntimeSessionId: 'cascade-old',
        currentRuntimeSessionId: 'cascade-new',
        reason: 'missing_previous_runtime_session_id',
      },
    });
  });

  it('GET /api/threads/:threadId/sessions keeps legacy CLI sessions independent from runtime sidecars', async () => {
    const { RuntimeSessionStore } = await import(
      '../dist/domains/cats/services/runtime-session/RuntimeSessionStore.js'
    );
    const runtimeSessionStore = new RuntimeSessionStore();
    const store = await setup(undefined, undefined, runtimeSessionStore);
    store.create({ cliSessionId: 'cli-legacy-1', threadId: 'thread-1', catId: 'opus', userId: 'user-1' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-1/sessions',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0].cliSessionId, 'cli-legacy-1');
    assert.equal(body.sessions[0].runtimeSession, undefined);
  });

  it('GET /api/threads/:threadId/sessions?catId=opus filters by cat', async () => {
    const store = await setup();
    store.create({ cliSessionId: 'cli-1', threadId: 'thread-1', catId: 'opus', userId: 'user-1' });
    store.create({ cliSessionId: 'cli-2', threadId: 'thread-1', catId: 'codex', userId: 'user-1' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-1/sessions?catId=opus',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0].catId, 'opus');
  });

  it('GET /api/sessions/:sessionId returns session record', async () => {
    const store = await setup();
    const record = store.create({ cliSessionId: 'cli-1', threadId: 'thread-1', catId: 'opus', userId: 'user-1' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.id, record.id);
    assert.equal(body.catId, 'opus');
    assert.equal(body.status, 'active');
  });

  it('GET /api/sessions/:sessionId returns 404 for unknown session', async () => {
    await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/non-existent-id',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.payload);
    assert.ok(body.error);
  });

  it('sessions include contextHealth when set', async () => {
    const store = await setup();
    const record = store.create({ cliSessionId: 'cli-1', threadId: 'thread-1', catId: 'opus', userId: 'user-1' });
    store.update(record.id, {
      contextHealth: {
        usedTokens: 50000,
        windowTokens: 200000,
        fillRatio: 0.25,
        source: 'exact',
        measuredAt: Date.now(),
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    const body = JSON.parse(res.payload);
    assert.ok(body.contextHealth);
    assert.equal(body.contextHealth.fillRatio, 0.25);
    assert.equal(body.contextHealth.source, 'exact');
  });

  it('POST /api/sessions/:sessionId/seal seals an idle owned active session and the next activation gets a new record', async () => {
    const store = await setup();
    const active = store.create({ cliSessionId: 'cli-active', threadId: 'thread-1', catId: 'opus', userId: 'user-1' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${active.id}/seal`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.mode, 'sealed');
    assert.equal(body.session.id, active.id);
    assert.equal(body.session.status, 'sealed');
    assert.equal(body.session.sealReason, 'manual');
    assert.equal(store.getActive('opus', 'thread-1'), null);

    const next = store.create({ cliSessionId: 'cli-next', threadId: 'thread-1', catId: 'opus', userId: 'user-1' });
    assert.equal(next.status, 'active');
    assert.equal(next.seq, active.seq + 1);
    assert.notEqual(next.id, active.id);
  });

  it('POST /api/sessions/:sessionId/seal rejects a caller without session access', async () => {
    const store = await setup();
    const active = store.create({ cliSessionId: 'cli-private', threadId: 'thread-1', catId: 'opus', userId: 'user-1' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${active.id}/seal`,
      headers: { 'x-cat-cafe-user': 'other-user' },
    });

    assert.equal(res.statusCode, 403);
    assert.equal(store.get(active.id).status, 'active');
  });

  it('POST /api/sessions/:sessionId/seal rejects an active invocation without changing the session', async () => {
    const invocationTracker = {
      has: (threadId, catId) => threadId === 'thread-1' && catId === 'opus',
    };
    const store = await setup(undefined, undefined, undefined, undefined, invocationTracker);
    const active = store.create({ cliSessionId: 'cli-running', threadId: 'thread-1', catId: 'opus', userId: 'user-1' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${active.id}/seal`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 409);
    const body = JSON.parse(res.payload);
    assert.equal(body.code, 'SESSION_ACTIVE_INVOCATION');
    assert.equal(store.get(active.id).status, 'active');
    assert.equal(store.getChain('opus', 'thread-1').length, 1);
  });

  it('POST /api/sessions/:sessionId/seal rejects an active invocation owned by another runtime identity', async () => {
    const invocationTracker = {
      has: (threadId, catId) => threadId === 'thread-1' && catId === 'opus',
      // A2A and scheduled turns are not initiated with the browser caller's identity.
      getUserId: () => 'unknown',
    };
    const store = await setup(undefined, undefined, undefined, undefined, invocationTracker);
    const active = store.create({
      cliSessionId: 'cli-running-a2a',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user-1',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${active.id}/seal`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(res.payload).code, 'SESSION_ACTIVE_INVOCATION');
    assert.equal(store.get(active.id).status, 'active');
  });

  it('POST /api/sessions/:sessionId/seal rejects durable live work after process-local tracker loss', async () => {
    const tracker = { has: () => false };
    const durableLiveness = async () => ({ catIds: ['opus'], complete: true });
    const store = await setup(undefined, undefined, undefined, undefined, tracker, durableLiveness);
    const active = store.create({
      cliSessionId: 'cli-running-after-restart',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user-1',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${active.id}/seal`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(res.payload).code, 'SESSION_ACTIVE_INVOCATION');
    assert.equal(store.get(active.id).status, 'active');
  });

  it('POST /api/sessions/:sessionId/seal fails closed when durable liveness is incomplete', async () => {
    const store = await setup(undefined, undefined, undefined, undefined, { has: () => false }, async () => ({
      catIds: [],
      complete: false,
    }));
    const active = store.create({
      cliSessionId: 'cli-liveness-unknown',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user-1',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${active.id}/seal`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 503);
    assert.equal(JSON.parse(res.payload).code, 'SESSION_LIVENESS_UNAVAILABLE');
    assert.equal(store.get(active.id).status, 'active');
  });

  it('POST /api/sessions/:sessionId/seal returns a conflict when requestSeal loses its CAS race', async () => {
    let store;
    const racingSealer = {
      requestSeal: async ({ sessionId }) => {
        store.update(sessionId, {
          status: 'sealed',
          sealReason: 'threshold',
          sealedAt: Date.now(),
          updatedAt: Date.now(),
        });
        return { accepted: false, status: 'sealed' };
      },
      finalize: async () => {
        throw new Error('must not finalize after a rejected seal');
      },
    };
    store = await setup(undefined, racingSealer);
    const active = store.create({ cliSessionId: 'cli-race', threadId: 'thread-1', catId: 'opus', userId: 'user-1' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${active.id}/seal`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 409);
    const body = JSON.parse(res.payload);
    assert.equal(body.code, 'SESSION_SEAL_RACE');
    assert.equal(body.currentStatus, 'sealed');
    assert.equal(store.getChain('opus', 'thread-1').length, 1);
  });

  it('POST /api/sessions/:sessionId/seal holds the exact tracker slot until the active pointer is cleared', async () => {
    const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
    const tracker = new InvocationTracker();
    let store;
    let blockedDuringClaim;
    let admittedAfterClaim;
    const sealer = {
      requestSeal: async ({ sessionId, reason }) => {
        blockedDuringClaim = tracker.startAll('thread-1', ['opus'], 'user-1');
        const claimed = store.transitionToSealing(sessionId, reason);
        return claimed ? { accepted: true, status: 'sealing', sessionId } : { accepted: false, status: 'sealed' };
      },
      finalize: async ({ sessionId }) => {
        admittedAfterClaim = tracker.startAll('thread-1', ['opus'], 'user-1');
        assert.ok(admittedAfterClaim);
        store.update(sessionId, { status: 'sealed', sealedAt: Date.now(), updatedAt: Date.now() });
        tracker.completeAll('thread-1', ['opus'], admittedAfterClaim);
        return { sealed: true, clean: true };
      },
    };
    store = await setup(undefined, sealer, undefined, undefined, tracker);
    const active = store.create({
      cliSessionId: 'cli-slot-guard',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user-1',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${active.id}/seal`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(blockedDuringClaim, null, 'new work must not be admitted while the seal CAS owns the slot');
    assert.equal(admittedAfterClaim.signal.aborted, false, 'new work may start after the pointer is cleared');
  });

  it('POST /api/sessions/:sessionId/seal reports a partial terminal seal instead of success', async () => {
    let store;
    const partialSealer = {
      requestSeal: async ({ sessionId, reason }) => {
        const claimed = store.transitionToSealing(sessionId, reason);
        return claimed ? { accepted: true, status: 'sealing', sessionId } : { accepted: false, status: 'sealed' };
      },
      finalize: async ({ sessionId }) => {
        store.update(sessionId, { status: 'sealed', sealedAt: Date.now(), updatedAt: Date.now() });
        return { sealed: true, clean: false };
      },
    };
    store = await setup(undefined, partialSealer);
    const active = store.create({ cliSessionId: 'cli-partial', threadId: 'thread-1', catId: 'opus', userId: 'user-1' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${active.id}/seal`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 503);
    assert.equal(JSON.parse(res.payload).code, 'SESSION_SEAL_PARTIAL');
    assert.equal(store.get(active.id).status, 'sealed');
  });

  it('POST /api/sessions/:sessionId/unseal returns 401 without identity for untrusted browser origin', async () => {
    const store = await setup();
    const sealed = store.create({ cliSessionId: 'cli-sealed', threadId: 'thread-1', catId: 'opus', userId: 'user-1' });
    store.update(sealed.id, { status: 'sealed', sealReason: 'threshold', sealedAt: Date.now(), updatedAt: Date.now() });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sealed.id}/unseal`,
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('POST /api/sessions/:sessionId/unseal returns 404 for unknown session', async () => {
    await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/non-existent-id/unseal',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('POST /api/sessions/:sessionId/unseal returns 404 when thread no longer exists', async () => {
    const store = await setup();
    const dangling = store.create({
      cliSessionId: 'cli-dangling',
      threadId: 'ghost-thread',
      catId: 'opus',
      userId: 'user-1',
    });
    store.update(dangling.id, {
      status: 'sealed',
      sealReason: 'threshold',
      sealedAt: Date.now(),
      updatedAt: Date.now(),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${dangling.id}/unseal`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.payload);
    assert.equal(body.error, 'Thread not found');
  });

  it('POST /api/sessions/:sessionId/unseal restores the selected record in place when no active session exists', async () => {
    const store = await setup();
    const sealed = store.create({ cliSessionId: 'cli-reopen', threadId: 'thread-1', catId: 'opus', userId: 'user-1' });
    store.update(sealed.id, { status: 'sealed', sealReason: 'threshold', sealedAt: Date.now(), updatedAt: Date.now() });
    assert.equal(store.getActive('opus', 'thread-1'), null);

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sealed.id}/unseal`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.mode, 'restored');
    assert.equal(body.session.id, sealed.id);
    assert.equal(body.session.status, 'active');
    assert.equal(body.session.cliSessionId, 'cli-reopen');
    assert.equal(body.session.seq, 0);
    assert.equal(store.getChain('opus', 'thread-1').length, 1);
  });

  it('POST /api/sessions/:sessionId/unseal restores over an explicitly confirmed empty active session', async () => {
    // Displaced finalize is async fire-and-forget in prod. Pin a no-op sealer so
    // the displaced record stays observable in its intermediate 'sealing' state.
    const store = await setup(undefined, {
      requestSeal: async () => ({ accepted: true }),
      finalize: async () => ({ sealed: false, clean: false }),
      reconcileStuck: async () => 0,
      reconcileAllStuck: async () => 0,
    });
    const sealed = store.create({ cliSessionId: 'cli-old', threadId: 'thread-1', catId: 'opus', userId: 'user-1' });
    store.update(sealed.id, { status: 'sealed', sealReason: 'threshold', sealedAt: Date.now(), updatedAt: Date.now() });
    // Empty active session is preserved as a separate sealing record.
    const active = store.create({ cliSessionId: 'cli-new', threadId: 'thread-1', catId: 'opus', userId: 'user-1' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sealed.id}/unseal`,
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { expectedActiveSessionId: active.id },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.mode, 'restored');
    assert.equal(body.session.id, sealed.id);
    assert.equal(store.get(active.id).status, 'sealing');
  });

  it('POST /api/sessions/:sessionId/unseal returns 409 on CAS race during displacement', async () => {
    const store = await setup();
    const sealed = store.create({ cliSessionId: 'cli-old', threadId: 'thread-1', catId: 'opus', userId: 'user-1' });
    store.update(sealed.id, { status: 'sealed', sealReason: 'threshold', sealedAt: Date.now(), updatedAt: Date.now() });
    // The store-level CAS rejects after route-level confirmation succeeds.
    const active = store.create({ cliSessionId: 'cli-new', threadId: 'thread-1', catId: 'opus', userId: 'user-1' });
    store.restoreActiveSession = () => ({ status: 'active_changed', activeSessionId: active.id });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sealed.id}/unseal`,
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { expectedActiveSessionId: active.id },
    });
    assert.equal(res.statusCode, 409);
    const body = JSON.parse(res.payload);
    assert.equal(body.code, 'active_session_changed');
  });

  it('POST /api/sessions/:sessionId/unseal requires explicit confirmation when another session is active', async () => {
    const store = await setup();
    const sealed = store.create({ cliSessionId: 'cli-old', threadId: 'thread-1', catId: 'opus', userId: 'user-1' });
    store.update(sealed.id, { status: 'sealed', sealReason: 'threshold', sealedAt: Date.now(), updatedAt: Date.now() });
    const active = store.create({ cliSessionId: 'cli-new', threadId: 'thread-1', catId: 'opus', userId: 'user-1' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sealed.id}/unseal`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 409);
    const body = JSON.parse(res.payload);
    assert.equal(body.code, 'active_session_confirmation_required');
    assert.equal(body.activeSessionId, active.id);
  });

  it('POST /api/sessions/:sessionId/unseal refuses to switch while the cat has queued or running work', async () => {
    const store = await setup(undefined, undefined, undefined, () => true);
    const sealed = store.create({ cliSessionId: 'cli-old', threadId: 'thread-1', catId: 'opus', userId: 'user-1' });
    store.update(sealed.id, { status: 'sealed', sealReason: 'threshold', sealedAt: Date.now(), updatedAt: Date.now() });
    const active = store.create({ cliSessionId: 'cli-new', threadId: 'thread-1', catId: 'opus', userId: 'user-1' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sealed.id}/unseal`,
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { expectedActiveSessionId: active.id },
    });

    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(res.payload).code, 'session_switch_busy');
    assert.equal(store.getActive('opus', 'thread-1', 'user-1').id, active.id);
    assert.equal(store.get(sealed.id).status, 'sealed');
  });

  it('POST /api/sessions/:sessionId/unseal refuses busy restoration even when no active record exists', async () => {
    const store = await setup(undefined, undefined, undefined, () => true);
    const sealed = store.create({ cliSessionId: 'cli-only', threadId: 'thread-1', catId: 'opus', userId: 'user-1' });
    store.update(sealed.id, { status: 'sealed', sealReason: 'threshold', sealedAt: Date.now(), updatedAt: Date.now() });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sealed.id}/unseal`,
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { expectedActiveSessionId: null },
    });

    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(res.payload).code, 'session_switch_busy');
    assert.equal(store.get(sealed.id).status, 'sealed');
  });

  it('POST /api/sessions/:sessionId/unseal explicitly switches to the selected record without deleting active work', async () => {
    // Displaced finalize is async fire-and-forget in prod. Pin a no-op sealer so
    // the displaced record stays observable in its intermediate 'sealing' state.
    const store = await setup(undefined, {
      requestSeal: async () => ({ accepted: true }),
      finalize: async () => ({ sealed: false, clean: false }),
      reconcileStuck: async () => 0,
      reconcileAllStuck: async () => 0,
    });
    const sealed = store.create({ cliSessionId: 'cli-old', threadId: 'thread-1', catId: 'opus', userId: 'user-1' });
    store.update(sealed.id, { status: 'sealed', sealReason: 'threshold', sealedAt: Date.now(), updatedAt: Date.now() });
    // Non-empty active work must be preserved while it is safely sealed.
    const active = store.create({ cliSessionId: 'cli-new', threadId: 'thread-1', catId: 'opus', userId: 'user-1' });
    store.update(active.id, { messageCount: 5 });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sealed.id}/unseal`,
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { expectedActiveSessionId: active.id },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.mode, 'restored');
    assert.equal(body.session.id, sealed.id);
    assert.equal(body.session.seq, 0);
    assert.equal(store.getActive('opus', 'thread-1', 'user-1').id, sealed.id);
    assert.equal(store.get(active.id).status, 'sealing');
    assert.equal(store.get(active.id).sealReason, 'manual_session_switch');
    assert.equal(store.get(active.id).messageCount, 5);
    assert.equal(store.getChain('opus', 'thread-1').length, 2);
  });

  it('POST /api/sessions/:sessionId/unseal rejects system-owned non-default threads', async () => {
    const store = await setup(
      mockThreadStore({
        'system-thread': { id: 'system-thread', createdBy: 'system' },
      }),
    );
    const sealed = store.create({
      cliSessionId: 'cli-system-thread',
      threadId: 'system-thread',
      catId: 'opus',
      userId: 'system',
    });
    store.update(sealed.id, { status: 'sealed', sealReason: 'threshold', sealedAt: Date.now(), updatedAt: Date.now() });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sealed.id}/unseal`,
      headers: { 'x-cat-cafe-user': 'other-user' },
    });

    assert.equal(res.statusCode, 403);
  });

  it('POST /api/sessions/:sessionId/unseal rejects other users on system-owned default thread', async () => {
    const store = await setup(
      mockThreadStore({
        default: { id: 'default', createdBy: 'system' },
      }),
    );
    const sealed = store.create({
      cliSessionId: 'cli-default-sealed',
      threadId: 'default',
      catId: 'opus',
      userId: 'owner-user',
    });
    store.update(sealed.id, {
      status: 'sealed',
      sealReason: 'threshold',
      sealedAt: Date.now(),
      updatedAt: Date.now(),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sealed.id}/unseal`,
      headers: { 'x-cat-cafe-user': 'attacker-user' },
    });

    assert.equal(res.statusCode, 403);
  });
});
