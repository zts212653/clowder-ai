import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { createPluginThreadHost } from '../dist/domains/plugin/host-surface/plugin-thread-host.js';
import { MemoryConnectorThreadBindingStore } from '../dist/infrastructure/connectors/ConnectorThreadBindingStore.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

async function check(store) {
  const host = createPluginThreadHost({
    threadDeepLinkUrl: (id) => `https://cafe.example.test/thread/${encodeURIComponent(id)}`,
    pluginId: 'dev.fixture',
    pluginInstanceId: 'i',
    ownerUserId: 'owner',
    projectPath: '/isolated',
    systemThreadTitle: 'Fixture',
    effectiveGrants: ['thread.write', 'thread.readContent'],
    threadStore: new ThreadStore(),
    messageStore: store,
    bindingStore: new MemoryConnectorThreadBindingStore(),
  });
  const thread = await host.create({ title: 'same millisecond' });
  for (const content of ['a', 'b', 'c'])
    await store.append({ threadId: thread.id, userId: 'owner', catId: null, content, timestamp: 100, mentions: [] });
  const page = await host.readMessages(thread.id, { limit: 2 });
  assert.deepEqual(
    page.map((m) => m.content),
    ['b', 'c'],
  );
  const previous = await host.readMessages(thread.id, {
    limit: 2,
    before: { timestamp: page[0].timestamp, id: page[0].id },
  });
  assert.deepEqual(
    previous.map((m) => m.content),
    ['a'],
  );
  assert.deepEqual(
    await host.readMessages(thread.id, { limit: 2, before: { timestamp: previous[0].timestamp, id: previous[0].id } }),
    [],
  );
  for (const before of [
    100,
    {},
    { timestamp: 100 },
    { timestamp: 100, id: '' },
    { timestamp: 100, id: 'x', extra: true },
  ])
    await assert.rejects(() => host.readMessages(thread.id, { limit: 2, before }), /before/);

  const delayedThread = await host.create({ title: 'delivery score' });
  const delayed = await store.append({
    threadId: delayedThread.id,
    userId: 'system',
    catId: null,
    content: 'delayed',
    timestamp: 1,
    deliveryStatus: 'queued',
    mentions: [],
  });
  await store.append({
    threadId: delayedThread.id,
    userId: 'owner',
    catId: null,
    content: 'earlier',
    timestamp: 100,
    mentions: [],
  });
  await store.markDelivered(delayed.id, 500);
  const last = await host.readMessages(delayedThread.id, { limit: 1 });
  assert.equal(last[0].content, 'delayed');
  assert.equal(last[0].timestamp, 500, 'public timestamp is timeline-order time, not authoring time');
  assert.deepEqual(
    (
      await host.readMessages(delayedThread.id, { limit: 1, before: { timestamp: last[0].timestamp, id: last[0].id } })
    ).map((m) => m.content),
    ['earlier'],
  );
}

test('Memory: composite history cursor retains same-score messages and delivery timeline order', () =>
  check(new MessageStore()));
test(
  'Redis: composite history cursor retains same-score messages and delivery timeline order',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'F202 thread history');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const { RedisMessageStore } = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `f202-history-${randomUUID()}:` });
    try {
      await check(new RedisMessageStore(redis, { ttlSeconds: 0 }));
    } finally {
      await redis.quit();
    }
  },
);
