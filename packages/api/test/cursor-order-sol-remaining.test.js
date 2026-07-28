/**
 * Cursor Order — Tests for Sol R1-R3 findings
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
 * Architecture ref: docs/architecture/1200-cursor-order-analysis.md §8.8
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
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

  it('stored v1 earlier + incoming v2 with later ID → MUST advance (ID lex fallback)', async (t) => {
    if (skipWithoutRedis(t)) return;
    const r = await getRedis();
    await ensureModules();

    const { SessionStore } = await import('@cat-cafe/shared/utils');
    const store = new SessionStore(r);

    // When stored v1 message hash is pruned, Lua falls back to ID lex comparison.
    // stored raw ID 'msgA' < incoming embedded ID 'msgB' → accept (advance).
    const userId = 'u-cas3',
      catId = 'c-cas3',
      threadId = 't-cas3-' + Date.now();
    await r.set(`delivery-cursor:${userId}:${catId}:${threadId}`, 'msgA');

    const advanced = await store.setDeliveryCursor(userId, catId, threadId, 'v2:0000000000999999:msgB');
    assert.equal(advanced, true, 'v1→v2 with later ID: ID lex fallback must advance');

    // Verify stored value was updated to v2
    const stored = await store.getDeliveryCursor(userId, catId, threadId);
    assert.equal(stored, 'v2:0000000000999999:msgB', 'Stored must be updated to v2 cursor');

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

  it('Memory: queued append returns message WITHOUT visibilitySeq', async () => {
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

    assert.equal(msg.visibilitySeq, undefined, 'Queued append must NOT have visibilitySeq');
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

      // Step 2: Queued append (the message to be delivered)
      const msg = await store.append({
        userId: 'u1',
        catId: 'opus',
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
