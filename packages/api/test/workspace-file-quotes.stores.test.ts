import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import Redis from 'ioredis';
import { type IMessageStore, MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.js';
import { assertRedisIsolationOrThrow, cleanupClientKeyspace } from './helpers/redis-test-helpers.js';

async function publishedWindow(store: IMessageStore) {
  const append = (catId: string | null, status: 'queued' | 'canceled' | 'delivered', timestamp: number) =>
    store.append({
      userId: 'reader',
      threadId: 'quoted',
      catId: catId ? createCatId(catId) : null,
      content: 'published speech or private work',
      mentions: [],
      ...(status === 'queued' ? { deliveryStatus: status } : {}),
      timestamp,
    });
  const delivered = await append('codex61-sol', 'delivered', 1);
  const first = await append('codex61-sol', 'queued', 2);
  await append(null, 'queued', 2);
  await append('system', 'queued', 2);
  const canceled = await append('codex61-sol', 'queued', 2);
  await store.markCanceled(canceled.id);
  await store.append({
    userId: 'reader',
    threadId: 'quoted',
    catId: createCatId('codex61-sol'),
    content: 'private briefing',
    mentions: [],
    deliveryStatus: 'queued',
    origin: 'briefing',
    timestamp: 2,
  });
  for (let index = 0; index < 55; index++) await append(null, 'queued', 2);
  const second = await append('codex-sol', 'queued', 2);
  const recent = await append('codex61-sol', 'delivered', 3);
  await store.append({
    userId: 'foreign',
    threadId: 'quoted',
    catId: createCatId('codex61-sol'),
    content: 'other owner',
    mentions: [],
    timestamp: 4,
    deliveryStatus: 'queued',
  });
  assert.deepEqual(
    (await store.getBefore(10, 10, 'reader')).map((m) => m.id),
    [delivered.id, recent.id],
  );
  const options = { includeQueuedCatMessages: true };
  const page = await store.getBefore(10, 2, 'reader', undefined, options);
  assert.deepEqual(
    page.map((m) => m.id),
    [second.id, recent.id],
    'opt-in uses the timeline publication predicate',
  );
  const older = await store.getBefore(page[0].timestamp, 2, 'reader', page[0].id, options);
  assert.deepEqual(
    older.map((m) => m.id),
    [delivered.id, first.id],
    'same-timestamp/id cursor retains earlier queued speech',
  );
  assert.deepEqual(await store.getBefore(older[0].timestamp, 2, 'reader', older[0].id, options), []);
}
test('memory file-quote scan includes published queued cats only and preserves the compound cursor', async () => {
  await publishedWindow(new MessageStore());
});
test(
  'Redis file-quote scan includes published queued cats only and preserves the compound cursor',
  { skip: !process.env.REDIS_URL },
  async () => {
    const url = process.env.REDIS_URL;
    assert.ok(url);
    assertRedisIsolationOrThrow(url, 'file-quotes-published-window');
    const redis = new Redis(url, { keyPrefix: 'f309-quote-scan-' + randomUUID() + ':' });
    try {
      await publishedWindow(new RedisMessageStore(redis));
    } finally {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  },
);
