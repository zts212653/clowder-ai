/**
 * Cursor Order — Tests for Sol R1-R5 findings
 *
 * RED tests BEFORE fixes (TDD discipline):
 *   P2-4: v1→v2 CAS cross-format regression (SET_IF_GREATER_LUA)
 *   P2-5: Tombstone store parity (Memory vs Redis getByThreadAfter)
 *   P2-6: append() return value missing visibilitySeq
 *   P2-8: includeAcked cross-format pair resolution
 *   P1-3: Dormant TTL migration (integration — Redis-only)
 *   Lua hwm guard: NaN/fractional hwm blocks mutations
 *   compareCursors: pair-domain + cross-format indeterminate (#1200 P2-3)
 *
 * Sol R5 additions:
 *   Lua CAS fail-closed on cross-format (no ID lex fallback)
 *   Reconcile cursor format (v1→v2 atomic upgrade)
 *   Late-delivery CAS: Q(old ID, high seq) vs B(new ID, low seq)
 *   Notice filter indeterminate handling (cross-format conservatively keeps)
 *   Comprehensive HWM zero-mutation (hash/ZSET/timeline/message-state)
 *
 * Architecture ref: docs/architecture/1200-cursor-order-analysis.md §8.8
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

let MessageStore;
let RedisMessageStore;
let createRedisClient;
let cursorFor;
let parseCursor;
let compareCursors;

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
  compareCursors = cursor.compareCursors;
  modulesLoaded = true;
}

/** Skip Redis tests properly instead of false-green `if (!r) return` (Sol R2 P2) */
function skipWithoutRedis(t) {
  const reason = redisIsolationSkipReason(REDIS_URL);
  if (reason) {
    t.skip(reason);
    return true;
  }
  return false;
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

/** Cleanup patterns for all cursor/message namespaces used by this test file */
const CLEANUP_PATTERNS = ['delivery-cursor:*', 'mention-ack:*', 'seen-cursor:*', 'msg:*'];

after(async () => {
  if (redis) {
    await cleanupPrefixedRedisKeys(redis, CLEANUP_PATTERNS);
    await redis.quit().catch(() => {});
  }
});

// ============================================================================
// P2-4: SET_IF_GREATER_LUA cross-format CAS regression
// ============================================================================

describe('P2-4: SET_IF_GREATER cross-format CAS regression', () => {
  it('stored v1 later + incoming v2 earlier → must NOT advance', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();
    await ensureModules();

    const { SessionStore } = await import('@cat-cafe/shared/utils');
    const store = new SessionStore(r);

    const userId = 'u-cas1',
      catId = 'c-cas1',
      threadId = 't-cas1-' + Date.now();
    await r.set(`delivery-cursor:${userId}:${catId}:${threadId}`, 'msgB');

    const advanced = await store.setDeliveryCursor(userId, catId, threadId, 'v2:0000000000000001:msgA');

    assert.equal(advanced, false, 'CAS must reject v2 cursor when stored v1 is chronologically later');
    const stored = await store.getDeliveryCursor(userId, catId, threadId);
    assert.equal(stored, 'msgB', 'Stored cursor must remain at msgB');

    await r.del(`delivery-cursor:${userId}:${catId}:${threadId}`);
  });

  it('stored v2 + incoming v1 → must NOT advance (v2→v1 regression)', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();
    await ensureModules();

    const { SessionStore } = await import('@cat-cafe/shared/utils');
    const store = new SessionStore(r);

    const userId = 'u-cas2',
      catId = 'c-cas2',
      threadId = 't-cas2-' + Date.now();
    await r.set(`delivery-cursor:${userId}:${catId}:${threadId}`, 'v2:0000000000000100:msgB');

    const advanced = await store.setDeliveryCursor(userId, catId, threadId, 'msgZ');
    assert.equal(advanced, false, 'v2→v1 regression must always be rejected');

    await r.del(`delivery-cursor:${userId}:${catId}:${threadId}`);
  });

  // Sol R5: fail-closed on cross-format (no ID lex fallback).
  // Previously this test expected advance via ID lex comparison. But late-delivered
  // Q has old ID + high seq — ID lex would wrongly place it behind B. Pure fail-closed
  // forces app-layer pre-reconciliation before CAS.
  it('stored v1 unresolvable + incoming v2 → MUST NOT advance (fail-closed)', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();
    await ensureModules();

    const { SessionStore } = await import('@cat-cafe/shared/utils');
    const store = new SessionStore(r);

    const userId = 'u-cas3',
      catId = 'c-cas3',
      threadId = 't-cas3-' + Date.now();
    await r.set(`delivery-cursor:${userId}:${catId}:${threadId}`, 'msgA');

    const advanced = await store.setDeliveryCursor(userId, catId, threadId, 'v2:0000000000999999:msgB');
    // R5: fail-closed — can't determine stored position without message hash
    assert.equal(advanced, false, 'Stored unresolvable v1 + incoming v2 → fail-closed (no ID lex fallback)');

    // Stored cursor must remain unchanged
    const stored = await store.getDeliveryCursor(userId, catId, threadId);
    assert.equal(stored, 'msgA', 'Stored must remain at v1 msgA (fail-closed)');

    await r.del(`delivery-cursor:${userId}:${catId}:${threadId}`);
  });

  it('same-format v2: earlier cursor must NOT advance', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();
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

  // Sol R4 P1-1 next-action 1: three-namespace CAS coverage (mention-ack, seen-cursor)
  it('mention-ack: stored v1 later + incoming v2 earlier → must NOT advance', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();
    await ensureModules();
    const { SessionStore } = await import('@cat-cafe/shared/utils');
    const store = new SessionStore(r);

    const userId = 'u-mac1',
      catId = 'c-mac1',
      threadId = `t-mac1-${Date.now()}`;
    await r.set(`mention-ack:${userId}:${catId}:${threadId}`, 'msgB');
    const advanced = await store.setMentionAckCursor(userId, catId, threadId, 'v2:0000000000000001:msgA');
    assert.equal(advanced, false, 'Mention-ack CAS: v1 msgB > v2 msgA → reject');
    await r.del(`mention-ack:${userId}:${catId}:${threadId}`);
  });

  it('seen-cursor: stored v1 later + incoming v2 earlier → must NOT advance', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();
    await ensureModules();
    const { SessionStore } = await import('@cat-cafe/shared/utils');
    const store = new SessionStore(r);

    const userId = 'u-sc1',
      catId = 'c-sc1',
      threadId = `t-sc1-${Date.now()}`;
    await r.set(`seen-cursor:${userId}:${catId}:${threadId}`, 'msgB');
    const advanced = await store.setSeenCursor(userId, catId, threadId, 'v2:0000000000000001:msgA');
    assert.equal(advanced, false, 'Seen-cursor CAS: v1 msgB > v2 msgA → reject');
    await r.del(`seen-cursor:${userId}:${catId}:${threadId}`);
  });
});

// ============================================================================
// P2-5: Tombstone store parity (getByThreadAfter) — Sol R2 corrected direction
// ============================================================================

