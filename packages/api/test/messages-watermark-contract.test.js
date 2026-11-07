import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Redis } from 'ioredis';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { MessageKeys } from '../dist/domains/cats/services/stores/redis-keys/message-keys.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

async function assertBrowserFrontier(store, markSeenRecall) {
  const append = (content, patch = {}) =>
    store.append({
      userId: 'owner',
      from: { kind: 'user', userId: 'owner' },
      threadId: 'thread',
      content,
      mentions: [],
      timestamp: Date.now(),
      ...patch,
    });
  const frontier = () =>
    store.getLatestVisibleCursor('thread', { evidence: 'browser_timeline', viewerUserId: 'owner' });
  const first = await append('visible');
  await append('private', { userId: 'another', from: { kind: 'user', userId: 'another' } });
  await append('queued input', { deliveryStatus: 'queued' });
  await append('internal', {
    userId: 'system',
    from: { kind: 'system', service: 'routing-guard-failure' },
    source: { connector: 'routing-guard-failure', label: 'internal', icon: 'alert-triangle' },
  });
  assert.equal((await frontier()).messageId, first.id);
  const speech = await append('queued speech', {
    from: { kind: 'agent', catId: 'opus' },
    origin: 'callback',
    deliveryStatus: 'queued',
  });
  assert.equal((await frontier()).messageId, speech.id);
  const seen = await append('seen legacy recall');
  await markSeenRecall(seen);
  assert.equal((await frontier()).messageId, seen.id);
  await store.softDelete(seen.id, 'owner');
  assert.equal((await frontier()).messageId, speech.id);
  const response = await store.appendAndObservePriorFrontier({
    userId: 'owner',
    from: { kind: 'agent', catId: 'opus' },
    threadId: 'thread',
    content: '',
    mentions: [],
    origin: 'stream',
    timestamp: Date.now(),
    lifecycle: {
      kind: 'response',
      orderKey: 'response-order',
      invocationId: 'child',
      targetId: 'opus',
      inputEntryIds: ['entry'],
      inputMessageIds: [first.id],
      status: 'processing',
      startedAt: Date.now(),
    },
  });
  assert.equal((await frontier()).messageId, speech.id);
  await store.commitLifecycleResponseTerminal(response.message.id, {
    invocationId: 'child',
    status: 'completed',
    completedAt: Date.now(),
    content: 'complete',
    mentions: [],
  });
  assert.equal((await frontier()).messageId, response.message.id);
}

const recallFields = {
  content: '',
  deliveryStatus: 'canceled',
  _tombstone: true,
  recall: { version: 1, exposure: 'seen', recalledAt: 1000 },
};

test('Memory browser frontier contract', async () => {
  await assertBrowserFrontier(new MessageStore(), (message) => Object.assign(message, recallFields));
});

test('Redis browser frontier matches Memory', { skip: redisIsolationSkipReason(process.env.REDIS_URL) }, async (t) => {
  assertRedisIsolationOrThrow(process.env.REDIS_URL, 'browser frontier');
  const redis = new Redis(process.env.REDIS_URL, { keyPrefix: `issue1287-watermark:${Date.now()}:` });
  t.after(() => redis.disconnect());
  await assertBrowserFrontier(new RedisMessageStore(redis), (message) =>
    redis.hset(MessageKeys.detail(message.id), {
      content: '',
      deliveryStatus: 'canceled',
      _tombstone: '1',
      recall: JSON.stringify(recallFields.recall),
    }),
  );
});
