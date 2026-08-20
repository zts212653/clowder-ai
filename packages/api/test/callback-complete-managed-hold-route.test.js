/**
 * F167 × F254 — invocation-bound managed hold disposition callback.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

describe('POST /api/callbacks/complete-managed-hold', () => {
  let registry;
  let threadStore;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    registry = new InvocationRegistry();
    threadStore = new ThreadStore();
  });

  async function createApp(managedHoldDispositionService) {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore: {
        async getMessagesForThread() {
          return [];
        },
      },
      socketManager: {
        broadcastAgentMessage() {},
        getMessages() {
          return [];
        },
      },
      threadStore,
      evidenceStore: {
        async store() {},
        async search() {
          return [];
        },
      },
      markerQueue: { enqueue() {} },
      reflectionService: { async run() {} },
      holdBallDeps: { registry, managedHoldDispositionService },
    });
    return app;
  }

  async function credentials() {
    const thread = await threadStore.create('user-managed-hold', 'managed hold');
    const auth = await registry.create(
      'user-managed-hold',
      'codex-sol',
      thread.id,
      undefined,
      undefined,
      undefined,
      'message-managed-hold',
    );
    return { ...auth, threadId: thread.id };
  }

  test('authenticates the current invocation and forwards only its record plus typed disposition', async () => {
    const calls = [];
    const app = await createApp({
      async complete(record, disposition) {
        calls.push({ record, disposition });
        return { outcome: 'applied', disposition };
      },
    });
    const auth = await credentials();
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/complete-managed-hold',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: { disposition: 'completed' },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].record.invocationId, auth.invocationId);
    assert.equal(calls[0].record.threadId, auth.threadId);
    assert.equal(calls[0].record.originTriggerMessageId, 'message-managed-hold');
    assert.equal(calls[0].disposition, 'completed');
  });

  test('rejects caller-selected subjects and stale fenced dispositions', async () => {
    const { ManagedHoldDispositionError } = await import(
      '../dist/domains/ball-custody/ManagedHoldDispositionService.js'
    );
    const app = await createApp({
      async complete() {
        throw new ManagedHoldDispositionError('managed_hold_disposition_stale_invocation');
      },
    });
    const auth = await credentials();
    const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };

    const widened = await app.inject({
      method: 'POST',
      url: '/api/callbacks/complete-managed-hold',
      headers,
      payload: { disposition: 'handled', taskId: 'caller-selected' },
    });
    assert.equal(widened.statusCode, 400);

    const stale = await app.inject({
      method: 'POST',
      url: '/api/callbacks/complete-managed-hold',
      headers,
      payload: { disposition: 'handled' },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(JSON.parse(stale.body).code, 'managed_hold_disposition_stale_invocation');
  });
});

describe('POST /api/callbacks/complete-a2a-dispatch', () => {
  let registry;
  let threadStore;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    registry = new InvocationRegistry();
    threadStore = new ThreadStore();
  });

  async function createApp(a2aDispatchDispositionService) {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore: {
        async getMessagesForThread() {
          return [];
        },
      },
      socketManager: {
        broadcastAgentMessage() {},
        getMessages() {
          return [];
        },
      },
      threadStore,
      evidenceStore: {
        async store() {},
        async search() {
          return [];
        },
      },
      markerQueue: { enqueue() {} },
      reflectionService: { async run() {} },
      holdBallDeps: { registry, a2aDispatchDispositionService },
    });
    return app;
  }

  async function credentials() {
    const thread = await threadStore.create('user-a2a', 'a2a dispatch');
    const auth = await registry.create(
      'user-a2a',
      'codex-sol',
      thread.id,
      undefined,
      'message-a2a',
      undefined,
      'message-a2a',
    );
    return { ...auth, threadId: thread.id };
  }

  test('forwards only callback auth plus the typed disposition', async () => {
    const calls = [];
    const app = await createApp({
      async complete(record, disposition) {
        calls.push({ record, disposition });
        return { outcome: 'applied', disposition };
      },
    });
    const auth = await credentials();
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/complete-a2a-dispatch',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: { disposition: 'completed' },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].record.a2aTriggerMessageId, 'message-a2a');
    assert.equal(calls[0].record.originTriggerMessageId, 'message-a2a');
    assert.equal(calls[0].disposition, 'completed');
  });

  test('rejects caller-selected subjects and stale fenced dispositions', async () => {
    const { A2ADispatchDispositionError } = await import(
      '../dist/domains/ball-custody/A2ADispatchDispositionService.js'
    );
    const app = await createApp({
      async complete() {
        throw new A2ADispatchDispositionError('a2a_dispatch_disposition_stale_invocation');
      },
    });
    const auth = await credentials();
    const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/callbacks/complete-a2a-dispatch',
          headers,
          payload: { disposition: 'handled', sourceMessageId: 'caller-selected' },
        })
      ).statusCode,
      400,
    );
    const stale = await app.inject({
      method: 'POST',
      url: '/api/callbacks/complete-a2a-dispatch',
      headers,
      payload: { disposition: 'handled' },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(JSON.parse(stale.body).code, 'a2a_dispatch_disposition_stale_invocation');
  });

  test('returns a verified replacement pointer when a disposition carrier was superseded', async () => {
    const { A2ADispatchDispositionError } = await import(
      '../dist/domains/ball-custody/A2ADispatchDispositionService.js'
    );
    const replacement = {
      kind: 'handed',
      sourceEventId: 'route:message-successor:codex-sol',
      sourceMessageId: 'message-successor',
      fromCatId: 'opus',
      toCatId: 'codex-sol',
      coordination: { id: 'coord-successor', phase: 'active', hop: 1 },
    };
    const app = await createApp({
      async complete() {
        throw new A2ADispatchDispositionError('a2a_dispatch_disposition_replaced', replacement);
      },
    });
    const auth = await credentials();
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/complete-a2a-dispatch',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: { disposition: 'handled' },
    });

    assert.equal(response.statusCode, 409);
    assert.deepEqual(JSON.parse(response.body), {
      error: 'A2A dispatch disposition rejected',
      code: 'a2a_dispatch_disposition_replaced',
      replacement,
    });
  });
});
