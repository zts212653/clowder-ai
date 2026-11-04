// @ts-check
/**
 * F332 / #1087 review P2: the stop-point scan reads the thread's own index with
 * the recipient projection — HMGET of MESSAGE_RECIPIENT_FIELDS, never HGETALL,
 * and never contentBlocks / bodies / tool payloads of the scanned rows. Source
 * checks keep their full reads through the shared reply-parent resolver, capped
 * and counted separately. `extra` stays a whole field (existing recipient cost).
 * Runs only against an isolated Redis (scripts/run-isolated-redis-tests.mjs).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Redis from 'ioredis';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const { RedisMessageStore } = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
const { resolveResumeStopPoint } = await import('../dist/domains/cats/services/agents/routing/resume-stop-point.js');

const HEAVY = ['content', 'thinking', 'toolEvents', 'metadata', 'contentBlocks'];
const BLOCK_TEXT = 'enlarged block payload '.repeat(2500);
const blocks = (label) => [{ type: 'text', text: `${label} ${BLOCK_TEXT}` }];
const skip = redisIsolationSkipReason(process.env.REDIS_URL);

/** @param {(store: any, redis: Redis) => Promise<void>} body */
async function withIsolatedStore(body) {
  assertRedisIsolationOrThrow(process.env.REDIS_URL, 'F332ColdResumeRedis');
  const redis = new Redis(/** @type {string} */ (process.env.REDIS_URL), { keyPrefix: `f332-resume-${process.pid}:` });
  try {
    await body(new RedisMessageStore(redis, { ttlSeconds: 0 }), redis);
  } finally {
    await cleanupClientKeyspace(redis);
    redis.disconnect();
  }
}

/**
 * Count full hydrations and projected reads, recording every heavy field a
 * projected read selects (asserted afterwards: a throw here would surface as
 * the resolver's `unavailable`, hiding which field was read).
 */
function spyHashReads(redis) {
  const send = redis.sendCommand.bind(redis);
  const counts = { full: 0, projected: 0, projectedFields: new Set(), heavyFields: new Set() };
  redis.sendCommand = (command, ...args) => {
    if (command.name === 'hgetall') counts.full++;
    if (command.name === 'hmget') {
      counts.projected++;
      for (const field of command.args.slice(1).map(String)) {
        counts.projectedFields.add(field);
        if (HEAVY.includes(field)) counts.heavyFields.add(field);
      }
    }
    return send(command, ...args);
  };
  return { counts, restore: () => (redis.sendCommand = send) };
}

const userRequest = (store, timestamp, label) =>
  store.append({
    threadId: 'T',
    userId: 'owner',
    from: { kind: 'user', userId: 'owner' },
    content: `@opus ${label}`,
    contentBlocks: blocks(label),
    mentions: ['opus'],
    timestamp,
  });

const opusReply = (store, timestamp, inputMessageIds) =>
  store.append({
    threadId: 'T',
    userId: 'owner',
    from: { kind: 'agent', catId: 'opus' },
    content: 'REPLY body',
    contentBlocks: blocks('reply'),
    mentions: [],
    origin: 'stream',
    timestamp,
    lifecycle: {
      kind: 'response',
      orderKey: `${timestamp}:inv-redis`,
      invocationId: 'inv-redis',
      targetId: 'opus',
      inputEntryIds: inputMessageIds.map((_, index) => `entry-${index}`),
      inputMessageIds,
      status: 'completed',
      startedAt: timestamp,
      completedAt: timestamp,
    },
  });

const resolve = (store) =>
  resolveResumeStopPoint({
    messageStore: store,
    threadId: 'T',
    userId: 'owner',
    catId: 'opus',
    viewer: { type: 'cat', catId: /** @type {any} */ ('opus') },
  });

test(
  'stop point scan reads recipient rows from the thread index: no contentBlocks, bodies or tool payloads',
  { skip },
  () =>
    withIsolatedStore(async (store, redis) => {
      const request = await userRequest(store, 1_000, '帮我整理冷恢复需求');
      const reply = await opusReply(store, 1_001, [request.id]);
      // Heavy unrelated speech after the reply in the same thread, and a busy neighbour thread.
      for (let i = 0; i < 20; i++) {
        await store.append({
          threadId: 'T',
          userId: 'owner',
          from: { kind: 'agent', catId: 'codex' },
          content: `chatter ${i}`,
          contentBlocks: blocks(`chatter ${i}`),
          mentions: [],
          timestamp: 2_000 + i,
        });
      }
      for (let i = 0; i < 150; i++) {
        await store.append({
          threadId: 'NEIGHBOUR',
          userId: 'owner',
          from: { kind: 'user', userId: 'owner' },
          content: `neighbour ${i}`,
          mentions: [],
          timestamp: 3_000 + i,
        });
      }

      // The fixture really stores enlarged blocks: a full read returns them.
      const full = await store.getById(reply.id);
      assert.ok(full.contentBlocks[0].text.length > 50_000, 'fixture carries enlarged contentBlocks');
      // The recipient page itself carries none of them.
      const page = await store.getByThreadBeforeBounded('T', Number.MAX_SAFE_INTEGER, 100, undefined, 'owner', 100, {
        recipientProjection: true,
      });
      assert.equal(page.messages.length, 22);
      assert.ok(
        page.messages.every((message) => !message.contentBlocks?.length),
        'recipient rows omit contentBlocks',
      );

      const { counts, restore } = spyHashReads(redis);
      const result = await resolve(store);
      restore();

      assert.deepEqual([...counts.heavyFields], [], 'no projected read selects contentBlocks, bodies or tool payloads');
      assert.equal(result.kind, 'found');
      assert.equal(result.stopPoint.responseMessageId, reply.id);
      assert.deepEqual(result.stopPoint.sourceMessageIds, [request.id]);
      assert.ok(counts.projected >= 22, `every scanned thread row is a projected read (${counts.projected})`);
      assert.ok(counts.projectedFields.has('lifecycle'), 'projected reads still carry the lifecycle record');
      // Source checks are the only full reads: one listed input, one HGETALL.
      assert.equal(counts.full, 1, `source checks only (${counts.full} full reads)`);
    }),
);

test('source checks stay capped at six full reads, separate from the projected scan', { skip }, () =>
  withIsolatedStore(async (store, redis) => {
    const requests = [];
    for (let i = 0; i < 8; i++) requests.push(await userRequest(store, 1_000 + i, `request ${i}`));
    const reply = await opusReply(
      store,
      1_100,
      requests.map((request) => request.id),
    );

    const { counts, restore } = spyHashReads(redis);
    const result = await resolve(store);
    restore();

    assert.deepEqual([...counts.heavyFields], [], 'the scan stays on recipient fields');
    assert.equal(result.kind, 'found');
    assert.equal(result.stopPoint.responseMessageId, reply.id);
    assert.deepEqual(
      result.stopPoint.sourceMessageIds,
      requests.slice(-3).map((request) => request.id),
      'the three newest readable sources are listed',
    );
    assert.equal(result.stopPoint.unreadableSourceCount, 0);
    assert.equal(counts.full, 6, `the six newest inputs are checked with full reads (${counts.full})`);
    assert.ok(counts.projected >= 9, `the scan itself stays projected (${counts.projected})`);
  }),
);
