/**
 * #1200 R14: Read-state cross-format regression — route-level tests.
 *
 * Exercises preReconcileReadCursor() through the actual HTTP routes
 * (PATCH /read, POST /read/latest, POST /read/mark-all) using a
 * cross-format-aware readStateStore stub that mirrors the Redis
 * ACK_CAS_LUA fail-closed behavior.
 *
 * These tests prove:
 * 1. Pre-reconcile is wired to ALL 3 ingress points (not just PATCH)
 * 2. Cross-format ack is correctly rejected without reconcile
 * 3. After reconcile, same-format ack advances correctly
 * 4. Unresolvable legacy cursors fail-closed (no regression)
 * 5. Sentinel notice cursor resolves via real delivery
 *
 * Complements cursor-order-sol-remaining.test.js Redis CAS primitive tests.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

/**
 * Cross-format-aware in-memory read state store.
 * Mirrors RedisThreadReadStateStore's ACK_CAS_LUA fail-closed behavior:
 * cross-format (v1 vs v2) ack is rejected; same-format uses lex comparison.
 */
function createCrossFormatAwareStore() {
  const cursors = new Map();
  return {
    ack(userId, threadId, messageId) {
      const key = `${userId}:${threadId}`;
      const current = cursors.get(key);
      if (current) {
        const curV2 = current.startsWith('v2:');
        const newV2 = messageId.startsWith('v2:');
        if (curV2 !== newV2) return false;
        if (messageId <= current) return false;
      }
      cursors.set(key, messageId);
      return true;
    },
    get(userId, threadId) {
      const key = `${userId}:${threadId}`;
      const id = cursors.get(key);
      return id ? { userId, threadId, lastReadMessageId: id, updatedAt: Date.now() } : null;
    },
    reconcileReadCursor(userId, threadId, oldV1, newV2) {
      const key = `${userId}:${threadId}`;
      if (cursors.get(key) === oldV1) {
        cursors.set(key, newV2);
        return true;
      }
      return false;
    },
    getUnreadSummaries: async () => [],
    deleteByThread: async () => {},
    /** Test helper: seed a raw cursor value */
    _seed(userId, threadId, cursor) {
      cursors.set(`${userId}:${threadId}`, cursor);
    },
    /** Test helper: read raw cursor value */
    _raw(userId, threadId) {
      return cursors.get(`${userId}:${threadId}`);
    },
  };
}

// ============================================================================
// POST /api/threads/:id/read/latest — cross-format regression
// ============================================================================

describe('#1200 R14 route: POST /read/latest cross-format', () => {
  let app;
  let threadStore;
  let messageStore;
  let readStateStore;

  beforeEach(async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { threadsRoutes } = await import('../dist/routes/threads.js');

    threadStore = new ThreadStore();
    messageStore = new MessageStore();
    readStateStore = createCrossFormatAwareStore();

    app = Fastify();
    await app.register(threadsRoutes, { threadStore, messageStore, readStateStore });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('pre-reconcile upgrades v1 → v2, then advances to later v2 cursor', async () => {
    const thread = threadStore.create('alice', 'Thread A');

    const msgA = messageStore.append({
      userId: 'alice',
      catId: 'opus',
      content: 'early message',
      mentions: [],
      timestamp: Date.now() - 2000,
      threadId: thread.id,
    });
    const msgC = messageStore.append({
      userId: 'alice',
      catId: 'opus',
      content: 'latest message',
      mentions: [],
      timestamp: Date.now(),
      threadId: thread.id,
    });

    // Seed stored cursor at msgA's raw ID (v1)
    readStateStore._seed('alice', thread.id, msgA.id);

    // Verify seed is v1
    const before = readStateStore._raw('alice', thread.id);
    assert.ok(!before.startsWith('v2:'), 'Seed must be v1 (raw ID)');

    // Call read/latest — must pre-reconcile v1→v2, then advance to latest
    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/read/latest`,
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.advanced, true, 'Must advance (pre-reconcile enables same-format CAS)');

    // Stored cursor must now be v2
    const after = readStateStore._raw('alice', thread.id);
    assert.ok(after.startsWith('v2:'), 'Stored must be v2 after reconcile+ack');
  });

  it('stored v1 B, B tombstoned, latest=A (earlier) → no regression', async () => {
    const thread = threadStore.create('alice', 'Thread B');

    const msgA = messageStore.append({
      userId: 'alice',
      catId: 'opus',
      content: 'message A (earlier, live)',
      mentions: [],
      timestamp: Date.now() - 2000,
      threadId: thread.id,
    });
    const msgB = messageStore.append({
      userId: 'alice',
      catId: 'opus',
      content: 'message B (later, will be tombstoned)',
      mentions: [],
      timestamp: Date.now(),
      threadId: thread.id,
    });

    // Seed stored cursor at B's raw ID (v1)
    readStateStore._seed('alice', thread.id, msgB.id);

    // Tombstone B — latest visible becomes A (earlier)
    messageStore.softDelete(msgB.id, 'admin');

    // Call read/latest — must NOT regress from B to A
    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/read/latest`,
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.advanced, false, 'Must NOT regress from later B to earlier A');

    // Stored cursor must remain at B's reconciled v2 (not A)
    const stored = readStateStore._raw('alice', thread.id);
    assert.ok(!stored.includes(msgA.id), 'Stored must NOT be A');
  });
});

