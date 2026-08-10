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
/** @type {typeof import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js')} */
let queueModule;

describe('F254 Queue-Aware Freshness Gate', async () => {
  wireModule = await import('../dist/domains/cats/services/freshness/checkFreshnessForPostMessage.js');
  unseenCheckerModule = await import('../dist/domains/cats/services/freshness/ThreadUnseenChecker.js');
  queueModule = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');

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
      getById: mock.fn(async (id) => messages.find((m) => m.id === id) ?? null),
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
    it('preserves the exact parent fence through the provider-native Queue adapter', async () => {
      const queue = new queueModule.InvocationQueue();
      queue.enqueue({
        ownerAuthProvenance: 'strict',
        threadId,
        userId,
        content: 'read this in the current parent',
        source: 'user',
        targetCats: [catId],
        authorIntentByCatId: {
          [catId]: { requested: 'continue_current', boundParentInvocationId: invocationId },
        },
        intent: 'execute',
      });

      const result = await wireModule.checkFreshnessForPostMessage({
        userId,
        catId,
        threadId,
        invocationId,
        toolName: 'provider_native_safe_boundary',
        cursorStore: makeMockCursorStore(msg1),
        messageStore: makeMockMessageStore([]),
        queueChecker: wireModule.createQueueChecker(queue, { parentInvocationId: invocationId }),
      });

      assert.equal(result.decision, 'held');
      assert.equal(result.reason, 'queued_messages_pending');
      assert.equal(result.unseenCount, 1);
    });

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

    it('holds for a delivered same-cat cross-thread A2A message', async () => {
      const messageId = '0000000002-000001-delivered-cross-thread';
      const result = await wireModule.checkFreshnessForPostMessage({
        userId,
        catId,
        threadId,
        invocationId,
        toolName: 'post_message',
        cursorStore: makeMockCursorStore(msg1),
        messageStore: makeMockMessageStore([
          {
            id: messageId,
            catId,
            content: '@opus parallel-self handoff',
            threadId,
            extra: { crossPost: { sourceThreadId: 'thread-source', sourceInvocationId: 'inv-source' } },
          },
        ]),
        queueChecker: makeMockQueueChecker([]),
      });

      assert.equal(result.decision, 'held');
      assert.equal(result.reason, 'unseen_available');
      assert.equal(result.unseenCount, 1);
    });

    it('holds for a queued same-cat cross-thread A2A message', async () => {
      const messageId = '0000000002-000001-queued-cross-thread';
      const messageStore = {
        getByThreadAfter: mock.fn(async () => []),
        getById: mock.fn(async (id) =>
          id === messageId
            ? {
                id,
                catId,
                content: '@opus queued parallel-self handoff',
                threadId,
                extra: { crossPost: { sourceThreadId: 'thread-source', sourceInvocationId: 'inv-source' } },
              }
            : null,
        ),
      };
      const result = await wireModule.checkFreshnessForPostMessage({
        userId,
        catId,
        threadId,
        invocationId,
        toolName: 'post_message',
        cursorStore: makeMockCursorStore(msg1),
        messageStore,
        queueChecker: makeMockQueueChecker([
          {
            entryId: 'queue-cross-thread',
            source: 'agent',
            sourceCategory: 'a2a',
            callerCatId: catId,
            content: '@opus queued parallel-self handoff',
            messageId,
          },
        ]),
      });

      assert.equal(result.decision, 'held');
      assert.equal(result.reason, 'queued_messages_pending');
      assert.equal(result.unseenCount, 1);
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

    it('does not hold for delivered tool-only empty cat stream messages', async () => {
      const msg2 = '0000000002-000001-bbb';
      const cursorStore = makeMockCursorStore(msg1);
      const messageStore = makeMockMessageStore([
        {
          id: msg2,
          catId: 'sonnet',
          content: '',
          threadId,
          origin: 'stream',
          toolEvents: [{ type: 'tool_use', toolName: 'cat_cafe_get_thread_context' }],
        },
      ]);
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
      assert.notEqual(result.reason, 'unseen_available');
    });

    it('does not hold on a typed sibling reply whose trigger was already covered by this child', async () => {
      const siblingReply = '0000000002-000001-sibling';
      const cursorStore = makeMockCursorStore(msg1);
      const eventLog = { append: mock.fn(async () => {}) };
      const messageStore = makeMockMessageStore([
        {
          id: siblingReply,
          catId: 'fable5',
          content: 'M1 result that M2 already carried into the current prompt',
          threadId,
          extra: { causal: { kind: 'invocation_reply', triggerMessageId: 'msg-m1' } },
        },
      ]);

      const result = await wireModule.checkFreshnessForPostMessage({
        userId,
        catId,
        threadId,
        invocationId,
        toolName: 'post_message',
        cursorStore,
        messageStore,
        queueChecker: makeMockQueueChecker([]),
        coveredMessageIds: ['msg-m1', 'msg-m2'],
        eventLog,
      });

      assert.equal(result.decision, 'forward');
      assert.equal(result.reason, 'no_unseen');
      assert.deepEqual(eventLog.append.mock.calls[0].arguments[0].relevanceSuppressions, {
        same_user_wave_sibling_reply: 1,
      });
    });

    it('still holds when the same-wave sibling reply explicitly directs new work to this child', async () => {
      const directedReply = '0000000002-000001-directed';
      const cursorStore = makeMockCursorStore(msg1);
      const messageStore = makeMockMessageStore([
        {
          id: directedReply,
          catId: 'fable5',
          content: '@opus please take this independent follow-up',
          mentions: ['opus'],
          threadId,
          extra: { causal: { kind: 'invocation_reply', triggerMessageId: 'msg-m1' } },
        },
      ]);

      const result = await wireModule.checkFreshnessForPostMessage({
        userId,
        catId,
        threadId,
        invocationId,
        toolName: 'post_message',
        cursorStore,
        messageStore,
        queueChecker: makeMockQueueChecker([]),
        coveredMessageIds: ['msg-m1', 'msg-m2'],
      });

      assert.equal(result.decision, 'held');
      assert.equal(result.reason, 'unseen_available');
    });

    it('holds for delivered scheduler trigger messages because they enter the next prompt', async () => {
      const msg2 = '0000000002-000001-bbb';
      const cursorStore = makeMockCursorStore(msg1);
      const messageStore = makeMockMessageStore([
        {
          id: msg2,
          catId: null,
          content: '⏰ 条件探针已满足，球回到 @opus',
          threadId,
          userId: 'scheduler',
          source: { connector: 'scheduler', label: '定时任务' },
        },
      ]);
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

      assert.equal(result.decision, 'held');
      assert.equal(result.reason, 'unseen_available');
      assert.equal(result.unseenCount, 1);
    });

    it('does not hold for an expected A2A reply to this cat handoff', async () => {
      const triggerId = '0000000002-000001-bbb';
      const replyId = '0000000003-000001-ccc';
      const cursorStore = makeMockCursorStore(msg1);
      const messageStore = makeMockMessageStore([
        {
          id: triggerId,
          catId,
          mentions: ['opus48'],
          content: '@opus48 please take this',
          threadId,
        },
        {
          id: replyId,
          catId: 'opus48',
          replyTo: triggerId,
          content: 'Taking it from here',
          threadId,
        },
      ]);
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
      assert.notEqual(result.reason, 'unseen_available');
    });

    it('holds for a cat reply whose parent did not mention that cat', async () => {
      const triggerId = '0000000002-000001-bbb';
      const replyId = '0000000003-000001-ccc';
      const cursorStore = makeMockCursorStore(msg1);
      const messageStore = makeMockMessageStore([
        {
          id: triggerId,
          catId,
          mentions: ['sonnet'],
          content: '@sonnet please take this',
          threadId,
        },
        {
          id: replyId,
          catId: 'opus48',
          replyTo: triggerId,
          content: 'Unsolicited side reply',
          threadId,
        },
      ]);
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

      assert.equal(result.decision, 'held');
      assert.equal(result.reason, 'unseen_available');
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

    it('forwards after same cat has marked the queued entry seen', async () => {
      const queue = new queueModule.InvocationQueue();
      const enqueued = queue.enqueue({
        ownerAuthProvenance: 'unknown',
        threadId,
        userId,
        content: 'queued body already read',
        source: 'user',
        targetCats: [catId],
        intent: 'execute',
      });
      assert.equal(queue.markQueuedSeen(threadId, userId, enqueued.entry.id, catId), true);

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
        queueChecker: wireModule.createQueueChecker(queue, { parentInvocationId: undefined }),
      });

      assert.equal(result.decision, 'forward');
      assert.equal(result.reason, 'no_unseen');
    });
  });

  // =================================================================
  // ThreadUnseenChecker — queue-aware notice
  // =================================================================

  describe('ThreadUnseenChecker with queueChecker', () => {
    it('reports a delivered same-cat cross-thread A2A message as unseen work', async () => {
      const crossThreadMessageId = '0000000002-000001-cross-thread';
      const cursorStore = makeMockCursorStore(msg1);
      const messageStore = makeMockMessageStore([
        {
          id: crossThreadMessageId,
          catId,
          content: '@opus parallel-self handoff',
          threadId,
          extra: {
            crossPost: {
              sourceThreadId: 'thread-source',
              sourceInvocationId: 'inv-source',
            },
          },
        },
      ]);

      const checker = new unseenCheckerModule.ThreadUnseenChecker({
        userId,
        cursorStore,
        messageStore,
        queueChecker: makeMockQueueChecker([]),
      });

      const result = await checker.checkUnseen({ threadId, catId });
      assert.notEqual(result, null, 'cross-thread provenance must override the same-cat self filter');
      assert.equal(result.count, 1);
      assert.equal(result.maxMessageId, crossThreadMessageId);
    });

    it('keeps a delivered same-cat same-thread message classified as self-source', async () => {
      const cursorStore = makeMockCursorStore(msg1);
      const messageStore = makeMockMessageStore([
        {
          id: '0000000002-000001-same-thread',
          catId,
          content: 'my own same-thread continuation',
          threadId,
        },
      ]);

      const checker = new unseenCheckerModule.ThreadUnseenChecker({
        userId,
        cursorStore,
        messageStore,
        queueChecker: makeMockQueueChecker([]),
      });

      const result = await checker.checkUnseen({ threadId, catId });
      assert.equal(result, null, 'same-thread continuation must remain suppressed');
    });

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

    it('returns null for delivered tool-only empty cat stream messages', async () => {
      const msg2 = '0000000002-000001-bbb';
      const cursorStore = makeMockCursorStore(msg1);
      const messageStore = makeMockMessageStore([
        {
          id: msg2,
          catId: 'sonnet',
          content: '',
          threadId,
          origin: 'stream',
          toolEvents: [{ type: 'tool_use', toolName: 'cat_cafe_get_thread_context' }],
        },
      ]);
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

    it('reports delivered scheduler trigger messages as unseen because they enter the next prompt', async () => {
      const msg2 = '0000000002-000001-bbb';
      const cursorStore = makeMockCursorStore(msg1);
      const messageStore = makeMockMessageStore([
        {
          id: msg2,
          catId: null,
          content: '⏰ 条件探针已满足，球回到 @opus',
          threadId,
          userId: 'scheduler',
          source: { connector: 'scheduler', label: '定时任务' },
        },
      ]);
      const queueChecker = makeMockQueueChecker([]);

      const checker = new unseenCheckerModule.ThreadUnseenChecker({
        userId,
        cursorStore,
        messageStore,
        queueChecker,
      });

      const result = await checker.checkUnseen({ threadId, catId });
      assert.notEqual(result, null);
      assert.equal(result.count, 1);
      assert.deepEqual(result.senders, ['定时任务']);
      assert.equal(result.maxMessageId, msg2);
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
      // maxMessageId must NOT start with 'queued:' — it must be a sortable cursor
      assert.ok(
        !result.maxMessageId.startsWith('queued:'),
        `maxMessageId must be sortable, got: ${result.maxMessageId}`,
      );
      // #1200: maxMessageId is now a v2 cursor (cursorFor wraps the synthetic ID).
      // Accept either raw sortable ID, v2 cursor with real ID, or v2 sentinel
      // cursor (id='0', used for queue fallback — sorts below all real IDs at same seq).
      assert.match(
        result.maxMessageId,
        /^(?:v2:\d{16}:(?:\d{16}-\d{6}-|0$)|\d{16}-\d{6}-)/,
        `maxMessageId must match sortable ID or v2 cursor format: ${result.maxMessageId}`,
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

    it('reports a queued same-cat cross-thread A2A entry as unseen work', async () => {
      const crossThreadMessageId = '0000000002-000001-queued-cross-thread';
      const messageStore = {
        getByThreadAfter: mock.fn(async () => []),
        getById: mock.fn(async (id) =>
          id === crossThreadMessageId
            ? {
                id,
                catId,
                content: '@opus queued parallel-self handoff',
                threadId,
                extra: {
                  crossPost: {
                    sourceThreadId: 'thread-source',
                    sourceInvocationId: 'inv-source',
                  },
                },
              }
            : null,
        ),
      };
      const queueChecker = makeMockQueueChecker([
        {
          entryId: 'queue-cross-thread',
          source: 'agent',
          sourceCategory: 'a2a',
          content: '@opus queued parallel-self handoff',
          callerCatId: catId,
          messageId: crossThreadMessageId,
        },
      ]);

      const checker = new unseenCheckerModule.ThreadUnseenChecker({
        userId,
        cursorStore: makeMockCursorStore(msg1),
        messageStore,
        queueChecker,
      });

      const result = await checker.checkUnseen({ threadId, catId });
      assert.notEqual(result, null, 'cross-thread A2A Queue entry must override the same-cat self filter');
      assert.equal(result.count, 1);
      assert.deepEqual(result.correlationMessageIds, [crossThreadMessageId]);
    });

    it('recognizes cross-thread provenance on a coalesced same-cat Queue entry', async () => {
      const sameThreadMessageId = '0000000002-000001-queued-same-thread';
      const crossThreadMessageId = '0000000003-000001-queued-cross-thread';
      const messages = new Map([
        [
          sameThreadMessageId,
          {
            id: sameThreadMessageId,
            catId,
            content: 'same-thread self message',
            threadId,
          },
        ],
        [
          crossThreadMessageId,
          {
            id: crossThreadMessageId,
            catId,
            content: '@opus coalesced parallel-self handoff',
            threadId,
            extra: { crossPost: { sourceThreadId: 'thread-source' } },
          },
        ],
      ]);
      const messageStore = {
        getByThreadAfter: mock.fn(async () => []),
        getById: mock.fn(async (id) => messages.get(id) ?? null),
      };
      const queueChecker = makeMockQueueChecker([
        {
          entryId: 'queue-coalesced-cross-thread',
          source: 'agent',
          sourceCategory: 'a2a',
          content: 'coalesced body',
          callerCatId: catId,
          messageId: sameThreadMessageId,
          mergedMessageIds: [crossThreadMessageId],
        },
      ]);

      const checker = new unseenCheckerModule.ThreadUnseenChecker({
        userId,
        cursorStore: makeMockCursorStore(msg1),
        messageStore,
        queueChecker,
      });

      const result = await checker.checkUnseen({ threadId, catId });
      assert.notEqual(result, null, 'any durable cross-thread trigger keeps the coalesced entry relevant');
      assert.deepEqual(result.correlationMessageIds, [sameThreadMessageId, crossThreadMessageId]);
    });

    it('keeps a queued same-cat same-thread A2A entry classified as self-source', async () => {
      const sameThreadMessageId = '0000000002-000001-queued-same-thread-a2a';
      const messageStore = {
        getByThreadAfter: mock.fn(async () => []),
        getById: mock.fn(async () => ({
          id: sameThreadMessageId,
          catId,
          content: 'same-thread self handoff',
          threadId,
        })),
      };
      const queueChecker = makeMockQueueChecker([
        {
          entryId: 'queue-same-thread-a2a',
          source: 'agent',
          sourceCategory: 'a2a',
          content: 'same-thread self handoff',
          callerCatId: catId,
          messageId: sameThreadMessageId,
        },
      ]);

      const checker = new unseenCheckerModule.ThreadUnseenChecker({
        userId,
        cursorStore: makeMockCursorStore(msg1),
        messageStore,
        queueChecker,
      });

      const result = await checker.checkUnseen({ threadId, catId });
      assert.equal(result, null, 'same-thread A2A must not masquerade as parallel-self work');
    });

    it('excludes expected A2A replies from delivered unseen notice', async () => {
      const cursorStore = makeMockCursorStore(msg1);
      const messageStore = makeMockMessageStore([
        {
          id: '0000000002-000001-trigger',
          catId,
          mentions: ['gpt52'],
          content: '@gpt52 请看',
          threadId,
        },
        {
          id: '0000000003-000001-reply',
          catId: 'gpt52',
          replyTo: '0000000002-000001-trigger',
          content: '收到',
          threadId,
        },
      ]);

      const checker = new unseenCheckerModule.ThreadUnseenChecker({
        userId,
        cursorStore,
        messageStore,
        queueChecker: makeMockQueueChecker([]),
      });

      const result = await checker.checkUnseen({ threadId, catId });
      assert.equal(result, null, 'target reply to this cat handoff should not create a freshness notice');
    });

    it('returns null after same cat has marked the queued entry seen', async () => {
      const queue = new queueModule.InvocationQueue();
      const enqueued = queue.enqueue({
        ownerAuthProvenance: 'unknown',
        threadId,
        userId,
        content: 'queued body already read',
        source: 'user',
        targetCats: [catId],
        intent: 'execute',
      });
      assert.equal(queue.markQueuedSeen(threadId, userId, enqueued.entry.id, catId), true);

      const checker = new unseenCheckerModule.ThreadUnseenChecker({
        userId,
        cursorStore: makeMockCursorStore(msg1),
        messageStore: makeMockMessageStore([]),
        queueChecker: wireModule.createQueueChecker(queue, { parentInvocationId: undefined }),
      });

      const result = await checker.checkUnseen({ threadId, catId });
      assert.equal(result, null, 'seen queued entries should not trigger notice');
    });
  });
});
