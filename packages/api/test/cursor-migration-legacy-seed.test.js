/**
 * #1224/#3444 visibility-cursor migration regression family — RED matrix
 * for REAL legacy migration seeds (audit: thread_msk4hm5oat1ldrbh, 2026-08-08).
 *
 * Root 1 — legacy seed freeze (delivery / mention / seen slots):
 *   Lazy visibility backfill writes the visibility ZSET but does NOT backfill
 *   message-hash `visibilitySeq`. With VISIBILITY_CURSOR_V2 OFF,
 *   gateForDurableSlot degrades acks to v1 raw IDs and skips pre-reconcile,
 *   so SET_IF_GREATER_LUA resolves (stored=unresolvable, incoming=resolvable)
 *   → fail-closed reject → durable cursor frozen forever. User symptom:
 *   Context Briefing replays old batches every warm continuation.
 *
 * Root 2 — read-state raw-lex inversion (ACK_CAS_LUA):
 *   Same-format v1 cursors are compared with raw string `<=`, but a valid
 *   visibility inversion (created-early message becomes visible later) makes
 *   raw-ID order ≠ visibility order → legitimate forward ack rejected.
 *   User symptom: unread badge resurrection / caughtUp never truthful.
 *
 * These tests seed the REAL migration state — visibility ZSET entry present,
 * hash seq ABSENT — unlike cursor-activation-gate.test.js whose fixture
 * pre-fills every hash and keeps raw-ID order aligned with seq order
 * (which is why the lifecycle suite stayed green across both roots).
 *
 * GREEN contract (Group A fix):
 *   CAS resolves v1 via message hash first, then the visibility ZSET
 *   (ZSCORE fallback — the ZSET is canonical visibility truth) inside the
 *   same atomic Lua region, for all four durable slots; read-state ack
 *   compares in the visibility (seq, id) pair domain.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const { cursorFor } = await import('../dist/domains/cats/services/stores/cursor.js');

let createRedisClient;
let SessionStoreClass;
let DeliveryCursorStoreClass;
let RedisThreadReadStateStoreClass;

async function ensureModules() {
  if (createRedisClient) return;
  const redisUtils = await import('@cat-cafe/shared/utils');
  createRedisClient = redisUtils.createRedisClient;
  SessionStoreClass = redisUtils.SessionStore;
  const dcs = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');
  DeliveryCursorStoreClass = dcs.DeliveryCursorStore;
  const rrs = await import('../dist/domains/cats/services/stores/redis/RedisThreadReadStateStore.js');
  RedisThreadReadStateStoreClass = rrs.RedisThreadReadStateStore;
}

/** Save and restore VISIBILITY_CURSOR_V2 between tests */
function withActivation(value) {
  const saved = process.env.VISIBILITY_CURSOR_V2;
  if (value === undefined) delete process.env.VISIBILITY_CURSOR_V2;
  else process.env.VISIBILITY_CURSOR_V2 = value;
  return () => {
    if (saved === undefined) delete process.env.VISIBILITY_CURSOR_V2;
    else process.env.VISIBILITY_CURSOR_V2 = saved;
  };
}

const REDIS_URL = process.env.REDIS_URL;

// ── Migration-seed fixtures ──────────────────────────────────────────
// LEGACY: pre-migration message. Lazy backfill gave it a visibility ZSET
// position but its hash has NO visibilitySeq field (the real production
// shape #3444 leaves behind).
// FRESH: post-migration message appended normally (hash + ZSET both set).
const THREAD = 'thread-migration-seed';
const M_LEGACY = { id: '0000000000100000-000001-legacy01', visibilitySeq: 1000 };
const M_FRESH = { id: '0000000000300000-000003-fresh003', visibilitySeq: 3000 };

// Visibility inversion pair: C created later (higher raw ID) but visible
// FIRST (lower seq); Q created earlier (lower raw ID) but visible LATER
// (higher seq). Raw-ID order ≠ visibility order — the #1200 core disease.
const C_INV = { id: '0000000000000200-000001-ccinvert', visibilitySeq: 1000 };
const Q_INV = { id: '0000000000000100-000001-qqinvert', visibilitySeq: 2000 };

// Legacy + inversion combo for read-state: stored cursor points at a
// legacy message (no hash seq) whose raw ID is HIGHER than the fresh
// later-visible message.
const CL_LEGACY = { id: '0000000000000400-000001-cclegacy', visibilitySeq: 1500 };
const QN_FRESH = { id: '0000000000000300-000001-qqfresh1', visibilitySeq: 2500 };