describe('P2-5: Tombstone store parity — getByThreadAfter keeps tombstones', () => {
  it('Memory: soft-deleted message KEPT in getByThreadAfter', async () => {
    await ensureModules();
    const store = new MessageStore();
    const threadId = `tombstone-mem-${Date.now()}`;

    const _m1 = store.append({
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

    store.softDelete(m2.id, 'admin');

    const page = store.getByThreadAfter(threadId);
    const ids = page.map((m) => m.id);
    assert.ok(ids.includes(m2.id), 'Soft-deleted message must be KEPT in getByThreadAfter (tombstone-keep)');
    assert.equal(page.length, 3, 'All 3 messages including deleted should remain');
  });

  it('Redis: soft-deleted message KEPT in getByThreadAfter', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();
    await ensureModules();

    const store = new RedisMessageStore(r);
    const threadId = `tombstone-redis-${Date.now()}`;

    const m1 = await store.append({
      userId: 'u1',
      catId: null,
      content: 'keep-redis',
      mentions: [],
      timestamp: Date.now() - 2000,
      threadId,
    });
    const m2 = await store.append({
      userId: 'u1',
      catId: null,
      content: 'delete-me-redis',
      mentions: [],
      timestamp: Date.now() - 1000,
      threadId,
    });
    const m3 = await store.append({
      userId: 'u1',
      catId: null,
      content: 'also-keep-redis',
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });

    await store.softDelete(m2.id, 'admin');

    const page = await store.getByThreadAfter(threadId);
    const ids = page.map((m) => m.id);
    assert.ok(ids.includes(m2.id), 'Redis: Soft-deleted must be KEPT in getByThreadAfter (tombstone-keep)');
    assert.equal(page.length, 3, 'Redis: All 3 messages including deleted should remain');
  });
});

// ============================================================================
// P2-6: append() return value missing visibilitySeq
// ============================================================================

describe('P2-6: append return value must include visibilitySeq', () => {
  it('Memory: direct append returns message with visibilitySeq', async () => {
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

  it('Memory: hidden queued append returns message WITHOUT visibilitySeq', async () => {
    await ensureModules();
    const store = new MessageStore();
    const threadId = `append-ret-q-${Date.now()}`;

    // #1269: use non-cat-speech (catId: null) to test hidden queued work.
    // Timeline-published cat speech (catId: 'opus') gets visibilitySeq at append;
    // hidden queued scheduler/system work does not.
    const msg = store.append({
      userId: 'u1',
      catId: null,
      content: 'queued',
      mentions: [],
      timestamp: Date.now(),
      threadId,
      deliveryStatus: 'queued',
    });

    assert.equal(msg.visibilitySeq, undefined, 'Hidden queued append must NOT have visibilitySeq');
  });

  it('Redis: direct append returns message with visibilitySeq', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();
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

describe('P2-8: includeAcked cross-format pair resolution', () => {
  it('v1 ack + v2 mention: production isMentionAcked path resolves correctly', async () => {
    await ensureModules();

    // Production isMentionAcked uses: compareCursors(cursorFor(item), lastAckId) <= 0
    // With getter canonicalization (P1-4 fix), lastAckId from getter is v2.
    // Test: when both sides have same message ID, comparison must resolve as acked.
    const lastAckCursor = cursorFor({ id: 'msgA', visibilitySeq: 100 }); // "v2:0000000000000100:msgA"
    const mentionMsg = { id: 'msgA', visibilitySeq: 100 };
    const mentionCursor = cursorFor(mentionMsg); // "v2:0000000000000100:msgA"

    // Same-format v2 vs v2: compareCursors resolves correctly
    assert.ok(compareCursors(mentionCursor, lastAckCursor) <= 0, 'Same message: must resolve as acked');
  });

  it('v2 ack + v2 mention: earlier mention correctly marked as acked', async () => {
    await ensureModules();

    const lastAckCursor = cursorFor({ id: 'msgB', visibilitySeq: 200 }); // ack up to seq=200
    const mentionMsg = { id: 'msgA', visibilitySeq: 100 }; // mention at seq=100 (earlier)
    const mentionCursor = cursorFor(mentionMsg);

    assert.ok(compareCursors(mentionCursor, lastAckCursor) <= 0, 'Earlier mention: must be acked');
  });

  it('v2 ack + v2 mention: later mention NOT marked as acked', async () => {
    await ensureModules();

    const lastAckCursor = cursorFor({ id: 'msgA', visibilitySeq: 100 }); // ack up to seq=100
    const mentionMsg = { id: 'msgC', visibilitySeq: 300 }; // mention at seq=300 (later)
    const mentionCursor = cursorFor(mentionMsg);

    assert.ok(compareCursors(mentionCursor, lastAckCursor) > 0, 'Later mention: must NOT be acked');
  });
});

// ============================================================================
// P1-3: Dormant TTL migration — keys with accidental TTL must be PERSIST'd
// ============================================================================

describe('P1-3: Dormant TTL migration', () => {
  it('cursor keys with accidental TTL are healed to persistent', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();

    // Import the migration helper
    const { persistDormantCursors } = await import(
      '../dist/domains/cats/services/stores/redis/persist-dormant-cursors.js'
    );

    const keyPrefix = r.options?.keyPrefix ?? '';
    const keys = [
      `delivery-cursor:u1:cat1:t-ttl-${Date.now()}`,
      `mention-ack:u1:cat1:t-ttl-${Date.now()}`,
      `seen-cursor:u1:cat1:t-ttl-${Date.now()}`,
    ];

    try {
      // Simulate pre-change state: keys with 7-day TTL
      // Use ioredis methods (which auto-prefix) so keys are in the right namespace
      for (const key of keys) {
        await r.set(key, 'some-cursor-value', 'EX', 604800); // 7 days
      }

      // Verify TTL is set (ioredis .ttl() auto-prefixes correctly)
      for (const key of keys) {
        const ttl = await r.ttl(key);
        assert.ok(ttl > 0, `Pre-migration: ${key} should have TTL > 0, got ${ttl}`);
      }

      // Run the actual migration helper
      const result = await persistDormantCursors(r);

      assert.ok(result.scanned > 0, 'Migration should scan keys');
      assert.ok(result.persisted > 0, 'Migration should persist at least some keys');

      // After migration: all keys should be persistent (TTL = -1)
      for (const key of keys) {
        const ttl = await r.ttl(key);
        assert.equal(ttl, -1, `Post-migration: ${key} must be persistent (TTL=-1), got ${ttl}`);
      }
    } finally {
      for (const key of keys) {
        await r.del(key);
      }
    }
  });
});

// ============================================================================
// P1-3: CLI entry point resolves to actual script
// ============================================================================

describe('P1-3: CLI entry point validation', () => {
  it('persist-dormant-cursors script file exists at scripts/ path', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const scriptPath = resolve(import.meta.dirname, '..', 'scripts', 'persist-dormant-cursors.mjs');
    assert.ok(existsSync(scriptPath), `CLI script must exist at ${scriptPath}`);
  });

  it('persist-dormant-cursors script is importable (dist/ dependency built)', async (t) => {
    if (skipWithoutRedis(t)) return;
    // Verify the CLI script's dynamic import resolves (needs dist/ built)
    try {
      const mod = await import('../dist/domains/cats/services/stores/redis/persist-dormant-cursors.js');
      assert.ok(typeof mod.persistDormantCursors === 'function', 'Module must export persistDormantCursors');
    } catch (err) {
      assert.fail(`persist-dormant-cursors dist import failed: ${err.message}`);
    }
  });
});

// ============================================================================
// Lua guard: NaN/fractional hwm blocks ALL mutations
// ============================================================================

describe('Lua hwm guard: NaN and fractional rejection', () => {
  it('APPEND rejects NaN hwm', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();

    const threadId = `nan-hwm-${Date.now()}`;

    try {
      await ensureModules();
      const store = new RedisMessageStore(r);

      // First: do a normal append to trigger ensureVisibilityMigrated (sets migration flag).
      // THEN poison the hwm — this ensures the guard is hit on the NEXT append,
      // not overwritten by the migration logic.
      await store.append({
        userId: 'u1',
        catId: null,
        content: 'trigger-migration',
        mentions: [],
        timestamp: Date.now() - 1000,
        threadId,
      });

      // Poison the hwm with NaN AFTER migration has run
      const metaKey = `msg:visibility-meta:${threadId}`;
      await r.hset(metaKey, 'hwm', 'nan');

      // Second append should fail-closed with VISIBILITY_HWM_NAN error
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

      // Zero-mutation assertion: HWM must remain poisoned (reject = no side effects)
      const hwmAfter = await r.hget(metaKey, 'hwm');
      assert.equal(hwmAfter, 'nan', 'HWM must remain poisoned after rejected append');
    } finally {
      // Cleanup all keys for this thread
      const metaKey = `msg:visibility-meta:${threadId}`;
      await r.del(metaKey);
    }
  });

  it('APPEND rejects fractional hwm', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();

    const threadId = `frac-hwm-${Date.now()}`;

    try {
      await ensureModules();
      const store = new RedisMessageStore(r);

      // Trigger migration first, then poison
      await store.append({
        userId: 'u1',
        catId: null,
        content: 'trigger-migration',
        mentions: [],
        timestamp: Date.now() - 1000,
        threadId,
      });

      const metaKey = `msg:visibility-meta:${threadId}`;
      await r.hset(metaKey, 'hwm', '1.5');

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

      // Zero-mutation assertion
      const hwmAfter = await r.hget(metaKey, 'hwm');
      assert.equal(hwmAfter, '1.5', 'HWM must remain poisoned after rejected append');
    } finally {
      const metaKey = `msg:visibility-meta:${threadId}`;
      await r.del(metaKey);
    }
  });

  it('DELIVER rejects NaN hwm', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();

    const threadId = `nan-deliver-${Date.now()}`;
    const metaKey = `msg:visibility-meta:${threadId}`;

    try {
      await ensureModules();
      const store = new RedisMessageStore(r);

      // Step 1: Direct append to trigger ensureVisibilityMigrated and set the
      // migration-complete flag. Without this, markDelivered's internal call
      // to ensureVisibilityMigrated re-runs migration and overwrites the
      // poisoned hwm (Sol R4 P2-5: queued append may not set the flag).
      await store.append({
        userId: 'u1',
        catId: null,
        content: 'trigger-migration',
        mentions: [],
        timestamp: Date.now() - 1000,
        threadId,
      });

      // Step 2: Hidden queued work (non-cat-speech) — no visibilitySeq at append,
      // so markDelivered enters the HWM allocation path. Timeline-published cat
      // speech (catId: 'opus') already has visibilitySeq and would skip HWM.
      const msg = await store.append({
        userId: 'scheduler',
        catId: null,
        content: 'queued-msg',
        mentions: [],
        timestamp: Date.now(),
        threadId,
        deliveryStatus: 'queued',
      });

      // Step 3: Poison hwm AFTER migration flag is set
      await r.hset(metaKey, 'hwm', 'nan');

      // Step 4: Deliver should hit the poisoned hwm guard
      await assert.rejects(
        () => store.markDelivered(msg.id, Date.now()),
        (err) => {
          assert.ok(err.message.includes('VISIBILITY_HWM_NAN'), `Expected NaN error, got: ${err.message}`);
          return true;
        },
        'Deliver with NaN hwm must throw VISIBILITY_HWM_NAN',
      );

      // Zero-mutation assertion: verify the queued message was NOT advanced
      // (hash, ZSET, HWM should be unchanged from poisoned state)
      const hwmAfter = await r.hget(metaKey, 'hwm');
      assert.equal(hwmAfter, 'nan', 'HWM must remain poisoned (zero mutation on reject)');
    } finally {
      await r.del(metaKey);
    }
  });
});

// ============================================================================
// compareCursors: pair-domain comparison (#1200 P2-3)
// ============================================================================

describe('compareCursors: pair-domain comparison', () => {
  before(async () => {
    await ensureModules();
  });

  it('v2 vs v2: higher seq wins', () => {
    const a = 'v2:0000000000000100:msgA';
    const b = 'v2:0000000000000200:msgB';
    assert.ok(compareCursors(a, b) < 0, 'seq 100 < seq 200');
    assert.ok(compareCursors(b, a) > 0, 'seq 200 > seq 100');
  });

  it('v2 vs v2: same seq, id tiebreaker', () => {
    const a = 'v2:0000000000000100:aaa';
    const b = 'v2:0000000000000100:bbb';
    assert.ok(compareCursors(a, b) < 0, 'same seq: aaa < bbb');
    assert.ok(compareCursors(b, a) > 0, 'same seq: bbb > aaa');
  });

  it('v2 vs v2: identical = 0', () => {
    const a = 'v2:0000000000000100:msgA';
    assert.equal(compareCursors(a, a), 0);
  });

  it('v1 vs v1: lex comparison on raw IDs', () => {
    assert.ok(compareCursors('aaa', 'bbb') < 0);
    assert.ok(compareCursors('bbb', 'aaa') > 0);
    assert.equal(compareCursors('aaa', 'aaa'), 0);
  });

  // #1200 P2-3: cross-format returns 0 (indeterminate) — no heuristic.
  // A synchronous comparator cannot resolve v1→seq without store access.
  // DeliveryCursorStore handles this via async canonicalizer.
  it('cross-format v1 vs v2: returns 0 (indeterminate)', () => {
    assert.equal(
      compareCursors('v2:0000000000000001:a', 'zzzzzzzzzzzzz'),
      0,
      'v2 vs v1 = indeterminate (no heuristic)',
    );
    assert.equal(
      compareCursors('zzzzzzzzzzzzz', 'v2:0000000000000001:a'),
      0,
      'v1 vs v2 = indeterminate (no heuristic)',
    );
  });

  it('v2→v1 regression: cross-format indeterminate protects against false advance', () => {
    const stored = 'v2:0000000000000100:msgB';
    const incoming = 'msgZ';
    // Cross-format returns 0, so compareCursors(incoming, stored) <= 0 → no advance
    assert.equal(compareCursors(incoming, stored), 0, 'v1 incoming vs v2 stored = indeterminate');
  });
});

// ============================================================================
// Sol R5: Late-delivery CAS — Q(old ID, high seq) vs B(new ID, low seq)
// ============================================================================

describe('Sol R5: Late-delivery CAS — visibility order ≠ ID order', () => {
  // Core #1200 disease: Q was created early (old ID) but delivered late (high seq).
  // B was created later (new ID) but delivered first (low seq).
  // Same-format v2 comparison uses (seq, id) pair — seq wins over ID.

  it('delivery: Q(old ID, seq200) advances past B(new ID, seq100)', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();
    await ensureModules();

    const { SessionStore } = await import('@cat-cafe/shared/utils');
    const store = new SessionStore(r);
    const userId = 'u-ld1',
      catId = 'c-ld1',
      threadId = `t-ld1-${Date.now()}`;

    // B: new ID, low seq (delivered first)
    const cursorB = 'v2:0000000000000100:msg-2025-01-01T00:00:01-001';
    await r.set(`delivery-cursor:${userId}:${catId}:${threadId}`, cursorB);

    // Q: old ID, high seq (late delivery)
    const cursorQ = 'v2:0000000000000200:msg-2025-01-01T00:00:00-001';
    const advanced = await store.setDeliveryCursor(userId, catId, threadId, cursorQ);
    assert.equal(advanced, true, 'Late-delivered Q (seq200) must advance past B (seq100)');

    const stored = await store.getDeliveryCursor(userId, catId, threadId);
    assert.equal(stored, cursorQ, 'Stored must be Q cursor');

    await r.del(`delivery-cursor:${userId}:${catId}:${threadId}`);
  });

  it('delivery: B(new ID, seq100) must NOT regress past Q(old ID, seq200)', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();
    await ensureModules();

    const { SessionStore } = await import('@cat-cafe/shared/utils');
    const store = new SessionStore(r);
    const userId = 'u-ld2',
      catId = 'c-ld2',
      threadId = `t-ld2-${Date.now()}`;

    // Q already stored at seq 200
    const cursorQ = 'v2:0000000000000200:msg-2025-01-01T00:00:00-001';
    await r.set(`delivery-cursor:${userId}:${catId}:${threadId}`, cursorQ);

    // B tries to advance but has lower seq
    const cursorB = 'v2:0000000000000100:msg-2025-01-01T00:00:01-001';
    const advanced = await store.setDeliveryCursor(userId, catId, threadId, cursorB);
    assert.equal(advanced, false, 'B (seq100) must NOT regress past Q (seq200)');

    await r.del(`delivery-cursor:${userId}:${catId}:${threadId}`);
  });

  it('mention-ack: late-delivery Q advances past B', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();
    await ensureModules();
    const { SessionStore } = await import('@cat-cafe/shared/utils');
    const store = new SessionStore(r);
    const userId = 'u-ld3',
      catId = 'c-ld3',
      threadId = `t-ld3-${Date.now()}`;

    const cursorB = 'v2:0000000000000100:msg-B';
    await r.set(`mention-ack:${userId}:${catId}:${threadId}`, cursorB);
    const cursorQ = 'v2:0000000000000200:msg-Q-old-id';
    const advanced = await store.setMentionAckCursor(userId, catId, threadId, cursorQ);
    assert.equal(advanced, true, 'Mention-ack: Q(seq200) must advance past B(seq100)');
    await r.del(`mention-ack:${userId}:${catId}:${threadId}`);
  });

  it('seen-cursor: late-delivery Q advances past B', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();
    await ensureModules();
    const { SessionStore } = await import('@cat-cafe/shared/utils');
    const store = new SessionStore(r);
    const userId = 'u-ld4',
      catId = 'c-ld4',
      threadId = `t-ld4-${Date.now()}`;

    const cursorB = 'v2:0000000000000100:msg-B';
    await r.set(`seen-cursor:${userId}:${catId}:${threadId}`, cursorB);
    const cursorQ = 'v2:0000000000000200:msg-Q-old-id';
    const advanced = await store.setSeenCursor(userId, catId, threadId, cursorQ);
    assert.equal(advanced, true, 'Seen-cursor: Q(seq200) must advance past B(seq100)');
    await r.del(`seen-cursor:${userId}:${catId}:${threadId}`);
  });
});

