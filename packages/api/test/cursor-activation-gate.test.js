/**
 * Cursor v2 activation gate — unit + integration tests (#1269 contract)
 *
 * Contract (maintainer review 2026-08-04):
 *   - cursorFor() always produces canonical v2 when visibilitySeq is known
 *     (NOT gated — CAS comparison/advancement must be v2-coherent)
 *   - gateForDurableSlot() controls whether untouched durable slots initiate v2
 *   - Existing v2 slots remain advanceable regardless of activation mode
 *
 * §1: Unit tests — gateForDurableSlot() pure function (no Redis)
 * §2: Integration tests — one-build persistent OFF→ON→OFF through real
 *      delivery, mention, seen, and read-state stores (requires Redis)
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const { cursorFor, compareCursors } = await import('../dist/domains/cats/services/stores/cursor.js');
const { gateForDurableSlot } = await import('../dist/domains/cats/services/stores/cursor-activation.js');

const msg = { id: '0000000000100000-000001-abcdef01', visibilitySeq: 100000 };
const msgNoSeq = { id: '0000000000200000-000002-abcdef02' };

/** Save and restore env between tests */
function withActivation(value) {
  const saved = process.env.VISIBILITY_CURSOR_V2;
  if (value === undefined) delete process.env.VISIBILITY_CURSOR_V2;
  else process.env.VISIBILITY_CURSOR_V2 = value;
  return () => {
    if (saved === undefined) delete process.env.VISIBILITY_CURSOR_V2;
    else process.env.VISIBILITY_CURSOR_V2 = saved;
  };
}

// ──────────────────────────────────────────────────────────────────
// §1  Unit tests — gateForDurableSlot pure function
// ──────────────────────────────────────────────────────────────────

describe('§1 gateForDurableSlot unit tests (#1269)', () => {
  // cursorFor: always canonical v2

  it('cursorFor produces v2 regardless of gate state', (t) => {
    const restore = withActivation(undefined);
    t.after(restore);
    assert.ok(cursorFor(msg).startsWith('v2:'));

    process.env.VISIBILITY_CURSOR_V2 = 'off';
    assert.ok(cursorFor(msg).startsWith('v2:'));

    process.env.VISIBILITY_CURSOR_V2 = 'on';
    assert.ok(cursorFor(msg).startsWith('v2:'));
  });

  it('cursorFor returns raw ID when visibilitySeq absent', () => {
    assert.equal(cursorFor(msgNoSeq), msgNoSeq.id);
  });

  // gateForDurableSlot: 2-param API

  it('gate OFF + untouched slot → v1 (raw ID extracted from v2)', (t) => {
    const restore = withActivation(undefined);
    t.after(restore);
    const canonical = cursorFor(msg);
    const durable = gateForDurableSlot(canonical, null);
    assert.equal(durable, msg.id, 'untouched slot with gate off must get v1');
    assert.ok(!durable.startsWith('v2:'));
  });

  it('gate OFF + existing v1 slot → v1', (t) => {
    const restore = withActivation('off');
    t.after(restore);
    const canonical = cursorFor(msg);
    const durable = gateForDurableSlot(canonical, 'some-old-v1-cursor');
    assert.equal(durable, msg.id, 'v1 slot with gate off must stay v1');
  });

  it('gate ON + untouched slot → v2 (initiate)', (t) => {
    const restore = withActivation('on');
    t.after(restore);
    const canonical = cursorFor(msg);
    const durable = gateForDurableSlot(canonical, null);
    assert.equal(durable, canonical, 'gate on must initiate v2 in untouched slot');
  });

  it('gate ON + existing v1 slot → v2 (upgrade)', (t) => {
    const restore = withActivation('on');
    t.after(restore);
    const canonical = cursorFor(msg);
    const durable = gateForDurableSlot(canonical, 'some-old-v1-cursor');
    assert.equal(durable, canonical, 'gate on must upgrade v1 slot to v2');
  });

  it('gate OFF + existing v2 slot → v2 (rollback-safe)', (t) => {
    const restore = withActivation(undefined);
    t.after(restore);
    const canonical = cursorFor(msg);
    const durable = gateForDurableSlot(canonical, 'v2:0000000000000001:old-msg');
    assert.equal(durable, canonical, 'existing v2 slot must advance in v2');
  });

  it('non-v2 canonical passes through unchanged', (t) => {
    const restore = withActivation(undefined);
    t.after(restore);
    const durable = gateForDurableSlot('raw-id-only', null);
    assert.equal(durable, 'raw-id-only', 'v1 canonical is not gated');
  });

  it('full lifecycle: off → on → off preserves v2', (t) => {
    // Phase 1: OFF — untouched → v1
    let restore = withActivation(undefined);
    const c1 = cursorFor(msg);
    const d1 = gateForDurableSlot(c1, null);
    assert.equal(d1, msg.id);
    restore();

    // Phase 2: ON — v1 slot → v2
    restore = withActivation('on');
    const msg2 = { id: 'msg-phase2', visibilitySeq: 200000 };
    const c2 = cursorFor(msg2);
    const d2 = gateForDurableSlot(c2, d1);
    assert.ok(d2.startsWith('v2:'));
    restore();

    // Phase 3: OFF (rollback) — existing v2 → v2
    restore = withActivation(undefined);
    t.after(restore);
    const msg3 = { id: 'msg-phase3', visibilitySeq: 300000 };
    const c3 = cursorFor(msg3);
    const d3 = gateForDurableSlot(c3, d2);
    assert.ok(d3.startsWith('v2:'), 'v2 must survive rollback');
    assert.ok(compareCursors(d3, d2) > 0, 'phase 3 > phase 2');
  });
});

