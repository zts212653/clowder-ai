import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { getRoster } from '../dist/config/cat-config-loader.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { RedisQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';
import { assertRedisIsolationOrThrow } from './helpers/redis-test-helpers.js';
import { privateInput, successorFixture } from './helpers/successor-routing-fixture.js';

// CI owns a portless fixture; the native Windows runner supplies its already isolated TCP child.
const isolated = process.env.CAT_CAFE_REDIS_TEST_ISOLATED === '1';
const owned = isolated ? null : ownedRedisFixture('issue1292-receipt');
async function fixture(t) {
  if (isolated) assertRedisIsolationOrThrow(process.env.REDIS_URL, 'issue1292 receipt');
  const prefix = `issue1292:${randomUUID()}:`;
  const redis = owned ? owned.client(prefix) : createRedisClient({ url: process.env.REDIS_URL, keyPrefix: prefix });
  await redis.ping();
  t.after(() => redis.quit());
  const ledger = new RedisQueueLedgerStore(redis);
  return { ...successorFixture(t, {}, ledger), redis };
}

test('Redis private receipt survives partial and full retirement, changed config and reopen', async (t) => {
  const h = await fixture(t);
  const input = privateInput(h.threadId, { targetCats: ['opus', 'codex'] });
  const admitted = await h.queue.enqueueDurable(input);
  await h.ledger.claim(h.threadId, admitted.entry.id, 'partial', 200, 'opus-5');
  await h.ledger.commit(h.threadId, admitted.entry.id, 'partial', 'processing', 201);
  getRoster().opus = { ...getRoster().opus, successor: 'ghost' };
  const replay = await h.queue.enqueueDurable(input);
  assert.equal(replay.deduped, true);
  assert.deepEqual(replay.entry.targets, ['codex']);
  await h.ledger.claim(h.threadId, admitted.entry.id, 'last', 202, 'codex');
  await h.ledger.commit(h.threadId, admitted.entry.id, 'last', 'processing', 203);
  const reopenedLedger = new RedisQueueLedgerStore(h.redis);
  const reopened = new InvocationQueue(reopenedLedger, {
    resolvePreResolvedTargets: () => assert.fail('receipt replay must not reroute'),
  });
  const retired = await reopened.enqueueDurable(input);
  assert.equal(retired.deduped, true);
  assert.deepEqual(retired.entries, []);
  await assert.rejects(reopened.enqueueDurable({ ...input, content: 'different work' }), /identity conflict/);
  assert.deepEqual(await reopenedLedger.list(h.threadId), []);
});

test('Redis base-shape receipt without requestedTargetCats remains compatible', async (t) => {
  const h = await fixture(t);
  const legacy = new InvocationQueue(h.ledger);
  const input = privateInput(h.threadId, { targetCats: ['codex'] });
  const admitted = await legacy.enqueueDurable(input);
  assert.equal(admitted.entry.payload.requestedTargetCats, undefined);
  await h.ledger.claim(h.threadId, admitted.entry.id, 'old', 200, 'codex');
  await h.ledger.commit(h.threadId, admitted.entry.id, 'old', 'processing', 201);
  getRoster().codex = { ...getRoster().codex, available: false };
  const replay = await h.queue.enqueueDurable(input);
  assert.equal(replay.deduped, true);
  assert.deepEqual(replay.entries, []);
});

test('Redis visible-notice replay keeps the old receipt after its target retires', async (t) => {
  const h = await fixture(t);
  const messages = new RedisMessageStore(h.redis, { ttlSeconds: 0 });
  const input = privateInput(h.threadId);
  const notice = {
    from: input.from,
    userId: input.userId,
    threadId: h.threadId,
    content: 'notice',
    mentions: [],
    timestamp: 1,
    idempotencyKey: 'notice',
  };
  const admitted = await h.queue.enqueueDurableWithVisibleNotice(input, notice, messages);
  await h.ledger.claim(h.threadId, admitted.entry.id, 'notice', 200, 'opus-5');
  await h.ledger.commit(h.threadId, admitted.entry.id, 'notice', 'processing', 201);
  getRoster().opus = { ...getRoster().opus, successor: 'ghost' };
  const replay = await h.queue.enqueueDurableWithVisibleNotice(input, notice, messages);
  assert.equal(replay.deduped, true);
  assert.equal(replay.notice.id, admitted.notice.id);
  assert.deepEqual(await h.ledger.list(h.threadId), []);
  assert.equal((await messages.getByThread(h.threadId)).length, 1);
});
