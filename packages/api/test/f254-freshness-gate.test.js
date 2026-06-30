/**
 * F254 FreshnessGateService Tests (Phase A — Layer 2)
 *
 * Tests the core freshness check logic that decides whether to
 * hold or forward a side-effect (post_message, cross_post, etc.).
 *
 * Pure logic tests — no Redis needed (uses in-memory DeliveryCursorStore).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

// Will be created: FreshnessGateService
const { FreshnessGateService } = await import('../dist/domains/cats/services/freshness/FreshnessGateService.js');
const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');

const userId = 'test-user';
const catId = 'opus';
const threadId = 'thread-test';

// Lexicographically sortable message IDs
const msgId1 = '0000000000000001-000001-aaaaaaaa';
const msgId2 = '0000000000000002-000001-bbbbbbbb';
const msgId3 = '0000000000000003-000001-cccccccc';
const msgId4 = '0000000000000004-000001-dddddddd';

describe('F254 FreshnessGateService', () => {
  let store;
  let gate;

  beforeEach(() => {
    store = new DeliveryCursorStore(); // in-memory, no sessionStore
    gate = new FreshnessGateService(store);
  });

  // --- Forward decisions ---

  it('forwards when seenCursor >= latestMessageId (no unseen)', async () => {
    await store.ackSeenCursor(userId, catId, threadId, msgId2);
    const result = await gate.checkFreshness({
      userId,
      catId,
      threadId,
      latestMessageId: msgId2,
      toolName: 'post_message',
    });
    assert.equal(result.decision, 'forward');
    assert.equal(result.reason, 'no_unseen');
  });

  it('forwards when seenCursor > latestMessageId (cursor ahead)', async () => {
    await store.ackSeenCursor(userId, catId, threadId, msgId3);
    const result = await gate.checkFreshness({
      userId,
      catId,
      threadId,
      latestMessageId: msgId2,
      toolName: 'post_message',
    });
    assert.equal(result.decision, 'forward');
  });

  // --- Cloud P1 fix: delivery-order vs ID-order divergence ---

  it('holds when unseenMessages provided even if seenCursor > latestMessageId (queued-then-delivered)', async () => {
    // Simulates a queued-then-delivered message: ID embeds old creation time
    // but delivered after the cursor (store returns it by delivery score).
    // Gate must NOT short-circuit on lexicographic ID comparison.
    const queuedMsgId = '0000000000000001-000001-queued00'; // old ID
    await store.ackSeenCursor(userId, catId, threadId, msgId3); // cursor way ahead

    const result = await gate.checkFreshness({
      userId,
      catId,
      threadId,
      latestMessageId: queuedMsgId, // ID < seenCursor, but message IS unseen
      toolName: 'post_message',
      unseenMessages: [{ id: queuedMsgId, from: 'codex', preview: 'Queued message delivered late' }],
    });

    assert.equal(result.decision, 'held', 'delivery-order unseen must not be dropped by ID comparison');
    assert.equal(result.unseenCount, 1);
  });

  // --- Held decisions ---

  it('holds when there are unseen messages', async () => {
    await store.ackSeenCursor(userId, catId, threadId, msgId1);
    const result = await gate.checkFreshness({
      userId,
      catId,
      threadId,
      latestMessageId: msgId3,
      toolName: 'post_message',
      // Simulate unseen messages from other cats
      unseenMessages: [
        { id: msgId2, from: 'codex', preview: 'Wait, I found a bug...' },
        { id: msgId3, from: 'user', preview: 'Actually, never mind' },
      ],
    });
    assert.equal(result.decision, 'held');
    assert.equal(result.reason, 'unseen_available');
    assert.equal(result.unseenCount, 2);
  });

  // --- Fail-open ---

  it('AC-A3: fail-open when seenCursor does not exist', async () => {
    // No cursor set — brand new thread
    const result = await gate.checkFreshness({
      userId,
      catId,
      threadId,
      latestMessageId: msgId3,
      toolName: 'post_message',
    });
    assert.equal(result.decision, 'forward');
    assert.equal(result.reason, 'cursor_missing_fail_open');
  });

  // --- Self-message exclusion ---

  it('forwards when all unseen messages are from self', async () => {
    await store.ackSeenCursor(userId, catId, threadId, msgId1);
    const result = await gate.checkFreshness({
      userId,
      catId,
      threadId,
      latestMessageId: msgId3,
      toolName: 'post_message',
      unseenMessages: [
        { id: msgId2, from: catId, preview: 'My own earlier message' },
        { id: msgId3, from: catId, preview: 'Another message I sent' },
      ],
    });
    assert.equal(result.decision, 'forward');
    assert.equal(result.reason, 'all_self_messages');
  });

  it('holds when unseen includes mix of self and others', async () => {
    await store.ackSeenCursor(userId, catId, threadId, msgId1);
    const result = await gate.checkFreshness({
      userId,
      catId,
      threadId,
      latestMessageId: msgId3,
      toolName: 'post_message',
      unseenMessages: [
        { id: msgId2, from: catId, preview: 'My own message' },
        { id: msgId3, from: 'codex', preview: 'Review feedback' },
      ],
    });
    assert.equal(result.decision, 'held');
    assert.equal(result.unseenCount, 1, 'only non-self messages count as unseen');
  });

  // --- HeldEnvelope structure ---

  it('AC-A4: held envelope caps previews at 3 (DEFAULT_HELD_CONTEXT_LIMIT)', async () => {
    await store.ackSeenCursor(userId, catId, threadId, msgId1);
    const result = await gate.checkFreshness({
      userId,
      catId,
      threadId,
      latestMessageId: msgId4,
      toolName: 'post_message',
      unseenMessages: [
        { id: '0000000000000002-000001-eeeeeeee', from: 'codex', preview: 'Message 1' },
        { id: '0000000000000002-000002-eeeeeeee', from: 'user', preview: 'Message 2' },
        { id: '0000000000000003-000001-eeeeeeee', from: 'sonnet', preview: 'Message 3' },
        { id: '0000000000000004-000001-eeeeeeee', from: 'gpt52', preview: 'Message 4' },
      ],
    });
    assert.equal(result.decision, 'held');
    assert.equal(result.previews.length, 3, 'max 3 previews');
    assert.equal(result.omittedCount, 1, '1 message omitted');
    assert.equal(result.unseenCount, 4, 'total unseen count includes omitted');
  });

  // --- acknowledgeHeld escape hatch ---

  it('AC-A5: acknowledgeHeld forces forward even with unseen', async () => {
    await store.ackSeenCursor(userId, catId, threadId, msgId1);
    const result = await gate.checkFreshness({
      userId,
      catId,
      threadId,
      latestMessageId: msgId3,
      toolName: 'post_message',
      unseenMessages: [{ id: msgId2, from: 'codex', preview: 'Wait!' }],
      acknowledgeHeld: true,
    });
    assert.equal(result.decision, 'forward');
    assert.equal(result.reason, 'acknowledge_held');
  });

  // --- Tool name tracking ---

  it('records toolName in the decision', async () => {
    await store.ackSeenCursor(userId, catId, threadId, msgId1);
    const result = await gate.checkFreshness({
      userId,
      catId,
      threadId,
      latestMessageId: msgId3,
      toolName: 'cross_post_message',
      unseenMessages: [{ id: msgId2, from: 'user', preview: 'Hey' }],
    });
    assert.equal(result.toolName, 'cross_post_message');
  });
});
