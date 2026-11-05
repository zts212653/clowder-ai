import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { queueHttpFixture } from './helpers/1398-queue-http-fixture.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('sticky-recipient');
test('Redis reload preserves the latest sent Human choice across delivery reordering, pagination and queueing', async (t) => {
  const redis = owned.client('sticky:');
  const messages = new RedisMessageStore(redis, { ttlSeconds: 0 });
  const f = await queueHttpFixture(t, { messageStore: messages });
  const old = Date.now() - 2 * 60 * 60 * 1000;
  const append = (mentions, timestamp, extra = {}) =>
    messages.append({
      from: { kind: 'user', userId: 'owner' },
      userId: 'owner',
      threadId: f.thread.id,
      content: mentions.map((id) => `@${id}`).join(' ') || '继续',
      mentions,
      timestamp,
      ...extra,
    });
  const earlier = await append(['opus'], old, { deliveryStatus: 'queued' });
  await append(['codex'], old + 1);
  for (let i = 0; i < 60; i++) await append([], old + 2 + i);
  await messages.markDelivered(earlier.id, Date.now());
  const check = async (expected) => {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/routing/preview',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { scope: 'thread', threadId: f.thread.id, content: '继续' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().targetCats, expected);
  };
  await check(['codex']);
  await append(['gemini'], Date.now(), { deliveryStatus: 'queued' });
  await check(['gemini']);
  // A new store/router reads the same durable message records, with no process cache.
  const reloaded = await queueHttpFixture(t, { messageStore: new RedisMessageStore(redis, { ttlSeconds: 0 }) });
  reloaded.threads.get = (id) => f.threads.get(id);
  assert.deepEqual((await reloaded.router.previewTargets('继续', { threadId: f.thread.id })).targetCats, ['gemini']);
});
