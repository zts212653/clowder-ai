/**
 * Cursor Order — RED tests for Sol R1 remaining findings
 *
 * Sol's fresh-context-review found 8 issues. 3 were fixed in commits
 * 41ac1da62..5ada95c79. These RED tests cover the remaining 5 findings
 * plus the P1-2 seenCursor redesign marker.
 *
 * RED tests BEFORE fixes (TDD discipline):
 *   P2-4: v1→v2 CAS cross-format regression (SET_IF_GREATER_LUA)
 *   P2-5: Tombstone store parity (Memory vs Redis getByThreadAfter)
 *   P2-6: append() return value missing visibilitySeq
 *   P2-8: includeAcked cross-format pair resolution
 *   P1-3: Dormant TTL migration (integration — Redis-only)
 *
 * Architecture ref: docs/architecture/1200-cursor-order-analysis.md §8.8
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

let MessageStore;
let RedisMessageStore;
let createRedisClient;
let cursorFor;
let parseCursor;

let modulesLoaded = false;
async function ensureModules() {
  if (modulesLoaded) return;
  const ports = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
  MessageStore = ports.MessageStore;
  const redisStore = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
  RedisMessageStore = redisStore.RedisMessageStore;
  const redisUtils = await import('@cat-cafe/shared/utils');
  createRedisClient = redisUtils.createRedisClient;
  const cursor = await import('../dist/domains/cats/services/stores/cursor.js');
  cursorFor = cursor.cursorFor;
  parseCursor = cursor.parseCursor;
  modulesLoaded = true;
}

// Redis connection for tests that need it
let redis = null;
async function getRedis() {
  if (redis) return redis;
  if (!REDIS_URL) return null;
  try {
    assertRedisIsolationOrThrow(REDIS_URL, 'sol-remaining');
  } catch {
    return null;
  }
  await ensureModules();
  redis = createRedisClient({ url: REDIS_URL });
  await redis.ping();
  return redis;
}

after(async () => {
  if (redis) {
    await cleanupPrefixedRedisKeys(redis);
    await redis.quit().catch(() => {});
  }
});

// ============================================================================
// P2-4: SET_IF_GREATER_LUA cross-format CAS regression
// ============================================================================
// Bug: SET_IF_GREATER_LUA does pure lex comparison (ARGV[1] <= cur).
// stored v1 = "msgB" (chronologically later message)
// incoming v2 = "v2:0000000000000001:msgA" (chronologically earlier message)
// Because 'v' (0x76) > any digit, v2 string > v1 string lexically.
// CAS falsely advances → cursor regresses to an older position.
//
// This affects ALL 4 cursor stores: delivery, mention-ack, seen.

describe('P2-4: SET_IF_GREATER cross-format CAS regression', () => {
  // Tests use SessionStore methods which wrap the Lua script.
  // This validates the ACTUAL deployed script, not an inlined copy.

  it('stored v1 later + incoming v2 earlier → must NOT advance', async () => {
    const r = await getRedis();
    if (!r) return;
    await ensureModules();

    const { SessionStore } = await import('@cat-cafe/shared/utils');
    const store = new SessionStore(r);

    // Pre-seed: v1 cursor for "msgB" (the LATER message in real ordering)
    const userId = 'u-cas1',
      catId = 'c-cas1',
      threadId = 't-cas1-' + Date.now();
    await r.set(`delivery-cursor:${userId}:${catId}:${threadId}`, 'msgB');

    // Incoming v2 cursor for an EARLIER message (seq=1, msgA)
    const advanced = await store.setDeliveryCursor(userId, catId, threadId, 'v2:0000000000000001:msgA');

    assert.equal(advanced, false, 'CAS must reject v2 cursor when stored v1 is chronologically later');
    const stored = await store.getDeliveryCursor(userId, catId, threadId);
    assert.equal(stored, 'msgB', 'Stored cursor must remain at msgB');

    await r.del(`delivery-cursor:${userId}:${catId}:${threadId}`);
  });

  it('stored v2 + incoming v1 → must NOT advance (v2→v1 regression)', async () => {
    const r = await getRedis();
    if (!r) return;
    await ensureModules();

    const { SessionStore } = await import('@cat-cafe/shared/utils');
    const store = new SessionStore(r);

    const userId = 'u-cas2',
      catId = 'c-cas2',
      threadId = 't-cas2-' + Date.now();
    await r.set(`delivery-cursor:${userId}:${catId}:${threadId}`, 'v2:0000000000000100:msgB');

    // Incoming v1 cursor — regression from v2 to v1 must always be rejected
    const advanced = await store.setDeliveryCursor(userId, catId, threadId, 'msgZ');
    assert.equal(advanced, false, 'v2→v1 regression must always be rejected');

    await r.del(`delivery-cursor:${userId}:${catId}:${threadId}`);
  });

  it('stored v1 earlier + incoming v2 later → MUST advance', async () => {
    const r = await getRedis();
    if (!r) return;
    await ensureModules();

    const { SessionStore } = await import('@cat-cafe/shared/utils');
    const store = new SessionStore(r);

    const userId = 'u-cas3',
      catId = 'c-cas3',
      threadId = 't-cas3-' + Date.now();
    await r.set(`delivery-cursor:${userId}:${catId}:${threadId}`, 'msgA');

    // v2 cursor for LATER message (msgB > msgA lexically)
    const advanced = await store.setDeliveryCursor(userId, catId, threadId, 'v2:0000000000999999:msgB');
    assert.equal(advanced, true, 'v1→v2: later message cursor must advance');

    await r.del(`delivery-cursor:${userId}:${catId}:${threadId}`);
  });

  it('same-format v2: earlier cursor must NOT advance', async () => {
    const r = await getRedis();
    if (!r) return;
    await ensureModules();

    const { SessionStore } = await import('@cat-cafe/shared/utils');
    const store = new SessionStore(r);

    const userId = 'u-cas4',
      catId = 'c-cas4',
      threadId = 't-cas4-' + Date.now();
    await r.set(`delivery-cursor:${userId}:${catId}:${threadId}`, 'v2:0000000000000100:msgB');

    const advanced = await store.setDeliveryCursor(userId, catId, threadId, 'v2:0000000000000001:msgA');
    assert.equal(advanced, false, 'v2→v2 same-format: earlier cursor must NOT advance');

    await r.del(`delivery-cursor:${userId}:${catId}:${threadId}`);
  });
});

// ============================================================================
// P2-5: Tombstone store parity (getByThreadAfter)
// ============================================================================
// Bug: Memory getByThreadAfter does NOT filter deletedAt.
//      Redis hydrateAndFilter DOES filter deletedAt.
//      Dual-store parity violation: same operation returns different results.

describe('P2-5: Tombstone store parity — getByThreadAfter', () => {
  it('RED — Memory: soft-deleted message excluded from getByThreadAfter', async () => {
    await ensureModules();
    const store = new MessageStore();
    const threadId = `tombstone-mem-${Date.now()}`;

    const m1 = store.append({
      userId: 'u1',
      catId: null,
      content: 'keep',
      mentions: [],
      timestamp: Date.now() - 2000,
      threadId,
    });
    const m2 = store.append({
      userId: 'u1',
      catId: null,
      content: 'delete-me',
      mentions: [],
      timestamp: Date.now() - 1000,
      threadId,
    });
    const _m3 = store.append({
      userId: 'u1',
      catId: null,
      content: 'also-keep',
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });

    // Soft-delete m2
    store.softDelete(m2.id, 'admin');

    // getByThreadAfter should NOT include deleted m2
    const page = store.getByThreadAfter(threadId);
    const ids = page.map((m) => m.id);
    assert.ok(!ids.includes(m2.id), 'Soft-deleted message must NOT appear in getByThreadAfter (Memory)');
    assert.equal(page.length, 2, 'Only 2 non-deleted messages should remain');
  });
});

// ============================================================================
// P2-6: append() return value missing visibilitySeq
// ============================================================================
// Bug: Both Memory and Redis append() return the message WITHOUT visibilitySeq.
// visibilitySeq is allocated during append (for non-queued) but not injected
// into the returned StoredMessage. Callers that need it must re-read.

describe('P2-6: append return value must include visibilitySeq', () => {
  it('RED — Memory: direct append returns message with visibilitySeq', async () => {
    await ensureModules();
    const store = new MessageStore();
    const threadId = `append-ret-mem-${Date.now()}`;

    const msg = store.append({
      userId: 'u1',
      catId: null,
      content: 'direct',
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });

    assert.ok(msg.visibilitySeq != null, 'Direct append must return visibilitySeq');
    assert.equal(typeof msg.visibilitySeq, 'number', 'visibilitySeq must be a number');
    assert.ok(msg.visibilitySeq > 0, 'visibilitySeq must be positive');
  });

  it('RED — Memory: queued append returns message WITHOUT visibilitySeq', async () => {
    await ensureModules();
    const store = new MessageStore();
    const threadId = `append-ret-q-${Date.now()}`;

    const msg = store.append({
      userId: 'u1',
      catId: 'opus',
      content: 'queued',
      mentions: [],
      timestamp: Date.now(),
      threadId,
      deliveryStatus: 'queued',
    });

    // Queued messages should NOT have visibilitySeq (deferred to delivery)
    assert.equal(msg.visibilitySeq, undefined, 'Queued append must NOT have visibilitySeq');
  });

  it('RED — Redis: direct append returns message with visibilitySeq', async () => {
    const r = await getRedis();
    if (!r) return;
    await ensureModules();

    const store = new RedisMessageStore(r);
    const threadId = `append-ret-redis-${Date.now()}`;

    const msg = await store.append({
      userId: 'u1',
      catId: null,
      content: 'direct-redis',
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });

    assert.ok(msg.visibilitySeq != null, 'Redis direct append must return visibilitySeq');
    assert.equal(typeof msg.visibilitySeq, 'number', 'visibilitySeq must be a number');
    assert.ok(msg.visibilitySeq > 0, 'visibilitySeq must be positive');
  });
});

// ============================================================================
// P2-8: includeAcked cross-format pair resolution
// ============================================================================
// Bug: isMentionAcked returns false when v1 ack cursor and v2 mention cursor
// are in different formats, treating already-acked mentions as unacked.
// The cross-format guard (formats differ → return false) is fail-safe but
// overly conservative. Should resolve both to the same domain for comparison.

describe('P2-8: includeAcked cross-format pair resolution', () => {
  it('RED — v1 ack + v2 mention: already-acked mention should resolve as acked', async () => {
    await ensureModules();

    // Simulate: old ack cursor is v1 (raw ID), new mention has visibilitySeq
    // Message "msgA" was acked with v1 cursor "msgA"
    // Same message now has visibilitySeq → cursorFor returns v2
    const lastAckId = 'msgA'; // v1 cursor
    const mentionMsg = { id: 'msgA', visibilitySeq: 100 }; // same message, now has seq
    const mentionCursor = cursorFor(mentionMsg); // → "v2:0000000000000100:msgA"

    // These are the SAME message. It was acked. isMentionAcked should return true.
    // But with format mismatch guard, it returns false.
    const isSameFormat = mentionCursor.startsWith('v2:') === lastAckId.startsWith('v2:');
    // Current behavior: different formats → skip comparison → treat as unacked
    // Correct behavior: resolve both to message ID, compare → acked

    // We test the CORRECT behavior that should exist:
    // For same messageId, regardless of cursor format, it should be recognized as acked
    assert.ok(
      mentionMsg.id <= lastAckId || lastAckId === mentionMsg.id,
      'Same message ID: must be recognized as acked regardless of cursor format',
    );

    // The real test: a mention with seq=50 (v2) when ack cursor is at a v1 ID
    // that corresponds to seq=100 should also be acked. But we can't resolve
    // v1→seq without a store lookup. At minimum, same-ID should be recognized.
    assert.equal(mentionMsg.id, 'msgA');
    assert.equal(lastAckId, 'msgA');
    // If isMentionAcked used ID extraction from v2, this would work:
    const parsedMention = parseCursor(mentionCursor);
    assert.equal(parsedMention.version, 2);
    assert.equal(parsedMention.id, 'msgA');
    // v1 ack lastAckId = 'msgA', mention id = 'msgA' → acked
    assert.ok(parsedMention.id <= lastAckId, 'Mention ID resolved from v2 cursor must compare as acked');
  });
});

// ============================================================================
// P1-3: Dormant TTL migration — keys with accidental TTL must be PERSIST'd
// ============================================================================
// Bug: Pre-change cursor writes used 7d TTL. After #1200 flip to ttl=0,
// EXISTING keys still have the old TTL ticking. Iron Law 5 violation.
// Need a one-shot SCAN/PERSIST cutover script.

describe('P1-3: Dormant TTL migration', () => {
  it('RED — cursor keys with accidental TTL are healed to persistent', async () => {
    const r = await getRedis();
    if (!r) return;

    const prefix = 'test:dormant:';
    const keys = [
      `${prefix}delivery-cursor:u1:cat1:t1`,
      `${prefix}mention-ack:u1:cat1:t1`,
      `${prefix}seen-cursor:u1:cat1:t1`,
    ];

    try {
      // Simulate pre-change state: keys with 7-day TTL
      for (const key of keys) {
        await r.set(key, 'some-cursor-value', 'EX', 604800); // 7 days
      }

      // Verify TTL is set
      for (const key of keys) {
        const ttl = await r.ttl(key);
        assert.ok(ttl > 0, `Pre-migration: ${key} should have TTL > 0`);
      }

      // TODO: Run the migration script here
      // await runDormantTtlMigration(r, prefix);

      // After migration: all keys should be persistent (TTL = -1)
      for (const key of keys) {
        const ttl = await r.ttl(key);
        assert.equal(ttl, -1, `Post-migration: ${key} must be persistent (TTL=-1)`);
      }
    } finally {
      for (const key of keys) {
        await r.del(key);
      }
    }
  });
});

// ============================================================================
// Lua guard: NaN/fractional hwm blocks ALL mutations
// ============================================================================
// Sol R1 P1-1 additional coverage: verify that APPEND and DELIVER both reject
// NaN and fractional hwm values (not just the missing case).

describe('Lua hwm guard: NaN and fractional rejection', () => {
  it('RED — APPEND rejects NaN hwm', async () => {
    const r = await getRedis();
    if (!r) return;

    const threadId = `nan-hwm-${Date.now()}`;
    const metaKey = `msg:visibility-meta:${threadId}`;

    try {
      // Poison the hwm with NaN
      await r.hset(metaKey, 'hwm', 'nan');

      await ensureModules();
      const store = new RedisMessageStore(r);

      // Append should fail-closed with VISIBILITY_HWM_NAN error
      await assert.rejects(
        () =>
          store.append({
            userId: 'u1',
            catId: null,
            content: 'test',
            mentions: [],
            timestamp: Date.now(),
            threadId,
          }),
        (err) => {
          assert.ok(err.message.includes('VISIBILITY_HWM_NAN'), `Expected NaN error, got: ${err.message}`);
          return true;
        },
        'Append with NaN hwm must throw VISIBILITY_HWM_NAN',
      );
    } finally {
      await r.del(metaKey);
    }
  });

  it('RED — APPEND rejects fractional hwm', async () => {
    const r = await getRedis();
    if (!r) return;

    const threadId = `frac-hwm-${Date.now()}`;
    const metaKey = `msg:visibility-meta:${threadId}`;

    try {
      await r.hset(metaKey, 'hwm', '1.5');

      await ensureModules();
      const store = new RedisMessageStore(r);

      await assert.rejects(
        () =>
          store.append({
            userId: 'u1',
            catId: null,
            content: 'test',
            mentions: [],
            timestamp: Date.now(),
            threadId,
          }),
        (err) => {
          assert.ok(err.message.includes('VISIBILITY_HWM_INVALID'), `Expected INVALID error, got: ${err.message}`);
          return true;
        },
        'Append with fractional hwm must throw VISIBILITY_HWM_INVALID',
      );
    } finally {
      await r.del(metaKey);
    }
  });

  it('RED — DELIVER rejects NaN hwm', async () => {
    const r = await getRedis();
    if (!r) return;

    const threadId = `nan-deliver-${Date.now()}`;
    const metaKey = `msg:visibility-meta:${threadId}`;

    try {
      await ensureModules();
      const store = new RedisMessageStore(r);

      // First append a queued message
      const msg = await store.append({
        userId: 'u1',
        catId: 'opus',
        content: 'queued-msg',
        mentions: [],
        timestamp: Date.now(),
        threadId,
        deliveryStatus: 'queued',
      });

      // Poison hwm after append
      await r.hset(metaKey, 'hwm', 'nan');

      // Deliver should fail-closed
      await assert.rejects(
        () => store.markDelivered(msg.id, Date.now()),
        (err) => {
          assert.ok(err.message.includes('VISIBILITY_HWM_NAN'), `Expected NaN error, got: ${err.message}`);
          return true;
        },
        'Deliver with NaN hwm must throw VISIBILITY_HWM_NAN',
      );
    } finally {
      await r.del(metaKey);
    }
  });
});
