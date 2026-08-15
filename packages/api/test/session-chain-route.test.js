/**
 * Session Chain Route Tests
 * F24: GET /api/threads/:threadId/sessions, GET /api/sessions/:sessionId
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

/** Minimal mock threadStore for auth tests */
function mockThreadStore(threads = {}) {
  return {
    get: async (id) => threads[id] ?? null,
    list: async () => Object.values(threads),
    create: async () => {},
    update: async () => null,
    delete: async () => false,
  };
}

describe('Session Chain Routes', () => {
  let app;
  let SessionChainStore;
  let sessionChainRoutes;

  async function setup(threadStoreOverride, sealerOverride, runtimeSessionStoreOverride, isSessionSwitchBusy) {
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
      requestSeal: async () => ({ accepted: true }),
      finalize: async () => {},
      reconcileStuck: async () => 0,
      reconcileAllStuck: async () => 0,
    };
    await app.register(sessionChainRoutes, {
      sessionChainStore: store,
      threadStore,
      sessionSealer: mockSealer,
      ...(runtimeSessionStoreOverride ? { runtimeSessionStore: runtimeSessionStoreOverride } : {}),
      ...(isSessionSwitchBusy ? { isSessionSwitchBusy } : {}),
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
    const store = await setup();
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
    const store = await setup();
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
