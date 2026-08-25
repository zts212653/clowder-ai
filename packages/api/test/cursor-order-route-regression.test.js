/**
 * #1200 R14: Read-state cross-format regression — route-level tests.
 *
 * Exercises stored-cursor preparation through the actual HTTP routes
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
  const anchors = new Map();
  return {
    ack(userId, threadId, messageId, canonicalCursor) {
      const key = `${userId}:${threadId}`;
      const current = cursors.get(key);
      if (current) {
        const curV2 = current.startsWith('v2:');
        const newV2 = messageId.startsWith('v2:');
        if (curV2 !== newV2) return false;
        if (messageId <= current) return false;
      }
      cursors.set(key, messageId);
      if (canonicalCursor) anchors.set(key, canonicalCursor);
      return true;
    },
    get(userId, threadId) {
      const key = `${userId}:${threadId}`;
      const id = cursors.get(key);
      return id
        ? {
            userId,
            threadId,
            lastReadMessageId: id,
            ...(anchors.get(key) ? { lastReadVisibilityCursor: anchors.get(key) } : {}),
            updatedAt: Date.now(),
          }
        : null;
    },
    reconcileReadCursor(userId, threadId, oldV1, newV2) {
      const key = `${userId}:${threadId}`;
      if (cursors.get(key) === oldV1) {
        cursors.set(key, newV2);
        return true;
      }
      return false;
    },
    replaceReadCursorIfEqual(userId, threadId, expectedValue, newValue, canonicalCursor) {
      const key = `${userId}:${threadId}`;
      if (cursors.get(key) !== expectedValue) return false;
      cursors.set(key, newValue);
      if (canonicalCursor) anchors.set(key, canonicalCursor);
      return true;
    },
    replaceReadCoordinateIfEqual(userId, threadId, expected, replacement) {
      const key = `${userId}:${threadId}`;
      if (cursors.get(key) !== expected.lastReadMessageId) return false;
      if (anchors.get(key) !== expected.lastReadVisibilityCursor) return false;
      cursors.set(key, replacement.lastReadMessageId);
      if (replacement.lastReadVisibilityCursor === undefined) anchors.delete(key);
      else anchors.set(key, replacement.lastReadVisibilityCursor);
      return true;
    },
    getUnreadSummaries: async () => [],
    deleteByThread: async () => {},
    /** Test helper: seed a raw cursor value */
    _seed(userId, threadId, cursor, anchor) {
      const key = `${userId}:${threadId}`;
      cursors.set(key, cursor);
      if (anchor) anchors.set(key, anchor);
    },
    /** Test helper: read raw cursor value */
    _raw(userId, threadId) {
      return cursors.get(`${userId}:${threadId}`);
    },
  };
}

