import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

function createMockSocketManager() {
  return {
    broadcastAgentMessage() {},
  };
}

function registrationPayload(overrides = {}) {
  return {
    runtime: 'antigravity-desktop',
    runtimeSessionId: 'cascade-route-1',
    runtimeConversationId: 'conversation-route-1',
    catId: 'antig-opus',
    model: 'claude-opus-4-6',
    title: 'IDE direct route test',
    startedAt: 1000,
    lastObservedAt: 1000,
    provenance: {
      source: 'antigravity-ide-direct',
      ideWindowId: 'ide-window-route-1',
    },
    ...overrides,
  };
}

describe('Callback external runtime session registration routes', () => {
  let invocationRegistry;
  let agentKeyRegistry;
  let messageStore;
  let threadStore;
  let sessionChainStore;
  let runtimeSessionStore;
  let auditEvents;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { RuntimeSessionStore } = await import(
      '../dist/domains/cats/services/runtime-session/RuntimeSessionStore.js'
    );

    invocationRegistry = new InvocationRegistry();
    agentKeyRegistry = new AgentKeyRegistry({ ttlMs: 86400000 });
    messageStore = new MessageStore();
    threadStore = new ThreadStore();
    sessionChainStore = new SessionChainStore();
    runtimeSessionStore = new RuntimeSessionStore();
    auditEvents = [];
  });

  async function createApp(overrides = {}) {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry: invocationRegistry,
      agentKeyRegistry,
      messageStore,
      socketManager: createMockSocketManager(),
      threadStore,
      sessionChainStore,
      runtimeSessionStore,
      eventAuditLog: overrides.eventAuditLog ?? {
        append: async (event) => {
          auditEvents.push(event);
          return { id: `audit-${auditEvents.length}`, timestamp: Date.now(), ...event };
        },
      },
    });
    return app;
  }

  async function issueAgentKey(catId = 'antig-opus', userId = 'user-1') {
    return agentKeyRegistry.issue(catId, userId);
  }

  test('agent-key registration creates then updates the same SessionRecord', async () => {
    const app = await createApp();
    const { secret } = await issueAgentKey();

    const first = await app.inject({
      method: 'POST',
      url: '/api/callbacks/external-runtime-sessions/register',
      headers: { 'x-agent-key-secret': secret },
      payload: registrationPayload(),
    });
    assert.equal(first.statusCode, 200);
    const firstBody = JSON.parse(first.body);
    assert.equal(firstBody.status, 'created');
    assert.equal(firstBody.runtimeSessionId, 'cascade-route-1');
    assert.equal(firstBody.binding.mode, 'orphan_anchor');
    assert.ok(firstBody.drilldown.digest.endsWith('/digest'));

    const second = await app.inject({
      method: 'POST',
      url: '/api/callbacks/external-runtime-sessions/register',
      headers: { 'x-agent-key-secret': secret },
      payload: registrationPayload({ lastObservedAt: 3000, runtimeConversationId: 'conversation-route-2' }),
    });
    assert.equal(second.statusCode, 200);
    const secondBody = JSON.parse(second.body);
    assert.equal(secondBody.status, 'updated');
    assert.equal(secondBody.sessionId, firstBody.sessionId);

    assert.equal(sessionChainStore.getChain('antig-opus', firstBody.threadId).length, 1);
    assert.equal((await messageStore.getByThread(firstBody.threadId)).length, 0, 'route must not append chat messages');

    const metadata = runtimeSessionStore.getByRuntimeSession('antigravity-desktop', 'cascade-route-1');
    assert.equal(metadata.runtimeConversationId, 'conversation-route-2');
    assert.equal(metadata.lifecycle.lastObservedAt, 3000);
    assert.equal(auditEvents.length, 2);
    assert.equal(auditEvents[0].type, 'external_runtime_session_registered');
    assert.match(auditEvents[0].data.agentKeyId, /^ak_/);
    assert.equal(auditEvents[0].data.runtimeSessionId, 'cascade-route-1');
    assert.equal(auditEvents[0].data.bindingMode, 'orphan_anchor');
    assert.equal(auditEvents[0].data.sessionId, firstBody.sessionId);
  });

  test('rejects re-registration from a different user for the same runtime session', async () => {
    const app = await createApp();
    const { secret } = await issueAgentKey('antig-opus', 'user-1');
    const { secret: otherUserSecret } = await issueAgentKey('antig-opus', 'user-2');

    const first = await app.inject({
      method: 'POST',
      url: '/api/callbacks/external-runtime-sessions/register',
      headers: { 'x-agent-key-secret': secret },
      payload: registrationPayload(),
    });
    assert.equal(first.statusCode, 200);

    const crossUser = await app.inject({
      method: 'POST',
      url: '/api/callbacks/external-runtime-sessions/register',
      headers: { 'x-agent-key-secret': otherUserSecret },
      payload: registrationPayload({ lastObservedAt: 3000 }),
    });
    assert.equal(crossUser.statusCode, 409);
    assert.equal(JSON.parse(crossUser.body).error, 'external_runtime_user_immutable');

    const metadata = runtimeSessionStore.getByRuntimeSession('antigravity-desktop', 'cascade-route-1');
    assert.equal(metadata.userId, 'user-1');
    assert.equal(metadata.lifecycle.lastObservedAt, 1000);
  });

  test('requires agent-key auth and rejects invocation principals', async () => {
    const app = await createApp();
    const ownedThread = threadStore.create('user-1', 'Invocation thread');
    const invocation = await invocationRegistry.create('user-1', 'antig-opus', ownedThread.id);

    const missing = await app.inject({
      method: 'POST',
      url: '/api/callbacks/external-runtime-sessions/register',
      payload: registrationPayload(),
    });
    assert.equal(missing.statusCode, 401);

    const invocationAuth = await app.inject({
      method: 'POST',
      url: '/api/callbacks/external-runtime-sessions/register',
      headers: {
        'x-invocation-id': invocation.invocationId,
        'x-callback-token': invocation.callbackToken,
      },
      payload: registrationPayload(),
    });
    assert.equal(invocationAuth.statusCode, 403);
  });

  test('keeps validation failures as 400 but reports audit failures as server errors', async () => {
    const app = await createApp();
    const { secret } = await issueAgentKey();

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/callbacks/external-runtime-sessions/register',
      headers: { 'x-agent-key-secret': secret },
      payload: registrationPayload({ runtimeSessionId: '' }),
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(JSON.parse(invalid.body).error, 'invalid_external_runtime_registration');

    const failingApp = await createApp({
      eventAuditLog: {
        append: async () => {
          throw new Error('audit log unavailable');
        },
      },
    });
    const failure = await failingApp.inject({
      method: 'POST',
      url: '/api/callbacks/external-runtime-sessions/register',
      headers: { 'x-agent-key-secret': secret },
      payload: registrationPayload({ runtimeSessionId: 'cascade-route-audit-failure' }),
    });
    assert.equal(failure.statusCode, 500);
    const failureBody = JSON.parse(failure.body);
    assert.equal(failureBody.error, 'external_runtime_registration_failed');
    assert.match(failureBody.message, /audit log unavailable/);
  });

  test('rejects cat spoofing and unowned explicit thread binding', async () => {
    const app = await createApp();
    const { secret } = await issueAgentKey();
    const ownedThread = threadStore.create('user-1', 'Owned thread');
    const otherThread = threadStore.create('other-user', 'Other user thread');

    const spoof = await app.inject({
      method: 'POST',
      url: '/api/callbacks/external-runtime-sessions/register',
      headers: { 'x-agent-key-secret': secret },
      payload: registrationPayload({ catId: 'antigravity' }),
    });
    assert.equal(spoof.statusCode, 403);

    const unowned = await app.inject({
      method: 'POST',
      url: '/api/callbacks/external-runtime-sessions/register',
      headers: { 'x-agent-key-secret': secret },
      payload: registrationPayload({ binding: { mode: 'thread', threadId: otherThread.id } }),
    });
    assert.equal(unowned.statusCode, 403);

    const owned = await app.inject({
      method: 'POST',
      url: '/api/callbacks/external-runtime-sessions/register',
      headers: { 'x-agent-key-secret': secret },
      payload: registrationPayload({
        runtimeSessionId: 'cascade-route-owned-thread',
        binding: { mode: 'thread', threadId: ownedThread.id },
      }),
    });
    assert.equal(owned.statusCode, 200);
    const ownedBody = JSON.parse(owned.body);
    assert.equal(ownedBody.binding.mode, 'thread');
    assert.equal(ownedBody.threadId, ownedThread.id);
  });
});
