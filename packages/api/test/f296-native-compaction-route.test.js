import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';

async function fixture({ busy = false, cursorChanged = false, enabled = true, providerError } = {}) {
  const [{ nativeSessionControlRoutes }, { SessionChainStore }, { AgentRegistry }, epochModule, epochStoreModule] =
    await Promise.all([
      import('../dist/routes/native-session-control-routes.js'),
      import('../dist/domains/cats/services/stores/ports/SessionChainStore.js'),
      import('../dist/domains/cats/services/agents/registry/AgentRegistry.js'),
      import('../dist/domains/cats/services/session/ContextEpochOwner.js'),
      import('../dist/domains/cats/services/stores/ports/ContextEpochStore.js'),
    ]);
  const app = Fastify();
  const store = new SessionChainStore();
  const agentRegistry = new AgentRegistry();
  const calls = [];
  let deliveryCursorReads = 0;
  agentRegistry.register('codex', {
    async *invoke() {},
    async requestNativeCompaction(input) {
      calls.push(input);
      if (providerError) throw providerError;
      return {
        eventId: 'context-compaction:codex:app_server:native-1:turn-1:item-1',
        runtimeSessionId: 'native-1',
        evidenceRef: 'codex_app_server_context_compaction:native-1:turn-1:item-1',
      };
    },
  });
  const contextEpochOwner = new epochModule.ContextEpochOwner(new epochStoreModule.InMemoryContextEpochStore());
  const threadStore = {
    get: async (id) => (id === 'thread-1' ? { id, createdBy: 'owner-1' } : null),
    list: async () => [],
    create: async () => {},
    update: async () => null,
    delete: async () => false,
  };
  store.create({ cliSessionId: 'native-1', threadId: 'thread-1', catId: 'codex', userId: 'owner-1' });
  await contextEpochOwner.resolve({
    userId: 'owner-1',
    catId: 'codex',
    threadId: 'thread-1',
    disposition: {
      state: 'fresh',
      reason: 'no_prior_session',
      evidenceRef: 'provider:start',
      runtimeSessionId: 'native-1',
    },
  });
  await app.register(nativeSessionControlRoutes, {
    enabled,
    sessionChainStore: store,
    threadStore,
    agentRegistry,
    contextEpochOwner,
    deliveryCursorStore: {
      getCursor: async () => {
        deliveryCursorReads += 1;
        return cursorChanged && deliveryCursorReads > 1
          ? 'v2:0000000000000002:message-2'
          : 'v2:0000000000000001:message-1';
      },
      getSeenCursor: async () => 'v2:0000000000000001:message-1',
    },
    isSessionBusy: () => busy,
  });
  await app.ready();
  return { app, calls };
}

test('native compaction route authenticates the owner and advances the real epoch', async (t) => {
  const { app, calls } = await fixture();
  t.after(() => app.close());
  const anonymousBrowser = await app.inject({
    method: 'POST',
    url: '/api/threads/thread-1/sessions/codex/compact-native',
    headers: { origin: 'http://localhost:3011' },
  });
  assert.equal(anonymousBrowser.statusCode, 401);
  const denied = await app.inject({
    method: 'POST',
    url: '/api/threads/thread-1/sessions/codex/compact-native',
    headers: { 'x-cat-cafe-user': 'other' },
  });
  assert.equal(denied.statusCode, 403);
  const response = await app.inject({
    method: 'POST',
    url: '/api/threads/thread-1/sessions/codex/compact-native',
    headers: { 'x-cat-cafe-user': 'owner-1' },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    outcome: 'observed',
    transition: 'context_compacted',
    replayed: false,
    contextEpoch: 2,
    contextMode: 'cold',
    cursorState: 'preserved',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, 'native-1');
});

test('native compaction route refuses a busy session before provider control', async (t) => {
  const { app, calls } = await fixture({ busy: true });
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/api/threads/thread-1/sessions/codex/compact-native',
    headers: { 'x-cat-cafe-user': 'owner-1' },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, 'NATIVE_SESSION_BUSY');
  assert.equal(calls.length, 0);
});

test('native compaction control is absent outside the explicit Alpha deployment', async (t) => {
  const { app, calls } = await fixture({ enabled: false });
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/api/threads/thread-1/sessions/codex/compact-native',
    headers: { 'x-cat-cafe-user': 'owner-1' },
  });
  assert.equal(response.statusCode, 404);
  assert.equal(calls.length, 0);
});

test('native compaction route maps a host-lease race to bounded unavailability', async (t) => {
  const { app, calls } = await fixture({
    providerError: new Error('session native-1 already has an active host lease'),
  });
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/api/threads/thread-1/sessions/codex/compact-native',
    headers: { 'x-cat-cafe-user': 'owner-1' },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, 'NATIVE_SESSION_UNAVAILABLE');
  assert.equal(calls.length, 1);
});

test('native compaction route fails evidence when a cursor changes across the control boundary', async (t) => {
  const { app } = await fixture({ cursorChanged: true });
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/api/threads/thread-1/sessions/codex/compact-native',
    headers: { 'x-cat-cafe-user': 'owner-1' },
  });
  assert.equal(response.statusCode, 502);
  assert.equal(response.json().code, 'NATIVE_COMPACTION_CURSOR_CHANGED');
});