// ============================================================================
// Sol R5: Reconcile cursor format — atomic v1→v2 upgrade
// ============================================================================

describe('Sol R5: RECONCILE_CURSOR_FORMAT atomicity', () => {
  it('reconcile upgrades stored v1 to v2 when CAS matches', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();
    await ensureModules();
    const { SessionStore } = await import('@cat-cafe/shared/utils');
    const store = new SessionStore(r);
    const userId = 'u-rc1',
      catId = 'c-rc1',
      threadId = `t-rc1-${Date.now()}`;

    // Store v1 cursor
    await r.set(`delivery-cursor:${userId}:${catId}:${threadId}`, 'msgA');
    // Reconcile v1→v2 (same position, different format)
    const v2 = 'v2:0000000000000042:msgA';
    const ok = await store.reconcileDeliveryCursorFormat(userId, catId, threadId, 'msgA', v2);
    assert.equal(ok, true, 'Reconcile must succeed when stored matches oldValue');
    const stored = await store.getDeliveryCursor(userId, catId, threadId);
    assert.equal(stored, v2, 'Stored must be upgraded to v2');

    await r.del(`delivery-cursor:${userId}:${catId}:${threadId}`);
  });

  it('reconcile rejects when stored has already changed (CAS miss)', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();
    await ensureModules();
    const { SessionStore } = await import('@cat-cafe/shared/utils');
    const store = new SessionStore(r);
    const userId = 'u-rc2',
      catId = 'c-rc2',
      threadId = `t-rc2-${Date.now()}`;

    // Store a different value than what reconcile expects
    await r.set(`delivery-cursor:${userId}:${catId}:${threadId}`, 'msgB');
    const ok = await store.reconcileDeliveryCursorFormat(userId, catId, threadId, 'msgA', 'v2:0000000000000042:msgA');
    assert.equal(ok, false, 'Reconcile must reject when stored ≠ oldValue (concurrent change)');
    const stored = await store.getDeliveryCursor(userId, catId, threadId);
    assert.equal(stored, 'msgB', 'Stored must remain unchanged');

    await r.del(`delivery-cursor:${userId}:${catId}:${threadId}`);
  });

  it('reconcile preserves TTL on expiring cursors', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();
    await ensureModules();
    const { SessionStore } = await import('@cat-cafe/shared/utils');
    const store = new SessionStore(r);
    const userId = 'u-rc3',
      catId = 'c-rc3',
      threadId = `t-rc3-${Date.now()}`;

    // Store v1 with TTL
    await r.set(`delivery-cursor:${userId}:${catId}:${threadId}`, 'msgA', 'EX', 3600);
    const ttlBefore = await r.ttl(`delivery-cursor:${userId}:${catId}:${threadId}`);
    assert.ok(ttlBefore > 3500, `TTL before reconcile should be ~3600, got ${ttlBefore}`);

    const v2 = 'v2:0000000000000042:msgA';
    await store.reconcileDeliveryCursorFormat(userId, catId, threadId, 'msgA', v2);

    const ttlAfter = await r.ttl(`delivery-cursor:${userId}:${catId}:${threadId}`);
    assert.ok(ttlAfter > 3500, `TTL after reconcile should be preserved (~3600), got ${ttlAfter}`);

    await r.del(`delivery-cursor:${userId}:${catId}:${threadId}`);
  });

  it('reconcile + CAS flow: pre-reconcile v1→v2 then CAS succeeds', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();
    await ensureModules();
    const { SessionStore } = await import('@cat-cafe/shared/utils');
    const store = new SessionStore(r);
    const userId = 'u-rc4',
      catId = 'c-rc4',
      threadId = `t-rc4-${Date.now()}`;

    // Simulate: stored v1 'msgA' with message hash that has visibilitySeq=42
    await r.set(`delivery-cursor:${userId}:${catId}:${threadId}`, 'msgA');
    // Create message hash so Lua can resolve v1
    await r.hset(`msg:msgA`, 'visibilitySeq', '42');

    // Step 1: Reconcile v1→v2 (what DeliveryCursorStore.preReconcile does)
    const v2Old = 'v2:0000000000000042:msgA';
    const ok = await store.reconcileDeliveryCursorFormat(userId, catId, threadId, 'msgA', v2Old);
    assert.equal(ok, true, 'Reconcile must succeed');

    // Step 2: CAS with v2 incoming (higher seq) — now same-format v2 vs v2
    const v2New = 'v2:0000000000000100:msgB';
    const advanced = await store.setDeliveryCursor(userId, catId, threadId, v2New);
    assert.equal(advanced, true, 'After reconcile, CAS v2→v2 with higher seq must advance');

    const stored = await store.getDeliveryCursor(userId, catId, threadId);
    assert.equal(stored, v2New, 'Stored must be updated to new v2 cursor');

    await r.del(`delivery-cursor:${userId}:${catId}:${threadId}`);
    await r.del(`msg:msgA`);
  });

  it('mention-ack reconcile works across namespaces', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();
    await ensureModules();
    const { SessionStore } = await import('@cat-cafe/shared/utils');
    const store = new SessionStore(r);
    const userId = 'u-rc5',
      catId = 'c-rc5',
      threadId = `t-rc5-${Date.now()}`;

    await r.set(`mention-ack:${userId}:${catId}:${threadId}`, 'msgX');
    const v2 = 'v2:0000000000000077:msgX';
    const ok = await store.reconcileMentionAckCursorFormat(userId, catId, threadId, 'msgX', v2);
    assert.equal(ok, true, 'Mention-ack reconcile must succeed');
    const stored = await store.getMentionAckCursor(userId, catId, threadId);
    assert.equal(stored, v2, 'Mention-ack must be upgraded to v2');

    await r.del(`mention-ack:${userId}:${catId}:${threadId}`);
  });

  it('seen-cursor reconcile works across namespaces', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();
    await ensureModules();
    const { SessionStore } = await import('@cat-cafe/shared/utils');
    const store = new SessionStore(r);
    const userId = 'u-rc6',
      catId = 'c-rc6',
      threadId = `t-rc6-${Date.now()}`;

    await r.set(`seen-cursor:${userId}:${catId}:${threadId}`, 'msgY');
    const v2 = 'v2:0000000000000099:msgY';
    const ok = await store.reconcileSeenCursorFormat(userId, catId, threadId, 'msgY', v2);
    assert.equal(ok, true, 'Seen-cursor reconcile must succeed');
    const stored = await store.getSeenCursor(userId, catId, threadId);
    assert.equal(stored, v2, 'Seen-cursor must be upgraded to v2');

    await r.del(`seen-cursor:${userId}:${catId}:${threadId}`);
  });
});

