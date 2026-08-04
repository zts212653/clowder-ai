/**
 * #1269 R12 — Redis mention publication boundary parity test
 *
 * Proves that the five Redis mention-read sites (getMentionsFor full-scan,
 * getMentionsFor cursor-scan, getMentionsForLegacy, getRecentMentionsFor,
 * and hydrateAndFilter with mention extraFilter) honour the isTimelinePublished
 * contract: real-cat speech is visible at append, hidden scheduler work is
 * invisible until delivery.
 *
 * Isolated Redis test — skipped locally without REDIS_URL + isolation flag.
 * Runs in CI via `pnpm --filter @cat-cafe/api test:redis`.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

let RedisMessageStore;
let createRedisClient;
let cursorFor;

let modulesLoaded = false;
async function ensureModules() {
  if (modulesLoaded) return;
  const redisStore = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
  RedisMessageStore = redisStore.RedisMessageStore;
  const redisUtils = await import('@cat-cafe/shared/utils');
  createRedisClient = redisUtils.createRedisClient;
  const cursor = await import('../dist/domains/cats/services/stores/cursor.js');
  cursorFor = cursor.cursorFor;
  modulesLoaded = true;
}

function skipWithoutRedis(t) {
  const reason = redisIsolationSkipReason(REDIS_URL);
  if (reason) {
    t.skip(reason);
    return true;
  }
  return false;
}

// Per-file unique keyPrefix to avoid cross-file cleanup races
const KEY_PREFIX = 'cat-cafe:r12-mention-parity:';

let redis = null;
async function getRedis() {
  if (redis) return redis;
  if (!REDIS_URL) return null;
  try {
    assertRedisIsolationOrThrow(REDIS_URL, 'r12-mention-parity');
  } catch {
    return null;
  }
  await ensureModules();
  redis = createRedisClient({ url: REDIS_URL, keyPrefix: KEY_PREFIX });
  await redis.ping();
  return redis;
}

after(async () => {
  if (redis) {
    await cleanupClientKeyspace(redis);
    await redis.quit().catch(() => {});
  }
});

describe('#1269 R12: Redis mention publication boundary parity', () => {
  // ---- Core parity test: C (direct) + Q (cat speech) + H (hidden scheduler) ----
  it('getMentionsFor: Q visible at append, H invisible until delivery', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();
    await ensureModules();

    const store = new RedisMessageStore(r);
    const threadId = `r12-mention-${Date.now()}`;

    // C: direct mention — visible immediately
    const c = await store.append({
      userId: 'u1',
      catId: null,
      content: '@opus direct mention',
      mentions: ['opus'],
      timestamp: Date.now() - 3000,
      threadId,
    });

    // Q: queued real-cat speech mention — timeline-published at append
    const q = await store.append({
      userId: 'u1',
      catId: 'opus',
      content: '@opus cat speech mention',
      mentions: ['opus'],
      timestamp: Date.now() - 2000,
      threadId,
      deliveryStatus: 'queued',
    });

    // H: hidden scheduler work — NOT timeline-published until delivery
    const h = await store.append({
      userId: 'scheduler',
      catId: null,
      content: '@opus hidden scheduler work',
      mentions: ['opus'],
      timestamp: Date.now() - 1000,
      threadId,
      deliveryStatus: 'queued',
    });

    // Before H delivery: C and Q visible, H invisible
    const mentions1 = await store.getMentionsFor('opus', 20, undefined, threadId);
    const ids1 = mentions1.map((m) => m.id);
    assert.ok(ids1.includes(c.id), 'C (direct) should be visible');
    assert.ok(ids1.includes(q.id), 'Q (cat speech) should be visible at append');
    assert.ok(!ids1.includes(h.id), 'H (scheduler) should be invisible before delivery');

    // Deliver H
    await store.markDelivered(h.id, Date.now());

    // After H delivery: all three visible
    const mentions2 = await store.getMentionsFor('opus', 20, undefined, threadId);
    const ids2 = mentions2.map((m) => m.id);
    assert.ok(ids2.includes(c.id), 'C still visible after H delivery');
    assert.ok(ids2.includes(q.id), 'Q still visible after H delivery');
    assert.ok(ids2.includes(h.id), 'H visible after delivery');
  });

  it('getMentionsFor cursor: Q exactly once after C cursor', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();
    await ensureModules();

    const store = new RedisMessageStore(r);
    const threadId = `r12-cursor-${Date.now()}`;

    // C: direct mention
    const c = await store.append({
      userId: 'u1',
      catId: null,
      content: '@opus direct',
      mentions: ['opus'],
      timestamp: Date.now() - 2000,
      threadId,
    });

    // Q: queued real-cat speech (timeline-published)
    await store.append({
      userId: 'u1',
      catId: 'opus',
      content: '@opus cat speech',
      mentions: ['opus'],
      timestamp: Date.now() - 1000,
      threadId,
      deliveryStatus: 'queued',
    });

    // Get C's cursor
    const fullPage = await store.getMentionsFor('opus', 20, undefined, threadId);
    const cMsg = fullPage.find((m) => m.id === c.id);
    assert.ok(cMsg, 'C must be in the full page');
    const cCursor = cursorFor(cMsg);

    // After C's cursor: Q should appear exactly once
    const afterC = await store.getMentionsFor('opus', 20, undefined, threadId, cCursor);
    assert.equal(afterC.length, 1, 'Exactly one mention after C cursor');
    assert.equal(afterC[0].content, '@opus cat speech', 'Q is the mention after C');
  });

  it('getRecentMentionsFor: Q visible at append, H invisible until delivery', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();
    await ensureModules();

    const store = new RedisMessageStore(r);
    const threadId = `r12-recent-${Date.now()}`;

    // C: direct mention
    await store.append({
      userId: 'u1',
      catId: null,
      content: '@opus direct recent',
      mentions: ['opus'],
      timestamp: Date.now() - 3000,
      threadId,
    });

    // Q: queued real-cat speech
    await store.append({
      userId: 'u1',
      catId: 'opus',
      content: '@opus cat speech recent',
      mentions: ['opus'],
      timestamp: Date.now() - 2000,
      threadId,
      deliveryStatus: 'queued',
    });

    // H: hidden scheduler work
    const h = await store.append({
      userId: 'scheduler',
      catId: null,
      content: '@opus hidden recent',
      mentions: ['opus'],
      timestamp: Date.now() - 1000,
      threadId,
      deliveryStatus: 'queued',
    });

    // Before delivery: C and Q visible, H invisible
    const recent1 = await store.getRecentMentionsFor('opus', 20, undefined, threadId);
    const contents1 = recent1.map((m) => m.content);
    assert.ok(contents1.includes('@opus direct recent'), 'C visible in recent');
    assert.ok(contents1.includes('@opus cat speech recent'), 'Q visible in recent at append');
    assert.ok(!contents1.includes('@opus hidden recent'), 'H invisible in recent before delivery');

    // Deliver H
    await store.markDelivered(h.id, Date.now());

    // After delivery: all three visible
    const recent2 = await store.getRecentMentionsFor('opus', 20, undefined, threadId);
    const contents2 = recent2.map((m) => m.content);
    assert.ok(contents2.includes('@opus direct recent'), 'C still in recent');
    assert.ok(contents2.includes('@opus cat speech recent'), 'Q still in recent');
    assert.ok(contents2.includes('@opus hidden recent'), 'H visible in recent after delivery');
  });

  it('getMentionsForLegacy (no threadId): Q visible, H invisible until delivery', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();
    await ensureModules();

    const store = new RedisMessageStore(r);
    const threadId = `r12-legacy-${Date.now()}`;

    // Q: queued real-cat speech — timeline-published
    await store.append({
      userId: 'u1',
      catId: 'opus',
      content: '@terra legacy cat speech',
      mentions: ['terra'],
      timestamp: Date.now() - 2000,
      threadId,
      deliveryStatus: 'queued',
    });

    // H: hidden scheduler work
    const h = await store.append({
      userId: 'scheduler',
      catId: null,
      content: '@terra legacy hidden',
      mentions: ['terra'],
      timestamp: Date.now() - 1000,
      threadId,
      deliveryStatus: 'queued',
    });

    // Legacy path (no threadId) — Q visible, H invisible
    const legacy1 = await store.getMentionsFor('terra', 20);
    const contents1 = legacy1.map((m) => m.content);
    assert.ok(contents1.includes('@terra legacy cat speech'), 'Q visible via legacy path');
    assert.ok(!contents1.includes('@terra legacy hidden'), 'H invisible via legacy path');

    // Deliver H
    await store.markDelivered(h.id, Date.now());

    // After delivery: both visible
    const legacy2 = await store.getMentionsFor('terra', 20);
    const contents2 = legacy2.map((m) => m.content);
    assert.ok(contents2.includes('@terra legacy cat speech'), 'Q still visible via legacy');
    assert.ok(contents2.includes('@terra legacy hidden'), 'H visible via legacy after delivery');
  });
});
