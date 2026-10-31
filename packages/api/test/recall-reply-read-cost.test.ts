import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import type { IThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.js';
import { applyMigrations, SCHEMA_V1 } from '../src/domains/memory/schema.js';
import { recallMetricsRoutes } from '../src/routes/recall-metrics.js';
import { projectRecallReplies } from '../src/routes/recall-reply-index.js';
import { fixtureRedis, hash } from './helpers/recall-reply-fixture.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

test('recall events reads 500 reply positions without fetching message bodies, including cursor continuation', async () => {
  const { store, calls } = fixtureRedis(
    Array.from({ length: 1000 }, (_, i) => hash(`m-${String(i).padStart(4, '0')}`, i)),
  );
  const db = new Database(':memory:');
  db.exec(SCHEMA_V1);
  db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
  applyMigrations(db);
  const app = Fastify();
  const threadStore = {
    get: async () => ({ id: 'thread-owned', createdBy: 'owner' }),
    list: async () => [{ id: 'thread-owned', createdBy: 'owner' }],
  } as unknown as Pick<IThreadStore, 'get' | 'list'>;
  await app.register(recallMetricsRoutes, { evidenceDb: db, threadStore, messageStore: store });
  try {
    const first = await app.inject({
      url: '/api/recall/events?threadId=thread-owned&limit=1',
      headers: { 'X-Cat-Cafe-User': 'owner' },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().replies.length, 500);
    assert.deepEqual(first.json().replyCursor, { timestamp: 500, messageId: 'm-0500' });
    const second = await app.inject({
      url: '/api/recall/events?threadId=thread-owned&replyBeforeTs=500&replyBeforeId=m-0500',
      headers: { 'X-Cat-Cafe-User': 'owner' },
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().replies.length, 500);
    assert.equal(second.json().replies[0].messageId, 'm-0000');
    assert.equal(second.json().replies.at(-1).messageId, 'm-0499');
    assert.equal(
      calls.filter((call) => call.method === 'hgetall').length,
      0,
      'coordinate reader must not fetch full message hashes',
    );
    const fields = calls.flatMap((call) => call.fields ?? []);
    assert.ok(
      !fields.some((field) => ['content', 'thinking', 'toolEvents', 'contentBlocks', 'metadata'].includes(field)),
    );
    const count = calls.length;
    const forbidden = await app.inject({
      url: '/api/recall/events?threadId=thread-owned',
      headers: { 'X-Cat-Cafe-User': 'other-owner' },
    });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(calls.length, count, 'authorization must precede the projection read');
  } finally {
    await app.close();
    db.close();
  }
});

test('native reply positions preserve filtered window size and equal-score cursor semantics', async () => {
  const hashes = Array.from({ length: 120 }, (_, i) =>
    hash(`m-${String(i).padStart(4, '0')}`, i, { timelineOrderAt: '1000' }),
  );
  hashes.push(
    hash('x-other', 999, { userId: 'other', timelineOrderAt: '1000' }),
    hash('x-deleted', 999, { deletedAt: '12', timelineOrderAt: '1000' }),
    hash('x-queued', 999, { deliveryStatus: 'queued', timelineOrderAt: '1000' }),
    hash('x-canceled', 999, { deliveryStatus: 'canceled', timelineOrderAt: '1000' }),
    hash('x-managed-ownerless', 999, {
      userId: 'scheduler',
      catId: '',
      source: JSON.stringify({ connector: 'hold-ball' }),
      timelineOrderAt: '1000',
    }),
    hash('x-system', 999, { userId: 'system', catId: 'system', timelineOrderAt: '1000' }),
    hash('x-human', 999, { catId: '', timelineOrderAt: '1000' }),
    hash('x-explicit', 999, {
      extra: JSON.stringify({ stream: { invocationId: 'explicit' }, isExplicitPost: true }),
      timelineOrderAt: '1000',
    }),
  );
  const { store } = fixtureRedis(hashes);
  const legacy = await store.getByThread('thread-owned', 7, 'owner');
  const native = await store.getThreadReplyProjection('thread-owned', 'owner', 7);
  assert.deepEqual(
    native.map((row) => row.id),
    legacy.map((row) => row.id),
  );
  assert.deepEqual(projectRecallReplies(native), projectRecallReplies(legacy));
  assert.ok(
    native.some((row) => row.catId === null),
    'non-replies still occupy the original pagination window',
  );
  const before = { timestamp: 1000, messageId: 'm-0060' };
  const previous = await store.getByThreadBefore('thread-owned', before.timestamp, 7, before.messageId, 'owner');
  const older = await store.getThreadReplyProjection('thread-owned', 'owner', 7, before);
  assert.deepEqual(projectRecallReplies(older), projectRecallReplies(previous));
  assert.deepEqual(
    older.map((row) => row.id),
    ['m-0053', 'm-0054', 'm-0055', 'm-0056', 'm-0057', 'm-0058', 'm-0059'],
  );
  assert.deepEqual(
    await store.getThreadReplyProjection('thread-owned', 'owner', 7, { timestamp: 999, messageId: 'missing' }),
    [],
  );
});

test('native reply projection rejects incomplete reads instead of reporting an empty successful page', async () => {
  for (const fault of ['command', 'missing', 'null'] as const) {
    const { store, calls } = fixtureRedis([hash('m', 1)], fault);
    await assert.rejects(store.getThreadReplyProjection('thread-owned', 'owner'), /unavailable|incomplete/);
    assert.equal(calls.filter((call) => call.method === 'hgetall').length, 0);
  }
});

test(
  'native Redis reply projection preserves visibility and tied-score paging on the stored thread index',
  {
    skip: redisIsolationSkipReason(process.env.REDIS_URL),
  },
  async () => {
    const redisUrl = process.env.REDIS_URL;
    assertRedisIsolationOrThrow(redisUrl, 'recall reply projection');
    const Redis = (await import('ioredis')).default;
    const redis = new Redis(redisUrl as string, { keyPrefix: 'recall-coordinates:', lazyConnect: true });
    await redis.connect();
    const store = new RedisMessageStore(redis);
    const rows = Array.from({ length: 110 }, (_, index) =>
      hash(`m-${String(index).padStart(4, '0')}`, index, { timelineOrderAt: '5000' }),
    );
    rows.push(
      hash('x-foreign-owner', 999, { userId: 'other', timelineOrderAt: '5000' }),
      hash('x-deleted', 999, { deletedAt: '12', timelineOrderAt: '5000' }),
      hash('x-queued', 999, { deliveryStatus: 'queued', timelineOrderAt: '5000' }),
      hash('x-foreign-thread', 999, { threadId: 'other-thread', timelineOrderAt: '5000' }),
    );
    try {
      const seed = redis.pipeline();
      for (const row of rows) {
        seed.hset(`msg:${row.id}`, row);
        seed.zadd('msg:thread:thread-owned', row.timelineOrderAt, row.id);
      }
      assert.ok((await seed.exec())?.every(([error]) => !error));
      const first = await store.getThreadReplyProjection('thread-owned', 'owner', 100);
      assert.deepEqual(
        first.map((row) => row.id),
        Array.from({ length: 100 }, (_, i) => `m-${String(i + 10).padStart(4, '0')}`),
      );
      const older = await store.getThreadReplyProjection('thread-owned', 'owner', 100, {
        timestamp: 5000,
        messageId: 'm-0010',
      });
      assert.deepEqual(
        older.map((row) => row.id),
        Array.from({ length: 10 }, (_, i) => `m-${String(i).padStart(4, '0')}`),
      );
      assert.deepEqual(await store.getThreadReplyProjection('thread-owned', 'other', 100), [
        {
          id: 'x-foreign-owner',
          catId: 'sonnet',
          timestamp: 999,
          timelineOrderAt: 5000,
          extra: { stream: { invocationId: 'parent-x-foreign-owner', turnInvocationId: 'turn-x-foreign-owner' } },
        },
      ]);
    } finally {
      await redis.quit();
    }
  },
);