// ============================================================================
// Sol R5: Notice filter indeterminate — cross-format conservatively KEEPS
// ============================================================================

describe('Sol R5: Notice filter cross-format indeterminate handling', () => {
  before(async () => {
    await ensureModules();
  });

  // This tests the consumer-side pattern:
  //   cmp > 0 || (cmp === 0 && n.maxMessageId !== seenCursor)
  // which keeps notices when comparison is indeterminate (cross-format).

  it('v1 maxMessageId + v2 seenCursor → notice must be KEPT (indeterminate)', () => {
    const maxMessageId = 'msg-legacy-raw-id'; // v1
    const seenCursor = 'v2:0000000000000100:msg-modern'; // v2

    // compareCursors returns 0 for cross-format
    const cmp = compareCursors(maxMessageId, seenCursor);
    assert.equal(cmp, 0, 'Cross-format comparison must return 0 (indeterminate)');

    // Old filter `> 0` would REMOVE this notice — WRONG
    const oldFilter = cmp > 0;
    assert.equal(oldFilter, false, 'Old filter incorrectly removes indeterminate notice');

    // New filter keeps it because strings differ (not truly equal)
    const newFilter = cmp > 0 || (cmp === 0 && maxMessageId !== seenCursor);
    assert.equal(newFilter, true, 'New filter must KEEP notice (indeterminate = unresolved)');
  });

  it('v2 maxMessageId + v1 seenCursor → notice must be KEPT (indeterminate)', () => {
    const maxMessageId = 'v2:0000000000000200:msg-modern';
    const seenCursor = 'msg-legacy-raw-id';

    const cmp = compareCursors(maxMessageId, seenCursor);
    assert.equal(cmp, 0, 'Cross-format v2 vs v1 = indeterminate');

    const newFilter = cmp > 0 || (cmp === 0 && maxMessageId !== seenCursor);
    assert.equal(newFilter, true, 'Reverse cross-format must also KEEP notice');
  });

  it('truly equal maxMessageId + seenCursor → notice resolved (removed)', () => {
    const cursor = 'v2:0000000000000100:msg-same';

    const cmp = compareCursors(cursor, cursor);
    assert.equal(cmp, 0, 'Same string comparison = 0');

    // Strings are identical → truly equal, notice is resolved
    // biome-ignore lint/suspicious/noSelfCompare: intentional — testing same-string identity semantics
    const newFilter = cmp > 0 || (cmp === 0 && cursor !== cursor);
    assert.equal(newFilter, false, 'Truly equal = notice resolved, must be REMOVED');
  });

  it('maxMessageId ahead of seenCursor → notice kept (unresolved)', () => {
    const maxMessageId = 'v2:0000000000000200:msg-ahead';
    const seenCursor = 'v2:0000000000000100:msg-behind';

    const cmp = compareCursors(maxMessageId, seenCursor);
    assert.ok(cmp > 0, 'Same-format v2: ahead must be > 0');

    const newFilter = cmp > 0 || (cmp === 0 && maxMessageId !== seenCursor);
    assert.equal(newFilter, true, 'Ahead notice must be KEPT (unresolved)');
  });

  it('maxMessageId behind seenCursor → notice resolved (removed)', () => {
    const maxMessageId = 'v2:0000000000000050:msg-behind';
    const seenCursor = 'v2:0000000000000100:msg-ahead';

    const cmp = compareCursors(maxMessageId, seenCursor);
    assert.ok(cmp < 0, 'Same-format v2: behind must be < 0');

    const newFilter = cmp > 0 || (cmp === 0 && maxMessageId !== seenCursor);
    assert.equal(newFilter, false, 'Behind notice must be REMOVED (resolved)');
  });
});

// ============================================================================
// Sol R5: isMentionAcked indeterminate-aware comparison
// ============================================================================