// ──────────────────────────────────────────────────────────────────
// §2  Integration tests — real stores, one-build OFF→ON→OFF
// ──────────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL;

// Lazy-loaded modules for integration tests
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

/** Three test messages with increasing visibilitySeq */
const MSGS = [
  { id: 'gate-msg-001', visibilitySeq: 1000 },
  { id: 'gate-msg-002', visibilitySeq: 2000 },
  { id: 'gate-msg-003', visibilitySeq: 3000 },
];

describe('§2 Integration: durable-slot gate through real stores (#1269)', () => {
  let redis;
  let redisAvailable = false;
  const prefix = `test-gate-${Date.now()}:`;
  const userId = 'test-user';
  const catId = 'opus';
  const threadId = 'thread-gate-test';

  before(async () => {
    if (redisIsolationSkipReason(REDIS_URL)) return;
    try {
      assertRedisIsolationOrThrow(REDIS_URL, 'cursor-activation-gate');
    } catch {
      return;
    }
    await ensureModules();
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: prefix });
    await redis.ping();
    redisAvailable = true;

    // Seed message hashes so SET_IF_GREATER_LUA can resolve v1 IDs
    for (const m of MSGS) {
      await redis.hset(`msg:${m.id}`, 'visibilitySeq', String(m.visibilitySeq));
    }
  });

  after(async () => {
    if (redis) {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  });

  // ── Delivery cursor ──

  it('delivery: OFF→ON→OFF lifecycle', async (t) => {
    if (!redisAvailable) {
      t.skip('Redis not available');
      return;
    }
    const sessionStore = new SessionStoreClass(redis);
    const store = new DeliveryCursorStoreClass(sessionStore);
    const readKey = `delivery-cursor:${userId}:${catId}:${threadId}`;

    // Phase 1: OFF — untouched slot → stored as v1
    const restore1 = withActivation(undefined);
    await store.ackCursor(userId, catId, threadId, cursorFor(MSGS[0]));
    const stored1 = await redis.get(readKey);
    assert.equal(stored1, MSGS[0].id, 'OFF: untouched slot must store v1');
    assert.ok(!stored1.startsWith('v2:'), 'OFF: must not be v2');
    restore1();

    // Phase 2: ON — advance to later message → stored as v2
    const restore2 = withActivation('on');
    await store.ackCursor(userId, catId, threadId, cursorFor(MSGS[1]));
    const stored2 = await redis.get(readKey);
    assert.ok(stored2.startsWith('v2:'), 'ON: must store v2');
    assert.ok(stored2.includes(MSGS[1].id), 'ON: must contain msg-002 ID');
    restore2();

    // Phase 3: OFF (rollback) — advance again → v2 preserved (no downgrade)
    const restore3 = withActivation(undefined);
    t.after(restore3);
    await store.ackCursor(userId, catId, threadId, cursorFor(MSGS[2]));
    const stored3 = await redis.get(readKey);
    assert.ok(stored3.startsWith('v2:'), 'Rollback: existing v2 slot stays v2');
    assert.ok(stored3.includes(MSGS[2].id), 'Rollback: must advance to msg-003');

    // Phase 3b: OFF — different thread (untouched) → v1
    const freshThread = 'thread-gate-fresh';
    await store.ackCursor(userId, catId, freshThread, cursorFor(MSGS[0]));
    const storedFresh = await redis.get(`delivery-cursor:${userId}:${catId}:${freshThread}`);
    assert.equal(storedFresh, MSGS[0].id, 'OFF: new untouched slot must be v1');
  });

  // ── Mention cursor ──

  it('mention: OFF→ON→OFF lifecycle', async (t) => {
    if (!redisAvailable) {
      t.skip('Redis not available');
      return;
    }
    const sessionStore = new SessionStoreClass(redis);
    const store = new DeliveryCursorStoreClass(sessionStore);
    const readKey = `mention-ack:${userId}:${catId}:${threadId}`;

    // OFF — untouched → v1
    const r1 = withActivation(undefined);
    await store.ackMentionCursor(userId, catId, threadId, cursorFor(MSGS[0]));
    const s1 = await redis.get(readKey);
    assert.equal(s1, MSGS[0].id, 'OFF: mention slot must store v1');
    r1();

    // ON → v2
    const r2 = withActivation('on');
    await store.ackMentionCursor(userId, catId, threadId, cursorFor(MSGS[1]));
    const s2 = await redis.get(readKey);
    assert.ok(s2.startsWith('v2:'), 'ON: mention slot must store v2');
    r2();

    // OFF (rollback) → v2 preserved
    const r3 = withActivation(undefined);
    t.after(r3);
    await store.ackMentionCursor(userId, catId, threadId, cursorFor(MSGS[2]));
    const s3 = await redis.get(readKey);
    assert.ok(s3.startsWith('v2:'), 'Rollback: mention v2 preserved');
  });

  // ── Seen cursor ──

  it('seen: OFF→ON→OFF lifecycle', async (t) => {
    if (!redisAvailable) {
      t.skip('Redis not available');
      return;
    }
    const sessionStore = new SessionStoreClass(redis);
    const store = new DeliveryCursorStoreClass(sessionStore);
    const readKey = `seen-cursor:${userId}:${catId}:${threadId}`;

    // OFF — untouched → v1
    const r1 = withActivation(undefined);
    await store.ackSeenCursor(userId, catId, threadId, cursorFor(MSGS[0]));
    const s1 = await redis.get(readKey);
    assert.equal(s1, MSGS[0].id, 'OFF: seen slot must store v1');
    r1();

    // ON → v2
    const r2 = withActivation('on');
    await store.ackSeenCursor(userId, catId, threadId, cursorFor(MSGS[1]));
    const s2 = await redis.get(readKey);
    assert.ok(s2.startsWith('v2:'), 'ON: seen slot must store v2');
    r2();

    // OFF (rollback) → v2 preserved
    const r3 = withActivation(undefined);
    t.after(r3);
    await store.ackSeenCursor(userId, catId, threadId, cursorFor(MSGS[2]));
    const s3 = await redis.get(readKey);
    assert.ok(s3.startsWith('v2:'), 'Rollback: seen v2 preserved');
  });

  // ── Read-state cursor ──

  it('read-state: OFF→ON→OFF lifecycle', async (t) => {
    if (!redisAvailable) {
      t.skip('Redis not available');
      return;
    }
    const readStateStore = new RedisThreadReadStateStoreClass(redis);

    // Phase 1: OFF — untouched → v1
    // gateForDurableSlot applied before ack (mirrors threads.ts gatedReadStateAck)
    const r1 = withActivation(undefined);
    const c1 = cursorFor(MSGS[0]);
    const existing1 = await readStateStore.get(userId, threadId);
    const gated1 = gateForDurableSlot(c1, existing1?.lastReadMessageId ?? null);
    assert.equal(gated1, MSGS[0].id, 'OFF: gate must produce v1');
    await readStateStore.ack(userId, threadId, gated1);
    const s1 = await readStateStore.get(userId, threadId);
    assert.equal(s1.lastReadMessageId, MSGS[0].id, 'OFF: read-state must store v1');
    r1();

    // Phase 2: ON — advance → v2
    // With gate ON, we need to reconcile stored v1 → v2 before CAS
    const r2 = withActivation('on');
    const c2 = cursorFor(MSGS[1]);
    const existing2 = await readStateStore.get(userId, threadId);
    const gated2 = gateForDurableSlot(c2, existing2?.lastReadMessageId ?? null);
    assert.ok(gated2.startsWith('v2:'), 'ON: gate must produce v2');
    // Reconcile stored v1 → v2 (mirrors preReconcileReadCursor)
    if (existing2 && !existing2.lastReadMessageId.startsWith('v2:')) {
      const storedV2 = cursorFor(MSGS[0]); // canonical v2 of stored msg
      await readStateStore.reconcileReadCursor(userId, threadId, existing2.lastReadMessageId, storedV2);
    }
    await readStateStore.ack(userId, threadId, gated2);
    const s2 = await readStateStore.get(userId, threadId);
    assert.ok(s2.lastReadMessageId.startsWith('v2:'), 'ON: read-state must store v2');
    r2();

    // Phase 3: OFF (rollback) — existing v2 → v2 preserved
    const r3 = withActivation(undefined);
    t.after(r3);
    const c3 = cursorFor(MSGS[2]);
    const existing3 = await readStateStore.get(userId, threadId);
    const gated3 = gateForDurableSlot(c3, existing3?.lastReadMessageId ?? null);
    assert.ok(gated3.startsWith('v2:'), 'Rollback: existing v2 must keep gate open');
    await readStateStore.ack(userId, threadId, gated3);
    const s3 = await readStateStore.get(userId, threadId);
    assert.ok(s3.lastReadMessageId.startsWith('v2:'), 'Rollback: read-state v2 preserved');

    // Phase 3b: OFF — different thread (untouched) → v1
    const freshThread = 'thread-read-fresh';
    const cFresh = cursorFor(MSGS[0]);
    const gatedFresh = gateForDurableSlot(cFresh, null);
    assert.equal(gatedFresh, MSGS[0].id, 'OFF: new thread gate produces v1');
    await readStateStore.ack(userId, freshThread, gatedFresh);
    const sFresh = await readStateStore.get(userId, freshThread);
    assert.equal(sFresh.lastReadMessageId, MSGS[0].id, 'OFF: new read-state slot is v1');
  });

  // ── Monotonicity: v2 never downgrades ──

  it('v2 slot rejects v1 downgrade attempt', async (t) => {
    if (!redisAvailable) {
      t.skip('Redis not available');
      return;
    }
    const sessionStore = new SessionStoreClass(redis);
    const store = new DeliveryCursorStoreClass(sessionStore);
    const thread = 'thread-no-downgrade';
    const readKey = `delivery-cursor:${userId}:${catId}:${thread}`;

    // Seed v2 directly
    const r1 = withActivation('on');
    await store.ackCursor(userId, catId, thread, cursorFor(MSGS[1]));
    const seeded = await redis.get(readKey);
    assert.ok(seeded.startsWith('v2:'), 'Seeded v2');
    r1();

    // Attempt v1 ack (lower message) with gate OFF
    const r2 = withActivation(undefined);
    t.after(r2);
    await store.ackCursor(userId, catId, thread, cursorFor(MSGS[0]));
    const afterAttempt = await redis.get(readKey);
    assert.ok(afterAttempt.startsWith('v2:'), 'v2 must not be downgraded');
    assert.ok(afterAttempt.includes(MSGS[1].id), 'Position must not regress');
  });
});
