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
});