function appendTerminalManagedHold(messageStore, threadId, { ownerUserId, hiddenTrigger = false, suffix }) {
  const custody = {
    version: 1,
    entryId: `entry-${suffix}`,
    revision: 1,
    ownerUserId,
    intent: 'managed command wake',
    status: 'queued',
    allTargetCats: ['opus5'],
    pendingTargetCats: ['opus5'],
    notifiedByCatIds: [],
    seenByCatIds: [],
    seenInvocationIdByCatId: {},
    failedByCatIds: [],
    handledByCatIds: [],
    priority: 'normal',
    createdAt: 2000,
    updatedAt: 2000,
  };
  const message = messageStore.append({
    userId: 'scheduler',
    catId: null,
    content: `managed command ${suffix}`,
    mentions: [],
    timestamp: 2000,
    threadId,
    deliveryStatus: 'queued',
    queueCustody: custody,
    ...(hiddenTrigger ? { extra: { scheduler: { hiddenTrigger: true } } } : {}),
    source: {
      connector: 'hold-ball',
      label: '持球结果',
      icon: '🏓',
      meta: { taskId: `task-${suffix}`, threadId, catId: 'opus5', wakeWhen: true },
    },
  });
  messageStore.transitionQueueCustody(message.id, {
    expectedRevision: 1,
    next: {
      ...custody,
      revision: 2,
      status: 'terminal',
      pendingTargetCats: [],
      failedByCatIds: ['opus5'],
      updatedAt: 2100,
    },
    deliveredAt: 2100,
  });
  return message;
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
    // #1269: pre-reconcile only runs when gate is ON (v2 initiation enabled)
    const savedGate = process.env.VISIBILITY_CURSOR_V2;
    process.env.VISIBILITY_CURSOR_V2 = 'on';
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

    // #1269: restore gate state
    if (savedGate === undefined) delete process.env.VISIBILITY_CURSOR_V2;
    else process.env.VISIBILITY_CURSOR_V2 = savedGate;
  });

  it('corrects a hidden stored v1 cursor to the latest owner-visible evidence', async () => {
    const savedGate = process.env.VISIBILITY_CURSOR_V2;
    process.env.VISIBILITY_CURSOR_V2 = 'on';
    try {
      const thread = threadStore.create('alice', 'Hidden stored cursor read/latest boundary');
      const ownerVisible = appendTerminalManagedHold(messageStore, thread.id, {
        ownerUserId: 'alice',
        suffix: 'read-latest-owner-visible',
      });
      const hidden = appendTerminalManagedHold(messageStore, thread.id, {
        ownerUserId: 'alice',
        hiddenTrigger: true,
        suffix: 'read-latest-hidden-stored',
      });
      readStateStore._seed('alice', thread.id, hidden.id);

      const res = await app.inject({
        method: 'POST',
        url: `/api/threads/${thread.id}/read/latest`,
        headers: { 'x-cat-cafe-user': 'alice' },
      });
      const body = JSON.parse(res.body);

      assert.equal(res.statusCode, 200);
      assert.equal(body.advanced, true, 'Eligible latest evidence must replace the hidden stored cursor');
      assert.equal(body.caughtUp, true);
      assert.ok(readStateStore._raw('alice', thread.id)?.includes(ownerVisible.id));
      assert.ok(!readStateStore._raw('alice', thread.id)?.includes(hidden.id));
    } finally {
      if (savedGate === undefined) delete process.env.VISIBILITY_CURSOR_V2;
      else process.env.VISIBILITY_CURSOR_V2 = savedGate;
    }
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

  it('stored canonical v2 B, latest=A (earlier) → evidence repair must not regress it', async () => {
    const savedGate = process.env.VISIBILITY_CURSOR_V2;
    process.env.VISIBILITY_CURSOR_V2 = 'on';
    try {
      const thread = threadStore.create('alice', 'Thread canonical monotonicity');
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
      const cursorB = messageStore.canonicalizeCursor(msgB.id, thread.id);
      readStateStore._seed('alice', thread.id, cursorB, cursorB);
      messageStore.softDelete(msgB.id, 'admin');

      const res = await app.inject({
        method: 'POST',
        url: `/api/threads/${thread.id}/read/latest`,
        headers: { 'x-cat-cafe-user': 'alice' },
      });
      const body = JSON.parse(res.body);

      assert.equal(res.statusCode, 200);
      assert.equal(body.advanced, false, 'A canonical higher cursor must not be treated as repairable');
      assert.equal(body.caughtUp, true, 'A stored canonical anchor beyond latest is already caught up');
      assert.equal(readStateStore._raw('alice', thread.id), cursorB);
      assert.ok(!cursorB.includes(msgA.id));
    } finally {
      if (savedGate === undefined) delete process.env.VISIBILITY_CURSOR_V2;
      else process.env.VISIBILITY_CURSOR_V2 = savedGate;
    }
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
    // #1269: pre-reconcile only runs when gate is ON (v2 initiation enabled)
    const savedGate = process.env.VISIBILITY_CURSOR_V2;
    process.env.VISIBILITY_CURSOR_V2 = 'on';
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

    // #1269: restore gate state
    if (savedGate === undefined) delete process.env.VISIBILITY_CURSOR_V2;
    else process.env.VISIBILITY_CURSOR_V2 = savedGate;
  });

  it('corrects an ownerless stored v1 cursor during mark-all', async () => {
    const savedGate = process.env.VISIBILITY_CURSOR_V2;
    process.env.VISIBILITY_CURSOR_V2 = 'on';
    try {
      const thread = threadStore.create('alice', 'Ownerless stored cursor mark-all boundary');
      const ownerVisible = appendTerminalManagedHold(messageStore, thread.id, {
        ownerUserId: 'alice',
        suffix: 'mark-all-owner-visible',
      });
      const ownerless = appendTerminalManagedHold(messageStore, thread.id, {
        ownerUserId: undefined,
        suffix: 'mark-all-ownerless-stored',
      });
      readStateStore._seed('alice', thread.id, ownerless.id);

      const res = await app.inject({
        method: 'POST',
        url: '/api/threads/read/mark-all',
        headers: { 'x-cat-cafe-user': 'alice' },
      });
      const body = JSON.parse(res.body);

      assert.equal(res.statusCode, 200);
      assert.equal(body.advancedCount, 1, 'Eligible latest evidence must replace the ownerless stored cursor');
      assert.ok(readStateStore._raw('alice', thread.id)?.includes(ownerVisible.id));
      assert.ok(!readStateStore._raw('alice', thread.id)?.includes(ownerless.id));
    } finally {
      if (savedGate === undefined) delete process.env.VISIBILITY_CURSOR_V2;
      else process.env.VISIBILITY_CURSOR_V2 = savedGate;
    }
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

  it('corrects a foreign stored v1 cursor before accepting a valid owner PATCH target', async () => {
    const savedGate = process.env.VISIBILITY_CURSOR_V2;
    process.env.VISIBILITY_CURSOR_V2 = 'on';
    try {
      const thread = threadStore.create('alice', 'Foreign stored cursor PATCH boundary');
      const ownerVisible = appendTerminalManagedHold(messageStore, thread.id, {
        ownerUserId: 'alice',
        suffix: 'patch-owner-visible',
      });
      const foreign = appendTerminalManagedHold(messageStore, thread.id, {
        ownerUserId: 'bob',
        suffix: 'patch-foreign-stored',
      });
      readStateStore._seed('alice', thread.id, foreign.id);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/threads/${thread.id}/read`,
        headers: { 'x-cat-cafe-user': 'alice', 'content-type': 'application/json' },
        payload: { upToMessageId: ownerVisible.id },
      });
      const body = JSON.parse(res.body);

      assert.equal(res.statusCode, 200);
      assert.deepEqual(body, { advanced: true, caughtUp: true });
      assert.ok(readStateStore._raw('alice', thread.id)?.includes(ownerVisible.id));
      assert.ok(!readStateStore._raw('alice', thread.id)?.includes(foreign.id));
    } finally {
      if (savedGate === undefined) delete process.env.VISIBILITY_CURSOR_V2;
      else process.env.VISIBILITY_CURSOR_V2 = savedGate;
    }
  });

  it('corrects a foreign stored v1 cursor while v2 initiation is off', async () => {
    const savedGate = process.env.VISIBILITY_CURSOR_V2;
    delete process.env.VISIBILITY_CURSOR_V2;
    try {
      const thread = threadStore.create('alice', 'Foreign stored rollback cursor PATCH boundary');
      const ownerVisible = appendTerminalManagedHold(messageStore, thread.id, {
        ownerUserId: 'alice',
        suffix: 'patch-v1-off-owner-visible',
      });
      const foreign = appendTerminalManagedHold(messageStore, thread.id, {
        ownerUserId: 'bob',
        suffix: 'patch-v1-off-foreign-stored',
      });
      readStateStore._seed('alice', thread.id, foreign.id);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/threads/${thread.id}/read`,
        headers: { 'x-cat-cafe-user': 'alice', 'content-type': 'application/json' },
        payload: { upToMessageId: ownerVisible.id },
      });
      const body = JSON.parse(res.body);

      assert.equal(res.statusCode, 200);
      assert.deepEqual(body, { advanced: true, caughtUp: true });
      assert.equal(readStateStore._raw('alice', thread.id), ownerVisible.id);
      const afterState = readStateStore.get('alice', thread.id);
      assert.ok(afterState.lastReadVisibilityCursor?.includes(ownerVisible.id));
    } finally {
      if (savedGate === undefined) delete process.env.VISIBILITY_CURSOR_V2;
      else process.env.VISIBILITY_CURSOR_V2 = savedGate;
    }
  });

  it('corrects a foreign stored canonical v2 cursor before accepting a valid owner PATCH target', async () => {
    const savedGate = process.env.VISIBILITY_CURSOR_V2;
    process.env.VISIBILITY_CURSOR_V2 = 'on';
    try {
      const thread = threadStore.create('alice', 'Foreign stored canonical cursor PATCH boundary');
      const ownerVisible = appendTerminalManagedHold(messageStore, thread.id, {
        ownerUserId: 'alice',
        suffix: 'patch-v2-owner-visible',
      });
      const foreign = appendTerminalManagedHold(messageStore, thread.id, {
        ownerUserId: 'bob',
        suffix: 'patch-v2-foreign-stored',
      });
      const foreignCursor = messageStore.canonicalizeCursor(foreign.id, thread.id);
      readStateStore._seed('alice', thread.id, foreignCursor, foreignCursor);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/threads/${thread.id}/read`,
        headers: { 'x-cat-cafe-user': 'alice', 'content-type': 'application/json' },
        payload: { upToMessageId: ownerVisible.id },
      });
      const body = JSON.parse(res.body);

      assert.equal(res.statusCode, 200);
      assert.deepEqual(body, { advanced: true, caughtUp: true });
      assert.ok(readStateStore._raw('alice', thread.id)?.includes(ownerVisible.id));
      assert.ok(!readStateStore._raw('alice', thread.id)?.includes(foreign.id));
    } finally {
      if (savedGate === undefined) delete process.env.VISIBILITY_CURSOR_V2;
      else process.env.VISIBILITY_CURSOR_V2 = savedGate;
    }
  });

  it('does not ACK a mutable stream until the same message is finally delivered', async () => {
    const thread = threadStore.create('alice', 'Mutable stream PATCH boundary');
    const stream = messageStore.append({
      userId: 'alice',
      catId: 'codex-sol',
      content: 'partial stream',
      mentions: [],
      timestamp: Date.now(),
      threadId: thread.id,
      origin: 'stream',
      deliveryStatus: 'queued',
    });

    const beforeFinal = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}/read`,
      headers: { 'x-cat-cafe-user': 'alice', 'content-type': 'application/json' },
      payload: { upToMessageId: stream.id },
    });
    assert.equal(beforeFinal.statusCode, 200);
    assert.deepEqual(JSON.parse(beforeFinal.body), { advanced: false, caughtUp: false });
    assert.equal(readStateStore._raw('alice', thread.id), undefined, 'partial stream must not advance read state');

    messageStore.markDelivered(stream.id, Date.now() + 1);

    const afterFinal = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}/read`,
      headers: { 'x-cat-cafe-user': 'alice', 'content-type': 'application/json' },
      payload: { upToMessageId: stream.id },
    });
    assert.equal(afterFinal.statusCode, 200);
    assert.deepEqual(JSON.parse(afterFinal.body), { advanced: true, caughtUp: true });
    assert.ok(readStateStore._raw('alice', thread.id)?.includes(stream.id));
  });

  it('does not ACK a terminal managed-hold message owned by another user', async () => {
    const thread = threadStore.create('system', 'Shared managed-hold cursor boundary');
    const foreign = appendTerminalManagedHold(messageStore, thread.id, {
      ownerUserId: 'bob',
      suffix: 'foreign-owner',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}/read`,
      headers: { 'x-cat-cafe-user': 'alice', 'content-type': 'application/json' },
      payload: { upToMessageId: foreign.id },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { advanced: false, caughtUp: false });
    assert.equal(readStateStore._raw('alice', thread.id), undefined);
  });

  it('does not ACK a hidden terminal managed-hold message even for its owner', async () => {
    const thread = threadStore.create('system', 'Hidden managed-hold cursor boundary');
    const hidden = appendTerminalManagedHold(messageStore, thread.id, {
      ownerUserId: 'alice',
      hiddenTrigger: true,
      suffix: 'hidden-owner',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}/read`,
      headers: { 'x-cat-cafe-user': 'alice', 'content-type': 'application/json' },
      payload: { upToMessageId: hidden.id },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { advanced: false, caughtUp: false });
    assert.equal(readStateStore._raw('alice', thread.id), undefined);
  });

  it('does not ACK a legacy ownerless terminal managed-hold message', async () => {
    const thread = threadStore.create('system', 'Ownerless managed-hold cursor boundary');
    const ownerless = appendTerminalManagedHold(messageStore, thread.id, {
      ownerUserId: undefined,
      suffix: 'legacy-ownerless',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}/read`,
      headers: { 'x-cat-cafe-user': 'alice', 'content-type': 'application/json' },
      payload: { upToMessageId: ownerless.id },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { advanced: false, caughtUp: false });
    assert.equal(readStateStore._raw('alice', thread.id), undefined);
  });

  it('ACKs an owner-visible terminal managed-hold message for its durable owner', async () => {
    const thread = threadStore.create('system', 'Owner-visible managed-hold cursor boundary');
    const ownerVisible = appendTerminalManagedHold(messageStore, thread.id, {
      ownerUserId: 'alice',
      suffix: 'owner-visible',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}/read`,
      headers: { 'x-cat-cafe-user': 'alice', 'content-type': 'application/json' },
      payload: { upToMessageId: ownerVisible.id },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { advanced: true, caughtUp: true });
    assert.ok(readStateStore._raw('alice', thread.id)?.includes(ownerVisible.id));
  });

  it('stored v1 for pruned message → explicit read evidence repairs the slot', async () => {
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
    // canonicalizeCursor returns the raw ID unchanged, proving that the old
    // position is unknowable. The validated PATCH target is new read evidence.
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
    assert.equal(body.advanced, true, 'Validated read evidence must repair an unresolvable stored cursor');
    assert.equal(body.caughtUp, true);

    const stored = readStateStore._raw('alice', thread.id);
    assert.notEqual(stored, prunedV1, 'Stored cursor must leave the unresolvable value');
    assert.ok(stored.includes(msgLive.id), 'Stored cursor must bind the validated read target');
  });

  it('does not repair backward when a durable anchor proves the stored position is later', async () => {
    const savedGate = process.env.VISIBILITY_CURSOR_V2;
    process.env.VISIBILITY_CURSOR_V2 = 'on';
    try {
      const thread = threadStore.create('alice', 'Anchored monotonic read');
      const msgA = messageStore.append({
        userId: 'alice',
        catId: 'opus',
        content: 'earlier visible message',
        mentions: [],
        timestamp: Date.now() - 2000,
        threadId: thread.id,
      });
      const msgB = messageStore.append({
        userId: 'alice',
        catId: 'opus',
        content: 'later read position',
        mentions: [],
        timestamp: Date.now(),
        threadId: thread.id,
      });
      const cursorB = messageStore.canonicalizeCursor(msgB.id, thread.id);
      const stalePrimary = '0000000000000001-pruned-primary';
      readStateStore._seed('alice', thread.id, stalePrimary, cursorB);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/threads/${thread.id}/read`,
        headers: { 'x-cat-cafe-user': 'alice' },
        payload: { upToMessageId: msgA.id },
      });
      const body = JSON.parse(res.body);

      assert.equal(res.statusCode, 200);
      assert.equal(body.advanced, false);
      assert.equal(body.caughtUp, true);
      assert.equal(readStateStore._raw('alice', thread.id), stalePrimary);
    } finally {
      if (savedGate === undefined) delete process.env.VISIBILITY_CURSOR_V2;
      else process.env.VISIBILITY_CURSOR_V2 = savedGate;
    }
  });
});

