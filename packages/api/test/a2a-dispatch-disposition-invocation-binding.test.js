import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

import { createCatId } from '@cat-cafe/shared';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { RedisAuthInvocationBackend } from '../dist/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';
import { createA2ADispositionHarness as harness } from './helpers/a2a-dispatch-disposition-harness.js';

function sessionManager() {
  return {
    get: async () => undefined,
    getOrCreate: async () => ({}),
    store: async () => {},
    delete: async () => {},
    resolveWorkingDirectory: () => '/tmp/test',
  };
}

async function createInvocation(registry, source, overrides = {}) {
  const service = {
    async *invoke() {
      yield { type: 'done', catId: 'codex-sol', timestamp: Date.now() };
    },
  };
  let invocationId;
  for await (const message of invokeSingleCat(
    {
      registry,
      sessionManager: sessionManager(),
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    },
    {
      catId: createCatId('codex-sol'),
      service,
      prompt: source.content,
      userId: 'user-1',
      ownerAuthProvenance: 'strict',
      threadId: 'thread-1',
      parentInvocationId: 'parent-a2a-1',
      a2aTriggerMessageId: source.id,
      isLastCat: true,
      ...overrides,
    },
  )) {
    if (message.type !== 'system_info' || !message.content) continue;
    const payload = JSON.parse(message.content);
    if (payload.type === 'invocation_created') invocationId = payload.invocationId;
  }
  assert.ok(invocationId, 'the production path must create one callback-auth principal');
  const record = await registry.getRecord(invocationId);
  assert.ok(record);
  return record;
}

async function createCallbackApp(registry, a2aDispatchDispositionService) {
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
    threadStore: new ThreadStore(),
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

test('normal create and continuation bind the server-derived exact A2A source', async () => {
  const registry = new InvocationRegistry();
  const h = await harness({ registry });
  const initial = await createInvocation(registry, h.source);
  const continuation = await createInvocation(registry, h.source, {
    executionCausal: { triggerMessageId: 'queue-envelope-must-not-replace-exact-source' },
  });

  for (const record of [initial, continuation]) {
    assert.equal(record.a2aTriggerMessageId, h.source.id);
    assert.equal(record.originTriggerMessageId, h.source.id);
  }
  await assert.rejects(
    () => h.service.complete(initial, 'handled'),
    /^A2ADispatchDispositionError: a2a_dispatch_disposition_stale_invocation$/,
  );
  assert.equal((await h.service.complete(continuation, 'completed')).outcome, 'applied');
  assert.equal((await h.service.complete(continuation, 'completed')).outcome, 'replayed');
});

test('the callback route completes from invocation-bound source without caller source input', async () => {
  const registry = new InvocationRegistry();
  const h = await harness({ registry });
  const record = await createInvocation(registry, h.source);
  const app = await createCallbackApp(registry, h.service);
  const response = await app.inject({
    method: 'POST',
    url: '/api/callbacks/complete-a2a-dispatch',
    headers: {
      'x-invocation-id': record.invocationId,
      'x-callback-token': record.callbackToken,
    },
    payload: { disposition: 'completed' },
  });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.outcome, 'applied');
  assert.equal(body.disposition, 'completed');
  assert.equal(body.invocationId, record.invocationId);
  assert.equal(body.sourceMessageId, h.source.id);
  await app.close();
});

const redisUrl = process.env.REDIS_URL;
test(
  'restart rehydrates the exact A2A source before disposition',
  { skip: !redisUrl || redisUrl.includes(':6399') ? 'requires isolated Redis, never 6399' : false },
  async () => {
    const keyPrefix = `cat-cafe-test:a2a-source:${process.pid}:`;
    let redis = createRedisClient({ url: redisUrl, keyPrefix });
    let activeRegistry = new InvocationRegistry({ backend: new RedisAuthInvocationBackend(redis) });
    const h = await harness({ registry: { isLatest: (invocationId) => activeRegistry.isLatest(invocationId) } });
    const record = await createInvocation(activeRegistry, h.source);
    await redis.quit();

    redis = createRedisClient({ url: redisUrl, keyPrefix });
    activeRegistry = new InvocationRegistry({ backend: new RedisAuthInvocationBackend(redis) });
    try {
      const recovered = await activeRegistry.getRecord(record.invocationId);
      assert.ok(recovered);
      assert.equal(recovered.a2aTriggerMessageId, h.source.id);
      assert.equal(recovered.originTriggerMessageId, h.source.id);
      assert.equal((await h.service.complete(recovered, 'completed')).outcome, 'applied');
    } finally {
      const keys = await redis.keys(`${keyPrefix}auth:*`);
      const logicalKeys = keys.map((key) => key.replace(keyPrefix, ''));
      if (logicalKeys.length > 0) await redis.del(...logicalKeys);
      await redis.quit();
    }
  },
);
