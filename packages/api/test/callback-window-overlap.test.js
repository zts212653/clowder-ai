import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { MessageKeys } from '../dist/domains/cats/services/stores/redis-keys/message-keys.js';
import { createCallbackContextFixture } from './helpers/callback-context-fixture.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('callback-window-overlap');

async function fixture(t, keyPrefix) {
  const redis = owned.client(keyPrefix);
  const store = new RedisMessageStore(redis, { ttlSeconds: 0 });
  const f = await createCallbackContextFixture(t, { callbackOptions: { messageStore: store } });
  const append = (content, timestamp, extra = {}) =>
    store.append({
      userId: f.userId,
      threadId: f.threadId,
      from: { kind: 'user', userId: f.userId },
      content,
      mentions: [],
      timestamp,
      ...extra,
    });
  const older = await append('older', 90);
  const anchor = await append('anchor', 100, { deliveryStatus: 'queued' });
  const late = await append('queued before anchor publication; delivered after it', 110, { deliveryStatus: 'queued' });
  await store.markDelivered(anchor.id, 120);
  await store.markDelivered(late.id, 130);
  // Preserve the historical raw index position. Publication uses a separate
  // visibility index, so the same canonical row is a neighbor on both sides.
  await redis.zadd(MessageKeys.thread(f.threadId), 110, late.id);
  return { ...f, older, late, anchor };
}

test('thread-context default window emits each cross-index neighbor once and reaches its terminal page', async (t) => {
  const f = await fixture(t, 'context:');
  const response = await f.read({ messageId: f.anchor.id });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.hasMore, false, 'a repeated tail neighbor must not mint a stuck cursor');
  assert.equal(body.nextCursor, undefined);
  assert.deepEqual(
    body.messages.map((message) => message.id),
    [f.older.id, f.anchor.id, f.late.id],
  );
});

test('get-message context contains unique cross-index neighbors and excludes its anchor', async (t) => {
  const f = await fixture(t, 'drill:');
  const response = await f.app.inject({
    url: `/api/callbacks/get-message?messageId=${f.anchor.id}&mode=full&contextCount=3`,
    headers: { 'x-invocation-id': f.auth.invocationId, 'x-callback-token': f.auth.callbackToken },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().message.id, f.anchor.id);
  assert.deepEqual(
    response.json().context.map((message) => message.id),
    [f.older.id, f.late.id],
  );
});
