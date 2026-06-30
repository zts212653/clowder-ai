/**
 * F254 Queue-Aware Freshness Gate Tests
 *
 * Bug found 2026-06-29 (operator live test): F117's isDelivered() filter at the
 * store layer hides queued messages from the freshness gate, causing false-forward
 * when the user sends messages while the cat is running.
 *
 * These tests verify that:
 * 1. checkFreshnessForPostMessage holds when InvocationQueue has pending entries
 * 2. ThreadUnseenChecker returns unseen result when queue has pending entries
 * 3. Queue check is a fallback — delivered unseen messages take precedence
 * 4. Self-source queue entries (from the same cat) don't trigger hold
 * 5. acknowledgeHeld still works as escape hatch
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

/** @type {typeof import('../dist/domains/cats/services/freshness/checkFreshnessForPostMessage.js')} */
let wireModule;
/** @type {typeof import('../dist/domains/cats/services/freshness/ThreadUnseenChecker.js')} */
let unseenCheckerModule;

describe('F254 Queue-Aware Freshness Gate', async () => {
  wireModule = await import('../dist/domains/cats/services/freshness/checkFreshnessForPostMessage.js');
  unseenCheckerModule = await import('../dist/domains/cats/services/freshness/ThreadUnseenChecker.js');

  const userId = 'user-1';
  const catId = 'opus';
  const threadId = 'thread-1';
  const invocationId = 'inv-1';

  const msg1 = '0000000001-000001-aaa';

  function makeMockCursorStore(seenCursor = undefined) {
    return {
      getSeenCursor: mock.fn(async () => seenCursor),
      ackSeenCursor: mock.fn(async () => {}),
      getCursor: mock.fn(async () => null),
      ackCursor: mock.fn(async () => {}),
      deleteByThreadForUser: mock.fn(async () => {}),
    };
  }

  /** Message store that returns empty (simulating isDelivered filtering out queued msgs) */
  function makeMockMessageStore(messages = []) {
    return {
      getByThreadAfter: mock.fn(async () => messages),
      getByThread: mock.fn(async () => messages),
    };
  }

  /** Queue checker that reports pending queued messages */
  function makeMockQueueChecker(entries = []) {
    return {
      getQueuedForThread: mock.fn(() => entries),
    };
  }

  // =================================================================
  // checkFreshnessForPostMessage — queue-aware hold
  // =================================================================

  describe('checkFreshnessForPostMessage with queueChecker', () => {
    it('holds when no delivered unseen but queue has pending user messages', async () => {
      // Bug scenario: user sent a message while cat was running.
      // isDelivered() filtered it out, so messageStore returns empty.
      // But InvocationQueue has the pending entry.
      const cursorStore = makeMockCursorStore(msg1);
      const messageStore = makeMockMessageStore([]); // empty — isDelivered filtered
      const queueChecker = makeMockQueueChecker([{ source: 'user', content: '算了不做了', callerCatId: undefined }]);

      const result = await wireModule.checkFreshnessForPostMessage({
        userId,
        catId,
        threadId,
        invocationId,
        toolName: 'post_message',
        cursorStore,
        messageStore,
        queueChecker,
      });

      assert.equal(result.decision, 'held');
      assert.equal(result.reason, 'queued_messages_pending');
      assert.equal(result.unseenCount, 1);
    });

    it('holds with correct sender info from queued entries', async () => {
      const cursorStore = makeMockCursorStore(msg1);
      const messageStore = makeMockMessageStore([]);
      const queueChecker = makeMockQueueChecker([
        { source: 'user', content: 'first msg', callerCatId: undefined },
        { source: 'agent', content: 'second msg', callerCatId: 'codex' },
      ]);

      const result = await wireModule.checkFreshnessForPostMessage({
        userId,
        catId,
        threadId,
        invocationId,
        toolName: 'post_message',
        cursorStore,
        messageStore,
        queueChecker,
      });

      assert.equal(result.decision, 'held');
      assert.equal(result.reason, 'queued_messages_pending');
      assert.equal(result.unseenCount, 2);
    });

    it('does not hold for queue entries from the same cat (self-source)', async () => {
      const cursorStore = makeMockCursorStore(msg1);
      const messageStore = makeMockMessageStore([]);
      const queueChecker = makeMockQueueChecker([
        { source: 'agent', content: 'my own continuation', callerCatId: 'opus' },
      ]);

      const result = await wireModule.checkFreshnessForPostMessage({
        userId,
        catId,
        threadId,
        invocationId,
        toolName: 'post_message',
        cursorStore,
        messageStore,
        queueChecker,
      });

      assert.equal(result.decision, 'forward');
    });

    it('delivered unseen takes precedence over queued (shows previews)', async () => {
      // Both delivered unseen AND queued exist — delivered takes precedence
      // because cat can actually read those messages
      const msg2 = '0000000002-000001-bbb';
      const cursorStore = makeMockCursorStore(msg1);
      const messageStore = makeMockMessageStore([{ id: msg2, catId: 'codex', content: 'Review comment', threadId }]);
      const queueChecker = makeMockQueueChecker([{ source: 'user', content: 'Also this', callerCatId: undefined }]);

      const result = await wireModule.checkFreshnessForPostMessage({
        userId,
        catId,
        threadId,
        invocationId,
        toolName: 'post_message',
        cursorStore,
        messageStore,
        queueChecker,
      });

      assert.equal(result.decision, 'held');
      assert.equal(result.reason, 'unseen_available');
      // Should show delivered message preview, not queued
    });

    it('forwards when no delivered unseen and no queued messages', async () => {
      const cursorStore = makeMockCursorStore(msg1);
      const messageStore = makeMockMessageStore([]);
      const queueChecker = makeMockQueueChecker([]);

      const result = await wireModule.checkFreshnessForPostMessage({
        userId,
        catId,
        threadId,
        invocationId,
        toolName: 'post_message',
        cursorStore,
        messageStore,
        queueChecker,
      });

      assert.equal(result.decision, 'forward');
    });

    it('forwards when queueChecker is not provided (backward compat)', async () => {
      const cursorStore = makeMockCursorStore(msg1);
      const messageStore = makeMockMessageStore([]);

      const result = await wireModule.checkFreshnessForPostMessage({
        userId,
        catId,
        threadId,
        invocationId,
        toolName: 'post_message',
        cursorStore,
        messageStore,
        // no queueChecker — backward compat
      });

      assert.equal(result.decision, 'forward');
    });

    it('P1: holds when delivered unseen are all-self but queue has non-self entry', async () => {
      // Mixed scenario (gpt52 review P1): store has delivered self-messages,
      // but queue has a pending user message. The gate should NOT false-forward
      // with "all_self_messages" — it must check the queue after the gate
      // returns all_self_messages when thread is exhausted.
      const msg2 = '0000000002-000001-bbb';
      const cursorStore = makeMockCursorStore(msg1);
      const messageStore = makeMockMessageStore([{ id: msg2, catId: 'opus', content: 'My own earlier message' }]);
      const queueChecker = makeMockQueueChecker([{ source: 'user', content: '算了不做了', callerCatId: undefined }]);

      const result = await wireModule.checkFreshnessForPostMessage({
        userId,
        catId,
        threadId,
        invocationId,
        toolName: 'post_message',
        cursorStore,
        messageStore,
        queueChecker,
      });

      assert.equal(result.decision, 'held', 'must not false-forward when queue has non-self entry');
      assert.equal(result.reason, 'queued_messages_pending');
    });

    it('acknowledgeHeld bypasses queue-based hold', async () => {
      const cursorStore = makeMockCursorStore(msg1);
      const messageStore = makeMockMessageStore([]);
      const queueChecker = makeMockQueueChecker([{ source: 'user', content: 'user msg', callerCatId: undefined }]);

      const result = await wireModule.checkFreshnessForPostMessage({
        userId,
        catId,
        threadId,
        invocationId,
        toolName: 'post_message',
        cursorStore,
        messageStore,
        queueChecker,
        acknowledgeHeld: true,
      });

      assert.equal(result.decision, 'forward');
    });
  });

  // =================================================================
  // ThreadUnseenChecker — queue-aware notice
  // =================================================================

  describe('ThreadUnseenChecker with queueChecker', () => {
    it('returns unseen result when no delivered unseen but queue has entries', async () => {
      const cursorStore = makeMockCursorStore(msg1);
      const messageStore = makeMockMessageStore([]);
      const queueChecker = makeMockQueueChecker([{ source: 'user', content: 'new user msg', callerCatId: undefined }]);

      const checker = new unseenCheckerModule.ThreadUnseenChecker({
        userId,
        cursorStore,
        messageStore,
        queueChecker,
      });

      const result = await checker.checkUnseen({ threadId, catId });
      assert.ok(result, 'should return unseen result, not null');
      assert.equal(result.count, 1);
      assert.ok(result.senders.includes('user'));
    });

    it('returns null when no delivered unseen and no queued entries', async () => {
      const cursorStore = makeMockCursorStore(msg1);
      const messageStore = makeMockMessageStore([]);
      const queueChecker = makeMockQueueChecker([]);

      const checker = new unseenCheckerModule.ThreadUnseenChecker({
        userId,
        cursorStore,
        messageStore,
        queueChecker,
      });

      const result = await checker.checkUnseen({ threadId, catId });
      assert.equal(result, null);
    });

    it('P2: queue notice maxMessageId must be sortable (not queued: prefix)', async () => {
      // Cloud review P2: synthetic `queued:${threadId}` sorts AFTER all real
      // zero-padded message IDs ('q' > '0'), making the notice permanently
      // unresolved in FreshnessNoticeService.checkHoldBallReminder.
      // maxMessageId must use the same sortable format as real message IDs.
      const cursorStore = makeMockCursorStore(msg1);
      const messageStore = makeMockMessageStore([]);
      const queueChecker = makeMockQueueChecker([{ source: 'user', content: 'msg', callerCatId: undefined }]);

      const checker = new unseenCheckerModule.ThreadUnseenChecker({
        userId,
        cursorStore,
        messageStore,
        queueChecker,
      });

      const result = await checker.checkUnseen({ threadId, catId });
      assert.ok(result, 'should return unseen result');
      // maxMessageId must NOT start with 'queued:' — it must be a sortable ID
      assert.ok(
        !result.maxMessageId.startsWith('queued:'),
        `maxMessageId must be sortable, got: ${result.maxMessageId}`,
      );
      // Must be a zero-padded numeric prefix (same format as generateSortableId)
      assert.match(
        result.maxMessageId,
        /^\d{16}-\d{6}-/,
        `maxMessageId must match sortable ID format: ${result.maxMessageId}`,
      );
    });

    it('excludes self-source queue entries from notice', async () => {
      const cursorStore = makeMockCursorStore(msg1);
      const messageStore = makeMockMessageStore([]);
      const queueChecker = makeMockQueueChecker([
        { source: 'agent', content: 'self continuation', callerCatId: 'opus' },
      ]);

      const checker = new unseenCheckerModule.ThreadUnseenChecker({
        userId,
        cursorStore,
        messageStore,
        queueChecker,
      });

      const result = await checker.checkUnseen({ threadId, catId });
      assert.equal(result, null, 'self-source queue entries should not trigger notice');
    });
  });
});