/**
 * Seed a message into the store shape under test.
 * hashSeq=false reproduces the lazy-backfill legacy shape:
 * ZSET position exists, hash field absent.
 */
async function seedMessage(redis, threadId, msg, { hashSeq = true } = {}) {
  // A legacy-live message still has a detail hash; only the visibilitySeq
  // field is absent after lazy migration. Keep that distinction explicit so
  // this fixture cannot accidentally drift into the fully-pruned shape.
  await redis.hset(`msg:${msg.id}`, 'id', msg.id, 'threadId', threadId);
  if (hashSeq) {
    await redis.hset(`msg:${msg.id}`, 'visibilitySeq', String(msg.visibilitySeq));
  }
  await redis.zadd(`msg:visibility:${threadId}`, msg.visibilitySeq, msg.id);
}

describe('#3444 migration legacy-seed matrix (requires Redis)', () => {
  let redis;
  let redisAvailable = false;
  const prefix = `test-migration-seed-${Date.now()}:`;
  const userId = 'test-user';
  const catId = 'opus';

  before(async () => {
    if (redisIsolationSkipReason(REDIS_URL)) return;
    try {
      assertRedisIsolationOrThrow(REDIS_URL, 'cursor-migration-legacy-seed');
    } catch {
      return;
    }
    await ensureModules();
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: prefix });
    await redis.ping();
    redisAvailable = true;

    // Real migration shape: legacy messages have ZSET-only positions.
    await seedMessage(redis, THREAD, M_LEGACY, { hashSeq: false });
    await seedMessage(redis, THREAD, M_FRESH, { hashSeq: true });
    await seedMessage(redis, THREAD, C_INV, { hashSeq: true });
    await seedMessage(redis, THREAD, Q_INV, { hashSeq: true });
    await seedMessage(redis, THREAD, CL_LEGACY, { hashSeq: false });
    await seedMessage(redis, THREAD, QN_FRESH, { hashSeq: true });
  });

  after(async () => {
    if (redis) {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  });

  // ────────────────────────────────────────────────────────────────
  // §1 Root 1 — SessionStore SET_IF_GREATER_LUA, three durable slots.
  // Stored v1 points at a legacy (ZSET-only) message; a later fresh
  // message must still advance the cursor.
  // ────────────────────────────────────────────────────────────────

  const SLOTS = [
    {
      name: 'delivery',
      set: (s, threadId, id) => s.setDeliveryCursor(userId, catId, threadId, id),
      get: (s, threadId) => s.getDeliveryCursor(userId, catId, threadId),
    },
    {
      name: 'mention',
      set: (s, threadId, id) => s.setMentionAckCursor(userId, catId, threadId, id),
      get: (s, threadId) => s.getMentionAckCursor(userId, catId, threadId),
    },
    {
      name: 'seen',
      set: (s, threadId, id) => s.setSeenCursor(userId, catId, threadId, id),
      get: (s, threadId) => s.getSeenCursor(userId, catId, threadId),
    },
  ];

  for (const slot of SLOTS) {
    it(`§1 ${slot.name}: legacy ZSET-only stored cursor must not freeze the slot`, async (t) => {
      if (!redisAvailable) {
        t.skip('Redis not available');
        return;
      }
      const threadId = `${THREAD}-${slot.name}`;
      // Slot-scoped thread so each slot test is independent; seed the
      // same legacy/fresh pair into this thread's visibility ZSET.
      await seedMessage(redis, threadId, M_LEGACY, { hashSeq: false });
      await seedMessage(redis, threadId, M_FRESH, { hashSeq: true });

      const sessionStore = new SessionStoreClass(redis);

      // Seed the durable slot with the legacy v1 cursor (empty slot: CAS accepts).
      const seeded = await slot.set(sessionStore, threadId, M_LEGACY.id);
      assert.equal(seeded, true, `${slot.name}: empty slot must accept the legacy seed`);

      // EXPECTED (GREEN contract): the fresh, later-visible message advances
      // the cursor — the Lua CAS must resolve the stored legacy v1 via the
      // visibility ZSET (canonical truth) when the hash field is absent.
      // CURRENT (bug): resolveSeq(stored) = nil → fail-closed reject → frozen.
      const advanced = await slot.set(sessionStore, threadId, M_FRESH.id);
      assert.equal(advanced, true, `${slot.name}: fresh message must advance past legacy cursor`);

      const stored = await slot.get(sessionStore, threadId);
      assert.ok(
        stored != null && stored.includes(M_FRESH.id),
        `${slot.name}: stored cursor must reach the fresh message, got: ${stored}`,
      );
    });
  }

  // ────────────────────────────────────────────────────────────────
  // §2 Root 1 end-to-end — DeliveryCursorStore.ackCursor with the
  // activation gate OFF (the production dormant mode of #3444).
  // ────────────────────────────────────────────────────────────────

  it('§2 delivery e2e: gate OFF ack must advance past a legacy stored cursor', async (t) => {
    if (!redisAvailable) {
      t.skip('Redis not available');
      return;
    }
    const restore = withActivation(undefined); // OFF (dormant, production state)
    t.after(restore);

    const threadId = `${THREAD}-e2e`;
    await seedMessage(redis, threadId, M_LEGACY, { hashSeq: false });
    await seedMessage(redis, threadId, M_FRESH, { hashSeq: true });

    const sessionStore = new SessionStoreClass(redis);
    const store = new DeliveryCursorStoreClass(sessionStore);

    // Legacy v1 cursor left behind by the pre-migration era.
    await store.ackCursor(userId, catId, threadId, M_LEGACY.id);

    // A fresh message is delivered and acked through the real path:
    // canonical v2 in, gate OFF degrades the durable write to v1.
    await store.ackCursor(userId, catId, threadId, cursorFor(M_FRESH));

    // EXPECTED (GREEN): cursor advanced — next incremental context starts
    // after M_FRESH, no replay. CURRENT (bug): CAS rejected silently, the
    // cursor stays at M_LEGACY and every warm continuation replays history.
    const stored = await store.getCursor(userId, catId, threadId);
    assert.ok(
      stored != null && stored.includes(M_FRESH.id),
      `delivery e2e: cursor must advance past legacy seed, got: ${stored}`,
    );
  });

  // ────────────────────────────────────────────────────────────────
  // §3 Root 2 — RedisThreadReadStateStore.ack (ACK_CAS_LUA).
  // Read-state must advance in the visibility domain, not raw-ID lex.
  // ────────────────────────────────────────────────────────────────

  it('§3a read-state: visibility inversion — later-visible ack must advance', async (t) => {
    if (!redisAvailable) {
      t.skip('Redis not available');
      return;
    }
    const threadId = `${THREAD}-readstate-inv`;
    await seedMessage(redis, threadId, C_INV, { hashSeq: true });
    await seedMessage(redis, threadId, Q_INV, { hashSeq: true });

    const store = new RedisThreadReadStateStoreClass(redis);

    // User reads up to C (visible first, created later — higher raw ID).
    const ackC = await store.ack(userId, threadId, C_INV.id);
    assert.equal(ackC, true, 'first ack on empty state must succeed');

    // User then reads Q (visible LATER — the true forward direction).
    // EXPECTED (GREEN): ack succeeds; read-state reaches Q.
    // CURRENT (bug): raw lex Q.id <= C.id → rejected → unread badge
    // resurrects for a message the user has already read.
    const ackQ = await store.ack(userId, threadId, Q_INV.id);
    assert.equal(ackQ, true, 'later-visible message must advance read-state');

    const state = await store.get(userId, threadId);
    assert.equal(state?.lastReadMessageId, Q_INV.id, 'read-state must rest at the later-visible message');
  });

  it('§3b read-state: legacy stored cursor + inversion — ZSET-only resolve must work', async (t) => {
    if (!redisAvailable) {
      t.skip('Redis not available');
      return;
    }
    const threadId = `${THREAD}-readstate-legacy`;
    await seedMessage(redis, threadId, CL_LEGACY, { hashSeq: false });
    await seedMessage(redis, threadId, QN_FRESH, { hashSeq: true });

    const store = new RedisThreadReadStateStoreClass(redis);

    // Stored cursor points at a legacy message (no hash seq, ZSET only).
    const ackLegacy = await store.ack(userId, threadId, CL_LEGACY.id);
    assert.equal(ackLegacy, true, 'first ack on empty state must succeed');

    // EXPECTED (GREEN): resolving the stored legacy cursor falls back to the
    // visibility ZSET; QN (seq 2500 > 1500) advances despite lower raw ID.
    // CURRENT (bug): same-format raw lex rejects the legitimate forward ack.
    const ackFresh = await store.ack(userId, threadId, QN_FRESH.id);
    assert.equal(ackFresh, true, 'later-visible fresh message must advance past legacy read cursor');

    const state = await store.get(userId, threadId);
    assert.equal(state?.lastReadMessageId, QN_FRESH.id, 'read-state must rest at the fresh message');
  });
});