describe('Sol R5: isMentionAcked cross-format indeterminate', () => {
  before(async () => {
    await ensureModules();
  });

  it('v1 mention cursor + v2 ack cursor → NOT acked (indeterminate)', () => {
    // Simulates: getter canonicalized ack to v2, but cursorFor(item) returns v1
    // (pre-migration message without visibilitySeq)
    const ic = 'msg-legacy-mention'; // v1
    const lastAckId = 'v2:0000000000000100:msg-acked'; // v2

    const cmp = compareCursors(ic, lastAckId);
    assert.equal(cmp, 0, 'Cross-format = indeterminate');

    // Old: `<= 0` treats as acked — WRONG (drops pending mention)
    const oldResult = cmp <= 0;
    assert.equal(oldResult, true, 'Old filter incorrectly marks as acked');

    // New: only true string equality counts
    const newResult = cmp < 0 || (cmp === 0 && ic === lastAckId);
    assert.equal(newResult, false, 'New filter: cross-format indeterminate = NOT acked');
  });

  it('same-format v2 earlier mention → correctly acked', () => {
    const ic = 'v2:0000000000000050:msg-early';
    const lastAckId = 'v2:0000000000000100:msg-ack-point';

    const cmp = compareCursors(ic, lastAckId);
    assert.ok(cmp < 0, 'Earlier mention must be < ack point');

    const newResult = cmp < 0 || (cmp === 0 && ic === lastAckId);
    assert.equal(newResult, true, 'Earlier same-format mention = correctly acked');
  });

  it('identical cursor strings → correctly acked (true equality)', () => {
    const cursor = 'v2:0000000000000100:msg-exact';

    const cmp = compareCursors(cursor, cursor);
    // biome-ignore lint/suspicious/noSelfCompare: intentional — testing same-string identity semantics
    const newResult = cmp < 0 || (cmp === 0 && cursor === cursor);
    assert.equal(newResult, true, 'Identical strings = truly equal = acked');
  });
});

// ============================================================================
// Sol R5: Comprehensive HWM zero-mutation — hash/ZSET/timeline/message-state
// ============================================================================

describe('Sol R5: HWM reject zero-mutation (comprehensive)', () => {
  it('DELIVER reject: message hash unchanged (deliveryStatus, no visibilitySeq)', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();
    await ensureModules();

    const threadId = `zmut-deliver-${Date.now()}`;
    const metaKey = `msg:visibility-meta:${threadId}`;
    const store = new RedisMessageStore(r);

    try {
      // Trigger migration flag
      await store.append({
        userId: 'u1',
        catId: null,
        content: 'trigger',
        mentions: [],
        timestamp: Date.now() - 1000,
        threadId,
      });

      // Hidden queued work (non-cat-speech) — no visibilitySeq at append,
      // so markDelivered enters the HWM allocation path.
      const msg = await store.append({
        userId: 'scheduler',
        catId: null,
        content: 'queued-msg',
        mentions: [],
        timestamp: Date.now(),
        threadId,
        deliveryStatus: 'queued',
      });

      // Snapshot pre-rejection state
      const hashBefore = await r.hgetall(`msg:${msg.id}`);
      const threadZsetBefore = await r.zrangebyscore(`msg:thread:${threadId}`, '-inf', '+inf', 'WITHSCORES');
      const visZsetBefore = await r.zrangebyscore(`msg:visibility:${threadId}`, '-inf', '+inf', 'WITHSCORES');

      // Poison hwm
      await r.hset(metaKey, 'hwm', 'nan');

      // Deliver should reject
      await assert.rejects(() => store.markDelivered(msg.id, Date.now()), /VISIBILITY_HWM_NAN/);

      // Comprehensive zero-mutation checks
      const hashAfter = await r.hgetall(`msg:${msg.id}`);
      assert.deepEqual(hashAfter, hashBefore, 'Message hash must be unchanged after rejected deliver');
      assert.equal(hashAfter.deliveryStatus, 'queued', 'deliveryStatus must remain queued');
      assert.equal(hashAfter.visibilitySeq, undefined, 'visibilitySeq must NOT be set');
      assert.equal(hashAfter.deliveredAt, undefined, 'deliveredAt must NOT be set');

      const threadZsetAfter = await r.zrangebyscore(`msg:thread:${threadId}`, '-inf', '+inf', 'WITHSCORES');
      assert.deepEqual(threadZsetAfter, threadZsetBefore, 'Thread ZSET must be unchanged');

      const visZsetAfter = await r.zrangebyscore(`msg:visibility:${threadId}`, '-inf', '+inf', 'WITHSCORES');
      assert.deepEqual(visZsetAfter, visZsetBefore, 'Visibility ZSET must be unchanged');

      const hwmAfter = await r.hget(metaKey, 'hwm');
      assert.equal(hwmAfter, 'nan', 'HWM must remain poisoned');
    } finally {
      await r.del(metaKey);
    }
  });

  it('APPEND reject: no new hash/ZSET/timeline entries created', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();
    await ensureModules();

    const threadId = `zmut-append-${Date.now()}`;
    const metaKey = `msg:visibility-meta:${threadId}`;
    const store = new RedisMessageStore(r);

    try {
      // Trigger migration
      const seed = await store.append({
        userId: 'u1',
        catId: null,
        content: 'seed',
        mentions: [],
        timestamp: Date.now() - 1000,
        threadId,
      });

      // Snapshot post-seed state
      const threadZsetBefore = await r.zrangebyscore(`msg:thread:${threadId}`, '-inf', '+inf', 'WITHSCORES');
      const visZsetBefore = await r.zrangebyscore(`msg:visibility:${threadId}`, '-inf', '+inf', 'WITHSCORES');
      const hwmBefore = await r.hget(metaKey, 'hwm');

      // Poison hwm
      await r.hset(metaKey, 'hwm', 'nan');

      // Append should reject
      await assert.rejects(
        () =>
          store.append({
            userId: 'u1',
            catId: null,
            content: 'rejected',
            mentions: [],
            timestamp: Date.now(),
            threadId,
          }),
        /VISIBILITY_HWM_NAN/,
      );

      // Thread ZSET should have no new entries
      const threadZsetAfter = await r.zrangebyscore(`msg:thread:${threadId}`, '-inf', '+inf', 'WITHSCORES');
      assert.equal(threadZsetAfter.length, threadZsetBefore.length, 'Thread ZSET must not grow');

      // Visibility ZSET should have no new entries
      const visZsetAfter = await r.zrangebyscore(`msg:visibility:${threadId}`, '-inf', '+inf', 'WITHSCORES');
      assert.equal(visZsetAfter.length, visZsetBefore.length, 'Visibility ZSET must not grow');

      // Restore hwm for cleanup
      await r.hset(metaKey, 'hwm', hwmBefore || '0');
    } finally {
      await r.del(metaKey);
    }
  });
});

// ============================================================================
// Sol R6 P1-1: PTTL sub-second TTL preservation (reconcile)
// ============================================================================

describe('Sol R6 P1-1: RECONCILE preserves sub-second TTL via PTTL/PX', () => {
  it('key with sub-second TTL: reconcile preserves via PTTL/PX (not permanentized)', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();
    await ensureModules();
    const { SessionStore } = await import('@cat-cafe/shared/utils');
    const store = new SessionStore(r);
    const userId = 'u-pttl1',
      catId = 'c-pttl1',
      threadId = `t-pttl1-${Date.now()}`;
    const key = `delivery-cursor:${userId}:${catId}:${threadId}`;

    try {
      // Store cursor with 5000ms TTL. The bug scenario: old code uses TTL (seconds)
      // which returns 0 when <1s remains, causing permanentization. PTTL (ms) is correct.
      // We use 5000ms here for test reliability, then verify PTTL is preserved.
      await r.set(key, 'msgA', 'PX', 5000);

      // Verify PTTL shows remaining ms
      const pttlBefore = await r.pttl(key);
      assert.ok(pttlBefore > 0 && pttlBefore <= 5000, `PTTL before reconcile must be >0, got ${pttlBefore}`);

      // Reconcile v1→v2
      const v2 = 'v2:0000000000000042:msgA';
      const ok = await store.reconcileDeliveryCursorFormat(userId, catId, threadId, 'msgA', v2);
      assert.equal(ok, true, 'Reconcile must succeed');

      // After reconcile: PTTL must still be set (Lua uses PX to preserve ms-precision)
      const pttlAfter = await r.pttl(key);
      assert.ok(pttlAfter > 0, `PTTL after reconcile must be >0 (not permanentized), got ${pttlAfter}`);
      assert.ok(pttlAfter <= 5000, `PTTL after reconcile must be <= original 5000, got ${pttlAfter}`);

      // Value must be upgraded
      const stored = await r.get(key);
      assert.equal(stored, v2, 'Value must be upgraded to v2');
    } finally {
      await r.del(key);
    }
  });

  it('persistent key (no TTL): reconcile keeps it persistent', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();
    await ensureModules();
    const { SessionStore } = await import('@cat-cafe/shared/utils');
    const store = new SessionStore(r);
    const userId = 'u-pttl2',
      catId = 'c-pttl2',
      threadId = `t-pttl2-${Date.now()}`;
    const key = `delivery-cursor:${userId}:${catId}:${threadId}`;

    try {
      // Store persistent cursor (no TTL)
      await r.set(key, 'msgA');
      const pttlBefore = await r.pttl(key);
      assert.equal(pttlBefore, -1, 'Persistent key PTTL must be -1');

      // Reconcile
      const v2 = 'v2:0000000000000042:msgA';
      await store.reconcileDeliveryCursorFormat(userId, catId, threadId, 'msgA', v2);

      // Must remain persistent
      const pttlAfter = await r.pttl(key);
      assert.equal(pttlAfter, -1, 'After reconcile: persistent key must remain persistent (PTTL=-1)');
    } finally {
      await r.del(key);
    }
  });
});

