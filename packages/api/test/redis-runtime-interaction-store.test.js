import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { cleanupClientKeyspace } from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const skip = !REDIS_URL || process.env.CAT_CAFE_REDIS_TEST_ISOLATED !== '1';

describe('RedisRuntimeInteractionStore', { skip }, () => {
  let redis;
  let store;
  let store2;
  let RuntimeInteractionKeys;

  before(async () => {
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const module = await import('../dist/domains/runtime-interaction/stores/RedisRuntimeInteractionStore.js');
    RuntimeInteractionKeys = module.RuntimeInteractionKeys;
    const keyPrefix = `cat-cafe-test:f306:${process.pid}:`;
    redis = createRedisClient({ url: REDIS_URL, keyPrefix });
    await redis.ping();
    store = new module.RedisRuntimeInteractionStore(redis);
    store2 = new module.RedisRuntimeInteractionStore(redis);
  });

  after(async () => {
    if (!redis) return;
    await cleanupClientKeyspace(redis);
    await redis.quit();
  });

  const request = {
    version: 1,
    interactionId: 'redis-interaction',
    kind: 'approval',
    owner: { userId: 'user-1', threadId: 'thread-1', catId: 'codex-sol', invocationId: 'inv-1' },
    provider: {
      providerId: 'openai',
      method: 'item/fileChange/requestApproval',
      requestId: 'rpc-1',
      threadId: 'provider-thread',
      turnId: 'provider-turn',
      itemId: 'provider-item',
    },
    createdAt: 1000,
    title: 'Apply file change?',
    decisions: [
      { id: 'accept', label: 'Apply', outcome: 'accept' },
      { id: 'decline', label: 'Decline', outcome: 'decline' },
    ],
  };

  it('persists staged/pending interaction truth with TTL=0', async () => {
    await store.createStaged({ request, hostEpoch: 'host-1', now: 1000 });
    await store.anchor(
      request.interactionId,
      'host-1',
      { threadId: 'thread-1', messageId: 'message-1', blockId: 'runtime-interaction:redis-interaction' },
      1001,
    );

    assert.equal(await redis.pttl(RuntimeInteractionKeys.detail(request.interactionId)), -1);
    assert.equal((await store.get(request.interactionId)).status, 'pending');
    assert.deepEqual(
      (await store.listPendingByUser('user-1')).map((record) => record.request.interactionId),
      ['redis-interaction'],
    );
  });

  it('settles once across two store instances and removes the pending index atomically', async () => {
    const terminal = {
      status: 'answered',
      reasonCode: 'answered',
      settledAt: 1002,
      response: { kind: 'decision', decisionId: 'accept' },
    };
    const results = await Promise.all([
      store.settle({ interactionId: request.interactionId, hostEpoch: 'host-1', terminal, now: 1002 }),
      store2.settle({ interactionId: request.interactionId, hostEpoch: 'host-1', terminal, now: 1002 }),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal((await store.get(request.interactionId)).status, 'answered');
    assert.deepEqual(await store.listPendingByUser('user-1'), []);
    assert.equal(await redis.pttl(RuntimeInteractionKeys.detail(request.interactionId)), -1);
  });

  it('invalidates every old-host active record without touching terminal history', async () => {
    const oldRequest = {
      ...request,
      interactionId: 'old-pending',
      provider: { ...request.provider, requestId: 'rpc-2' },
    };
    const newRequest = {
      ...request,
      interactionId: 'new-pending',
      provider: { ...request.provider, requestId: 'rpc-3' },
    };
    await store.createStaged({ request: oldRequest, hostEpoch: 'old-host', now: 2000 });
    await store.anchor(
      oldRequest.interactionId,
      'old-host',
      { threadId: 'thread-1', messageId: 'message-old', blockId: 'runtime-interaction:old-pending' },
      2001,
    );
    await store.createStaged({ request: newRequest, hostEpoch: 'new-host', now: 2000 });

    const invalidated = await store2.invalidateActiveFromOtherHostEpoch('new-host', 'host_restarted', 2002);
    assert.deepEqual(
      invalidated.map((record) => record.request.interactionId),
      ['old-pending'],
    );
    assert.equal((await store.get('old-pending')).terminal.reasonCode, 'host_restarted');
    assert.equal((await store.get('new-pending')).status, 'staged');
    assert.equal((await store.get('redis-interaction')).status, 'answered');
  });

  it('preserves empty arrays and request numbers exactly across Lua lifecycle transitions', async () => {
    const formRequest = {
      ...request,
      interactionId: 'empty-required',
      kind: 'elicitation',
      mode: 'form',
      message: 'Optional configuration',
      requestedSchema: {
        type: 'object',
        properties: { region: { type: 'string' } },
        required: [],
        additionalProperties: false,
      },
      createdAt: 123456789012345,
      decisions: [{ id: 'accept', label: 'Submit', outcome: 'accept' }],
    };
    await store.createStaged({ request: formRequest, hostEpoch: 'host-1', now: 3000 });
    await store.anchor(
      formRequest.interactionId,
      'host-1',
      { threadId: 'thread-1', messageId: 'message-empty', blockId: 'runtime-interaction:empty-required' },
      3001,
    );
    const anchored = await store.get(formRequest.interactionId);
    assert.deepEqual(anchored.request.requestedSchema.required, []);
    assert.equal(anchored.request.createdAt, formRequest.createdAt);

    const questionRequest = {
      ...request,
      interactionId: 'empty-secret-ids',
      kind: 'question',
      questions: [{ id: 'environment', header: 'Environment', question: 'Where?' }],
    };
    delete questionRequest.decisions;
    await store.createStaged({ request: questionRequest, hostEpoch: 'host-1', now: 3100 });
    await store.anchor(
      questionRequest.interactionId,
      'host-1',
      { threadId: 'thread-1', messageId: 'message-question', blockId: 'runtime-interaction:empty-secret-ids' },
      3101,
    );
    await store.settle({
      interactionId: questionRequest.interactionId,
      hostEpoch: 'host-1',
      now: 3102,
      terminal: {
        status: 'answered',
        reasonCode: 'answered',
        settledAt: 3102,
        response: {
          kind: 'answers',
          answeredQuestionIds: ['environment'],
          secretQuestionIds: [],
        },
      },
    });
    assert.deepEqual((await store.get(questionRequest.interactionId)).terminal.response.secretQuestionIds, []);
  });
});
