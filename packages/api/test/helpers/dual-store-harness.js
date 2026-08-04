/**
 * Dual-Store Test Harness — §8.10 step 1
 *
 * Runs each cursor-order test scenario against BOTH Memory (MessageStore) and
 * Redis (RedisMessageStore), asserting identical pages including sizes.
 * The harness IS the FM-4 parity contract.
 *
 * Usage:
 *   import { dualStoreTest, helpers } from './helpers/dual-store-harness.js';
 *   dualStoreTest('scenario name', async (ctx) => {
 *     const c = await ctx.appendDirect({ content: 'C', timestamp: 200 });
 *     const q = await ctx.appendQueued({ content: 'Q', timestamp: 100 });
 *     await ctx.deliver(q, 300);
 *     const page = await ctx.afterPage(c.id);
 *     assert.equal(page.length, 1);
 *     assert.equal(page[0].id, q.id);
 *   });
 *
 * Architecture ref: docs/architecture/1200-cursor-order-analysis.md §8.8
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

// Lazy-loaded modules (from dist)
let MessageStore;
let RedisMessageStore;
let generateSortableId;
let createRedisClient;

let modulesLoaded = false;
async function ensureModules() {
  if (modulesLoaded) return;
  const portsModule = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
  MessageStore = portsModule.MessageStore;
  generateSortableId = portsModule.generateSortableId;
  const redisStoreModule = await import('../../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
  RedisMessageStore = redisStoreModule.RedisMessageStore;
  const redisUtils = await import('@cat-cafe/shared/utils');
  createRedisClient = redisUtils.createRedisClient;
  modulesLoaded = true;
}

// Shared Redis client for the test session
let sharedRedis = null;
let redisConnected = false;

async function getRedis() {
  if (sharedRedis) return { redis: sharedRedis, connected: redisConnected };
  if (!REDIS_URL) return { redis: null, connected: false };
  try {
    assertRedisIsolationOrThrow(REDIS_URL, 'dual-store-harness');
  } catch {
    return { redis: null, connected: false };
  }
  await ensureModules();
  sharedRedis = createRedisClient({ url: REDIS_URL });
  try {
    await sharedRedis.ping();
    redisConnected = true;
  } catch {
    await sharedRedis.quit().catch(() => {});
    sharedRedis = null;
  }
  return { redis: sharedRedis, connected: redisConnected };
}

/**
 * Generate a unique thread ID for test isolation.
 */
let threadCounter = 0;
function uniqueThreadId() {
  return `cursor-order-test-${Date.now()}-${++threadCounter}`;
}

/**
 * Create a test context for a given store instance.
 *
 * Provides helpers: appendDirect, appendQueued, deliver, afterPage, etc.
 * All timestamps are OFFSETS from a base (so tests don't need real epoch values).
 */
function createTestContext(store, storeType, redis) {
  const threadId = uniqueThreadId();
  const userId = 'test-user';
  const baseTs = Date.now() - 100_000; // base timestamp, well in the past

  /**
   * Append a direct (immediately visible) message.
   * @param {object} opts
   * @param {string} opts.content - message content
   * @param {number} opts.timestamp - absolute timestamp (use ctx.ts(offset) for relative)
   * @param {string[]} [opts.mentions] - mentioned cat IDs
   * @param {string} [opts.idempotencyKey]
   */
  async function appendDirect(opts) {
    const msg = await store.append({
      userId: opts.userId ?? userId,
      catId: opts.catId ?? null,
      content: opts.content,
      mentions: opts.mentions ?? [],
      timestamp: opts.timestamp,
      threadId,
      idempotencyKey: opts.idempotencyKey,
    });
    return msg;
  }

  /**
   * Append a hidden queued message (not immediately visible in the visibility index).
   * Sets status: 'queued' via the store's delivery metadata path.
   * Default catId is null (non-cat-speech) so the message is NOT timeline-published
   * and receives NO visibilitySeq at append — visibility is deferred to delivery.
   * Pass catId: 'opus' explicitly when testing timeline-published cat speech.
   */
  async function appendQueued(opts) {
    const msg = await store.append({
      userId: opts.userId ?? userId,
      catId: opts.catId ?? null,
      content: opts.content,
      mentions: opts.mentions ?? [],
      timestamp: opts.timestamp,
      threadId,
      deliveryStatus: 'queued',
      idempotencyKey: opts.idempotencyKey,
    });
    return msg;
  }

  /**
   * Deliver a queued message at a given timestamp.
   */
  async function deliver(msg, deliveredAt) {
    const result = await store.markDelivered(msg.id, deliveredAt);
    return result;
  }

  /**
   * Cancel a queued message.
   */
  async function cancel(msg) {
    return store.markCanceled(msg.id);
  }

  /**
   * Get the after-page: messages after a cursor position.
   */
  async function afterPage(afterId, limit) {
    return store.getByThreadAfter(threadId, afterId, limit, userId);
  }

  /**
   * Get messages by thread (time-ordered, for read-state tests).
   */
  async function byThread(limit) {
    return store.getByThread(threadId, limit, userId);
  }

  /**
   * Convert a relative offset to an absolute timestamp.
   */
  function ts(offset) {
    return baseTs + offset;
  }

  /**
   * Legacy seeding shim (Redis only): directly write a message hash and ZADD
   * with a specific score to simulate legacy data with unusual properties.
   *
   * For Memory store, appends normally then adjusts internal state.
   */
  async function seedLegacy(opts) {
    const { id, content, score, mentions } = opts;
    if (storeType === 'redis' && redis) {
      // Direct Redis write to simulate legacy data
      const msgHash = {
        id,
        threadId,
        userId,
        catId: '',
        content: content ?? `legacy-${id}`,
        mentions: JSON.stringify(mentions ?? []),
        timestamp: String(typeof score === 'number' && Number.isFinite(score) ? score : Date.now()),
        isDelivered: 'true',
      };
      await redis.hset(`msg:${id}`, msgHash);
      // ZADD with the exact score (may be fractional, +inf, -inf)
      await redis.zadd(`msg:thread:${threadId}`, String(score), id);
      await redis.zadd('msg:timeline', String(score), id);
      await redis.zadd(`msg:user:${userId}`, String(score), id);
      if (mentions) {
        for (const catId of mentions) {
          await redis.zadd(`msg:mentions:${catId}`, String(score), id);
        }
      }
      return { id, content: content ?? `legacy-${id}`, threadId };
    }
    // Memory store: append normally with the timestamp
    const timestamp = typeof score === 'number' && Number.isFinite(score) && score > 0 ? Math.floor(score) : Date.now();
    const msg = store.append({
      userId,
      catId: null,
      content: content ?? `legacy-${id}`,
      mentions: mentions ?? [],
      timestamp,
      threadId,
    });
    return msg;
  }

  return {
    store,
    storeType,
    redis,
    threadId,
    userId,
    baseTs,
    ts,
    appendDirect,
    appendQueued,
    deliver,
    cancel,
    afterPage,
    byThread,
    seedLegacy,
  };
}