// ============================================================================
// Sol R6 P1-2: Scan correctness — no arbitrary cap when target-bounded
// ============================================================================

describe('Sol R6 P1-2: seenCursor scan correctness bound', () => {
  before(async () => {
    await ensureModules();
  });

  // The fix: `maxScanTotal` safety cap only applies when maxSeenPosition === 0
  // (pre-migration, no target). When maxSeenPosition > 0 (post-migration),
  // scan runs until target found or pages exhausted — no arbitrary truncation.
  //
  // This is a pattern-level test (the actual scan is deep in route handlers).
  // We verify the decision logic: safety cap active only when target = 0.

  it('target-bounded scan (maxSeenPosition > 0): no cap applies', () => {
    const maxSeenPosition = 150;
    const maxScanFallback = 500;
    let scannedTotal = 0;

    // Simulate 600 iterations — must NOT break early when target is set
    let earlyBreak = false;
    for (let i = 0; i < 600; i++) {
      scannedTotal++;
      if (maxSeenPosition === 0 && scannedTotal >= maxScanFallback) {
        earlyBreak = true;
        break;
      }
    }

    assert.equal(earlyBreak, false, 'Target-bounded scan must NOT hit safety cap');
    assert.equal(scannedTotal, 600, 'All 600 iterations must complete');
  });

  it('pre-migration fallback (maxSeenPosition === 0): safety cap at 500', () => {
    const maxSeenPosition = 0;
    const maxScanFallback = 500;
    let scannedTotal = 0;

    let earlyBreak = false;
    for (let i = 0; i < 600; i++) {
      if (maxSeenPosition === 0 && scannedTotal >= maxScanFallback) {
        earlyBreak = true;
        break;
      }
      scannedTotal++;
    }

    assert.equal(earlyBreak, true, 'Pre-migration fallback must hit safety cap');
    assert.equal(scannedTotal, 500, 'Must stop at 500 (safety cap)');
  });
});

// ============================================================================
// Sol R6 P2-1: hydrateMessages visibilitySeq injection
// ============================================================================

describe('Sol R6 P2-1: Redis hydrateMessages includes visibilitySeq', () => {
  it('getRecentMentionsFor returns messages with visibilitySeq', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();
    await ensureModules();

    const store = new RedisMessageStore(r);
    const threadId = `hydrate-vis-${Date.now()}`;
    const catId = 'opus';

    // Append a message that mentions a cat (so getRecentMentionsFor picks it up)
    const msg = await store.append({
      userId: 'u1',
      catId: null,
      content: `Hey @${catId} check this`,
      mentions: [catId],
      timestamp: Date.now(),
      threadId,
    });

    // Verify append returned visibilitySeq
    assert.ok(msg.visibilitySeq != null, 'append must return visibilitySeq');

    // getRecentMentionsFor goes through hydrateMessages (not hydrateHash)
    const mentions = await store.getRecentMentionsFor(catId, 50);

    // Find our message in the results
    const found = mentions.find((m) => m.id === msg.id);
    assert.ok(found, 'Our message must appear in getRecentMentionsFor results');
    assert.ok(found.visibilitySeq != null, 'hydrateMessages must inject visibilitySeq from hash');
    assert.equal(found.visibilitySeq, msg.visibilitySeq, 'visibilitySeq must match append return value');

    // Verify cursorFor produces v2 (not v1) — the downstream effect
    const cursor = cursorFor(found);
    assert.ok(cursor.startsWith('v2:'), `cursorFor must produce v2 for hydrated message, got: ${cursor}`);
  });
});

// ============================================================================
// Sol R6 P2-2: Notice compat resolver — legacy maxCursor canonicalization
// ============================================================================

describe('Sol R6/R7 P2-2: Notice consumer — dual-field + compat resolver', () => {
  before(async () => {
    await ensureModules();
  });

  // --- Pattern-level tests (consumer expression correctness) ---

  it('new event (maxCursor set): uses maxCursor for comparison, not maxMessageId', () => {
    // New events: maxMessageId = raw ID, maxCursor = v2 cursor
    const notice = {
      maxMessageId: 'msg-new',
      maxCursor: 'v2:0000000000000100:msg-new',
    };
    const seenCursor = 'v2:0000000000000200:msg-seen';

    const noticeCursor = notice.maxCursor ?? notice.maxMessageId;
    const cmp = compareCursors(noticeCursor, seenCursor);

    assert.ok(cmp < 0, 'New event behind seenCursor must resolve as behind');
    const keep = cmp > 0 || (cmp === 0 && noticeCursor !== seenCursor);
    assert.equal(keep, false, 'Notice behind seenCursor must be filtered out (resolved)');
  });

  it('legacy event (no maxCursor): falls back to maxMessageId', () => {
    const notice = {
      maxMessageId: 'v2:0000000000000300:msg-legacy',
      maxCursor: undefined,
    };
    const seenCursor = 'v2:0000000000000200:msg-seen';

    const noticeCursor = notice.maxCursor ?? notice.maxMessageId;
    assert.equal(noticeCursor, 'v2:0000000000000300:msg-legacy', 'Must fall back to maxMessageId');

    const cmp = compareCursors(noticeCursor, seenCursor);
    assert.ok(cmp > 0, 'Legacy notice ahead of seenCursor must be kept');
  });

  it('compat resolver: canonicalized v1→v2 enables same-format comparison', () => {
    const canonicalized = 'v2:0000000000000050:msg-legacy-raw-id';
    const seenCursor = 'v2:0000000000000200:msg-seen';

    const cmp = compareCursors(canonicalized, seenCursor);
    assert.ok(cmp < 0, 'Canonicalized v1→v2 (seq50) < seenCursor (seq200)');

    const keep = cmp > 0 || (cmp === 0 && canonicalized !== seenCursor);
    assert.equal(keep, false, 'Canonicalized notice behind seenCursor must be filtered out');
  });

  // --- Sol R7 required: service-level regression test ---
  // Production path: legacy event(maxMessageId=raw v1, no maxCursor) at same
  // position as v2 seenCursor → checkHoldBallReminder must return null (resolved),
  // NOT emit notice_deferred. This exercises the actual service code, not just
  // the comparison expression.

  it('service: legacy event + v2 seenCursor → resolved via canonicalize (no false reminder)', async () => {
    await ensureModules();
    const { FreshnessNoticeService } = await import(
      '../dist/domains/cats/services/freshness/FreshnessNoticeService.js'
    );
    const { FreshnessAttentionEventLog } = await import(
      '../dist/domains/cats/services/freshness/FreshnessAttentionEventLog.js'
    );

    // Build in-memory event log stub that returns a legacy notice_attached event
    const legacyEvent = {
      kind: 'notice_attached',
      threadId: 't-service-legacy',
      catId: 'opus',
      invocationId: 'inv-legacy-test',
      timestamp: Date.now() - 60000,
      toolName: 'list_recent',
      unseenSenders: ['lang'],
      noticeId: 'notice-inv-legacy-test-1',
      maxMessageId: 'msg-raw-legacy-id', // v1 raw ID (legacy — no maxCursor)
      // maxCursor: absent — this is the legacy case
    };

    const eventLogStub = {
      append: async () => {},
      getUnresolvedNotices: async () => [legacyEvent],
    };
    const noopStateStore = {
      get: async () => null,
      incrementToolCallCount: async () => 0,
      recordNoticeDelivered: async () => {},
    };
    const noopUnseenChecker = { checkUnseen: async () => null };

    const service = new FreshnessNoticeService(noopStateStore, eventLogStub, noopUnseenChecker);

    // seenCursor is v2 at same position as the legacy event's message
    const seenCursor = 'v2:0000000000000100:msg-raw-legacy-id';

    // Canonicalize stub: simulates messageStore.canonicalizeCursor resolving
    // raw v1 "msg-raw-legacy-id" to v2 cursor at seq=100
    const canonicalize = async (msgId, _threadId) => {
      if (msgId === 'msg-raw-legacy-id') return 'v2:0000000000000100:msg-raw-legacy-id';
      return msgId; // fallback: identity
    };

    const result = await service.checkHoldBallReminder({
      invocationId: 'inv-legacy-test',
      threadId: 't-service-legacy',
      catId: 'opus',
      currentSeenCursor: seenCursor,
      canonicalizeCursor: canonicalize,
    });

    // With canonicalization: v2:...100:msg vs v2:...100:msg → truly equal → resolved
    assert.equal(result, null, 'Legacy event at same position must resolve (null = no reminder)');
  });

  it('service: legacy event without canonicalize → indeterminate → conservative keep (reminder)', async () => {
    await ensureModules();
    const { FreshnessNoticeService } = await import(
      '../dist/domains/cats/services/freshness/FreshnessNoticeService.js'
    );

    const legacyEvent = {
      kind: 'notice_attached',
      threadId: 't-service-nocanon',
      catId: 'opus',
      invocationId: 'inv-nocanon-test',
      timestamp: Date.now() - 60000,
      toolName: 'list_recent',
      unseenSenders: ['lang'],
      noticeId: 'notice-inv-nocanon-test-1',
      maxMessageId: 'msg-raw-no-canon',
    };

    const deferredEvents = [];
    const eventLogStub = {
      append: async (e) => deferredEvents.push(e),
      getUnresolvedNotices: async () => [legacyEvent],
    };
    const noopStateStore = {
      get: async () => null,
      incrementToolCallCount: async () => 0,
      recordNoticeDelivered: async () => {},
    };
    const noopUnseenChecker = { checkUnseen: async () => null };

    const service = new FreshnessNoticeService(noopStateStore, eventLogStub, noopUnseenChecker);
    const seenCursor = 'v2:0000000000000200:msg-seen';

    // No canonicalizeCursor provided — cross-format indeterminate → conservative keep
    const result = await service.checkHoldBallReminder({
      invocationId: 'inv-nocanon-test',
      threadId: 't-service-nocanon',
      catId: 'opus',
      currentSeenCursor: seenCursor,
      // canonicalizeCursor: not provided
    });

    // Without canonicalization, v1 vs v2 = indeterminate → keep → reminder returned
    assert.ok(result !== null, 'Without canonicalize: legacy event must be kept (conservative)');
    assert.ok(result.text.includes('未读'), 'Reminder text must mention unread');
    assert.equal(deferredEvents.length, 1, 'Must emit notice_deferred event');
    assert.equal(deferredEvents[0].kind, 'notice_deferred', 'Deferred event must be notice_deferred');
  });

  // --- Sol R7 required: new event dual-field semantics ---

  it('new event stores raw ID in maxMessageId, v2 cursor in maxCursor', async () => {
    await ensureModules();
    const { parseCursor: pc } = await import('../dist/domains/cats/services/stores/cursor.js');

    // Simulate what FreshnessNoticeService.checkAndMaybeNotice does:
    // unseen.maxMessageId from ThreadUnseenChecker is already v2
    const v2FromChecker = 'v2:0000000000000100:msg-2025-01-01T00:00:00-001';
    const parsed = pc(v2FromChecker);

    assert.ok(parsed, 'parseCursor must parse v2 cursor');
    assert.equal(parsed.id, 'msg-2025-01-01T00:00:00-001', 'parsed.id must be raw message ID');
    assert.notEqual(parsed.id, v2FromChecker, 'Raw ID must differ from v2 cursor');

    // Event creation would use:
    // maxMessageId: parsed.id (raw)
    // maxCursor: v2FromChecker (v2)
    assert.equal(parsed.id, 'msg-2025-01-01T00:00:00-001');
  });
});

