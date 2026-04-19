/**
 * Mention Ack Tests (#77)
 * 10 regression scenarios from bug report:
 * 1. Basic flow (get → ack → session #2 sees 0)
 * 2. Crash recovery (get → no ack → session #2 still sees same)
 * 3. Same-ms mentions (ack to 2nd → only 3rd remains)
 * 4. Ack ownership validation (wrong user/thread/cat → 400)
 * 5. Cursor fallback (stale cursor → full scan)
 * 6. Window hard validation (ack beyond window → 400)
 * 7. Pagination overflow (25 mentions / limit=20 → two rounds)
 * 8. F24 session chain (seal → new session shares cursor)
 * 9. Cascade cleanup (thread delete → cursor cleaned)
 * 10. F27 auto-ack on enqueue (callback enqueues → pending-mentions empty)
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

function createMockSocketManager() {
  return {
    broadcastAgentMessage() {},
    getMessages() {
      return [];
    },
  };
}

describe('Mention Ack (#77)', () => {
  let registry;
  let messageStore;
  let deliveryCursorStore;
  let socketManager;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');

    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    deliveryCursorStore = new DeliveryCursorStore();
    socketManager = createMockSocketManager();
  });

  async function createApp(extraOpts = {}) {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      deliveryCursorStore,
      sharedBank: 'cat-cafe-shared',
      ...extraOpts,
    });
    return app;
  }

  function appendMention(threadId, content, ts) {
    return messageStore.append({
      userId: 'user-1',
      catId: null,
      content,
      mentions: ['opus'],
      timestamp: ts ?? Date.now(),
      threadId,
    });
  }

  async function getPending(app, invocationId, callbackToken, { includeAcked } = {}) {
    const extra = includeAcked ? `?includeAcked=${encodeURIComponent(includeAcked)}` : '';
    const res = await app.inject({
      method: 'GET',
      url: `/api/callbacks/pending-mentions${extra}`,
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });
    return JSON.parse(res.body);
  }

  async function ackMentions(app, invocationId, callbackToken, upToMessageId) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/ack-mentions',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { upToMessageId },
    });
    return { statusCode: res.statusCode, body: JSON.parse(res.body) };
  }

  async function postMessage(app, invocationId, callbackToken, content) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { content },
    });
    return { statusCode: res.statusCode, body: JSON.parse(res.body) };
  }

  // ---- Test 1: Basic flow ----
  test('basic flow: get → ack → session #2 sees 0 pending', async () => {
    const app = await createApp();

    // Session #1: 3 mentions arrive
    const m1 = appendMention('thread-A', '@opus task 1', 1000);
    const _m2 = appendMention('thread-A', '@opus task 2', 2000);
    const m3 = appendMention('thread-A', '@opus task 3', 3000);

    const sess1 = registry.create('user-1', 'opus', 'thread-A');
    const pending1 = await getPending(app, sess1.invocationId, sess1.callbackToken);
    assert.equal(pending1.mentions.length, 3);
    assert.equal(pending1.mentions[0].id, m1.id);
    assert.equal(pending1.mentions[2].id, m3.id);

    // Session #1 acks up to last
    const ack1 = await ackMentions(app, sess1.invocationId, sess1.callbackToken, m3.id);
    assert.equal(ack1.body.status, 'ok');

    // Session #2: should see 0 pending
    const sess2 = registry.create('user-1', 'opus', 'thread-A');
    const pending2 = await getPending(app, sess2.invocationId, sess2.callbackToken);
    assert.equal(pending2.mentions.length, 0);

    // New message arrives → session #2 sees only it
    const m4 = appendMention('thread-A', '@opus task 4', 4000);
    const pending3 = await getPending(app, sess2.invocationId, sess2.callbackToken);
    assert.equal(pending3.mentions.length, 1);
    assert.equal(pending3.mentions[0].id, m4.id);
  });

  // ---- Test 2: Crash recovery ----
  test('crash recovery: get without ack → session #2 still sees same mentions', async () => {
    const app = await createApp();

    appendMention('thread-A', '@opus task 1', 1000);
    appendMention('thread-A', '@opus task 2', 2000);

    const sess1 = registry.create('user-1', 'opus', 'thread-A');
    const pending1 = await getPending(app, sess1.invocationId, sess1.callbackToken);
    assert.equal(pending1.mentions.length, 2);

    // Session #1 crashes — no ack

    // Session #2: should see SAME mentions (not lost)
    const sess2 = registry.create('user-1', 'opus', 'thread-A');
    const pending2 = await getPending(app, sess2.invocationId, sess2.callbackToken);
    assert.equal(pending2.mentions.length, 2);
    assert.equal(pending2.mentions[0].id, pending1.mentions[0].id);
    assert.equal(pending2.mentions[1].id, pending1.mentions[1].id);
  });

  // ---- Test 3: Same-millisecond mentions ----
  test('same-ms mentions: ack to 2nd → only 3rd remains', async () => {
    const app = await createApp();
    const ts = Date.now();

    const m1 = appendMention('thread-A', '@opus same-ms-1', ts);
    const m2 = appendMention('thread-A', '@opus same-ms-2', ts);
    const m3 = appendMention('thread-A', '@opus same-ms-3', ts);

    // IDs are sortable even within same ms (seq counter)
    assert.ok(m1.id < m2.id);
    assert.ok(m2.id < m3.id);

    const sess = registry.create('user-1', 'opus', 'thread-A');
    const pending = await getPending(app, sess.invocationId, sess.callbackToken);
    assert.equal(pending.mentions.length, 3);

    // Ack up to m2
    await ackMentions(app, sess.invocationId, sess.callbackToken, m2.id);

    // Only m3 remains
    const pending2 = await getPending(app, sess.invocationId, sess.callbackToken);
    assert.equal(pending2.mentions.length, 1);
    assert.equal(pending2.mentions[0].id, m3.id);
  });

  // ---- Test 4: Ack ownership validation ----
  test('ack validation: wrong messageId → 400', async () => {
    const app = await createApp();

    // Message from user-1 mentioning opus in thread-A
    const m1 = appendMention('thread-A', '@opus valid', 1000);

    // Message from user-1 mentioning codex (not opus)
    const mCodex = messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '@codex review',
      mentions: ['codex'],
      timestamp: 2000,
      threadId: 'thread-A',
    });

    // Message in different thread
    const mOtherThread = appendMention('thread-B', '@opus other-thread', 3000);

    // Nonexistent messageId
    const sess = registry.create('user-1', 'opus', 'thread-A');

    // 400: nonexistent
    const r1 = await ackMentions(app, sess.invocationId, sess.callbackToken, 'nonexistent-id');
    assert.equal(r1.statusCode, 400);
    assert.match(r1.body.error, /does not exist/);

    // 400: wrong cat (mentions codex not opus)
    const r2 = await ackMentions(app, sess.invocationId, sess.callbackToken, mCodex.id);
    assert.equal(r2.statusCode, 400);
    assert.match(r2.body.error, /does not mention current cat/);

    // 400: wrong thread
    const r3 = await ackMentions(app, sess.invocationId, sess.callbackToken, mOtherThread.id);
    assert.equal(r3.statusCode, 400);
    assert.match(r3.body.error, /does not belong to current thread/);

    // OK: valid ack
    const r4 = await ackMentions(app, sess.invocationId, sess.callbackToken, m1.id);
    assert.equal(r4.statusCode, 200);
    assert.equal(r4.body.status, 'ok');

    // Noop: ack same message again (idempotent)
    const r5 = await ackMentions(app, sess.invocationId, sess.callbackToken, m1.id);
    assert.equal(r5.statusCode, 200);
    assert.equal(r5.body.status, 'noop');
  });

  // ---- Test 5: Cursor fallback — stale cursor that's lexicographically before new messages ----
  test('cursor fallback: old cursor from deleted message → new messages still visible', async () => {
    const app = await createApp();

    // First, create a message and ack it
    const m0 = appendMention('thread-A', '@opus old msg', 1000);
    const sess1 = registry.create('user-1', 'opus', 'thread-A');
    await ackMentions(app, sess1.invocationId, sess1.callbackToken, m0.id);

    // Now m0's ID is the cursor. Even if m0 is later deleted/expired,
    // the cursor still has its ID. New messages after it are still visible.
    const m1 = appendMention('thread-A', '@opus new msg', 2000);

    const sess2 = registry.create('user-1', 'opus', 'thread-A');
    const pending = await getPending(app, sess2.invocationId, sess2.callbackToken);

    // In-memory: string comparison m1.id > m0.id → m1 is returned
    assert.equal(pending.mentions.length, 1);
    assert.equal(pending.mentions[0].id, m1.id);
  });

  // ---- Test 6: Window hard validation ----
  test('window hard validation: ack beyond window → 400', async () => {
    const app = await createApp();

    // Create 25 mentions
    const msgs = [];
    for (let i = 0; i < 25; i++) {
      msgs.push(appendMention('thread-A', `@opus task ${i}`, 1000 + i));
    }

    const sess = registry.create('user-1', 'opus', 'thread-A');

    // get_pending_mentions returns first 20 (limit=20)
    const pending = await getPending(app, sess.invocationId, sess.callbackToken);
    assert.equal(pending.mentions.length, 20);

    // Try to ack to message #25 (beyond window) → 400
    const r1 = await ackMentions(app, sess.invocationId, sess.callbackToken, msgs[24].id);
    assert.equal(r1.statusCode, 400);
    assert.match(r1.body.error, /exceeds current pending window/);

    // Ack to message #20 (last in window) → OK
    const r2 = await ackMentions(app, sess.invocationId, sess.callbackToken, msgs[19].id);
    assert.equal(r2.statusCode, 200);
    assert.equal(r2.body.status, 'ok');
  });

  // ---- Test 7: Pagination overflow ----
  test('pagination overflow: 25 mentions / limit=20 → two rounds', async () => {
    const app = await createApp();

    const msgs = [];
    for (let i = 0; i < 25; i++) {
      msgs.push(appendMention('thread-A', `@opus task ${i}`, 1000 + i));
    }

    const sess = registry.create('user-1', 'opus', 'thread-A');

    // Round 1: get oldest 20
    const round1 = await getPending(app, sess.invocationId, sess.callbackToken);
    assert.equal(round1.mentions.length, 20);
    assert.equal(round1.mentions[0].id, msgs[0].id);
    assert.equal(round1.mentions[19].id, msgs[19].id);

    // Ack round 1
    await ackMentions(app, sess.invocationId, sess.callbackToken, msgs[19].id);

    // Round 2: get remaining 5
    const round2 = await getPending(app, sess.invocationId, sess.callbackToken);
    assert.equal(round2.mentions.length, 5);
    assert.equal(round2.mentions[0].id, msgs[20].id);
    assert.equal(round2.mentions[4].id, msgs[24].id);

    // Ack round 2
    await ackMentions(app, sess.invocationId, sess.callbackToken, msgs[24].id);

    // Round 3: 0 pending
    const round3 = await getPending(app, sess.invocationId, sess.callbackToken);
    assert.equal(round3.mentions.length, 0);

    // Verify: all 25 seen, no duplicates
    const allIds = [...round1.mentions, ...round2.mentions].map((m) => m.id);
    assert.equal(allIds.length, 25);
    assert.equal(new Set(allIds).size, 25);
  });

  // ---- Test 8: F24 session chain ----
  test('F24 session chain: session #1 acks → seal → session #2 inherits cursor', async () => {
    const app = await createApp();

    const _m1 = appendMention('thread-A', '@opus before seal', 1000);
    const m2 = appendMention('thread-A', '@opus before seal 2', 2000);

    // Session #1 processes and acks
    const sess1 = registry.create('user-1', 'opus', 'thread-A');
    const pending1 = await getPending(app, sess1.invocationId, sess1.callbackToken);
    assert.equal(pending1.mentions.length, 2);
    await ackMentions(app, sess1.invocationId, sess1.callbackToken, m2.id);

    // Session #1 seals (simulated — cursor persists in deliveryCursorStore)

    // New mention arrives between seal and session #2
    const m3 = appendMention('thread-A', '@opus after seal', 3000);

    // Session #2 (same user, same thread) — inherits cursor
    const sess2 = registry.create('user-1', 'opus', 'thread-A');
    const pending2 = await getPending(app, sess2.invocationId, sess2.callbackToken);
    assert.equal(pending2.mentions.length, 1);
    assert.equal(pending2.mentions[0].id, m3.id);

    // No new mentions → session #2 sees empty
    await ackMentions(app, sess2.invocationId, sess2.callbackToken, m3.id);
    const pending3 = await getPending(app, sess2.invocationId, sess2.callbackToken);
    assert.equal(pending3.mentions.length, 0);
  });

  // ---- Test 9: Cascade cleanup ----
  test('cascade cleanup: thread delete → mention-ack cursor cleaned', async () => {
    const app = await createApp();

    const m1 = appendMention('thread-A', '@opus cleanup test', 1000);
    const sess = registry.create('user-1', 'opus', 'thread-A');
    await ackMentions(app, sess.invocationId, sess.callbackToken, m1.id);

    // Verify cursor exists
    const cursor = await deliveryCursorStore.getMentionAckCursor('user-1', 'opus', 'thread-A');
    assert.equal(cursor, m1.id);

    // Cascade delete (simulates thread deletion)
    const deleted = await deliveryCursorStore.deleteByThreadForUser('user-1', 'thread-A');
    assert.ok(deleted > 0);

    // Cursor should be gone
    const cursorAfter = await deliveryCursorStore.getMentionAckCursor('user-1', 'opus', 'thread-A');
    assert.equal(cursorAfter, undefined);
  });

  // ---- Bonus: existing pending-mentions tests still work with ack cursor ----
  test('pending-mentions without prior ack returns all mentions (backwards compat)', async () => {
    const app = await createApp();

    appendMention('thread-A', '@opus msg 1', 1000);
    appendMention('thread-A', '@opus msg 2', 2000);

    const sess = registry.create('user-1', 'opus', 'thread-A');
    const pending = await getPending(app, sess.invocationId, sess.callbackToken);
    assert.equal(pending.mentions.length, 2);
    // Ascending order (oldest first)
    assert.equal(pending.mentions[0].message, '@opus msg 1');
    assert.equal(pending.mentions[1].message, '@opus msg 2');
    // Backwards compat: default mode should not add extra fields.
    assert.equal('acked' in pending.mentions[0], false);
  });

  test('pending-mentions includeAcked=1 returns acked mentions with acked:true', async () => {
    const app = await createApp();

    const m1 = appendMention('thread-A', '@opus acked msg 1', 1000);
    const m2 = appendMention('thread-A', '@opus acked msg 2', 2000);

    const sess = registry.create('user-1', 'opus', 'thread-A');
    await ackMentions(app, sess.invocationId, sess.callbackToken, m2.id);

    const pendingDefault = await getPending(app, sess.invocationId, sess.callbackToken);
    assert.equal(pendingDefault.mentions.length, 0);

    const pendingIncludeAcked = await getPending(app, sess.invocationId, sess.callbackToken, { includeAcked: '1' });
    assert.equal(pendingIncludeAcked.mentions.length, 2);
    assert.equal(pendingIncludeAcked.mentions[0].id, m1.id);
    assert.equal(pendingIncludeAcked.mentions[1].id, m2.id);
    assert.equal(pendingIncludeAcked.mentions[0].acked, true);
    assert.equal(pendingIncludeAcked.mentions[1].acked, true);
  });

  test('pending-mentions includeAcked=1 keeps window anchored to recent mentions', async () => {
    const app = await createApp();

    const mentions = [];
    for (let i = 1; i <= 25; i++) {
      mentions.push(appendMention('thread-A', `@opus msg ${i}`, i * 1000));
    }

    const sess = registry.create('user-1', 'opus', 'thread-A');
    await ackMentions(app, sess.invocationId, sess.callbackToken, mentions[9].id);

    const pendingIncludeAcked = await getPending(app, sess.invocationId, sess.callbackToken, { includeAcked: '1' });
    assert.equal(pendingIncludeAcked.mentions.length, 20);
    assert.equal(pendingIncludeAcked.mentions[0].message, '@opus msg 6');
    assert.equal(pendingIncludeAcked.mentions[pendingIncludeAcked.mentions.length - 1].message, '@opus msg 25');
    assert.equal(
      pendingIncludeAcked.mentions.some((m) => m.message === '@opus msg 1'),
      false,
    );

    const m10 = pendingIncludeAcked.mentions.find((m) => m.message === '@opus msg 10');
    const m11 = pendingIncludeAcked.mentions.find((m) => m.message === '@opus msg 11');
    assert.equal(m10.acked, true);
    assert.equal(m11.acked, false);
  });

  test('ack-mentions returns 401 for invalid credentials', async () => {
    const app = await createApp();
    const { invocationId } = registry.create('user-1', 'opus', 'thread-A');

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/ack-mentions',
      payload: {
        invocationId,
        callbackToken: 'wrong-token',
        upToMessageId: 'msg-1',
      },
    });
    assert.equal(res.statusCode, 401);
  });

  // ---- Test 10: Auto-ack on enqueue (F27) ----
  test('auto-acks mention cursor when callback enqueues to parent worklist', async () => {
    const { registerWorklist, unregisterWorklist } = await import(
      '../dist/domains/cats/services/agents/routing/WorklistRegistry.js'
    );

    // Stubs: callbacksRoutes only calls enqueueA2ATargets when these are present.
    // In this test we keep a parent worklist registered, so enqueue should NOT
    // fall back to standalone invocation and these should remain unused.
    const routerStub = { routeExecution: async function* () {} };
    const invocationRecordStoreStub = {
      create: async () => ({ outcome: 'duplicate' }),
      update: async () => {},
    };

    const app = await createApp({ router: routerStub, invocationRecordStore: invocationRecordStoreStub });
    const threadId = 'thread-f27-auto-ack';

    const owner = registerWorklist(threadId, ['codex'], 5);
    try {
      const sender = registry.create('user-1', 'codex', threadId);
      const r1 = await postMessage(app, sender.invocationId, sender.callbackToken, '@opus review please take a look');
      assert.equal(r1.statusCode, 200);
      assert.equal(r1.body.status, 'ok');

      // Ensure the callback path actually enqueued to the parent worklist.
      assert.ok(owner.list.includes('codex'));
      assert.ok(owner.list.includes('opus'));

      const [triggerMessage] = messageStore.getRecent(1, 'user-1');
      assert.ok(triggerMessage);

      const cursor = await deliveryCursorStore.getMentionAckCursor('user-1', 'opus', threadId);
      assert.equal(cursor, triggerMessage.id);

      const opus = registry.create('user-1', 'opus', threadId);
      const pending = await getPending(app, opus.invocationId, opus.callbackToken);
      assert.equal(pending.mentions.length, 0);
    } finally {
      unregisterWorklist(threadId, owner);
    }
  });

  // ---- Task 4: Edge case — enqueue twice is monotonic ----
  test('enqueue twice: mention ack cursor is monotonic and pending-mentions stays empty', async () => {
    const { registerWorklist, unregisterWorklist } = await import(
      '../dist/domains/cats/services/agents/routing/WorklistRegistry.js'
    );
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');

    const routerStub = { routeExecution: async function* () {} };
    const invocationRecordStoreStub = {
      create: async () => ({ outcome: 'duplicate' }),
      update: async () => {},
    };

    const app = await createApp({ router: routerStub, invocationRecordStore: invocationRecordStoreStub });
    const threadId = 'thread-enqueue-twice-monotonic';

    const owner = registerWorklist(threadId, ['codex'], 5);
    try {
      const sender = registry.create('user-1', 'codex', threadId);

      const r1 = await postMessage(app, sender.invocationId, sender.callbackToken, '@opus review');
      assert.equal(r1.statusCode, 200);
      assert.equal(r1.body.status, 'ok');

      const [trigger1] = messageStore.getRecent(1, 'user-1');
      assert.ok(trigger1);
      assert.ok(owner.list.includes('opus'));

      const cursor1 = await deliveryCursorStore.getMentionAckCursor('user-1', 'opus', threadId);
      assert.equal(cursor1, trigger1.id);

      const opus1 = registry.create('user-1', 'opus', threadId);
      const pending1 = await getPending(app, opus1.invocationId, opus1.callbackToken);
      assert.equal(pending1.mentions.length, 0);

      await enqueueA2ATargets(
        {
          router: routerStub,
          invocationRecordStore: invocationRecordStoreStub,
          socketManager,
          deliveryCursorStore,
          log: app.log,
        },
        {
          targetCats: ['opus'],
          content: '@opus review',
          userId: 'user-1',
          threadId,
          triggerMessage: trigger1,
          callerCatId: 'codex',
        },
      );

      const cursor2 = await deliveryCursorStore.getMentionAckCursor('user-1', 'opus', threadId);
      assert.ok(cursor2 >= cursor1);
      assert.ok(cursor2 >= trigger1.id);

      const opus2 = registry.create('user-1', 'opus', threadId);
      const pending2 = await getPending(app, opus2.invocationId, opus2.callbackToken);
      assert.equal(pending2.mentions.length, 0);
    } finally {
      unregisterWorklist(threadId, owner);
    }
  });
});