/**
 * Register a dual-store test. Runs the same scenario against both Memory and
 * Redis stores. The Redis half skips if REDIS_URL is not set.
 *
 * @param {string} name - Test name
 * @param {(ctx: ReturnType<typeof createTestContext>) => Promise<void>} scenarioFn
 * @param {object} [opts]
 * @param {boolean} [opts.redisOnly] - Skip Memory half (for Redis-specific legacy tests)
 * @param {boolean} [opts.memoryOnly] - Skip Redis half
 */
export function dualStoreTest(name, scenarioFn, opts) {
  if (!opts?.redisOnly) {
    it(`[Memory] ${name}`, async () => {
      await ensureModules();
      const store = new MessageStore();
      const ctx = createTestContext(store, 'memory', null);
      await scenarioFn(ctx);
    });
  }

  const redisSkip = redisIsolationSkipReason(REDIS_URL);
  if (!opts?.memoryOnly) {
    it(`[Redis] ${name}`, { skip: redisSkip || undefined }, async () => {
      await ensureModules();
      const { redis, connected } = await getRedis();
      if (!connected) return;
      await cleanupPrefixedRedisKeys(redis, ['msg:*']);
      const store = new RedisMessageStore(redis, { ttlSeconds: null });
      const ctx = createTestContext(store, 'redis', redis);
      await scenarioFn(ctx);
    });
  }
}

/**
 * FM-4 parity test: runs the SAME scenario against both stores and asserts
 * that the resulting pages have identical content in identical order.
 *
 * @param {string} name
 * @param {(ctx: ReturnType<typeof createTestContext>) => Promise<{pages: Array<Array<{content: string}>>}>} scenarioFn
 *   Must return { pages: [[{content},...], ...] } — arrays of page results with content
 */
export function parityTest(name, scenarioFn) {
  it(`[Parity] ${name}`, { skip: redisIsolationSkipReason(REDIS_URL) || undefined }, async () => {
    await ensureModules();

    // Run against Memory
    const memStore = new MessageStore();
    const memCtx = createTestContext(memStore, 'memory', null);
    const memResult = await scenarioFn(memCtx);

    // Run against Redis
    const { redis, connected } = await getRedis();
    if (!connected) {
      // Can't do parity without Redis
      assert.fail('Parity test requires Redis');
      return;
    }
    await cleanupPrefixedRedisKeys(redis, ['msg:*']);
    const redisStore = new RedisMessageStore(redis, { ttlSeconds: null });
    const redisCtx = createTestContext(redisStore, 'redis', redis);
    const redisResult = await scenarioFn(redisCtx);

    // Compare pages by content (IDs differ between stores)
    assert.equal(
      memResult.pages.length,
      redisResult.pages.length,
      `Page count mismatch: Memory=${memResult.pages.length}, Redis=${redisResult.pages.length}`,
    );

    for (let i = 0; i < memResult.pages.length; i++) {
      const memPage = memResult.pages[i].map((m) => m.content);
      const redisPage = redisResult.pages[i].map((m) => m.content);
      assert.deepEqual(
        memPage,
        redisPage,
        `Page ${i} content mismatch: Memory=${JSON.stringify(memPage)}, Redis=${JSON.stringify(redisPage)}`,
      );
    }
  });
}

/**
 * Cleanup: call from after() in the test suite.
 */
export async function cleanupHarness() {
  if (sharedRedis && redisConnected) {
    await cleanupPrefixedRedisKeys(sharedRedis, ['msg:*']);
    await sharedRedis.quit().catch(() => {});
    sharedRedis = null;
    redisConnected = false;
  }
}