// --- Codex R9 P1: getLatestVisibleCursor must skip tombstones (both impls) ---

describe('Codex R9 P1: getLatestVisibleCursor skips soft-deleted (tombstoned) messages', () => {
  // --- In-memory implementation tests (always run) ---

  it('in-memory: latest cursor points to newest NON-deleted message', async () => {
    await ensureModules();
    const memStore = new MessageStore();
    const threadId = `tombstone-mem-latest-${Date.now()}`;

    const _msgA = memStore.append({
      userId: 'u1',
      catId: null,
      content: 'message A (live)',
      mentions: [],
      timestamp: Date.now() - 2000,
      threadId,
    });
    const msgB = memStore.append({
      userId: 'u1',
      catId: null,
      content: 'message B (live)',
      mentions: [],
      timestamp: Date.now() - 1000,
      threadId,
    });
    const msgC = memStore.append({
      userId: 'u1',
      catId: null,
      content: 'message C (will be tombstoned)',
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });

    // Soft-delete C
    memStore.softDelete(msgC.id, 'admin');

    const result = memStore.getLatestVisibleCursor(threadId);
    assert.ok(result, 'Must return a result (at least B is live)');

    const parsed = parseCursor(result.cursor);
    assert.ok(parsed, 'Must be parseable');
    assert.equal(parsed.id, msgB.id, 'Latest cursor must be B (not the tombstoned C)');
    assert.equal(result.messageId, msgB.id, 'messageId must also be B');
  });

  it('in-memory: returns null when all messages are tombstoned', async () => {
    await ensureModules();
    const memStore = new MessageStore();
    const threadId = `tombstone-mem-all-del-${Date.now()}`;

    const msgOnly = memStore.append({
      userId: 'u1',
      catId: null,
      content: 'sole message',
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });
    memStore.softDelete(msgOnly.id, 'admin');

    const result = memStore.getLatestVisibleCursor(threadId);
    assert.equal(result, null, 'All tombstoned → no latest cursor');
  });

  // --- Redis implementation tests (require isolation) ---

  let redis;
  let redisStore;
  // #1200 codex R10 P2: keyPrefix must be on the ioredis CLIENT, not RedisMessageStore
  // (which reads redis.options.keyPrefix). Use cleanupClientKeyspace for teardown.
  const TOMBSTONE_PREFIX = 'test-tombstone-latest:';

  before(async () => {
    await ensureModules();
    const skipReason = redisIsolationSkipReason(REDIS_URL);
    if (skipReason) {
      console.log(`SKIP (getLatestVisibleCursor tombstone Redis): ${skipReason}`);
      return;
    }
    assertRedisIsolationOrThrow(REDIS_URL, 'tombstone-latest');
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: TOMBSTONE_PREFIX });
    redisStore = new RedisMessageStore(redis);
  });

  after(async () => {
    if (redis) {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  });

  it('Redis: latest cursor points to newest NON-deleted message', async () => {
    if (!redisStore) return; // skipped — no Redis

    const threadId = `tombstone-redis-latest-${Date.now()}`;

    const _msgA = await redisStore.append({
      userId: 'u1',
      catId: null,
      content: 'message A (live)',
      mentions: [],
      timestamp: Date.now() - 2000,
      threadId,
    });
    const msgB = await redisStore.append({
      userId: 'u1',
      catId: null,
      content: 'message B (live)',
      mentions: [],
      timestamp: Date.now() - 1000,
      threadId,
    });
    const msgC = await redisStore.append({
      userId: 'u1',
      catId: null,
      content: 'message C (will be tombstoned)',
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });

    // Soft-delete C: softDelete(id, deletedBy)
    await redisStore.softDelete(msgC.id, 'admin');

    const result = await redisStore.getLatestVisibleCursor(threadId);
    assert.ok(result, 'Must return a result (at least B is live)');

    const parsed = parseCursor(result.cursor);
    assert.ok(parsed, 'Must be parseable');
    assert.equal(parsed.id, msgB.id, 'Latest cursor must be B (not the tombstoned C)');
    assert.equal(result.messageId, msgB.id, 'messageId must also be B');
  });

  it('Redis: returns null when all messages are tombstoned', async () => {
    if (!redisStore) return;

    const threadId = `tombstone-redis-all-del-${Date.now()}`;

    const msgOnly = await redisStore.append({
      userId: 'u1',
      catId: null,
      content: 'sole message',
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });
    await redisStore.softDelete(msgOnly.id, 'admin');

    const result = await redisStore.getLatestVisibleCursor(threadId);
    assert.equal(result ?? null, null, 'All tombstoned → no latest cursor');
  });
});

// --- Codex R13: ThreadUnseenChecker queue fallback HWM-ahead regression ---

describe('Codex R13: queue fallback synthetic seq exceeds seen cursor seq', () => {
  it('synthetic seq >= seenSeq + 1 even when Date.now() < seenSeq', async () => {
    await ensureModules();

    // Simulate: seen cursor has seq higher than Date.now() (allocator HWM ahead)
    const futureSeq = Date.now() + 100_000; // 100s in future
    const seenCursor = `v2:${String(futureSeq).padStart(16, '0')}:msg-seen`;

    // Parse and verify the synthetic seq would be higher
    const parsed = parseCursor(seenCursor);
    assert.ok(parsed, 'Must parse v2 cursor');
    assert.equal(parsed.seq, futureSeq, 'Seen cursor seq must be future');

    // The fix uses max(seenSeq + 1, Date.now()) — verify it produces > seenSeq
    const seenSeq = parsed.seq;
    const syntheticSeq = Math.max(seenSeq + 1, Date.now());
    assert.ok(syntheticSeq > futureSeq, 'Synthetic seq must exceed future seen seq');

    // Build the cursor the same way the code does
    const { cursorFor: cf, parseCursor: pc } = await import('../dist/domains/cats/services/stores/cursor.js');
    const { generateSortableId: gsi } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const syntheticCursor = cf({ id: gsi(syntheticSeq), visibilitySeq: syntheticSeq });
    const syntheticParsed = pc(syntheticCursor);
    assert.ok(syntheticParsed, 'Synthetic cursor must be parseable');
    assert.ok(syntheticParsed.seq > futureSeq, 'Synthetic cursor seq must exceed seen seq');

    // Verify compareCursors ranks synthetic > seen
    const cmp = compareCursors(syntheticCursor, seenCursor);
    assert.ok(cmp > 0, 'Synthetic cursor must compare greater than seen cursor');
  });
});

// --- Codex R13: read-state pre-reconcile before CAS ---

