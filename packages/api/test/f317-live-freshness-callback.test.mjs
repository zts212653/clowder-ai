import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { callbacksRoutes } from '../src/routes/callbacks.ts';

test('only an authenticated server-owned Live binding suppresses duplicate B1 notices', async () => {
  const registry = new InvocationRegistry();
  const identity = await registry.create('owner', 'codex-astra', 'home');
  const queries = [];
  let live = true;
  let redisCalls = 0;
  const app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    messageStore: new MessageStore(),
    socketManager: { broadcastAgentMessage() {} },
    deliveryCursorStore: { getSeenCursor: async () => 'seed' },
    redis: new Proxy(
      {},
      {
        get: () => async () => {
          redisCalls++;
          throw new Error('fixture Redis unavailable');
        },
      },
    ),
    isLiveCarrierInvocation: async (query) => {
      queries.push(query);
      return live;
    },
  });
  const request = {
    method: 'POST',
    url: '/api/callbacks/freshness-notice-check',
    payload: { toolName: 'get_thread_context', isReadOnly: true },
    headers: { 'x-invocation-id': identity.invocationId, 'x-callback-token': identity.callbackToken },
  };
  try {
    assert.equal((await app.inject({ ...request, headers: {} })).statusCode, 401);
    assert.equal(queries.length, 0);
    assert.equal((await app.inject(request)).statusCode, 200);
    assert.deepEqual(queries[0], { invocationId: identity.invocationId, catId: 'codex-astra', threadId: 'home' });
    assert.equal(redisCalls, 0, 'Live D2 owns its exact exposure query, not the stateless B1 query');
    live = false;
    assert.equal((await app.inject(request)).statusCode, 200);
    assert.ok(redisCalls > 0, 'ordinary authenticated calls keep B1 behavior');
  } finally {
    await app.close();
  }
});
