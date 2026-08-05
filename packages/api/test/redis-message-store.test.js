/**
 * RedisMessageStore tests
 * 有 Redis → 测全量；无 Redis → skip
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

function luaHash(fields) {
  return Object.entries(fields).flat();
}

describe('RedisMessageStore message JSON Unicode boundary', () => {
  it('normalizes lone surrogates before serializing the Redis hash', async () => {
    const { RedisMessageStore } = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    const loneHighSurrogate = String.fromCharCode(0xd800);
    const loneLowSurrogate = String.fromCharCode(0xdc00);
    let persistedFields;
    const redis = {
      options: {},
      eval: async (...args) => {
        const keyCount = Number(args[1]);
        persistedFields = JSON.parse(args[keyCount + 3]);
        return ['committed', persistedFields.id];
      },
      hgetall: async () => persistedFields,
    };
    const store = new RedisMessageStore(redis);
    const input = {
      userId: 'unicode-user',
      catId: 'codex',
      content: `redis${loneHighSurrogate}message 😀`,
      mentions: [],
      timestamp: 900,
      extra: { targetCats: [`codex${loneLowSurrogate}`] },
    };

    const stored = await store.append(input);

    assert.equal(persistedFields.content, 'redis�message 😀');
    assert.deepEqual(JSON.parse(persistedFields.extra).targetCats, ['codex�']);
    assert.equal(stored.content, 'redis�message 😀');
    assert.equal(input.content, `redis${loneHighSurrogate}message 😀`, 'normalization must not mutate caller input');
  });
});

describe('RedisMessageStore.markDelivered atomic transition', () => {
  it('uses Redis-side compare-and-set instead of read-check-write pipeline', async () => {
    const { RedisMessageStore } = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    const evalCalls = [];
    let multiCalls = 0;
    const redis = {
      options: {},
      hgetall: async () => {
        throw new Error('markDelivered must hydrate from the Lua receipt, not a post-EVAL read');
      },
      eval: async (...args) => {
        evalCalls.push(args);
        return [
          1,
          luaHash({
            id: 'msg-atomic',
            threadId: 't1',
            userId: 'u1',
            catId: '',
            content: 'queued body',
            mentions: '[]',
            timestamp: '1000',
            deliveryStatus: 'delivered',
            deliveredAt: '2000',
            timelineOrderAt: '2000',
          }),
        ];
      },
      multi: () => {
        multiCalls += 1;
        return {
          hset() {
            return this;
          },
          zadd() {
            return this;
          },
          exec: async () => [],
        };
      },
    };
    const store = new RedisMessageStore(redis);

    const result = await store.markDelivered('msg-atomic', 2000);

    assert.equal(result?.deliveryTransitioned, true);
    assert.equal(evalCalls.length, 1, 'delivery transition must be guarded by one Redis EVAL CAS');
    assert.equal(evalCalls[0][1], 1, 'Lua derives all sorted-set keys from the canonical message hash');
    assert.equal(multiCalls, 0, 'read-check-write pipeline lets concurrent callers both report transition');
  });

  it('reports non-transition when the Redis compare-and-set loses the race', async () => {
    const { RedisMessageStore } = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    const canonical = {
      id: 'msg-race',
      threadId: 't1',
      userId: 'u1',
      catId: '',
      content: 'queued body',
      mentions: '[]',
      timestamp: '1000',
      deliveryStatus: 'delivered',
      deliveredAt: '2001',
    };
    const redis = {
      options: {},
      hgetall: async () => {
        throw new Error('lost CAS must hydrate from the Lua receipt, not a post-EVAL read');
      },
      eval: async () => [0, luaHash(canonical)],
      multi: () => {
        throw new Error('markDelivered must not fall back to non-atomic pipeline');
      },
    };
    const store = new RedisMessageStore(redis);

    const result = await store.markDelivered('msg-race', 2000);

    assert.equal(result?.deliveryTransitioned, false);
    assert.equal(result?.deliveryStatus, 'delivered');
    assert.equal(result?.deliveredAt, 2001);
  });
});

describe('RedisMessageStore.markCanceled atomic transition', () => {
  it('uses Redis-side compare-and-set and reports whether queued actually transitioned', async () => {
    const { RedisMessageStore } = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    const evalCalls = [];
    const canonical = {
      id: 'msg-cancel-race',
      threadId: 't1',
      userId: 'u1',
      catId: '',
      content: 'queued body',
      mentions: '[]',
      timestamp: '1000',
      deliveryStatus: 'delivered',
      deliveredAt: '2000',
    };
    const redis = {
      options: {},
      hgetall: async () => {
        throw new Error('lost cancel CAS must hydrate from the Lua receipt, not a post-EVAL read');
      },
      eval: async (...args) => {
        evalCalls.push(args);
        return [0, luaHash(canonical)];
      },
      hset: async () => {
        throw new Error('markCanceled must not use an unconditional HSET');
      },
    };
    const store = new RedisMessageStore(redis);

    const result = await store.markCanceled('msg-cancel-race');

    assert.equal(evalCalls.length, 1);
    assert.equal(result?.deliveryTransitioned, false);
    assert.equal(result?.deliveryStatus, 'delivered');
  });
});

describe('RedisMessageStore bounded forward thread reads', () => {
  it('does not materialize the full thread index when a no-cursor read has a limit', async () => {
    const { RedisMessageStore } = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    const ids = Array.from({ length: 120 }, (_, index) => `msg-${String(index).padStart(3, '0')}`);
    const rangeCalls = [];
    const redis = {
      options: {},
      zrange: async (_key, start, stop) => {
        rangeCalls.push([start, stop]);
        const inclusiveStop = stop === -1 ? ids.length : stop + 1;
        return ids.slice(start, inclusiveStop);
      },
      multi: () => {
        const requested = [];
        return {
          hgetall(key) {
            requested.push(key.replace(/^msg:/, ''));
            return this;
          },
          async exec() {
            return requested.map((id) => {
              const index = ids.indexOf(id);
              return [
                null,
                {
                  id,
                  threadId: 'bounded-forward',
                  userId: 'user-1',
                  catId: index < 55 ? '' : 'opus',
                  content: id,
                  mentions: '[]',
                  timestamp: String(index + 1),
                  ...(index < 55 ? { deliveryStatus: 'queued' } : {}),
                },
              ];
            });
          },
        };
      },
    };
    const store = new RedisMessageStore(redis);

    const messages = await store.getByThreadAfter('bounded-forward', undefined, 2, 'user-1');

    assert.deepEqual(
      messages.map((message) => message.id),
      ['msg-055', 'msg-056'],
    );
    assert.ok(rangeCalls.length >= 2, 'hidden rows require bounded continuation reads');
    assert.ok(
      rangeCalls.every(([, stop]) => stop !== -1),
      `bounded reads must never request the full sorted set; calls=${JSON.stringify(rangeCalls)}`,
    );
  });
});

describe('RedisMessageStore bounded thread scan', () => {
  it('caps raw sorted-set candidates and Redis round-trips when rows are canceled', async () => {
    const { RedisMessageStore } = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    const ids = Array.from({ length: 3_000 }, (_, index) => `msg-${String(index).padStart(4, '0')}`).reverse();
    let rangeCalls = 0;
    let hydrateCalls = 0;
    let zscoreCalls = 0;
    const redis = {
      options: {},
      zrevrangebyscore: async (_key, _max, _min, ...args) => {
        rangeCalls += 1;
        const limitIndex = args.indexOf('LIMIT');
        const offset = Number(args[limitIndex + 1]);
        const count = Number(args[limitIndex + 2]);
        return ids.slice(offset, offset + count).flatMap((id, index) => [id, String(3_000 - offset - index)]);
      },
      zscore: async () => {
        zscoreCalls += 1;
        return '1';
      },
      multi: () => {
        const requested = [];
        return {
          hgetall(key) {
            requested.push(key.replace(/^msg:/, ''));
            return this;
          },
          async exec() {
            hydrateCalls += 1;
            return requested.map((id) => [
              null,
              {
                id,
                threadId: 'bounded-thread',
                userId: 'user-1',
                catId: '',
                content: 'canceled',
                mentions: '[]',
                timestamp: '1',
                deliveryStatus: 'canceled',
              },
            ]);
          },
        };
      },
    };
    const store = new RedisMessageStore(redis);

    const page = await store.getByThreadBeforeBounded(
      'bounded-thread',
      Number.MAX_SAFE_INTEGER,
      500,
      undefined,
      'user-1',
      2_000,
    );

    assert.equal(page.messages.length, 0);
    assert.equal(page.scannedCount, 2_000);
    assert.equal(page.exhausted, false);
    assert.equal(page.storageRoundTrips, 8);
    assert.equal(rangeCalls, 4, '500-id chunks bound sorted-set reads');
    assert.equal(hydrateCalls, 4, 'one hydration pipeline per sorted-set chunk');
    assert.equal(zscoreCalls, 0, 'WITHSCORES must replace one ZSCORE round-trip per candidate');
  });

  it('keeps the full 2,000-candidate route window within eleven Redis round-trips', async () => {
    const { RedisMessageStore } = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    const ids = Array.from({ length: 2_100 }, (_, index) => `msg-${String(index).padStart(4, '0')}`).reverse();
    let rangeCalls = 0;
    let rankCalls = 0;
    let hydrateCalls = 0;
    const withScores = (slice, baseIndex) => slice.flatMap((id, index) => [id, String(2_100 - baseIndex - index)]);
    const redis = {
      options: {},
      zrevrangebyscore: async (_key, _max, _min, ...args) => {
        rangeCalls += 1;
        const limitIndex = args.indexOf('LIMIT');
        const offset = Number(args[limitIndex + 1]);
        const count = Number(args[limitIndex + 2]);
        return withScores(ids.slice(offset, offset + count), offset);
      },
      zrevrank: async (_key, id) => {
        rankCalls += 1;
        const rank = ids.indexOf(id);
        return rank < 0 ? null : rank;
      },
      zrevrange: async (_key, start, stop) => {
        rangeCalls += 1;
        return withScores(ids.slice(start, stop + 1), start);
      },
      multi: () => {
        const requested = [];
        return {
          hgetall(key) {
            requested.push(key.replace(/^msg:/, ''));
            return this;
          },
          async exec() {
            hydrateCalls += 1;
            return requested.map((id) => [
              null,
              {
                id,
                threadId: 'bounded-thread',
                userId: 'user-1',
                catId: '',
                content: 'delivered',
                mentions: '[]',
                timestamp: '1',
                deliveryStatus: 'delivered',
              },
            ]);
          },
        };
      },
    };
    const store = new RedisMessageStore(redis);
    let cursorTimestamp = Number.MAX_SAFE_INTEGER;
    let cursorId;
    let scannedCount = 0;
    let storageRoundTrips = 0;

    while (scannedCount < 2_000) {
      const page = await store.getByThreadBeforeBounded(
        'bounded-thread',
        cursorTimestamp,
        500,
        cursorId,
        'user-1',
        2_000 - scannedCount,
      );
      scannedCount += page.scannedCount;
      storageRoundTrips += page.storageRoundTrips;
      cursorTimestamp = page.nextCursor.timestamp;
      cursorId = page.nextCursor.id;
    }

    assert.equal(scannedCount, 2_000);
    assert.equal(rangeCalls, 4);
    assert.equal(rankCalls, 3);
    assert.equal(hydrateCalls, 4);
    assert.equal(storageRoundTrips, 11);
  });
});

describe('RedisMessageStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisMessageStore;
  let generateSortableId;
  let collectAllThreadMessages;
  let createRedisClient;
  let MessageKeys;
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisMessageStore');

    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    RedisMessageStore = storeModule.RedisMessageStore;
    ({ generateSortableId } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));
    ({ collectAllThreadMessages } = await import(
      '../dist/domains/cats/services/agents/routing/thread-artifacts-aggregator.js'
    ));
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;
    ({ MessageKeys } = await import('../dist/domains/cats/services/stores/redis-keys/message-keys.js'));

    redis = createRedisClient({ url: REDIS_URL });
    // Connectivity check: skip all tests if Redis is unreachable
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-message-store.test] Redis unreachable, skipping tests');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisMessageStore(redis, { ttlSeconds: 60 });
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, ['msg:*']);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['msg:*']);
  });

  it('append() stores message and returns with id', async () => {
    const msg = await store.append({
      userId: 'user1',
      catId: null,
      content: 'hello',
      mentions: ['opus'],
      timestamp: Date.now(),
    });
    assert.ok(msg.id);
    assert.equal(msg.content, 'hello');
    assert.equal(msg.userId, 'user1');
  });

  it('F287 rehydrates a strict delivery-decision carrier from the real Redis hash', async () => {
    const deliveryDecision = {
      v: 1,
      producer: 'github_ci',
      producerProvenance: 'server_github_ci',
      repoFullName: 'zts212653/cat-cafe',
      prNumber: 3276,
      headSha: 'b'.repeat(40),
      phase: 'merge_gate',
      gateOutcome: 'source_evidence_complete',
      externalCondition: 'billing_spending_limit_zero_step',
      candidateAction: 'merge',
      occurredAt: 1_785_600_000_000,
    };
    const stored = await store.append({
      userId: 'user-f287-billing',
      catId: null,
      content: 'GitHub CI failed before any source step ran.',
      mentions: ['opus'],
      timestamp: deliveryDecision.occurredAt,
      threadId: 'thread-f287-billing',
      source: { connector: 'github-ci', label: 'GitHub CI/CD', icon: 'github' },
      extra: { memoryCue: { deliveryDecision } },
    });

    const hydrated = await store.getById(stored.id);

    assert.deepEqual(hydrated?.extra?.memoryCue, { deliveryDecision });
  });

  it('listOwnerMessagesInWindow returns the exact delivered owner timeline with inclusive boundaries and no page cap', async () => {
    const base = Date.now() - 10_000;
    const append = (overrides) =>
      store.append({
        userId: 'owner-window',
        catId: null,
        content: 'candidate',
        mentions: [],
        threadId: 'thread-a',
        ...overrides,
      });

    await append({ content: 'before', timestamp: base - 1 });
    const lower = await append({ content: 'lower', timestamp: base });
    await append({ content: 'other owner', timestamp: base + 1, userId: 'other-owner' });
    await append({ content: 'queued', timestamp: base + 2, deliveryStatus: 'queued' });
    const delivered = await append({ content: 'delivered later', timestamp: base - 2, deliveryStatus: 'queued' });
    await store.markDelivered(delivered.id, base + 3);
    const canceled = await append({ content: 'canceled', timestamp: base + 4, deliveryStatus: 'queued' });
    await store.markCanceled(canceled.id);
    const restored = await append({ content: 'restored', timestamp: base + 5 });
    await store.softDelete(restored.id, 'owner-window');

    const middle = [];
    for (let offset = 6; offset < 81; offset += 1) {
      middle.push(await append({ content: `middle ${offset}`, timestamp: base + offset }));
    }
    const upper = await append({ content: 'upper', timestamp: base + 81 });
    await append({ content: 'after', timestamp: base + 82 });

    const firstRead = await store.listOwnerMessagesInWindow('owner-window', base, base + 81);
    assert.deepEqual(
      firstRead.map((message) => message.id),
      [lower.id, delivered.id, ...middle.map((message) => message.id), upper.id],
    );

    await store.restore(restored.id);
    const restoredRead = await store.listOwnerMessagesInWindow('owner-window', base, base + 81);
    assert.deepEqual(
      restoredRead.map((message) => message.id),
      [lower.id, delivered.id, restored.id, ...middle.map((message) => message.id), upper.id],
    );
  });

  it('all Redis append entrypoints reject unsafe timestamps and transition-owned metadata before side effects', async () => {
    const appenders = [
      ['append', (target, message) => target.append(message)],
      ['appendIfThreadFrontier', (target, message) => target.appendIfThreadFrontier(message, null)],
      ['appendAndObservePriorFrontier', (target, message) => target.appendAndObservePriorFrontier(message)],
    ];
    let listenerCalls = 0;
    const admissionStore = new RedisMessageStore(redis, { ttlSeconds: 0, onAppend: () => listenerCalls++ });

    for (const [name, append] of appenders) {
      for (const timestamp of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 8_640_000_000_000_001]) {
        await assert.rejects(
          append(admissionStore, {
            userId: 'user1',
            catId: null,
            content: `${name} invalid timestamp`,
            mentions: [],
            timestamp,
            threadId: `thread-${name}`,
            idempotencyKey: `${name}-${String(timestamp)}`,
          }),
          { name: 'RangeError', message: /non-negative integer ECMAScript Date/ },
        );
      }
      for (const metadata of [
        { deliveredAt: undefined },
        { timelineOrderAt: undefined },
        { deliveredAt: 101, deliveryStatus: 'delivered' },
        { deliveryStatus: 'delivered' },
        { deliveryStatus: 'canceled' },
      ]) {
        await assert.rejects(
          append(admissionStore, {
            userId: 'user1',
            catId: null,
            content: `${name} forged terminal state`,
            mentions: [],
            timestamp: 100,
            threadId: `thread-${name}`,
            idempotencyKey: `${name}-terminal`,
            ...metadata,
          }),
          { name: 'TypeError', message: /append.*delivery metadata|transition owner/i },
        );
      }
    }

    const keys = [...(await redis.keys('cat-cafe:msg:*')), ...(await redis.keys('cat-cafe:cat-cafe:msg:*'))];
    assert.deepEqual(keys, []);
    assert.equal(listenerCalls, 0);
  });

  it('append admits and rehydrates the sortable-ID-safe Date boundaries', async () => {
    const roundTripStore = new RedisMessageStore(redis, { ttlSeconds: 0 });
    for (const timestamp of [0, 1, 8_640_000_000_000_000]) {
      const stored = await roundTripStore.append({
        userId: 'user1',
        catId: null,
        content: 'valid Date input',
        mentions: [],
        timestamp,
        deliveryStatus: 'queued',
      });
      const hydrated = await roundTripStore.getById(stored.id);
      assert.equal(hydrated.timestamp, timestamp);
      assert.equal(hydrated.deliveryStatus, 'queued');
      assert.equal(hydrated.deliveredAt, undefined);
      assert.equal(hydrated.timelineOrderAt, undefined);
    }
  });

  it('markDelivered rejects unsafe effective-order timestamps before hash/ZSET mutation and permits a valid retry', async () => {
    const admissionStore = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const invalidTimestamps = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 8_640_000_000_000_001];

    for (const [index, deliveredAt] of invalidTimestamps.entries()) {
      const userId = `user-delivery-admission-${index}`;
      const threadId = `thread-delivery-admission-${index}`;
      const queued = await admissionStore.append({
        userId,
        catId: null,
        content: `queued ${index}`,
        mentions: ['opus'],
        timestamp: 100 + index,
        threadId,
        deliveryStatus: 'queued',
      });
      const keys = {
        detail: `msg:${queued.id}`,
        timeline: 'msg:timeline',
        user: `msg:user:${userId}`,
        thread: `msg:thread:${threadId}`,
        mention: 'msg:mentions:opus',
      };
      const before = {
        hash: await redis.hgetall(keys.detail),
        timeline: await redis.zscore(keys.timeline, queued.id),
        user: await redis.zscore(keys.user, queued.id),
        thread: await redis.zscore(keys.thread, queued.id),
        mention: await redis.zscore(keys.mention, queued.id),
      };

      await assert.rejects(admissionStore.markDelivered(queued.id, deliveredAt), {
        name: 'RangeError',
        message: /non-negative integer ECMAScript Date/,
      });
      assert.deepEqual(await redis.hgetall(keys.detail), before.hash);
      assert.equal(await redis.zscore(keys.timeline, queued.id), before.timeline);
      assert.equal(await redis.zscore(keys.user, queued.id), before.user);
      assert.equal(await redis.zscore(keys.thread, queued.id), before.thread);
      assert.equal(await redis.zscore(keys.mention, queued.id), before.mention);

      const validDeliveredAt = index === 0 ? 0 : index === 1 ? 8_640_000_000_000_000 : 1_000 + index;
      const delivered = await admissionStore.markDelivered(queued.id, validDeliveredAt);
      assert.equal(delivered.deliveryTransitioned, true);
      assert.equal(delivered.deliveredAt, validDeliveredAt);
      assert.equal(delivered.timelineOrderAt, validDeliveredAt);

      const afterDelivery = await redis.hgetall(keys.detail);
      await assert.rejects(admissionStore.markDelivered(queued.id, deliveredAt), RangeError);
      assert.deepEqual(await redis.hgetall(keys.detail), afterDelivery, 'validation must not depend on current state');
    }
  });

  it('reassignUserId preserves admitted delivery order through raw-score forwarding and hydrated fallback', async () => {
    const admissionStore = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const cases = [
      { suffix: 'forwarded', deliveredAt: 8_640_000_000_000_000, removeSourceScore: false },
      { suffix: 'fallback', deliveredAt: 0, removeSourceScore: true },
    ];

    for (const { suffix, deliveredAt, removeSourceScore } of cases) {
      const sourceUserId = `user-delivery-source-${suffix}`;
      const targetUserId = `user-delivery-target-${suffix}`;
      const queued = await admissionStore.append({
        userId: sourceUserId,
        catId: null,
        content: suffix,
        mentions: [],
        timestamp: 100,
        threadId: 'thread-delivery-reassign',
        deliveryStatus: 'queued',
      });
      await admissionStore.markDelivered(queued.id, deliveredAt);
      if (removeSourceScore) await redis.zrem(`msg:user:${sourceUserId}`, queued.id);

      const reassigned = await admissionStore.reassignUserId(queued.id, targetUserId);
      assert.equal(reassigned.userId, targetUserId);
      assert.equal(reassigned.deliveredAt, deliveredAt);
      assert.equal(reassigned.timelineOrderAt, deliveredAt);
      assert.equal(await redis.zscore(`msg:user:${sourceUserId}`, queued.id), null);
      assert.equal(await redis.zscore(`msg:user:${targetUserId}`, queued.id), String(deliveredAt));
    }
  });

  it('markCanceled changes only queued rows and preserves legacy/delivered hashes and index scores', async () => {
    const admissionStore = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const userId = 'user-cancel-owner';
    const threadId = 'thread-cancel-owner';
    const base = { userId, catId: null, mentions: [], threadId };
    const queued = await admissionStore.append({
      ...base,
      content: 'queued',
      timestamp: 100,
      deliveryStatus: 'queued',
    });
    const legacy = await admissionStore.append({ ...base, content: 'legacy', timestamp: 110 });
    const delivered = await admissionStore.append({
      ...base,
      content: 'delivered',
      timestamp: 120,
      deliveryStatus: 'queued',
    });
    await admissionStore.markDelivered(delivered.id, 200);

    const snapshot = async (message) => ({
      hash: await redis.hgetall(`msg:${message.id}`),
      timeline: await redis.zscore('msg:timeline', message.id),
      user: await redis.zscore(`msg:user:${userId}`, message.id),
      thread: await redis.zscore(`msg:thread:${threadId}`, message.id),
    });
    const legacyBefore = await snapshot(legacy);
    const deliveredBefore = await snapshot(delivered);

    const canceled = await admissionStore.markCanceled(queued.id);
    assert.equal(canceled.deliveryTransitioned, true);
    assert.equal(canceled.deliveryStatus, 'canceled');
    assert.equal((await admissionStore.markCanceled(legacy.id)).deliveryTransitioned, false);
    assert.deepEqual(await snapshot(legacy), legacyBefore);
    assert.equal((await admissionStore.markCanceled(delivered.id)).deliveryTransitioned, false);
    assert.deepEqual(await snapshot(delivered), deliveredBefore);
    assert.equal((await admissionStore.markCanceled(queued.id)).deliveryTransitioned, false);
  });

  it('legacy hydration preserves blank invalid evidence, fractions, infinities, and missing epoch fallback', async () => {
    const cases = [
      { label: 'empty', timestamp: '', expected: Number.NaN },
      { label: 'whitespace', timestamp: '   ', expected: Number.NaN },
      { label: 'fractional', timestamp: '123.5', expected: 123.5 },
      { label: 'positive-infinity', timestamp: 'Infinity', expected: Number.POSITIVE_INFINITY },
      { label: 'negative-infinity', timestamp: '-Infinity', expected: Number.NEGATIVE_INFINITY },
      { label: 'missing', timestamp: undefined, expected: 0 },
    ];
    const seeded = [];
    for (const [index, fixture] of cases.entries()) {
      const score = Date.now() + index;
      const id = generateSortableId(score);
      await redis.hset(`msg:${id}`, {
        id,
        threadId: 'thread-legacy-timestamp',
        userId: 'u',
        catId: '',
        content: fixture.label,
        mentions: '[]',
        ...(fixture.timestamp === undefined ? {} : { timestamp: fixture.timestamp }),
      });
      await redis.zadd('msg:timeline', String(score), id);
      seeded.push({ ...fixture, id });
    }

    for (const fixture of seeded) {
      const actual = (await store.getById(fixture.id)).timestamp;
      if (Number.isNaN(fixture.expected)) assert.ok(Number.isNaN(actual), fixture.label);
      else assert.equal(actual, fixture.expected, fixture.label);
    }
    const recent = new Map((await store.getRecent(10)).map((message) => [message.id, message.timestamp]));
    for (const fixture of seeded) {
      const actual = recent.get(fixture.id);
      if (Number.isNaN(fixture.expected)) assert.ok(Number.isNaN(actual), fixture.label);
      else assert.equal(actual, fixture.expected, fixture.label);
    }
  });

  it('legacy fractional and infinity cursors remain exclusive and bounded consumers make progress', async () => {
    const base = Date.now();
    const cases = [
      { label: 'fractional', cursorTimestamp: base + 0.5, earlierTimestamp: base },
      { label: 'positive-infinity', cursorTimestamp: Number.POSITIVE_INFINITY, earlierTimestamp: base + 1 },
      { label: 'negative-infinity', cursorTimestamp: Number.NEGATIVE_INFINITY, earlierTimestamp: null },
    ];

    for (const [index, fixture] of cases.entries()) {
      const threadId = `thread-legacy-${fixture.label}`;
      const userId = `user-legacy-${fixture.label}`;
      const earlier =
        fixture.earlierTimestamp === null
          ? null
          : await store.append({
              userId,
              catId: null,
              content: `earlier than ${fixture.label}`,
              mentions: [],
              timestamp: fixture.earlierTimestamp,
              threadId,
            });
      const cursorId = generateSortableId(base + cases.length + index);
      await redis.hset(`msg:${cursorId}`, {
        id: cursorId,
        threadId,
        userId,
        catId: '',
        content: `legacy ${fixture.label} cursor`,
        mentions: '[]',
        timestamp: String(fixture.cursorTimestamp),
      });
      await redis.zadd('msg:timeline', String(fixture.cursorTimestamp), cursorId);
      await redis.zadd(`msg:user:${userId}`, String(fixture.cursorTimestamp), cursorId);
      await redis.zadd(`msg:thread:${threadId}`, String(fixture.cursorTimestamp), cursorId);
      const expectedIds = earlier ? [earlier.id] : [];

      assert.deepEqual(
        (await store.getBefore(fixture.cursorTimestamp, 10, userId, cursorId)).map((message) => message.id),
        expectedIds,
      );
      assert.deepEqual(
        (await store.getByThreadBefore(threadId, fixture.cursorTimestamp, 10, cursorId)).map((message) => message.id),
        expectedIds,
      );

      if (earlier) {
        let beforeCalls = 0;
        const boundedStore = {
          getByThread: (...args) => store.getByThread(...args),
          getByThreadBefore: (...args) => {
            beforeCalls += 1;
            if (beforeCalls > 3) throw new Error('before-cursor pagination did not make progress');
            return store.getByThreadBefore(...args);
          },
        };
        const collected = await collectAllThreadMessages(boundedStore, threadId, undefined, 1);
        assert.equal(beforeCalls, 2);
        assert.deepEqual(new Set(collected.map((message) => message.id)), new Set([earlier.id, cursorId]));
      }
    }
  });

  it('bounded Redis pages preserve a fractional effective-order cursor without truncation', async () => {
    const threadId = 'thread-legacy-bounded-fraction';
    const id = generateSortableId(Date.now());
    await redis.hset(`msg:${id}`, {
      id,
      threadId,
      userId: 'u',
      catId: '',
      content: 'legacy fraction',
      mentions: '[]',
      timestamp: '10.5',
    });
    await redis.zadd(`msg:thread:${threadId}`, '10.5', id);

    const page = await store.getByThreadBeforeBounded(threadId, 11, 1, undefined, undefined, 1);
    assert.deepEqual(
      page.messages.map((message) => message.id),
      [id],
    );
    assert.deepEqual(page.nextCursor, { timestamp: 10.5, id });
  });

  it('claimContentDedupKey() is atomic: first wins, live duplicate loses, distinct keys independent', async () => {
    const first = await store.claimContentDedupKey('fp-abc', 5000);
    assert.equal(first, true, 'first claim of a fingerprint succeeds');
    const second = await store.claimContentDedupKey('fp-abc', 5000);
    assert.equal(second, false, 'a still-live claim of the same fingerprint is reported as duplicate');
    const other = await store.claimContentDedupKey('fp-xyz', 5000);
    assert.equal(other, true, 'a different fingerprint is independent');
  });

  it('claimContentDedupKey() re-allows a fingerprint after the PX window expires', async () => {
    const first = await store.claimContentDedupKey('fp-ttl', 40);
    assert.equal(first, true);
    const immediate = await store.claimContentDedupKey('fp-ttl', 40);
    assert.equal(immediate, false, 'within window → duplicate');
    await new Promise((resolve) => setTimeout(resolve, 90)); // wait past the PX TTL
    const afterExpiry = await store.claimContentDedupKey('fp-ttl', 40);
    assert.equal(afterExpiry, true, 'after Redis PX expiry the fingerprint can be claimed again');
  });

  it('getRecent() returns messages in chronological order', async () => {
    const now = Date.now();
    await store.append({ userId: 'u', catId: null, content: 'first', mentions: [], timestamp: now });
    await store.append({ userId: 'u', catId: 'opus', content: 'second', mentions: [], timestamp: now + 1 });
    await store.append({ userId: 'u', catId: null, content: 'third', mentions: [], timestamp: now + 2 });

    const recent = await store.getRecent(10);
    assert.equal(recent.length, 3);
    assert.equal(recent[0].content, 'first');
    assert.equal(recent[2].content, 'third');
  });

  it('getRecent() filters by userId', async () => {
    const now = Date.now();
    await store.append({ userId: 'alice', catId: null, content: 'alice msg', mentions: [], timestamp: now });
    await store.append({ userId: 'bob', catId: null, content: 'bob msg', mentions: [], timestamp: now + 1 });

    const aliceOnly = await store.getRecent(10, 'alice');
    assert.equal(aliceOnly.length, 1);
    assert.equal(aliceOnly[0].content, 'alice msg');
  });

  it('getMentionsFor() returns messages mentioning a specific cat', async () => {
    const now = Date.now();
    await store.append({ userId: 'u', catId: null, content: 'hi opus', mentions: ['opus'], timestamp: now });
    await store.append({ userId: 'u', catId: null, content: 'hi codex', mentions: ['codex'], timestamp: now + 1 });
    await store.append({
      userId: 'u',
      catId: null,
      content: 'hi both',
      mentions: ['opus', 'codex'],
      timestamp: now + 2,
    });

    const opusMentions = await store.getMentionsFor('opus');
    assert.equal(opusMentions.length, 2);
    assert.equal(opusMentions[0].content, 'hi opus');
    assert.equal(opusMentions[1].content, 'hi both');
  });

  it('getMentionsFor() filters by threadId (#75)', async () => {
    const now = Date.now();
    await store.append({
      userId: 'u',
      catId: null,
      content: '@opus in tA',
      mentions: ['opus'],
      timestamp: now,
      threadId: 'thread-A',
    });
    await store.append({
      userId: 'u',
      catId: null,
      content: '@opus in tB',
      mentions: ['opus'],
      timestamp: now + 1,
      threadId: 'thread-B',
    });
    await store.append({
      userId: 'u',
      catId: null,
      content: '@opus in tA again',
      mentions: ['opus'],
      timestamp: now + 2,
      threadId: 'thread-A',
    });

    const threadA = await store.getMentionsFor('opus', 10, undefined, 'thread-A');
    assert.equal(threadA.length, 2);
    assert.equal(threadA[0].content, '@opus in tA');
    assert.equal(threadA[1].content, '@opus in tA again');

    // Without threadId returns all
    const all = await store.getMentionsFor('opus', 10);
    assert.equal(all.length, 3);
  });

  it('getBefore() returns messages before timestamp', async () => {
    const base = Date.now();
    await store.append({ userId: 'u', catId: null, content: 'old', mentions: [], timestamp: base });
    await store.append({ userId: 'u', catId: null, content: 'mid', mentions: [], timestamp: base + 100 });
    await store.append({ userId: 'u', catId: null, content: 'new', mentions: [], timestamp: base + 200 });

    const before = await store.getBefore(base + 200, 10);
    assert.equal(before.length, 2);
    assert.equal(before[0].content, 'old');
    assert.equal(before[1].content, 'mid');
  });

  it('getBefore() respects limit', async () => {
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      await store.append({ userId: 'u', catId: null, content: `msg${i}`, mentions: [], timestamp: base + i });
    }

    const before = await store.getBefore(base + 5, 2);
    assert.equal(before.length, 2);
    // Should get the 2 most recent before the cursor
    assert.equal(before[0].content, 'msg3');
    assert.equal(before[1].content, 'msg4');
  });

  it('getByThreadBeforeBounded resumes from a real Redis rank cursor and proves exhaustion', async () => {
    const base = Date.now();
    for (let index = 0; index < 510; index += 1) {
      await store.append({
        userId: 'user-1',
        catId: null,
        content: `bounded ${index}`,
        mentions: [],
        timestamp: base + index,
        threadId: 'bounded-real-redis',
      });
    }

    const first = await store.getByThreadBeforeBounded(
      'bounded-real-redis',
      Number.MAX_SAFE_INTEGER,
      500,
      undefined,
      'user-1',
      2_000,
    );
    const second = await store.getByThreadBeforeBounded(
      'bounded-real-redis',
      first.nextCursor.timestamp,
      500,
      first.nextCursor.id,
      'user-1',
      1_500,
    );

    assert.equal(first.messages.length, 500);
    assert.equal(first.scannedCount, 500);
    assert.equal(first.exhausted, false);
    assert.equal(first.storageRoundTrips, 2);
    assert.equal(second.messages.length, 10);
    assert.equal(second.scannedCount, 10);
    assert.equal(second.exhausted, true);
    assert.equal(second.storageRoundTrips, 3);
    assert.equal(new Set([...first.messages, ...second.messages].map((message) => message.id)).size, 510);
  });

  it('augmentStreamMetadata() persists stream-only metadata onto callback messages', async () => {
    const msg = await store.append({
      userId: 'u',
      catId: 'opus',
      content: 'callback canonical',
      mentions: [],
      timestamp: Date.now(),
      origin: 'callback',
      extra: { rich: { v: 1, blocks: [{ id: 'callback-card', kind: 'card', v: 1, title: 'Callback' }] } },
    });

    await store.augmentStreamMetadata(msg.id, {
      thinking: 'stream thinking',
      metadata: { provider: 'mock', model: 'test' },
      toolEvents: [{ id: 'te-1', type: 'tool_result', label: 'post_message ok', timestamp: Date.now() }],
      mentionsUser: true,
      extra: {
        stream: { invocationId: 'parent-inv' },
        tracing: { traceId: 'trace-1', spanId: 'span-1' },
        rich: { v: 1, blocks: [{ id: 'stream-card', kind: 'card', v: 1, title: 'Stream' }] },
      },
    });

    const refetched = await store.getById(msg.id);
    assert.equal(refetched.content, 'callback canonical');
    assert.equal(refetched.origin, 'callback');
    assert.equal(refetched.thinking, 'stream thinking');
    assert.deepEqual(refetched.metadata, { provider: 'mock', model: 'test' });
    assert.equal(refetched.toolEvents.length, 1);
    assert.equal(refetched.mentionsUser, true);
    assert.deepEqual(refetched.extra.stream, { invocationId: 'parent-inv' });
    assert.deepEqual(refetched.extra.tracing, { traceId: 'trace-1', spanId: 'span-1' });
    assert.deepEqual(
      refetched.extra.rich.blocks.map((block) => block.id),
      ['callback-card', 'stream-card'],
    );
  });

  it('hardDelete clears toolEvents from returned object and Redis', async () => {
    const msg = await store.append({
      userId: 'u',
      catId: 'opus',
      content: 'tool msg',
      mentions: [],
      timestamp: Date.now(),
      toolEvents: [
        { id: 'te-1', type: 'tool_use', label: 'opus → read', timestamp: Date.now() },
        { id: 'te-2', type: 'tool_result', label: 'opus ← result', detail: 'ok', timestamp: Date.now() },
      ],
    });
    // Verify toolEvents were stored
    const before = await store.getById(msg.id);
    assert.equal(before.toolEvents.length, 2);

    // hardDelete should clear toolEvents
    const deleted = await store.hardDelete(msg.id, 'admin');
    assert.ok(deleted);
    assert.equal(deleted.toolEvents, undefined, 'returned object should not carry toolEvents');
    assert.equal(deleted._tombstone, true);

    // Re-fetch from Redis to confirm
    const refetched = await store.getById(msg.id);
    assert.equal(refetched.toolEvents, undefined, 'Redis should not return toolEvents after hardDelete');
  });

  it('hardDelete clears thinking from returned object and Redis (F045 security)', async () => {
    const msg = await store.append({
      userId: 'u',
      catId: 'opus',
      content: 'response with thinking',
      mentions: [],
      timestamp: Date.now(),
      thinking: 'secret extended reasoning that must not survive hard delete',
    });
    // Verify thinking was stored
    const before = await store.getById(msg.id);
    assert.equal(before.thinking, 'secret extended reasoning that must not survive hard delete');

    // hardDelete should clear thinking
    const deleted = await store.hardDelete(msg.id, 'admin');
    assert.ok(deleted);
    assert.equal(deleted.thinking, undefined, 'returned object should not carry thinking');
    assert.equal(deleted._tombstone, true);

    // Re-fetch from Redis to confirm thinking is gone
    const refetched = await store.getById(msg.id);
    assert.equal(refetched.thinking, undefined, 'Redis should not return thinking after hardDelete');
  });

  it('message TTL is set', async () => {
    const msg = await store.append({
      userId: 'u',
      catId: null,
      content: 'ttl test',
      mentions: [],
      timestamp: Date.now(),
    });
    const ttl = await redis.ttl(`msg:${msg.id}`);
    assert.ok(ttl > 0, `Expected positive TTL, got ${ttl}`);
    assert.ok(ttl <= 60, `Expected TTL <= 60, got ${ttl}`);
  });

  it('append() with same idempotencyKey returns existing message', async () => {
    const first = await store.append({
      userId: 'u1',
      catId: null,
      content: 'kickoff',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread-idem',
      idempotencyKey: 'backlog:b1:attempt:a1',
    });

    const second = await store.append({
      userId: 'u1',
      catId: null,
      content: 'kickoff retried',
      mentions: [],
      timestamp: Date.now() + 1,
      threadId: 'thread-idem',
      idempotencyKey: 'backlog:b1:attempt:a1',
    });

    assert.equal(second.id, first.id);
    assert.equal(second.content, 'kickoff');

    const threadMessages = await store.getByThread('thread-idem', 10, 'u1');
    assert.equal(threadMessages.length, 1);
    assert.equal(threadMessages[0].id, first.id);
  });

  it('concurrent idempotent append creates exactly one thread member', async () => {
    const threadId = 'thread-concurrent-idem';
    const timestamp = Date.now();

    const [first, second] = await Promise.all([
      store.append({
        userId: 'u1',
        catId: null,
        content: 'concurrent',
        mentions: [],
        timestamp,
        threadId,
        idempotencyKey: 'concurrent-idem',
      }),
      store.append({
        userId: 'u1',
        catId: null,
        content: 'concurrent',
        mentions: [],
        timestamp,
        threadId,
        idempotencyKey: 'concurrent-idem',
      }),
    ]);

    assert.equal(first.id, second.id, 'both callers must observe the same winner');
    assert.deepEqual(await redis.zrange(`msg:thread:${threadId}`, 0, -1), [first.id]);
  });

  it('idempotent replay does not refire onAppend', async () => {
    let calls = 0;
    const timestamp = Date.now();
    const watchedStore = new RedisMessageStore(redis, {
      ttlSeconds: 60,
      onAppend: () => {
        calls += 1;
      },
    });
    const input = {
      userId: 'u1',
      catId: null,
      content: 'idempotent listener',
      mentions: [],
      timestamp,
      threadId: 'thread-redis-onappend',
      idempotencyKey: 'redis-onappend',
    };

    const first = await watchedStore.append(input);
    const replay = await watchedStore.append({ ...input, content: 'retry', timestamp: timestamp + 1 });

    assert.equal(replay.id, first.id);
    assert.equal(calls, 1, 'only the committed winner may fire onAppend');
  });

  it('idempotent replay preserves explicitly empty optional arrays', async () => {
    const input = {
      userId: 'u1',
      catId: null,
      content: 'empty arrays',
      contentBlocks: [],
      toolEvents: [],
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread-empty-arrays',
      whisperTo: [],
      idempotencyKey: 'empty-arrays',
    };

    const first = await store.append(input);
    const replay = await store.append(input);
    const hydrated = await store.getById(first.id);

    for (const message of [first, replay, hydrated]) {
      assert.deepEqual(message?.contentBlocks, []);
      assert.deepEqual(message?.toolEvents, []);
      assert.deepEqual(message?.whisperTo, []);
    }
  });

  it('atomically reclaims an idempotency key whose message hash is missing', async () => {
    const userId = 'u1';
    const threadId = 'thread-stale-idem';
    const idempotencyKey = 'stale-idem';
    const redisKey = MessageKeys.idempotency(userId, threadId, idempotencyKey);
    const missingId = generateSortableId(Date.now() - 1);
    const liveWinner = await store.append({
      userId,
      catId: null,
      content: 'concurrent live winner',
      mentions: [],
      timestamp: Date.now(),
      threadId,
      idempotencyKey: 'winner-seed',
    });
    await redis.set(redisKey, missingId);

    const originalDel = redis.del;
    const originalEval = redis.eval;
    let injectReplacement = true;
    const replaceStalePointer = async () => {
      if (!injectReplacement) return;
      injectReplacement = false;
      await redis.set(redisKey, liveWinner.id);
    };
    redis.del = async function (...keys) {
      if (keys.includes(redisKey)) await replaceStalePointer();
      return originalDel.apply(this, keys);
    };
    redis.eval = async function (...args) {
      await replaceStalePointer();
      return originalEval.apply(this, args);
    };

    let replay;
    try {
      replay = await store.append({
        userId,
        catId: null,
        content: 'must observe concurrent winner',
        mentions: [],
        timestamp: Date.now() + 1,
        threadId,
        idempotencyKey,
      });
    } finally {
      redis.del = originalDel;
      redis.eval = originalEval;
    }

    assert.equal(replay.id, liveWinner.id);
    assert.equal(await redis.get(redisKey), liveWinner.id);
    assert.deepEqual(await redis.zrange(MessageKeys.thread(threadId), 0, -1), [liveWinner.id]);
  });

  it('fails closed when an idempotency winner vanishes before hydration', async () => {
    const userId = 'u1';
    const threadId = 'thread-vanished-winner';
    const idempotencyKey = 'vanished-winner';
    const winner = await store.append({
      userId,
      catId: null,
      content: 'winner',
      mentions: [],
      timestamp: Date.now(),
      threadId,
      idempotencyKey,
    });

    let listenerCalls = 0;
    const watchedStore = new RedisMessageStore(redis, {
      ttlSeconds: 60,
      onAppend: () => {
        listenerCalls += 1;
      },
    });
    const redisKey = MessageKeys.idempotency(userId, threadId, idempotencyKey);
    const originalGet = redis.get;
    const originalEval = redis.eval;
    let bypassFastPath = true;
    let removeWinnerAfterLua = true;

    redis.get = async function (key, ...args) {
      if (bypassFastPath && key === redisKey) {
        bypassFastPath = false;
        return null;
      }
      return originalGet.call(this, key, ...args);
    };
    redis.eval = async function (...args) {
      const result = await originalEval.apply(this, args);
      const returnedId = Array.isArray(result) ? result[1] : result;
      if (removeWinnerAfterLua && returnedId === winner.id) {
        removeWinnerAfterLua = false;
        await this.del(MessageKeys.detail(winner.id));
      }
      return result;
    };

    try {
      await assert.rejects(
        watchedStore.append({
          userId,
          catId: null,
          content: 'loser',
          mentions: [],
          timestamp: Date.now() + 1,
          threadId,
          idempotencyKey,
        }),
        /Idempotency winner .* vanished before hydration/,
      );
    } finally {
      redis.get = originalGet;
      redis.eval = originalEval;
    }

    assert.equal(listenerCalls, 0);
    assert.deepEqual(await redis.zrange(MessageKeys.thread(threadId), 0, -1), [winner.id]);
  });

  it('prunes stale members from an active TTL-backed thread index', async () => {
    const threadId = 'thread-active-ttl-prune';
    const threadKey = `msg:thread:${threadId}`;
    const staleId = generateSortableId(Date.now() - 120_000);
    await redis.zadd(threadKey, Date.now() - 120_000, staleId);

    const ttlStore = new RedisMessageStore(redis, { ttlSeconds: 60 });
    const current = await ttlStore.append({
      userId: 'u1',
      catId: null,
      content: 'keeps thread active',
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });

    assert.deepEqual(await redis.zrange(threadKey, 0, -1), [current.id]);
    assert.ok((await redis.ttl(threadKey)) > 0);
  });

  it('F057-C2: mentionsUser round-trips through append/getById', async () => {
    const msg = await store.append({
      userId: 'u',
      catId: 'opus',
      content: '@co-creator 看看这个',
      mentions: ['opus'],
      timestamp: Date.now(),
      threadId: 'thread-mention-user',
      mentionsUser: true,
    });
    assert.equal(msg.mentionsUser, true, 'append should return mentionsUser');

    const fetched = await store.getById(msg.id);
    assert.equal(fetched.mentionsUser, true, 'getById should deserialize mentionsUser');
  });

  it('F057-C2: mentionsUser round-trips through hydrateMessages (getByThread)', async () => {
    const now = Date.now();
    await store.append({
      userId: 'u',
      catId: 'opus',
      content: '@user please check',
      mentions: [],
      timestamp: now,
      threadId: 'thread-mention-hydrate',
      mentionsUser: true,
    });
    await store.append({
      userId: 'u',
      catId: null,
      content: 'normal message',
      mentions: [],
      timestamp: now + 1,
      threadId: 'thread-mention-hydrate',
    });

    const msgs = await store.getByThread('thread-mention-hydrate', 10);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].mentionsUser, true, 'first message should have mentionsUser');
    assert.equal(msgs[1].mentionsUser, undefined, 'second message should not have mentionsUser');
  });

  it('markDelivered updates sorted set score to deliveredAt (#557)', async () => {
    const base = Date.now();
    const threadId = 'thread-score-deliver-557';

    // msgA sent first (base), msgB sent second (base+100) — both queued
    const msgA = await store.append({
      userId: 'u',
      catId: null,
      content: 'msgA-sent-first',
      mentions: [],
      timestamp: base,
      threadId,
      deliveryStatus: 'queued',
    });
    const msgB = await store.append({
      userId: 'u',
      catId: null,
      content: 'msgB-sent-second',
      mentions: [],
      timestamp: base + 100,
      threadId,
      deliveryStatus: 'queued',
    });

    // Deliver in REVERSE order: msgB delivered early (base+50), msgA delivered late (base+200)
    // This makes deliveredAt order diverge from send-time order.
    await store.markDelivered(msgB.id, base + 50);
    await store.markDelivered(msgA.id, base + 200);

    // With deliveredAt scoring: msgB(50) < msgA(200) — B sorts before A
    // With send-time scoring: msgA(0) < msgB(100) — A sorts before B
    // NOTE: queued messages are filtered from getByThread (isDelivered check),
    // but after markDelivered they become 'delivered' and are visible.
    const all = await store.getByThread(threadId, 10);
    const order = all.map((m) => m.id);
    const idxA = order.indexOf(msgA.id);
    const idxB = order.indexOf(msgB.id);
    assert.ok(idxA >= 0, 'msgA should be in results after delivery');
    assert.ok(idxB >= 0, 'msgB should be in results after delivery');
    assert.ok(idxB < idxA, 'msgB (deliveredAt=base+50) should sort before msgA (deliveredAt=base+200)');
  });

  it('markDelivered records actual delivery time without moving already-published cat speech', async () => {
    const base = Date.now();
    const threadId = 'thread-published-cat-score';
    const speech = await store.append({
      userId: 'u',
      catId: 'codex-sol',
      content: 'already-published cat speech',
      mentions: ['opus'],
      timestamp: base,
      threadId,
      deliveryStatus: 'queued',
    });

    const delivered = await store.markDelivered(speech.id, base + 500);

    assert.equal(delivered.deliveredAt, base + 500, 'delivery lifecycle keeps its actual terminal timestamp');
    assert.equal(delivered.timelineOrderAt, base, 'publication order is persisted for future readers');
    assert.equal(
      await redis.zscore(`msg:thread:${threadId}`, speech.id),
      String(base),
      'timeline order remains at authoring time because the speech was already published',
    );
  });

  it('legacy delivered cat rows without timelineOrderAt keep their historical delivery ordering', async () => {
    const { getTimelineOrderTime } = await import('../dist/domains/cats/services/stores/visibility.js');
    assert.equal(
      getTimelineOrderTime({
        id: 'legacy-cat',
        threadId: 'legacy-thread',
        userId: 'u',
        catId: 'opus',
        content: 'legacy',
        mentions: [],
        timestamp: 1_000,
        deliveredAt: 1_500,
        deliveryStatus: 'delivered',
      }),
      1_500,
    );
  });

  it('getByThreadAfter() uses deliveredAt score for cursor position (#557)', async () => {
    const base = Date.now();
    const threadId = 'thread-cursor-deliver-557';

    // agentReply at base (simulates invocation start time) — already delivered (no deliveryStatus)
    const agentReply = await store.append({
      userId: 'u',
      catId: 'opus',
      content: 'agent-reply',
      mentions: [],
      timestamp: base,
      threadId,
    });
    // queuedMsg sent BEFORE agent reply (base-10), queued — delivered AFTER (base+500).
    // Without zadd re-scoring, original timestamp (base-10) < cursor (base), so it would NOT
    // appear; only deliveredAt re-scoring (base+500 > base) makes it visible after cursor.
    const queuedMsg = await store.append({
      userId: 'u',
      catId: null,
      content: 'queued-user-msg',
      mentions: [],
      timestamp: base - 10,
      threadId,
      deliveryStatus: 'queued',
    });
    await store.markDelivered(queuedMsg.id, base + 500);

    // After agent reply cursor: queuedMsg should appear only because score was updated to deliveredAt
    const after = await store.getByThreadAfter(threadId, agentReply.id);
    const ids = after.map((m) => m.id);
    assert.ok(
      ids.includes(queuedMsg.id),
      'queued msg (deliveredAt=base+500 > cursor=base) should appear after agent reply',
    );
  });

  it('F148: origin=briefing survives append → getById round-trip', async () => {
    const msg = await store.append({
      userId: 'system',
      catId: null,
      content: 'briefing summary',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread-briefing-rt',
      origin: 'briefing',
      extra: { rich: { v: 1, blocks: [{ id: 'b1', kind: 'card', v: 1, title: 'test', tone: 'info' }] } },
    });
    assert.equal(msg.origin, 'briefing', 'append should return origin=briefing');

    const fetched = await store.getById(msg.id);
    assert.equal(fetched.origin, 'briefing', 'getById must deserialize origin=briefing');
    assert.ok(fetched.extra?.rich?.blocks?.length, 'rich blocks must survive round-trip');
  });

  it('F148: origin=briefing survives hydrateMessages (getByThread)', async () => {
    const now = Date.now();
    await store.append({
      userId: 'system',
      catId: null,
      content: 'briefing card',
      mentions: [],
      timestamp: now,
      threadId: 'thread-briefing-hydrate',
      origin: 'briefing',
    });
    await store.append({
      userId: 'u',
      catId: null,
      content: 'normal',
      mentions: [],
      timestamp: now + 1,
      threadId: 'thread-briefing-hydrate',
    });

    const msgs = await store.getByThread('thread-briefing-hydrate', 10);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].origin, 'briefing', 'briefing message must keep origin via hydrateMessages');
    assert.equal(msgs[1].origin, undefined, 'normal message should have no origin');
  });

  // ── #697 + #805 review: scanByDeliveryStatus ──

  it('scanByDeliveryStatus returns IDs matching target status', async () => {
    const now = Date.now();
    // Create messages with different delivery statuses
    const m1 = await store.append({
      userId: 'u1',
      catId: null,
      content: 'queued msg 1',
      mentions: [],
      timestamp: now,
      threadId: 'thread-scan-1',
      deliveryStatus: 'queued',
    });
    const m2 = await store.append({
      userId: 'u1',
      catId: null,
      content: 'delivered msg',
      mentions: [],
      timestamp: now + 1,
      threadId: 'thread-scan-1',
    });
    const m3 = await store.append({
      userId: 'u1',
      catId: null,
      content: 'queued msg 2',
      mentions: [],
      timestamp: now + 2,
      threadId: 'thread-scan-2',
      deliveryStatus: 'queued',
    });

    const queuedIds = await store.scanByDeliveryStatus('queued');

    // Should find both queued messages
    assert.equal(queuedIds.length, 2, 'should find exactly 2 queued messages');
    assert.ok(queuedIds.includes(m1.id), 'should include first queued message');
    assert.ok(queuedIds.includes(m3.id), 'should include second queued message');
    // Should NOT include delivered message
    assert.ok(!queuedIds.includes(m2.id), 'should not include delivered message');
  });

  it('scanByDeliveryStatus returns empty array when no matches', async () => {
    const now = Date.now();
    await store.append({
      userId: 'u1',
      catId: null,
      content: 'normal msg',
      mentions: [],
      timestamp: now,
      threadId: 'thread-scan-empty',
    });

    const queuedIds = await store.scanByDeliveryStatus('queued');
    assert.equal(queuedIds.length, 0);
  });

  it('scanByDeliveryStatus result order is independent of insertion order (SCAN non-deterministic)', async () => {
    const now = Date.now();
    const created = [];
    for (let i = 0; i < 5; i++) {
      const msg = await store.append({
        userId: 'u1',
        catId: null,
        content: `queued ${i}`,
        mentions: [],
        timestamp: now + i,
        threadId: 'thread-scan-order',
        deliveryStatus: 'queued',
      });
      created.push(msg.id);
    }

    const queuedIds = await store.scanByDeliveryStatus('queued');

    // All 5 should be found regardless of SCAN order
    assert.equal(queuedIds.length, 5);
    for (const id of created) {
      assert.ok(queuedIds.includes(id), `should include ${id}`);
    }
  });

  it('scanByDeliveryStatus finds canceled messages', async () => {
    const now = Date.now();
    const m1 = await store.append({
      userId: 'u1',
      catId: null,
      content: 'will be canceled',
      mentions: [],
      timestamp: now,
      threadId: 'thread-scan-cancel',
      deliveryStatus: 'queued',
    });
    await store.markCanceled(m1.id);

    const canceledIds = await store.scanByDeliveryStatus('canceled');
    assert.ok(canceledIds.includes(m1.id), 'should find canceled message');

    const queuedIds = await store.scanByDeliveryStatus('queued');
    assert.ok(!queuedIds.includes(m1.id), 'should not find canceled message in queued scan');
  });
});