// ============================================================================
// #1269: Route-level OFF→ON→OFF activation lifecycle via PATCH /read
// Exercises gatedReadStateAck() through the real HTTP endpoint.
// ============================================================================

describe('#1269 route: PATCH /read OFF→ON→OFF activation lifecycle', () => {
  let app;
  let threadStore;
  let messageStore;
  let readStateStore;
  let savedGate;

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

    savedGate = process.env.VISIBILITY_CURSOR_V2;
  });

  afterEach(async () => {
    if (savedGate === undefined) delete process.env.VISIBILITY_CURSOR_V2;
    else process.env.VISIBILITY_CURSOR_V2 = savedGate;
    if (app) await app.close();
  });

  it('OFF→ON→OFF: untouched v1, advance to v2, rollback preserves v2', async () => {
    const thread = threadStore.create('alice', 'Gate lifecycle thread');

    const msgA = messageStore.append({
      userId: 'alice',
      catId: 'opus',
      content: 'msg A',
      mentions: [],
      timestamp: Date.now() - 3000,
      threadId: thread.id,
    });
    const msgB = messageStore.append({
      userId: 'alice',
      catId: 'opus',
      content: 'msg B',
      mentions: [],
      timestamp: Date.now() - 2000,
      threadId: thread.id,
    });
    const msgC = messageStore.append({
      userId: 'alice',
      catId: 'opus',
      content: 'msg C',
      mentions: [],
      timestamp: Date.now(),
      threadId: thread.id,
    });

    // Phase 1: OFF — untouched slot, ack with msgA → stored as v1
    delete process.env.VISIBILITY_CURSOR_V2;
    const r1 = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}/read`,
      headers: { 'x-cat-cafe-user': 'alice', 'content-type': 'application/json' },
      payload: { upToMessageId: msgA.id },
    });
    assert.equal(r1.statusCode, 200);
    assert.equal(JSON.parse(r1.body).advanced, true, 'Phase 1: must advance');
    const s1 = readStateStore._raw('alice', thread.id);
    assert.ok(!s1.startsWith('v2:'), 'OFF: untouched slot stores v1');

    // Phase 2: ON — advance to msgB → stored as v2 (pre-reconcile upgrades v1→v2)
    process.env.VISIBILITY_CURSOR_V2 = 'on';
    const r2 = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}/read`,
      headers: { 'x-cat-cafe-user': 'alice', 'content-type': 'application/json' },
      payload: { upToMessageId: msgB.id },
    });
    assert.equal(r2.statusCode, 200);
    assert.equal(JSON.parse(r2.body).advanced, true, 'Phase 2: must advance');
    const s2 = readStateStore._raw('alice', thread.id);
    assert.ok(s2.startsWith('v2:'), 'ON: stored must be v2');

    // Phase 3: OFF (rollback) — advance to msgC → v2 preserved (existing v2 keeps gate open)
    delete process.env.VISIBILITY_CURSOR_V2;
    const r3 = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}/read`,
      headers: { 'x-cat-cafe-user': 'alice', 'content-type': 'application/json' },
      payload: { upToMessageId: msgC.id },
    });
    assert.equal(r3.statusCode, 200);
    assert.equal(JSON.parse(r3.body).advanced, true, 'Phase 3: must advance');
    const s3 = readStateStore._raw('alice', thread.id);
    assert.ok(s3.startsWith('v2:'), 'Rollback: v2 preserved in existing v2 slot');
  });
});

// ============================================================================
// Sentinel notice lifecycle: real ThreadUnseenChecker → FreshnessNoticeService
// ============================================================================

describe('#1200 R14: sentinel production lifecycle (checker → service → resolved)', () => {
  it('queue fallback sentinel from real ThreadUnseenChecker resolves via checkHoldBallReminder', async () => {
    const { ThreadUnseenChecker } = await import('../dist/domains/cats/services/freshness/ThreadUnseenChecker.js');
    const { FreshnessNoticeService } = await import(
      '../dist/domains/cats/services/freshness/FreshnessNoticeService.js'
    );
    const { cursorFor, parseCursor } = await import('../dist/domains/cats/services/stores/cursor.js');

    const threadId = 't-sentinel-lifecycle';
    const catId = 'opus';
    const userId = 'u-sentinel';
    const invocationId = 'inv-sentinel-test';

    // Simulate: seen cursor at seq 5000 (allocator HWM ahead of clock)
    const seenSeq = Date.now() + 5000;
    const seenCursor = cursorFor({ id: 'msg-seen-base', visibilitySeq: seenSeq });

    // --- Step 1: ThreadUnseenChecker produces sentinel via queue fallback ---
    const checker = new ThreadUnseenChecker({
      userId,
      cursorStore: {
        getSeenCursor: async () => seenCursor,
      },
      messageStore: {
        // Empty batch → triggers queue fallback
        getByThreadAfter: async () => [],
      },
      queueChecker: {
        getQueuedForThread: () => [{ source: 'user', content: 'queued msg from user', callerCatId: undefined }],
      },
    });

    const unseen = await checker.checkUnseen({ threadId, catId });
    assert.ok(unseen, 'Queue fallback must return unseen result');
    assert.ok(unseen.maxMessageId.startsWith('v2:'), 'maxMessageId must be v2 cursor');

    // Verify the sentinel uses '0' as ID (production code, not hand-constructed)
    const sentinelParsed = parseCursor(unseen.maxMessageId);
    assert.equal(sentinelParsed.id, '0', 'Production sentinel must use ID "0"');
    assert.ok(sentinelParsed.seq > seenSeq, 'Sentinel seq must exceed seen seq');

    // --- Step 2: FreshnessNoticeService records the sentinel as notice_attached ---
    const events = [];
    const eventLog = {
      append: async (e) => events.push(e),
      getUnresolvedNotices: async () => events.filter((e) => e.kind === 'notice_attached'),
    };
    const stateStore = {
      get: async () => null,
      incrementToolCallCount: async () => 1,
      recordNoticeDelivered: async () => {},
    };

    const service = new FreshnessNoticeService(stateStore, eventLog, checker);

    const notice = await service.checkAndMaybeNotice({
      invocationId,
      threadId,
      catId,
      toolName: 'list_recent',
      isReadOnly: true,
    });
    assert.ok(notice, 'Service must emit notice from queue fallback');
    assert.equal(events.length, 1, 'Must record one notice_attached event');
    assert.ok(events[0].maxCursor, 'Event must have maxCursor (v2)');

    // --- Step 3: Simulate real delivery at same seq with a real message ID ---
    // A real message queued earlier has a lower-timestamp ID (e.g. created 10s ago).
    // After delivery, its visibilitySeq = sentinelParsed.seq (same allocator).
    const realMsgId = `${String(Date.now() - 10000).padStart(16, '0')}-000001-abcdef12`;
    const deliveryCursor = cursorFor({ id: realMsgId, visibilitySeq: sentinelParsed.seq });

    // --- Step 4: checkHoldBallReminder with delivery cursor as seenCursor ---
    const reminder = await service.checkHoldBallReminder({
      invocationId,
      threadId,
      catId,
      currentSeenCursor: deliveryCursor,
    });

    // The sentinel cursor must sort BELOW the delivery cursor (same seq, '0' < realMsgId)
    // → notice is resolved → no reminder
    assert.equal(
      reminder,
      null,
      'Sentinel notice must resolve when seen cursor is at real delivery (same seq, real ID > "0")',
    );

    // Verify no notice_deferred was recorded (resolved = no deferred event)
    const deferred = events.filter((e) => e.kind === 'notice_deferred');
    assert.equal(deferred.length, 0, 'No notice_deferred when sentinel is resolved');
  });

  it('would FAIL if sentinel used generateSortableId (sorts above real delivery)', async () => {
    // This test proves the fix is necessary by showing the OLD behavior.
    // generateSortableId(syntheticSeq) produces an ID with syntheticSeq as timestamp,
    // which sorts ABOVE a real message ID created at an earlier timestamp.
    const { cursorFor, compareCursors } = await import('../dist/domains/cats/services/stores/cursor.js');
    const { generateSortableId } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const syntheticSeq = Date.now() + 5001; // seenSeq + 1 (same as production)
    const oldSentinelId = generateSortableId(syntheticSeq);
    const oldSentinelCursor = cursorFor({ id: oldSentinelId, visibilitySeq: syntheticSeq });

    // Real message created 10s ago (typical queue scenario)
    const realMsgId = `${String(Date.now() - 10000).padStart(16, '0')}-000001-abcdef12`;
    const deliveryCursor = cursorFor({ id: realMsgId, visibilitySeq: syntheticSeq });

    // OLD behavior: sentinel with generateSortableId sorts ABOVE real delivery
    const oldCmp = compareCursors(oldSentinelCursor, deliveryCursor);
    assert.ok(oldCmp > 0, 'OLD sentinel (generateSortableId) sorts ABOVE real delivery — BUG');

    // NEW behavior: sentinel with '0' sorts BELOW real delivery
    const newSentinelCursor = cursorFor({ id: '0', visibilitySeq: syntheticSeq });
    const newCmp = compareCursors(newSentinelCursor, deliveryCursor);
    assert.ok(newCmp < 0, 'NEW sentinel ("0") sorts BELOW real delivery — FIXED');
  });
});