// ============================================================================
// POST /api/threads/read/mark-all — cross-format regression
// ============================================================================

describe('#1200 R14 route: POST /read/mark-all cross-format', () => {
  let app;
  let threadStore;
  let messageStore;
  let readStateStore;

  beforeEach(async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { threadsRoutes } = await import('../dist/routes/threads.js');

    threadStore = new ThreadStore();
    messageStore = new MessageStore();
    readStateStore = createCrossFormatAwareStore();

    app = Fastify();
    await app.register(threadsRoutes, { threadStore, messageStore, readStateStore });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('pre-reconcile upgrades v1 → v2 across all threads, then advances', async () => {
    const thread = threadStore.create('alice', 'Thread X');

    const msgA = messageStore.append({
      userId: 'alice',
      catId: 'opus',
      content: 'early msg',
      mentions: [],
      timestamp: Date.now() - 2000,
      threadId: thread.id,
    });
    messageStore.append({
      userId: 'alice',
      catId: 'opus',
      content: 'latest msg',
      mentions: [],
      timestamp: Date.now(),
      threadId: thread.id,
    });

    // Seed stored cursor at A's raw ID (v1)
    readStateStore._seed('alice', thread.id, msgA.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/read/mark-all',
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.advancedCount, 1, 'Must advance 1 thread (pre-reconcile enables CAS)');

    // Stored must now be v2
    const stored = readStateStore._raw('alice', thread.id);
    assert.ok(stored.startsWith('v2:'), 'Stored must be v2 after mark-all reconcile+ack');
  });

  it('stored v1 B, B tombstoned, latest=A (earlier) → no regression', async () => {
    const thread = threadStore.create('alice', 'Thread Y');

    messageStore.append({
      userId: 'alice',
      catId: 'opus',
      content: 'message A (earlier)',
      mentions: [],
      timestamp: Date.now() - 2000,
      threadId: thread.id,
    });
    const msgB = messageStore.append({
      userId: 'alice',
      catId: 'opus',
      content: 'message B (later, tombstoned)',
      mentions: [],
      timestamp: Date.now(),
      threadId: thread.id,
    });

    readStateStore._seed('alice', thread.id, msgB.id);
    messageStore.softDelete(msgB.id, 'admin');

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/read/mark-all',
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.advancedCount, 0, 'Must NOT regress from later B to earlier A');
  });
});

// ============================================================================
// PATCH /api/threads/:id/read — cross-format regression
// ============================================================================

