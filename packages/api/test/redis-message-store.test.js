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

  it('append() rejects timestamps outside the sortable-ID-safe Date domain before side effects', async () => {
    const invalidTimestamps = [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      8_640_000_000_000_001,
      -8_640_000_000_000_001,
    ];
    let listenerCalls = 0;
    const admissionStore = new RedisMessageStore(redis, {
      ttlSeconds: 60,
      onAppend: () => listenerCalls++,
    });

    for (const timestamp of invalidTimestamps) {
      await assert.rejects(
        admissionStore.append({
          userId: 'user1',
          catId: null,
          content: 'must not persist',
          mentions: [],
          timestamp,
          idempotencyKey: `invalid-date-${String(timestamp)}`,
        }),
        { name: 'RangeError', message: /non-negative integer ECMAScript Date/ },
      );
    }

    const keys = [...(await redis.keys('cat-cafe:msg:*')), ...(await redis.keys('cat-cafe:cat-cafe:msg:*'))];
    assert.deepEqual(keys, [], 'invalid timestamps must not create Redis keys');
    assert.equal(listenerCalls, 0, 'invalid timestamps must not notify listeners');
  });

  it('append() admits non-negative integer ECMAScript Date boundaries', async () => {
    const roundTripStore = new RedisMessageStore(redis, { ttlSeconds: 0 });
    for (const timestamp of [0, 1, 8_640_000_000_000_000]) {
      const stored = await roundTripStore.append({
        userId: 'user1',
        catId: null,
        content: 'valid Date input',
        mentions: [],
        timestamp,
      });
      assert.equal(stored.timestamp, timestamp);
      assert.equal((await roundTripStore.getById(stored.id)).timestamp, timestamp);
    }

    const hydrated = await roundTripStore.getRecent(10);
    assert.deepEqual(
      hydrated.map((message) => message.timestamp),
      [0, 1, 8_640_000_000_000_000],
    );
  });

  it('append() rejects transition-owned delivery metadata before Redis side effects and preserves queued parity', async () => {
    let listenerCalls = 0;
    const admissionStore = new RedisMessageStore(redis, {
      ttlSeconds: 0,
      onAppend: () => listenerCalls++,
    });
    const userId = 'user-append-delivery-owner';
    const threadId = 'thread-append-delivery-owner';
    const timestamp = 100;
    const base = {
      userId,
      catId: null,
      content: 'delivery ownership probe',
      mentions: ['opus'],
      timestamp,
      threadId,
      idempotencyKey: 'append-delivery-owner',
    };
    const invalidMetadata = [
      { deliveredAt: undefined },
      { deliveredAt: 100.5, deliveryStatus: 'delivered' },
      { deliveredAt: Number.POSITIVE_INFINITY, deliveryStatus: 'delivered' },
      { deliveredAt: 101, deliveryStatus: 'delivered' },
      { deliveryStatus: 'delivered' },
      { deliveryStatus: 'canceled' },
    ];

    for (const metadata of invalidMetadata) {
      await assert.rejects(admissionStore.append({ ...base, ...metadata }), {
        name: 'TypeError',
        message: /append.*delivery metadata|transition owner/i,
      });
      assert.equal(listenerCalls, 0, 'ownership rejection must not notify listeners');
      const keys = [...(await redis.keys('cat-cafe:msg:*')), ...(await redis.keys('cat-cafe:cat-cafe:msg:*'))];
      assert.deepEqual(keys, [], 'ownership rejection must not create Redis keys');
    }

    const queued = await admissionStore.append({ ...base, deliveryStatus: 'queued' });
    const hydrated = await admissionStore.getById(queued.id);
    assert.equal(queued.deliveryStatus, 'queued');
    assert.equal(queued.deliveredAt, undefined);
    assert.equal(hydrated.deliveryStatus, 'queued');
    assert.equal(hydrated.deliveredAt, undefined);
    assert.equal(await redis.zscore('msg:timeline', queued.id), String(timestamp));
    assert.equal(await redis.zscore(`msg:user:${userId}`, queued.id), String(timestamp));
    assert.equal(await redis.zscore(`msg:thread:${threadId}`, queued.id), String(timestamp));
    assert.equal(listenerCalls, 1);
  });

  it('markCanceled() transitions only queued messages and preserves legacy/delivered hash and scores', async () => {
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
      message: await admissionStore.getById(message.id),
      hash: await redis.hgetall(`msg:${message.id}`),
      timeline: await redis.zscore('msg:timeline', message.id),
      user: await redis.zscore(`msg:user:${userId}`, message.id),
      thread: await redis.zscore(`msg:thread:${threadId}`, message.id),
    });
    const legacyBefore = await snapshot(legacy);
    const deliveredBefore = await snapshot(delivered);

    const canceled = await admissionStore.markCanceled(queued.id);
    assert.equal(canceled.deliveryStatus, 'canceled');
    assert.equal(canceled.deliveredAt, undefined);
    assert.equal((await redis.hgetall(`msg:${queued.id}`)).deliveryStatus, 'canceled');
    assert.equal(await redis.zscore('msg:timeline', queued.id), '100');
    assert.equal(await redis.zscore(`msg:user:${userId}`, queued.id), '100');
    assert.equal(await redis.zscore(`msg:thread:${threadId}`, queued.id), '100');

    assert.equal(await admissionStore.markCanceled(legacy.id), null);
    assert.deepEqual(await snapshot(legacy), legacyBefore, 'legacy-immediate hash and scores must remain unchanged');

    const deliveredResult = await admissionStore.markCanceled(delivered.id);
    assert.equal(deliveredResult, null);
    assert.deepEqual(await snapshot(delivered), deliveredBefore, 'delivered hash and scores must remain unchanged');

    const canceledBefore = await snapshot(queued);
    assert.equal(await admissionStore.markCanceled(queued.id), null);
    assert.deepEqual(await snapshot(queued), canceledBefore, 'repeated cancellation must be a no-op');
  });

  it('markDelivered() rejects unsafe order timestamps before hash/ZSET mutation and permits a valid retry', async () => {
    const admissionStore = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const invalidTimestamps = [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      8_640_000_000_000_001,
      -8_640_000_000_000_001,
    ];
    const validTimestamps = [0, 8_640_000_000_000_000];

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

      assert.deepEqual(await redis.hgetall(keys.detail), before.hash, `invalid ${String(deliveredAt)} hash mutation`);
      assert.equal(await redis.zscore(keys.timeline, queued.id), before.timeline);
      assert.equal(await redis.zscore(keys.user, queued.id), before.user);
      assert.equal(await redis.zscore(keys.thread, queued.id), before.thread);
      assert.equal(await redis.zscore(keys.mention, queued.id), before.mention);
      const unchanged = await admissionStore.getById(queued.id);
      assert.equal(unchanged.deliveryStatus, 'queued');
      assert.equal(unchanged.deliveredAt, undefined);

      const validDeliveredAt = validTimestamps[index] ?? 1_000 + index;
      const delivered = await admissionStore.markDelivered(queued.id, validDeliveredAt);
      assert.equal(delivered.deliveryStatus, 'delivered');
      assert.equal(delivered.deliveredAt, validDeliveredAt);
      assert.equal(await redis.zscore(keys.timeline, queued.id), String(validDeliveredAt));
      assert.equal(await redis.zscore(keys.user, queued.id), String(validDeliveredAt));
      assert.equal(await redis.zscore(keys.thread, queued.id), String(validDeliveredAt));
      assert.equal(await redis.zscore(keys.mention, queued.id), before.mention, 'mention order remains append-time');
      assert.equal((await admissionStore.getById(queued.id)).deliveredAt, validDeliveredAt);

      const afterDelivery = {
        hash: await redis.hgetall(keys.detail),
        timeline: await redis.zscore(keys.timeline, queued.id),
        user: await redis.zscore(keys.user, queued.id),
        thread: await redis.zscore(keys.thread, queued.id),
        mention: await redis.zscore(keys.mention, queued.id),
      };
      await assert.rejects(admissionStore.markDelivered(queued.id, deliveredAt), RangeError);
      assert.deepEqual(
        await redis.hgetall(keys.detail),
        afterDelivery.hash,
        'invalid input must not be state-dependent',
      );
      assert.equal(await redis.zscore(keys.timeline, queued.id), afterDelivery.timeline);
      assert.equal(await redis.zscore(keys.user, queued.id), afterDelivery.user);
      assert.equal(await redis.zscore(keys.thread, queued.id), afterDelivery.thread);
      assert.equal(await redis.zscore(keys.mention, queued.id), afterDelivery.mention);
    }
  });

  it('markDelivered() recovery preserves bounded effective-order pagination', async () => {
    const admissionStore = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const threadId = 'thread-delivery-admission-pagination';
    const first = await admissionStore.append({
      userId: 'user-delivery-admission-pagination',
      catId: null,
      content: 'first',
      mentions: [],
      timestamp: 100,
      threadId,
      deliveryStatus: 'queued',
    });
    const second = await admissionStore.append({
      userId: 'user-delivery-admission-pagination',
      catId: null,
      content: 'second',
      mentions: [],
      timestamp: 200,
      threadId,
      deliveryStatus: 'queued',
    });

    await assert.rejects(admissionStore.markDelivered(first.id, Number.POSITIVE_INFINITY), RangeError);
    await admissionStore.markDelivered(first.id, 300);
    await admissionStore.markDelivered(second.id, 400);

    const collected = await collectAllThreadMessages(admissionStore, threadId, undefined, 1);
    assert.deepEqual(
      collected.map((message) => message.id),
      [second.id, first.id],
      'one-record pages must return both messages exactly once after a valid retry',
    );
  });

  it('admitted delivery order stays exact through user-index forwarding and missing-score fallback', async () => {
    const admissionStore = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const cases = [
      { suffix: 'forwarded', deliveredAt: 8_640_000_000_000_000, removeSourceScore: false },
      { suffix: 'fallback', deliveredAt: 0, removeSourceScore: true },
    ];

    for (const { suffix, deliveredAt, removeSourceScore } of cases) {
      const sourceUserId = `user-delivery-reassign-source-${suffix}`;
      const targetUserId = `user-delivery-reassign-target-${suffix}`;
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

      if (removeSourceScore) {
        await redis.zrem(`msg:user:${sourceUserId}`, queued.id);
      }
      const reassigned = await admissionStore.reassignUserId(queued.id, targetUserId);

      assert.equal(reassigned.userId, targetUserId);
      assert.equal(reassigned.deliveredAt, deliveredAt);
      assert.equal(await redis.zscore(`msg:user:${sourceUserId}`, queued.id), null);
      assert.equal(await redis.zscore(`msg:user:${targetUserId}`, queued.id), String(deliveredAt));
      assert.equal((await admissionStore.getById(queued.id)).deliveredAt, deliveredAt);
    }
  });

  it('expired cursor recovery preserves order across admitted timestamp boundaries', async () => {
    const roundTripStore = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const threadId = 'thread-expired-cursor-domain';
    const later = [];
    for (const timestamp of [2, 8_640_000_000_000_000]) {
      later.push(
        await roundTripStore.append({
          userId: 'user1',
          catId: null,
          content: `timestamp ${timestamp}`,
          mentions: [],
          timestamp,
          threadId,
        }),
      );
    }
    const expiredCursor = generateSortableId(1);

    assert.deepEqual(
      (await roundTripStore.getByThreadAfter(threadId, expiredCursor)).map((message) => message.id),
      later.map((message) => message.id),
    );
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

  it('legacy hydration distinguishes blank timestamps from fractional and missing values', async () => {
    const cases = [
      { label: 'empty', timestamp: '', expected: Number.NaN },
      { label: 'whitespace', timestamp: '   ', expected: Number.NaN },
      { label: 'fractional', timestamp: '123.5', expected: 123.5 },
      { label: 'missing', timestamp: undefined, expected: 0 },
    ];
    const seeded = [];
    for (const [index, fixture] of cases.entries()) {
      const score = Date.now() + index;
      const id = generateSortableId(score);
      await redis.hset(`msg:${id}`, {
        id,
        threadId: 'thread-legacy-blank-timestamp',
        userId: 'u',
        catId: '',
        content: `legacy ${fixture.label} timestamp`,
        mentions: '[]',
        ...(fixture.timestamp === undefined ? {} : { timestamp: fixture.timestamp }),
      });
      await redis.zadd('msg:timeline', String(score), id);
      seeded.push({ ...fixture, id });
    }

    for (const fixture of seeded) {
      const actual = (await store.getById(fixture.id)).timestamp;
      if (Number.isNaN(fixture.expected)) {
        assert.ok(Number.isNaN(actual), `single hydration must preserve ${fixture.label} invalid evidence`);
      } else {
        assert.equal(actual, fixture.expected);
      }
    }

    const recentById = new Map((await store.getRecent(10)).map((message) => [message.id, message]));
    for (const fixture of seeded) {
      const actual = recentById.get(fixture.id).timestamp;
      if (Number.isNaN(fixture.expected)) {
        assert.ok(Number.isNaN(actual), `batch hydration must preserve ${fixture.label} invalid evidence`);
      } else {
        assert.equal(actual, fixture.expected);
      }
    }
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

  it('legacy numeric cursors remain exclusive in global and thread pagination', async () => {
    const base = Date.now();
    const cases = [
      { label: 'fractional', cursorTimestamp: base + 0.5, earlierTimestamp: base, redisScore: null },
      {
        label: 'positive-infinity',
        cursorTimestamp: Number.POSITIVE_INFINITY,
        earlierTimestamp: base + 1,
        redisScore: 'inf',
      },
      {
        label: 'negative-infinity',
        cursorTimestamp: Number.NEGATIVE_INFINITY,
        earlierTimestamp: null,
        redisScore: '-inf',
      },
    ];

    for (const [index, fixture] of cases.entries()) {
      const threadId = `thread-legacy-${fixture.label}-before`;
      const userId = `user-legacy-${fixture.label}-before`;
      const earlier =
        fixture.earlierTimestamp !== null
          ? await store.append({
              userId,
              catId: null,
              content: `earlier than ${fixture.label}`,
              mentions: [],
              timestamp: fixture.earlierTimestamp,
              threadId,
            })
          : null;
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

      if (fixture.redisScore) {
        assert.equal(await redis.zscore(`msg:thread:${threadId}`, cursorId), fixture.redisScore);
      }
      const expectedIds = earlier ? [earlier.id] : [];
      assert.deepEqual(
        (await store.getBefore(fixture.cursorTimestamp, 10, userId, cursorId)).map((message) => message.id),
        expectedIds,
        `global ${fixture.label} cursor must remain exclusive`,
      );
      assert.deepEqual(
        (await store.getByThreadBefore(threadId, fixture.cursorTimestamp, 10, cursorId)).map((message) => message.id),
        expectedIds,
        `thread ${fixture.label} cursor must remain exclusive`,
      );
    }
  });

  it('bounded multi-page consumer makes progress across legacy numeric cursors', async () => {
    const base = Date.now();
    const cases = [
      { label: 'fractional', cursorTimestamp: base + 0.5, earlierTimestamp: base },
      { label: 'positive-infinity', cursorTimestamp: Number.POSITIVE_INFINITY, earlierTimestamp: base + 1 },
    ];

    for (const [index, fixture] of cases.entries()) {
      const threadId = `thread-legacy-${fixture.label}-collector`;
      const earlier = await store.append({
        userId: 'u',
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
        userId: 'u',
        catId: '',
        content: `legacy ${fixture.label} cursor`,
        mentions: '[]',
        timestamp: String(fixture.cursorTimestamp),
      });
      await redis.zadd('msg:timeline', String(fixture.cursorTimestamp), cursorId);
      await redis.zadd(`msg:user:u`, String(fixture.cursorTimestamp), cursorId);
      await redis.zadd(`msg:thread:${threadId}`, String(fixture.cursorTimestamp), cursorId);

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
      assert.equal(beforeCalls, 2, `${fixture.label}: one full legacy page plus the terminal empty page`);
      assert.deepEqual(
        new Set(collected.map((message) => message.id)),
        new Set([earlier.id, cursorId]),
        `${fixture.label}: bounded pagination must terminate without replaying its cursor`,
      );
    }
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

  it('concurrent idempotent append creates exactly one thread member', async () => {
    const threadId = 'thread-concurrent-idem';
    const key = MessageKeys.thread(threadId);
    const timestamp = Date.now();

    const [a, b] = await Promise.all([
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

    assert.equal(a.id, b.id, 'both concurrent callers must observe the same message id');
    const members = await redis.zrange(key, 0, -1);
    assert.deepEqual(members, [a.id], 'thread zset must contain exactly the created message');
  });

  it('idempotent replay does not refire onAppend', async () => {
    let calls = 0;
    const timestamp = Date.now();
    const watchedStore = new RedisMessageStore(redis, {
      ttlSeconds: 60,
      onAppend: () => {
        calls++;
      },
    });

    const first = await watchedStore.append({
      userId: 'u1',
      catId: null,
      content: 'idem',
      mentions: [],
      timestamp,
      threadId: 'thread-redis-onappend',
      idempotencyKey: 'redis-onappend',
    });
    assert.equal(calls, 1);

    const replay = await watchedStore.append({
      userId: 'u1',
      catId: null,
      content: 'idem retry',
      mentions: [],
      timestamp: timestamp + 1,
      threadId: 'thread-redis-onappend',
      idempotencyKey: 'redis-onappend',
    });
    assert.equal(replay.id, first.id);
    assert.equal(calls, 1, 'idempotent replay must not refire onAppend');
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
    await redis.set(redisKey, missingId);

    const created = await store.append({
      userId,
      catId: null,
      content: 'replacement',
      mentions: [],
      timestamp: Date.now(),
      threadId,
      idempotencyKey,
    });
    const replay = await store.append({
      userId,
      catId: null,
      content: 'must replay replacement',
      mentions: [],
      timestamp: Date.now() + 1,
      threadId,
      idempotencyKey,
    });

    assert.notEqual(created.id, missingId);
    assert.equal(await redis.get(redisKey), created.id, 'stale mapping must be replaced by the new winner');
    assert.equal(replay.id, created.id, 'the replacement mapping must remain idempotent');
    assert.deepEqual(await redis.zrange(MessageKeys.thread(threadId), 0, -1), [created.id]);
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
        listenerCalls++;
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
      if (removeWinnerAfterLua && result === winner.id) {
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

    assert.equal(listenerCalls, 0, 'a non-persisted loser must not fire onAppend');
    assert.deepEqual(await redis.zrange(MessageKeys.thread(threadId), 0, -1), [winner.id]);
  });

  it('prunes stale members from an active TTL-backed thread index', async () => {
    const threadId = 'thread-active-ttl-prune';
    const threadKey = MessageKeys.thread(threadId);
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

    assert.deepEqual(
      await redis.zrange(threadKey, 0, -1),
      [current.id],
      'append must remove expired-score members even while refreshing the thread key TTL',
    );
    assert.ok((await redis.ttl(threadKey)) > 0, 'thread index must remain active after member pruning');
  });
});
