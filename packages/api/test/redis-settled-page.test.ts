import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { readRedisSettledPage } from '../src/utils/redis-settled-page.js';
import { cleanupClientKeyspace } from './helpers/redis-test-helpers.js';

test('actual owner index continues past 200, same-time ties and deleted anchors without rereading prefixes', async (t) => {
  assert.equal(process.env.CAT_CAFE_REDIS_TEST_ISOLATED, '1', 'use the canonical isolated Redis runner');
  const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `settled-page:${randomUUID()}:` });
  await redis.ping();
  t.after(async () => {
    await cleanupClientKeyspace(redis);
    await redis.quit();
  });
  const ids = Array.from({ length: 251 }, (_, index) => `proposal-${String(index).padStart(4, '0')}`);
  for (const id of ids) await redis.zadd('owner-index', 1000, id);
  let reads = 0;
  const read = async (id: string, decidedAt: number) => {
    reads++;
    return { id, decidedAt };
  };
  const first = await readRedisSettledPage(redis, 'owner-index', { limit: 30 }, read);
  assert.deepEqual(
    first.records.map((item) => item.id),
    ids.slice(-30).reverse(),
  );
  assert.equal(first.hasMore, true);
  assert.equal(reads, 30);
  assert.ok(first.frontier);
  await redis.zrem('owner-index', first.frontier.proposalId!);
  await redis.zadd('owner-index', 1001, 'new-at-head');
  const seen = [...first.records.map((item) => item.id)];
  let page = first;
  while (page.hasMore) {
    page = await readRedisSettledPage(redis, 'owner-index', { limit: 30, before: page.frontier! }, read);
    seen.push(...page.records.map((item) => item.id));
  }
  assert.deepEqual(seen, [...ids].reverse());
  assert.equal(new Set(seen).size, 251);
  assert.equal(reads, 251, 'each canonical detail is hydrated once across all pages');
});

test('empty physical entries advance and source failures never claim exhaustion', async (t) => {
  assert.equal(process.env.CAT_CAFE_REDIS_TEST_ISOLATED, '1');
  const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `settled-page:${randomUUID()}:` });
  await redis.ping();
  t.after(async () => {
    await cleanupClientKeyspace(redis);
    await redis.quit();
  });
  await redis.zadd('index', 3, 'c', 2, 'b', 1, 'a');
  const first = await readRedisSettledPage(redis, 'index', { limit: 2 }, async () => null);
  assert.deepEqual(first.records, []);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.frontier, { decidedAt: 2, proposalId: 'b' });
  const last = await readRedisSettledPage(redis, 'index', { limit: 2, before: first.frontier! }, async (id) => id);
  assert.deepEqual(last.records, ['a']);
  await assert.rejects(
    readRedisSettledPage(redis, 'index', { limit: 2 }, async () => {
      throw new Error('canonical unavailable');
    }),
    /canonical unavailable/,
  );
});