describe('#1200 R14 route: PATCH /read cross-format', () => {
  let app;
  let threadStore;
  let messageStore;
  let readStateStore;

  beforeEach(async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { threadsRoutes } = await import('../dist/routes/threads.js');

    threadStore = new ThreadStore();
    messageStore = new MessageStore();
    readStateStore = createCrossFormatAwareStore();

    app = Fastify();
    await app.register(threadsRoutes, { threadStore, messageStore, readStateStore });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('pre-reconcile upgrades v1 → v2, then advances to incoming v2', async () => {
    const thread = threadStore.create('alice', 'Thread P');

    const msgA = messageStore.append({
      userId: 'alice',
      catId: 'opus',
      content: 'early',
      mentions: [],
      timestamp: Date.now() - 2000,
      threadId: thread.id,
    });
    const msgC = messageStore.append({
      userId: 'alice',
      catId: 'opus',
      content: 'later',
      mentions: [],
      timestamp: Date.now(),
      threadId: thread.id,
    });

    // Seed stored cursor at A's raw ID (v1)
    readStateStore._seed('alice', thread.id, msgA.id);

    // PATCH with msgC — should pre-reconcile, then advance
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}/read`,
      headers: { 'x-cat-cafe-user': 'alice', 'content-type': 'application/json' },
      payload: { upToMessageId: msgC.id },
    });
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.advanced, true, 'Must advance (pre-reconcile enables same-format CAS)');
  });

  it('stored v1 for pruned message → fail-closed, cursor unchanged', async () => {
    const thread = threadStore.create('alice', 'Thread Q');

    const msgLive = messageStore.append({
      userId: 'alice',
      catId: 'opus',
      content: 'live message',
      mentions: [],
      timestamp: Date.now(),
      threadId: thread.id,
    });

    // Seed with a v1 cursor for a message that doesn't exist in the store.
    // canonicalizeCursor will return the raw ID unchanged → reconcile is no-op
    // → ack hits cross-format → fail-closed.
    const prunedV1 = 'msg-pruned-no-longer-in-store';
    readStateStore._seed('alice', thread.id, prunedV1);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}/read`,
      headers: { 'x-cat-cafe-user': 'alice', 'content-type': 'application/json' },
      payload: { upToMessageId: msgLive.id },
    });
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.advanced, false, 'Must fail-closed when stored v1 cannot be reconciled');

    // Stored cursor must remain the original v1
    const stored = readStateStore._raw('alice', thread.id);
    assert.equal(stored, prunedV1, 'Stored cursor must remain unchanged on fail-closed');
  });
});

// ============================================================================
// Sentinel notice lifecycle: synthetic → delivery → resolved
// ============================================================================

describe('#1200 R14: sentinel notice lifecycle (queue → delivery → resolved)', () => {
  it('sentinel cursor is resolved by real delivery at same or higher seq', async () => {
    const { cursorFor, compareCursors, parseCursor } = await import('../dist/domains/cats/services/stores/cursor.js');

    // Queue fallback produces sentinel cursor: v2:<seq>:0
    const seq = Date.now();
    const sentinelCursor = cursorFor({ id: '0', visibilitySeq: seq });

    // Real delivery at same seq has a real message ID
    const realId = `${String(seq).padStart(16, '0')}-000001-abcdef12`;
    const deliveryCursor = cursorFor({ id: realId, visibilitySeq: seq });

    // Sentinel must sort below delivery
    const cmp = compareCursors(sentinelCursor, deliveryCursor);
    assert.ok(cmp < 0, `Sentinel must sort below delivery at same seq: cmp=${cmp}`);

    // FreshnessNoticeService resolution check: is notice behind seenCursor?
    // If seenCursor advances to deliveryCursor, the sentinel notice resolves.
    const seenCursor = deliveryCursor;
    const noticeCmp = compareCursors(sentinelCursor, seenCursor);
    const resolved = noticeCmp < 0 || (noticeCmp === 0 && sentinelCursor === seenCursor);
    assert.equal(resolved, true, 'Sentinel notice must resolve when seen cursor >= delivery');

    // Also verify sentinel cursor is parseable
    const parsed = parseCursor(sentinelCursor);
    assert.ok(parsed, 'Sentinel cursor must be parseable');
    assert.equal(parsed.version, 2, 'Sentinel must be v2');
    assert.equal(parsed.seq, seq, 'Sentinel seq must match');
    assert.equal(parsed.id, '0', 'Sentinel id must be sentinel value');
  });

  it('sentinel cursor resolves when delivery is at higher seq', async () => {
    const { cursorFor, compareCursors } = await import('../dist/domains/cats/services/stores/cursor.js');

    const sentinelSeq = Date.now();
    const deliverySeq = sentinelSeq + 100;

    const sentinelCursor = cursorFor({ id: '0', visibilitySeq: sentinelSeq });
    const deliveryCursor = cursorFor({ id: 'msg-real', visibilitySeq: deliverySeq });

    const cmp = compareCursors(sentinelCursor, deliveryCursor);
    assert.ok(cmp < 0, 'Sentinel at lower seq must resolve when delivery is at higher seq');
  });
});