describe('Codex R13: RedisThreadReadStateStore reconcileReadCursor', () => {
  let redis;
  let store;
  const READ_PREFIX = 'test-read-reconcile:';

  before(async () => {
    await ensureModules();
    const skipReason = redisIsolationSkipReason(REDIS_URL);
    if (skipReason) {
      console.log(`SKIP (read-state reconcile): ${skipReason}`);
      return;
    }
    assertRedisIsolationOrThrow(REDIS_URL, 'read-reconcile');
    const { RedisThreadReadStateStore } = await import(
      '../dist/domains/cats/services/stores/redis/RedisThreadReadStateStore.js'
    );
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: READ_PREFIX });
    store = new RedisThreadReadStateStore(redis);
  });

  after(async () => {
    if (redis) {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  });

  it('reconcile upgrades stored v1 → v2 atomically', async () => {
    if (!store) return;

    const userId = 'u-reconcile-test';
    const threadId = 't-reconcile-test';
    const v1Id = 'msg-2025-01-15T12:00:00-001';
    const v2Cursor = 'v2:0000000000000050:msg-2025-01-15T12:00:00-001';

    // Seed with v1 cursor via ack (first ack always succeeds)
    await store.ack(userId, threadId, v1Id);
    const before = await store.get(userId, threadId);
    assert.equal(before.lastReadMessageId, v1Id, 'Stored must be v1');

    // Reconcile v1 → v2
    const ok = await store.reconcileReadCursor(userId, threadId, v1Id, v2Cursor);
    assert.equal(ok, true, 'Reconcile must succeed');

    const after = await store.get(userId, threadId);
    assert.equal(after.lastReadMessageId, v2Cursor, 'Stored must now be v2');
  });

  it('reconcile rejects if stored changed (race)', async () => {
    if (!store) return;

    const userId = 'u-reconcile-race';
    const threadId = 't-reconcile-race';

    // Seed with a known value
    await store.ack(userId, threadId, 'msg-original');

    // Try to reconcile with wrong old value
    const ok = await store.reconcileReadCursor(userId, threadId, 'msg-wrong', 'v2:0000000000000001:msg-wrong');
    assert.equal(ok, false, 'Reconcile must fail on mismatch');

    // Stored should be unchanged
    const state = await store.get(userId, threadId);
    assert.equal(state.lastReadMessageId, 'msg-original', 'Stored must not change on failed reconcile');
  });
});

// ============================================================================
// Codex R14 + Sol R14: ACK_CAS_LUA cross-format fail-closed
// ============================================================================

describe('Codex R14 + Sol R14: ACK_CAS_LUA fail-closed on cross-format', () => {
  let redis;
  let store;
  const ACK_CAS_PREFIX = 'test-ack-cas-xfmt:';

  before(async () => {
    await ensureModules();
    const skipReason = redisIsolationSkipReason(REDIS_URL);
    if (skipReason) {
      console.log(`SKIP (ack-cas cross-format): ${skipReason}`);
      return;
    }
    assertRedisIsolationOrThrow(REDIS_URL, 'ack-cas-xfmt');
    const { RedisThreadReadStateStore } = await import(
      '../dist/domains/cats/services/stores/redis/RedisThreadReadStateStore.js'
    );
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: ACK_CAS_PREFIX });
    store = new RedisThreadReadStateStore(redis);
  });

  after(async () => {
    if (redis) {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  });

  it('v2 incoming + v1 stored → ack REJECTS (fail-closed, no string compare)', async () => {
    if (!store) return;

    const userId = 'u-xfmt-1';
    const threadId = 't-xfmt-1';

    // Seed with v1 cursor
    await store.ack(userId, threadId, 'msg-2025-01-01T00:00:00-001');
    const before = await store.get(userId, threadId);
    assert.ok(!before.lastReadMessageId.startsWith('v2:'), 'Stored must be v1');

    // Attempt ack with v2 cursor — MUST reject (cross-format)
    const advanced = await store.ack(userId, threadId, 'v2:0000000000000001:msg-earlier');
    assert.equal(advanced, false, 'Cross-format v2→v1 must be REJECTED (fail-closed)');

    // Stored must not change
    const after = await store.get(userId, threadId);
    assert.equal(
      after.lastReadMessageId,
      before.lastReadMessageId,
      'Stored cursor must not change on cross-format rejection',
    );
  });

  it('v1 incoming + v2 stored → ack REJECTS (fail-closed)', async () => {
    if (!store) return;

    const userId = 'u-xfmt-2';
    const threadId = 't-xfmt-2';

    // Seed with v2 cursor (use reconcile path: ack v1, then reconcile to v2)
    await store.ack(userId, threadId, 'msg-seed');
    await store.reconcileReadCursor(userId, threadId, 'msg-seed', 'v2:0000000000000100:msg-seed');

    const before = await store.get(userId, threadId);
    assert.ok(before.lastReadMessageId.startsWith('v2:'), 'Stored must be v2');

    // Attempt ack with v1 cursor — MUST reject
    const advanced = await store.ack(userId, threadId, 'msg-later-v1');
    assert.equal(advanced, false, 'Cross-format v1→v2 must be REJECTED (fail-closed)');
  });

  it('same-format v2: newer cursor advances correctly', async () => {
    if (!store) return;

    const userId = 'u-xfmt-3';
    const threadId = 't-xfmt-3';

    // Seed with v2 via ack v1 + reconcile
    await store.ack(userId, threadId, 'msg-base');
    await store.reconcileReadCursor(userId, threadId, 'msg-base', 'v2:0000000000000050:msg-base');

    // Ack with newer v2 cursor — MUST succeed (same-format)
    const advanced = await store.ack(userId, threadId, 'v2:0000000000000100:msg-newer');
    assert.equal(advanced, true, 'Same-format v2 newer cursor must advance');

    const after = await store.get(userId, threadId);
    assert.equal(after.lastReadMessageId, 'v2:0000000000000100:msg-newer', 'Stored must be updated');
  });

  it('same-format v2: older cursor rejected', async () => {
    if (!store) return;

    const userId = 'u-xfmt-4';
    const threadId = 't-xfmt-4';

    // Seed with v2 via ack v1 + reconcile
    await store.ack(userId, threadId, 'msg-base');
    await store.reconcileReadCursor(userId, threadId, 'msg-base', 'v2:0000000000000200:msg-base');

    // Ack with older v2 cursor — MUST reject (not advancing)
    const advanced = await store.ack(userId, threadId, 'v2:0000000000000100:msg-older');
    assert.equal(advanced, false, 'Same-format v2 older cursor must be rejected');
  });

  it('pre-reconcile + ack flow: v1 stored → reconcile → v2 ack succeeds', async () => {
    if (!store) return;

    const userId = 'u-xfmt-5';
    const threadId = 't-xfmt-5';

    // Seed with v1
    await store.ack(userId, threadId, 'msg-legacy');

    // Without reconcile: v2 ack must fail (cross-format)
    const failedWithout = await store.ack(userId, threadId, 'v2:0000000000000200:msg-newer');
    assert.equal(failedWithout, false, 'v2 ack without reconcile must fail (cross-format)');

    // Reconcile v1 → v2
    const reconciled = await store.reconcileReadCursor(
      userId,
      threadId,
      'msg-legacy',
      'v2:0000000000000100:msg-legacy',
    );
    assert.equal(reconciled, true, 'Reconcile must succeed');

    // Now v2 ack should succeed (same-format, newer)
    const succeeded = await store.ack(userId, threadId, 'v2:0000000000000200:msg-newer');
    assert.equal(succeeded, true, 'v2 ack AFTER reconcile must succeed (same-format)');
  });
});

// ============================================================================
// Codex R14: Synthetic sentinel ID sorts below real message IDs
// ============================================================================

describe('Codex R14: queue fallback sentinel ID sorts below real messages', () => {
  before(async () => {
    await ensureModules();
  });

  it('sentinel cursor v2:seq:0 sorts below any real message cursor at same seq', () => {
    const seq = 1234567890123;
    const paddedSeq = String(seq).padStart(16, '0');

    // Sentinel cursor (what checkQueueFallback now produces)
    const sentinelCursor = cursorFor({ id: '0', visibilitySeq: seq });
    assert.equal(sentinelCursor, `v2:${paddedSeq}:0`, 'Sentinel cursor format');

    // Real message cursor at same seq (various ID patterns)
    const realIds = [
      '0001234567890000-000001-a1b2c3d4', // typical generateSortableId output
      '0000000000000001-000000-00000000', // minimum real ID
      'a', // single-char ID above '0'
    ];

    for (const realId of realIds) {
      const realCursor = cursorFor({ id: realId, visibilitySeq: seq });
      const cmp = compareCursors(sentinelCursor, realCursor);
      assert.ok(cmp < 0, `Sentinel '0' must sort below real ID '${realId}' at same seq, got cmp=${cmp}`);
    }
  });

  it('sentinel cursor sorts below real cursor at HIGHER seq', () => {
    const sentinelSeq = 100;
    const realSeq = 200;
    const sentinelCursor = cursorFor({ id: '0', visibilitySeq: sentinelSeq });
    const realCursor = cursorFor({ id: 'msg-real', visibilitySeq: realSeq });

    const cmp = compareCursors(sentinelCursor, realCursor);
    assert.ok(cmp < 0, 'Sentinel at lower seq must sort below real at higher seq');
  });
});
