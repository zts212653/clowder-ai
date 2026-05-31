import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

const user1AntigOpusPrincipal = {
  kind: 'agent_key',
  agentKeyId: 'ak-user1-antig-opus',
  userId: 'user-1',
  catId: 'antig-opus',
  scope: 'user-bound',
};

const user1AntigravityPrincipal = {
  kind: 'agent_key',
  agentKeyId: 'ak-user1-antigravity',
  userId: 'user-1',
  catId: 'antigravity',
  scope: 'user-bound',
};

const user2AntigOpusPrincipal = {
  kind: 'agent_key',
  agentKeyId: 'ak-user2-antig-opus',
  userId: 'user-2',
  catId: 'antig-opus',
  scope: 'user-bound',
};

function payloadFor(runtimeSessionId, catId, overrides = {}) {
  return {
    runtime: 'antigravity-desktop',
    runtimeSessionId,
    runtimeConversationId: `conversation-${runtimeSessionId}`,
    catId,
    model: catId === 'antigravity' ? 'gemini-3.1-pro' : 'claude-opus-4-6',
    title: `IDE ${runtimeSessionId}`,
    startedAt: 1000,
    lastObservedAt: 1000,
    provenance: { source: 'antigravity-ide-direct' },
    ...overrides,
  };
}

describe('external runtime sessions API routes', () => {
  let app;
  let sessionChainStore;
  let runtimeSessionStore;
  let threadStore;
  let user1Session;
  let user2Session;
  let user1OtherCatSession;

  beforeEach(async () => {
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { RuntimeSessionStore } = await import(
      '../dist/domains/cats/services/runtime-session/RuntimeSessionStore.js'
    );
    const { registerExternalRuntimeSession } = await import(
      '../dist/domains/cats/services/runtime-session/ExternalRuntimeSessionRegistration.js'
    );
    const { externalRuntimeSessionsRoutes } = await import('../dist/routes/external-runtime-sessions.js');

    sessionChainStore = new SessionChainStore();
    runtimeSessionStore = new RuntimeSessionStore();
    threadStore = new ThreadStore();

    user1Session = await registerExternalRuntimeSession(
      payloadFor('cascade-user1-opus', 'antig-opus', { lastObservedAt: 3000 }),
      user1AntigOpusPrincipal,
      { sessionChainStore, runtimeSessionStore, threadStore, now: () => 4000 },
    );
    user2Session = await registerExternalRuntimeSession(
      payloadFor('cascade-user2-opus', 'antig-opus', { lastObservedAt: 5000 }),
      user2AntigOpusPrincipal,
      { sessionChainStore, runtimeSessionStore, threadStore, now: () => 6000 },
    );
    user1OtherCatSession = await registerExternalRuntimeSession(
      payloadFor('cascade-user1-gemini', 'antigravity', { lastObservedAt: 7000 }),
      user1AntigravityPrincipal,
      { sessionChainStore, runtimeSessionStore, threadStore, now: () => 8000 },
    );

    app = Fastify();
    await app.register(externalRuntimeSessionsRoutes, {
      sessionChainStore,
      runtimeSessionStore,
      threadStore,
    });
  });

  test('list returns only sessions owned by the requesting user and caller cat', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/external-runtime-sessions?runtime=antigravity-desktop&limit=10',
      headers: { 'x-cat-cafe-user': 'user-1', 'x-cat-id': 'antig-opus' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(
      body.sessions.map((entry) => entry.sessionId),
      [user1Session.sessionId],
    );
    assert.equal(body.sessions[0].runtimeSessionId, 'cascade-user1-opus');
    assert.equal(body.sessions[0].binding.mode, 'orphan_anchor');
    assert.equal(body.sessions[0].drilldown.digest, `/api/sessions/${user1Session.sessionId}/digest`);
  });

  test('list keeps scanning recent pages until it finds readable sessions for the caller', async () => {
    const { registerExternalRuntimeSession } = await import(
      '../dist/domains/cats/services/runtime-session/ExternalRuntimeSessionRegistration.js'
    );

    for (let index = 0; index < 201; index += 1) {
      await registerExternalRuntimeSession(
        payloadFor(`cascade-busy-user2-${index}`, 'antig-opus', {
          lastObservedAt: 10000 + index,
        }),
        user2AntigOpusPrincipal,
        { sessionChainStore, runtimeSessionStore, threadStore, now: () => 20000 + index },
      );
    }

    const res = await app.inject({
      method: 'GET',
      url: '/api/external-runtime-sessions?runtime=antigravity-desktop&limit=1',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(
      body.sessions.map((entry) => entry.sessionId),
      [user1OtherCatSession.sessionId],
    );
  });

  test('x-cat-id cannot enumerate another cat runtime sessions', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/external-runtime-sessions?runtime=antigravity-desktop&catId=antigravity',
      headers: { 'x-cat-cafe-user': 'user-1', 'x-cat-id': 'antig-opus' },
    });

    assert.equal(res.statusCode, 403);
  });

  test('read returns metadata and rejects another user', async () => {
    await runtimeSessionStore.updateLifecycle(user1OtherCatSession.sessionId, {
      state: 'sealed',
      sealReason: 'runtime_disconnected',
      drainResult: 'complete',
      lastObservedAt: 7100,
    });

    const ok = await app.inject({
      method: 'GET',
      url: `/api/external-runtime-sessions/${user1OtherCatSession.sessionId}`,
      headers: { 'x-cat-cafe-user': 'user-1', 'x-cat-id': 'antigravity' },
    });
    assert.equal(ok.statusCode, 200);
    const body = JSON.parse(ok.body);
    assert.equal(body.sessionId, user1OtherCatSession.sessionId);
    assert.equal(body.runtimeSessionId, 'cascade-user1-gemini');
    assert.equal(body.model, 'gemini-3.1-pro');
    assert.deepEqual(body.identityHistory, [
      {
        catId: 'antigravity',
        model: 'gemini-3.1-pro',
        from: 1000,
        source: 'external_registration',
      },
    ]);
    assert.equal(body.lifecycle.state, 'sealed');
    assert.equal(body.lifecycle.sealReason, 'runtime_disconnected');
    assert.equal(body.lifecycle.drainResult, 'complete');
    assert.equal(body.drilldown.sessionRecord, `/api/sessions/${user1OtherCatSession.sessionId}`);
    assert.equal(body.drilldown.events, `/api/sessions/${user1OtherCatSession.sessionId}/events`);
    assert.equal(body.drilldown.digest, `/api/sessions/${user1OtherCatSession.sessionId}/digest`);

    const denied = await app.inject({
      method: 'GET',
      url: `/api/external-runtime-sessions/${user1Session.sessionId}`,
      headers: { 'x-cat-cafe-user': 'user-2', 'x-cat-id': 'antig-opus' },
    });
    assert.equal(denied.statusCode, 403);

    const otherUserOwn = await app.inject({
      method: 'GET',
      url: `/api/external-runtime-sessions/${user2Session.sessionId}`,
      headers: { 'x-cat-cafe-user': 'user-2', 'x-cat-id': 'antig-opus' },
    });
    assert.equal(otherUserOwn.statusCode, 200);
  });

  test('list and read allow sessions explicitly bound to the shared default thread', async () => {
    const { registerExternalRuntimeSession } = await import(
      '../dist/domains/cats/services/runtime-session/ExternalRuntimeSessionRegistration.js'
    );
    const { DEFAULT_THREAD_ID } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const defaultThreadSession = await registerExternalRuntimeSession(
      payloadFor('cascade-user1-default-thread', 'antig-opus', {
        lastObservedAt: 9000,
        binding: { mode: 'thread', threadId: DEFAULT_THREAD_ID },
      }),
      user1AntigOpusPrincipal,
      { sessionChainStore, runtimeSessionStore, threadStore, now: () => 10000 },
    );

    const listed = await app.inject({
      method: 'GET',
      url: '/api/external-runtime-sessions?runtime=antigravity-desktop&limit=5',
      headers: { 'x-cat-cafe-user': 'user-1', 'x-cat-id': 'antig-opus' },
    });

    assert.equal(listed.statusCode, 200);
    const listedBody = JSON.parse(listed.body);
    const listedDefaultThreadSession = listedBody.sessions.find(
      (session) => session.sessionId === defaultThreadSession.sessionId,
    );
    assert.ok(listedDefaultThreadSession);
    assert.equal(listedDefaultThreadSession.threadId, DEFAULT_THREAD_ID);
    assert.deepEqual(listedDefaultThreadSession.binding, {
      mode: 'thread',
      threadId: DEFAULT_THREAD_ID,
      requestedBy: 'agent_key',
    });

    const read = await app.inject({
      method: 'GET',
      url: `/api/external-runtime-sessions/${defaultThreadSession.sessionId}`,
      headers: { 'x-cat-cafe-user': 'user-1', 'x-cat-id': 'antig-opus' },
    });

    assert.equal(read.statusCode, 200);
    const readBody = JSON.parse(read.body);
    assert.equal(readBody.sessionId, defaultThreadSession.sessionId);
    assert.equal(readBody.threadId, DEFAULT_THREAD_ID);
  });

  // F211-REG1: Cat-Cafe-dispatched Antigravity sessions are written by
  // syncAntigravityRuntimeMetadata with surface 'cat-cafe-dispatch' (NOT via
  // registerExternalRuntimeSession). They must be visible in the runtime-sessions
  // list and readable in detail; otherwise the user cannot find the dispatched
  // Bengal session or its cascadeId (the 2026-05-28 "看不到他的 id" regression).
  async function seedDispatchSession({ runtimeSessionId, threadTitle, lastObservedAt }) {
    const thread = threadStore.create('user-1', threadTitle);
    const rec = await sessionChainStore.create({
      cliSessionId: runtimeSessionId,
      threadId: thread.id,
      catId: 'antig-opus',
      userId: 'user-1',
    });
    await runtimeSessionStore.upsert({
      sessionId: rec.id,
      runtime: 'antigravity-desktop',
      runtimeSessionId,
      threadId: thread.id,
      catId: 'antig-opus',
      userId: 'user-1',
      surface: 'cat-cafe-dispatch',
      identityHistory: [{ catId: 'antig-opus', model: 'claude-opus-4-6', from: 1000, source: 'session_init' }],
      lifecycle: { state: 'active', startedAt: 1000, lastObservedAt },
    });
    return { thread, rec };
  }

  test('list surfaces Cat-Cafe-dispatched sessions, not only ide-direct (F211-REG1)', async () => {
    const { rec } = await seedDispatchSession({
      runtimeSessionId: 'cascade-dispatch-1',
      threadTitle: 'dispatched bengal',
      lastObservedAt: 12000,
    });

    const listed = await app.inject({
      method: 'GET',
      url: '/api/external-runtime-sessions?runtime=antigravity-desktop&limit=10',
      headers: { 'x-cat-cafe-user': 'user-1', 'x-cat-id': 'antig-opus' },
    });

    assert.equal(listed.statusCode, 200);
    const body = JSON.parse(listed.body);
    const dispatched = body.sessions.find((session) => session.sessionId === rec.id);
    assert.ok(dispatched, 'dispatched session must appear in the runtime sessions list');
    assert.equal(dispatched.surface, 'cat-cafe-dispatch');
    assert.equal(dispatched.runtimeSessionId, 'cascade-dispatch-1');
  });

  test('read returns Cat-Cafe-dispatched session metadata, not 404 (F211-REG1)', async () => {
    const { rec } = await seedDispatchSession({
      runtimeSessionId: 'cascade-dispatch-2',
      threadTitle: 'dispatched bengal read',
      lastObservedAt: 13000,
    });

    const read = await app.inject({
      method: 'GET',
      url: `/api/external-runtime-sessions/${rec.id}`,
      headers: { 'x-cat-cafe-user': 'user-1', 'x-cat-id': 'antig-opus' },
    });

    assert.equal(read.statusCode, 200, 'dispatched session must be readable in detail');
    const body = JSON.parse(read.body);
    assert.equal(body.sessionId, rec.id);
    assert.equal(body.surface, 'cat-cafe-dispatch');
    assert.equal(body.runtimeSessionId, 'cascade-dispatch-2');
  });

  test('list scans per-surface so a cat-scoped query is not diluted by other cats (F211-REG1 cloud-P1)', async () => {
    // Reproduces the Redis pagination regression cloud Codex flagged: a global (no-surface)
    // listRecent page can be diluted by another cat's newer sessions, so the requested cat's
    // session lives beyond the first page. Dropping the surface filter made the route query the
    // global index + post-hoc catId filter, so the page came back sparse and the loop broke
    // early — hiding the session. The route must scan per-surface (dense indexes) instead.
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { externalRuntimeSessionsRoutes } = await import('../dist/routes/external-runtime-sessions.js');

    const chain = new SessionChainStore();
    const threads = new ThreadStore();
    const thread = threads.create('user-1', 'dispatched bengal diluted');
    const rec = await chain.create({
      cliSessionId: 'cascade-diluted',
      threadId: thread.id,
      catId: 'antig-opus',
      userId: 'user-1',
    });
    const dispatchRecord = {
      sessionId: rec.id,
      runtime: 'antigravity-desktop',
      runtimeSessionId: 'cascade-diluted',
      threadId: thread.id,
      catId: 'antig-opus',
      userId: 'user-1',
      surface: 'cat-cafe-dispatch',
      identityHistory: [{ catId: 'antig-opus', model: 'claude-opus-4-6', from: 1000, source: 'session_init' }],
      lifecycle: { state: 'active', startedAt: 1000, lastObservedAt: 1000 },
    };

    // Stub store mimicking the RedisRuntimeSessionStore index behavior: the global runtime zset
    // (no surface) returns a diluted/empty page at offset 0, while the surface-scoped index is dense.
    const stubStore = {
      listRecent: async ({ surface, catId }) => {
        if (!surface) return []; // global page diluted: cat's session is beyond offset 0
        if (surface === 'cat-cafe-dispatch' && catId === 'antig-opus') return [dispatchRecord];
        return [];
      },
      getBySessionId: async (id) => (id === dispatchRecord.sessionId ? dispatchRecord : null),
    };

    const dilutedApp = Fastify();
    await dilutedApp.register(externalRuntimeSessionsRoutes, {
      sessionChainStore: chain,
      runtimeSessionStore: stubStore,
      threadStore: threads,
    });

    const res = await dilutedApp.inject({
      method: 'GET',
      url: '/api/external-runtime-sessions?runtime=antigravity-desktop&limit=10',
      headers: { 'x-cat-cafe-user': 'user-1', 'x-cat-id': 'antig-opus' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(
      body.sessions.some((session) => session.sessionId === dispatchRecord.sessionId),
      'per-surface scan must surface a cat session that a diluted global page would hide',
    );
  });

  test('optional surface query filter still narrows to ide-direct when requested (F211-REG1)', async () => {
    await seedDispatchSession({
      runtimeSessionId: 'cascade-dispatch-3',
      threadTitle: 'dispatched bengal filtered out',
      lastObservedAt: 14000,
    });

    const listed = await app.inject({
      method: 'GET',
      url: '/api/external-runtime-sessions?runtime=antigravity-desktop&surface=ide-direct&limit=10',
      headers: { 'x-cat-cafe-user': 'user-1', 'x-cat-id': 'antig-opus' },
    });

    assert.equal(listed.statusCode, 200);
    const body = JSON.parse(listed.body);
    assert.ok(
      body.sessions.every((session) => session.surface !== 'cat-cafe-dispatch'),
      'surface=ide-direct filter must exclude dispatched sessions',
    );
    assert.ok(
      body.sessions.some((session) => session.sessionId === user1Session.sessionId),
      'surface=ide-direct filter must keep ide-direct sessions',
    );
  });
});
