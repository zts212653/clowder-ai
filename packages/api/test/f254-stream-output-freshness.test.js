/**
 * F254 Phase D — Stream Output Freshness Check
 *
 * Tests the freshness check that runs before route-serial stores the cat's
 * stream text output. When the cat's text was generated while unseen user
 * messages existed, the output is "stale" — still stored (fail-open) but
 * marked and a forced re-invoke is triggered.
 *
 * Pure logic tests — no Redis needed (uses in-memory stores).
 *
 * [宪宪/Claude Opus 4.6🐾]
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

// --- Module under test (will be created) ---
const { checkStreamOutputFreshness } = await import(
  '../dist/domains/cats/services/freshness/checkStreamOutputFreshness.js'
);
const { createQueueChecker } = await import('../dist/domains/cats/services/freshness/checkFreshnessForPostMessage.js');
const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');
const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');

// --- Test fixtures ---
const userId = 'test-user';
const catId = 'opus';
const threadId = 'thread-test';

// Lexicographically sortable message IDs (same convention as Phase A tests)
const msgId1 = '0000000000000001-000001-aaaaaaaa';
const msgId2 = '0000000000000002-000001-bbbbbbbb';
const msgId3 = '0000000000000003-000001-cccccccc';
const msgId4 = '0000000000000004-000001-dddddddd';

function sortableMsgId(n, suffix = 'msg') {
  return `${String(n).padStart(16, '0')}-000001-${suffix}`;
}

/** Minimal in-memory message store implementing FreshnessMessageReader */
function createMockMessageStore(messages = []) {
  return {
    getById(id) {
      return messages.find((m) => m.id === id) ?? null;
    },
    getByThreadAfter(tid, afterId, limit, _uid) {
      let filtered = messages.filter((m) => m.threadId === tid);
      if (afterId) {
        filtered = filtered.filter((m) => m.id > afterId);
      }
      if (limit) {
        filtered = filtered.slice(0, limit);
      }
      return filtered;
    },
  };
}

/** Minimal mock queue checker */
function createMockQueueChecker(queuedMessages = []) {
  return {
    getQueuedForThread(_tid, _uid) {
      return queuedMessages;
    },
  };
}

describe('F254 Phase D — checkStreamOutputFreshness', () => {
  let cursorStore;

  beforeEach(() => {
    cursorStore = new DeliveryCursorStore(); // in-memory
  });

  // --- Fresh scenarios ---

  it('returns fresh when no seenCursor exists (fail-open, cursor_missing)', async () => {
    const messageStore = createMockMessageStore([]);
    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
    });
    assert.equal(result.stale, false);
    assert.equal(result.reason, 'cursor_missing');
    assert.equal(result.unseenCount, 0);
  });

  it('returns fresh when no messages after seenCursor', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId2);
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'hello', threadId },
      { id: msgId2, catId: null, content: 'world', threadId },
    ]);
    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
    });
    assert.equal(result.stale, false);
    assert.equal(result.reason, 'no_unseen');
    assert.equal(result.unseenCount, 0);
  });

  it('reads a persisted seen cursor with the fail-closed unresolved-anchor policy', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId2);
    let readOptions;
    const messageStore = {
      getByThreadAfter(_threadId, _afterId, _limit, _userId, options) {
        readOptions = options;
        return [];
      },
    };

    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
    });

    assert.equal(result.stale, false);
    assert.deepEqual(readOptions, { unresolvedCursorPolicy: 'empty' });
  });

  it('returns fresh when only self-messages exist after seenCursor (AC-D5)', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'user msg', threadId },
      { id: msgId2, catId, content: 'my own reply', threadId },
      { id: msgId3, catId, content: 'another self msg', threadId },
    ]);
    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
    });
    assert.equal(result.stale, false);
    assert.equal(result.reason, 'self_only');
    assert.equal(result.unseenCount, 0);
  });

  it('returns stale for a delivered same-cat cross-thread A2A message', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'original', threadId },
      {
        id: msgId2,
        catId,
        content: '@opus parallel-self handoff',
        threadId,
        extra: { crossPost: { sourceThreadId: 'thread-source', sourceInvocationId: 'inv-source' } },
      },
    ]);

    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
    });

    assert.equal(result.stale, true);
    assert.equal(result.reason, 'unseen_messages');
    assert.deepEqual(result.unseenMessageIds, [msgId2]);
  });

  it('returns fresh for an expected A2A reply to this cat handoff', async () => {
    const callerCatId = 'gpt52';
    const targetCatId = 'opus48';
    await cursorStore.ackSeenCursor(userId, callerCatId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      {
        id: msgId2,
        catId: callerCatId,
        mentions: [targetCatId],
        content: '@opus48 请 review',
        threadId,
      },
      {
        id: msgId3,
        catId: targetCatId,
        replyTo: msgId2,
        content: 'APPROVE，收到',
        threadId,
      },
    ]);

    const result = await checkStreamOutputFreshness({
      userId,
      catId: callerCatId,
      threadId,
      cursorStore,
      messageStore,
    });

    assert.equal(result.stale, false, 'target reply to caller handoff should not re-wake caller');
    assert.equal(result.reason, 'self_only');
    assert.equal(result.unseenCount, 0);
  });

  // --- Stale scenarios ---

  it('returns stale when unseen user messages exist after seenCursor', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'original msg', threadId },
      { id: msgId2, catId: null, content: 'new user msg during processing', threadId },
    ]);
    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
    });
    assert.equal(result.stale, true);
    assert.equal(result.reason, 'unseen_messages');
    assert.equal(result.unseenCount, 1);
    assert.deepEqual(result.unseenSenders, ['user']);
    assert.equal(result.seenCursor, msgId1);
    assert.equal(result.highWatermark, msgId2);
  });

  it('paginates from a v2 seen cursor without comparing it to a raw message id', async () => {
    const v2SeenCursor = `v2:0000000000000001:${msgId1}`;
    const v2NextCursor = `v2:0000000000000002:${msgId2}`;
    const requestedCursors = [];
    const messageStore = {
      getById: () => null,
      getByThreadAfter(_threadId, afterId) {
        requestedCursors.push(afterId);
        if (afterId === v2SeenCursor) {
          return [
            {
              id: msgId2,
              threadId,
              userId,
              catId: null,
              content: 'new user message after canonical cursor',
              visibilitySeq: 2,
            },
          ];
        }
        if (afterId === v2NextCursor) return [];
        throw new Error(`unexpected pagination cursor: ${afterId}`);
      },
    };

    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore: { getSeenCursor: async () => v2SeenCursor },
      messageStore,
    });

    assert.equal(result.reason, 'unseen_messages');
    assert.equal(result.scanComplete, true);
    assert.deepEqual(result.unseenMessageIds, [msgId2]);
    assert.deepEqual(requestedCursors, [v2SeenCursor]);
  });

  it('returns stale when unseen messages from another cat exist', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'original', threadId },
      { id: msgId2, catId: 'sonnet', content: 'hey opus!', threadId },
    ]);
    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
    });
    assert.equal(result.stale, true);
    assert.equal(result.reason, 'unseen_messages');
    assert.equal(result.unseenCount, 1);
    assert.deepEqual(result.unseenSenders, ['sonnet']);
  });

  it('returns stale for another cat reply when parent did not route to that cat', async () => {
    const callerCatId = 'gpt52';
    const targetCatId = 'opus48';
    await cursorStore.ackSeenCursor(userId, callerCatId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      {
        id: msgId2,
        catId: callerCatId,
        mentions: ['sonnet'],
        content: '@sonnet 请看',
        threadId,
      },
      {
        id: msgId3,
        catId: targetCatId,
        replyTo: msgId2,
        content: '插一句',
        threadId,
      },
    ]);

    const result = await checkStreamOutputFreshness({
      userId,
      catId: callerCatId,
      threadId,
      cursorStore,
      messageStore,
    });

    assert.equal(result.stale, true, 'unrelated cat reply remains a freshness candidate');
    assert.equal(result.reason, 'unseen_messages');
    assert.deepEqual(result.unseenSenders, [targetCatId]);
  });

  it('attributes unseen connector messages to the connector label instead of user', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'original', threadId },
      {
        id: msgId2,
        catId: null,
        content: 'GitHub review feedback',
        threadId,
        source: { connector: 'github-review', label: 'GitHub Review', icon: 'github' },
      },
    ]);
    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
    });
    assert.equal(result.stale, true);
    assert.equal(result.reason, 'unseen_messages');
    assert.equal(result.unseenCount, 1);
    assert.deepEqual(result.unseenSenders, ['GitHub Review']);
  });

  it('does not report the current connector trigger message as stream-stale', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'original', threadId },
      {
        id: msgId2,
        catId: null,
        content: 'GitHub CI passed',
        threadId,
        source: { connector: 'github-ci', label: 'GitHub CI/CD', icon: 'github' },
      },
    ]);
    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
      currentTriggerMessageId: msgId2,
    });
    assert.equal(result.stale, false);
    assert.equal(result.reason, 'self_only');
    assert.equal(result.unseenCount, 0);
  });

  it('still reports non-trigger connector messages as stream-stale', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'original', threadId },
      {
        id: msgId2,
        catId: null,
        content: 'GitHub CI passed',
        threadId,
        source: { connector: 'github-ci', label: 'GitHub CI/CD', icon: 'github' },
      },
      {
        id: msgId3,
        catId: null,
        content: 'New GitHub review',
        threadId,
        source: { connector: 'github-review-feedback', label: 'Review Feedback', icon: 'github' },
      },
    ]);
    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
      currentTriggerMessageId: msgId2,
    });
    assert.equal(result.stale, true);
    assert.equal(result.reason, 'unseen_messages');
    assert.equal(result.unseenCount, 1);
    assert.deepEqual(result.unseenSenders, ['Review Feedback']);
    assert.equal(result.highWatermark, msgId3);
  });

  it('returns stale when queued messages exist (F117 queue awareness)', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([{ id: msgId1, catId: null, content: 'original', threadId }]);
    const queueChecker = createMockQueueChecker([
      { source: 'user', content: 'queued msg during cat run', messageId: msgId2 },
    ]);
    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
      queueChecker,
    });
    assert.equal(result.stale, true);
    assert.equal(result.reason, 'queued_messages');
    assert.ok(result.unseenCount >= 1);
    assert.deepEqual(result.unseenMessageIds, [msgId2]);
  });

  it('ADR-042 scans delivered messages only through the exact pre-append frontier', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'original trigger', threadId },
      { id: msgId2, catId: null, content: 'arrived before publication', threadId },
      { id: msgId3, catId: null, content: 'arrived after publication', threadId },
    ]);

    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      throughMessageId: msgId2,
      cursorStore,
      messageStore,
    });

    assert.equal(result.stale, true);
    assert.deepEqual(result.unseenMessageIds, [msgId2]);
    assert.equal(result.highWatermark, msgId2);
  });

  it('ADR-042 excludes queued identities allocated after the exact pre-append frontier', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'original trigger', threadId },
      { id: msgId2, catId: catId, content: 'self output boundary', threadId },
    ]);
    const queueChecker = createMockQueueChecker([
      { source: 'user', content: 'queued after publication', messageId: msgId3 },
    ]);

    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      throughMessageId: msgId2,
      cursorStore,
      messageStore,
      queueChecker,
    });

    assert.equal(result.stale, false);
    assert.deepEqual(result.unseenMessageIds, []);
  });

  it('ADR-042 does not let later merged cross-thread provenance reclassify an earlier self queue identity', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messages = new Map([
      [msgId2, { id: msgId2, catId, content: 'same-thread self work', threadId }],
      [
        msgId3,
        {
          id: msgId3,
          catId,
          content: '@opus later parallel-self handoff',
          threadId,
          extra: { crossPost: { sourceThreadId: 'thread-source', sourceInvocationId: 'inv-source' } },
        },
      ],
    ]);
    const messageStore = {
      getByThreadAfter: () => [],
      getById: (id) => messages.get(id) ?? null,
    };
    const queueChecker = createMockQueueChecker([
      {
        entryId: 'queue-coalesced-boundary',
        source: 'agent',
        sourceCategory: 'a2a',
        callerCatId: catId,
        content: 'coalesced queue body',
        messageId: msgId2,
        mergedMessageIds: [msgId3],
      },
    ]);

    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      throughMessageId: msgId2,
      cursorStore,
      messageStore,
      queueChecker,
    });

    assert.equal(result.stale, false);
    assert.deepEqual(result.unseenMessageIds, []);
  });

  it('fails closed when queued work has no durable message identity', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([{ id: msgId1, catId: null, content: 'original', threadId }]);
    const queueChecker = createMockQueueChecker([{ source: 'user', content: 'identity-less queue row' }]);
    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
      queueChecker,
    });
    assert.equal(result.stale, true);
    assert.equal(result.reason, 'queued_identity_missing');
    assert.equal(result.scanComplete, false);
  });

  it('excludes queued messages from self (callerCatId matches)', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([{ id: msgId1, catId: null, content: 'original', threadId }]);
    const queueChecker = createMockQueueChecker([
      { source: 'agent', content: 'my own queued msg', callerCatId: catId },
    ]);
    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
      queueChecker,
    });
    assert.equal(result.stale, false);
    assert.equal(result.reason, 'no_unseen');
  });

  it('returns stale for a queued same-cat cross-thread A2A message', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = {
      getByThreadAfter: () => [],
      getById: (id) =>
        id === msgId2
          ? {
              id,
              catId,
              content: '@opus queued parallel-self handoff',
              threadId,
              extra: { crossPost: { sourceThreadId: 'thread-source', sourceInvocationId: 'inv-source' } },
            }
          : null,
    };
    const queueChecker = createMockQueueChecker([
      {
        entryId: 'queue-cross-thread',
        source: 'agent',
        sourceCategory: 'a2a',
        callerCatId: catId,
        content: '@opus queued parallel-self handoff',
        messageId: msgId2,
      },
    ]);

    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
      queueChecker,
    });

    assert.equal(result.stale, true);
    assert.equal(result.reason, 'queued_messages');
    assert.deepEqual(result.unseenMessageIds, [msgId2]);
  });

  it('does not report queued stale after same cat has marked the queued entry seen', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const queue = new InvocationQueue();
    const enqueued = queue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId,
      userId,
      content: 'queued msg already read',
      source: 'user',
      targetCats: [catId],
      intent: 'execute',
    });
    assert.equal(queue.markQueuedSeen(threadId, userId, enqueued.entry.id, catId), true);

    const messageStore = createMockMessageStore([{ id: msgId1, catId: null, content: 'original', threadId }]);
    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
      queueChecker: createQueueChecker(queue, { parentInvocationId: undefined }),
    });

    assert.equal(result.stale, false);
    assert.equal(result.reason, 'no_unseen');
  });

  it('counts multiple unseen senders correctly', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'original', threadId },
      { id: msgId2, catId: null, content: 'user msg', threadId },
      { id: msgId3, catId: 'sonnet', content: 'sonnet msg', threadId },
      { id: msgId4, catId: null, content: 'another user msg', threadId },
    ]);
    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
    });
    assert.equal(result.stale, true);
    assert.equal(result.unseenCount, 3);
    assert.equal(result.highWatermark, msgId4);
    // user appears as unique sender (deduped)
    assert.ok(result.unseenSenders.includes('user'));
    assert.ok(result.unseenSenders.includes('sonnet'));
    assert.equal(result.unseenSenders.length, 2);
  });

  // --- Event callback (AC-D4) ---

  it('calls onEvent with stream_stale_detected when stale (AC-D4)', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'original', threadId },
      { id: msgId2, catId: null, content: 'new msg', threadId },
    ]);
    const events = [];
    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.stale, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'stream_stale_detected');
    assert.equal(events[0].unseenCount, 1);
    assert.deepEqual(events[0].unseenSenders, ['user']);
    assert.equal(events[0].reason, 'unseen_messages');
    assert.equal(events[0].catId, catId);
    assert.equal(events[0].threadId, threadId);
  });

  it('calls onEvent with stream_fresh when fresh (AC-D4)', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId2);
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'seen msg', threadId },
      { id: msgId2, catId: null, content: 'seen msg 2', threadId },
    ]);
    const events = [];
    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.stale, false);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'stream_fresh');
    assert.equal(events[0].reason, 'no_unseen');
  });

  it('does not throw when onEvent is not provided (backward compat)', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'original', threadId },
      { id: msgId2, catId: null, content: 'new', threadId },
    ]);
    // No onEvent — must not throw
    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
    });
    assert.equal(result.stale, true);
  });

  // --- messageFilter (cloud P1: honor route visibility) ---

  it('excludes filtered-out messages from unseen count when messageFilter is provided', async () => {
    // Play-mode: other cat's origin:'stream' is invisible — should not trigger stale
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'original', threadId },
      { id: msgId2, catId: 'sonnet', content: 'sonnet stream output', threadId, origin: 'stream' },
    ]);
    // Filter mimics play-mode: exclude other cats' origin:'stream'
    const messageFilter = (msg) => !(msg.catId && msg.catId !== catId && msg.origin === 'stream');
    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
      messageFilter,
    });
    assert.equal(result.stale, false, 'should be fresh — filtered message is invisible');
    assert.equal(result.unseenCount, 0);
  });

  it('still detects stale user messages even with messageFilter active', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'original', threadId },
      { id: msgId2, catId: 'sonnet', content: 'sonnet stream', threadId, origin: 'stream' },
      { id: msgId3, catId: null, content: 'real user msg', threadId },
    ]);
    const messageFilter = (msg) => !(msg.catId && msg.catId !== catId && msg.origin === 'stream');
    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
      messageFilter,
    });
    assert.equal(result.stale, true, 'user message should still trigger stale');
    assert.equal(result.unseenCount, 1);
    assert.deepEqual(result.unseenSenders, ['user']);
  });

  it('excludes system notices from unseen count when messageFilter filters userId=system', async () => {
    // System notices (verdict-no-pass-hint, void-hold-hint) have userId='system', catId=null.
    // Without filter they'd be counted as "user" messages → false stale.
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'original', threadId },
      { id: msgId2, catId: null, content: '[球权提醒]: ...', threadId, userId: 'system' },
      { id: msgId3, catId: null, content: '[持球提醒]: ...', threadId, userId: 'system' },
    ]);
    const messageFilter = (msg) => {
      if (msg.userId === 'system') return false;
      return true;
    };
    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
      messageFilter,
    });
    assert.equal(result.stale, false, 'system notices should not trigger stale');
    assert.equal(result.unseenCount, 0);
  });

  it('counts scheduler trigger messages as unseen because they enter the next prompt', async () => {
    // Hold-ball and scheduled-task triggers are scheduler-authored, but they are
    // real prompt-visible work. They must not be filtered with display-only system notices.
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'original', threadId },
      {
        id: msgId2,
        catId: null,
        content: '⏰ 条件探针已满足，球回到 @opus',
        threadId,
        userId: 'scheduler',
        source: { connector: 'scheduler', label: '定时任务' },
      },
    ]);
    const messageFilter = (msg) => {
      if (msg.userId === 'system') return false;
      return true;
    };
    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
      messageFilter,
    });
    assert.equal(result.stale, true, 'scheduler trigger messages should trigger stale');
    assert.equal(result.reason, 'unseen_messages');
    assert.equal(result.unseenCount, 1);
    assert.deepEqual(result.unseenSenders, ['定时任务']);
  });

  it('excludes briefing messages from unseen count (origin=briefing never enters prompt)', async () => {
    // F148 Phase E: briefing messages are non-routing display-only.
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'original', threadId },
      { id: msgId2, catId: null, content: 'briefing content', threadId, origin: 'briefing' },
    ]);
    const messageFilter = (msg) => {
      if (msg.origin === 'briefing') return false;
      return true;
    };
    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
      messageFilter,
    });
    assert.equal(result.stale, false, 'briefing messages should not trigger stale');
    assert.equal(result.unseenCount, 0);
  });

  it('excludes tool-only empty cat stream messages from unseen count', async () => {
    // A cat can persist an empty stream bubble containing only tool events while
    // it is still working. That is not a routable message and must not trigger
    // a Freshness re-invoke for another cat.
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'original', threadId },
      {
        id: msgId2,
        catId: 'sonnet',
        content: '',
        threadId,
        origin: 'stream',
        toolEvents: [{ type: 'tool_use', toolName: 'cat_cafe_get_thread_context' }],
      },
    ]);
    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
    });
    assert.equal(result.stale, false, 'empty tool-only stream should not trigger stale');
    assert.equal(result.unseenCount, 0);
  });

  it('excludes route-guard failure diagnostics from unseen count without a caller filter', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'original', threadId },
      {
        id: msgId2,
        catId: null,
        userId: 'system',
        content: '[路由守卫]: 补救失败，第二次回复仍没有合法的路由出口。',
        threadId,
        source: { connector: 'routing-guard-failure', label: '路由守卫失败' },
      },
    ]);
    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
    });
    assert.equal(result.stale, false, 'routing-guard diagnostics are internal, not new work');
    assert.equal(result.unseenCount, 0);
  });

  it('excludes hidden whispers from unseen count (canViewMessage check)', async () => {
    // F35: whisper addressed to another cat — invisible to this cat in play mode.
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'original', threadId },
      { id: msgId2, catId: 'sonnet', content: 'secret whisper', threadId, visibility: 'whisper', whisperTo: ['gpt52'] },
    ]);
    // Mirror canViewMessage logic for play-mode cat viewer
    const messageFilter = (msg) => {
      if (msg.visibility === 'whisper' && !msg.revealedAt) {
        const to = msg.whisperTo;
        if (!Array.isArray(to) || !to.includes(catId)) return false;
      }
      return true;
    };
    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
      messageFilter,
    });
    assert.equal(result.stale, false, 'whisper to another cat should not trigger stale');
    assert.equal(result.unseenCount, 0);
  });

  it('includes whispers addressed TO this cat as unseen (visible whisper triggers stale)', async () => {
    // F35: whisper addressed to this cat — visible, should trigger stale.
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'original', threadId },
      { id: msgId2, catId: 'sonnet', content: 'hey opus!', threadId, visibility: 'whisper', whisperTo: [catId] },
    ]);
    const messageFilter = (msg) => {
      if (msg.visibility === 'whisper' && !msg.revealedAt) {
        const to = msg.whisperTo;
        if (!Array.isArray(to) || !to.includes(catId)) return false;
      }
      return true;
    };
    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
      messageFilter,
    });
    assert.equal(result.stale, true, 'whisper addressed to this cat should trigger stale');
    assert.equal(result.unseenCount, 1);
  });

  // --- Pagination (cloud P2: continue scanning beyond first batch) ---

  it('paginates beyond all-self first batch to find unseen user message', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    // Build 20 self-messages (fills first batch) + 1 user message beyond limit
    const selfMsgs = Array.from({ length: 20 }, (_, i) => ({
      id: `0000000000000${String(i + 2).padStart(3, '0')}-000001-self${String(i).padStart(4, '0')}`,
      catId,
      content: `self msg ${i}`,
      threadId,
    }));
    const userMsgBeyondLimit = {
      id: '0000000000000099-000001-userlate',
      catId: null,
      content: 'user message at position 21',
      threadId,
    };
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'original', threadId },
      ...selfMsgs,
      userMsgBeyondLimit,
    ]);
    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
    });
    assert.equal(result.stale, true, 'should detect user message beyond first batch');
    assert.equal(result.reason, 'unseen_messages');
    assert.ok(result.unseenCount >= 1);
  });

  it('paginates all unseen pages before deriving count and highWatermark for single-flight', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const unseenMsgs = Array.from({ length: 25 }, (_, i) => ({
      id: sortableMsgId(i + 2, `user${String(i).padStart(4, '0')}`),
      catId: null,
      content: `user msg ${i}`,
      threadId,
    }));
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'original', threadId },
      ...unseenMsgs,
    ]);

    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
    });

    assert.equal(result.stale, true);
    assert.equal(result.reason, 'unseen_messages');
    assert.equal(result.unseenCount, 25);
    assert.equal(result.highWatermark, unseenMsgs[24].id);
  });

  it('does not truncate the closure frontier after 100 unseen messages', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const unseenMsgs = Array.from({ length: 125 }, (_, i) => ({
      id: sortableMsgId(i + 2, `bulk${String(i).padStart(4, '0')}`),
      catId: null,
      content: `user msg ${i}`,
      threadId,
    }));
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'original', threadId },
      ...unseenMsgs,
    ]);

    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
    });

    assert.equal(result.stale, true);
    assert.equal(result.unseenCount, unseenMsgs.length);
    assert.equal(result.highWatermark, unseenMsgs.at(-1).id);
  });

  it('IR-6: ignores a user message explicitly directed only to another cat', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'original', threadId },
      { id: msgId2, catId: null, content: '@fable5 only', mentions: ['fable5'], threadId },
    ]);

    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
    });

    assert.equal(result.stale, false);
    assert.equal(result.reason, 'self_only');
    assert.equal(result.unseenCount, 0);
  });

  it('IR-6: ignores explicit targetCats that do not include the current cat', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'original', threadId },
      {
        id: msgId2,
        catId: null,
        content: 'steer only fable',
        mentions: [],
        extra: { targetCats: ['fable5'] },
        threadId,
      },
    ]);

    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
    });

    assert.equal(result.stale, false);
    assert.equal(result.reason, 'self_only');
  });

  it('IR-6: does not let one cat closure replacement stale another cat', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'original', threadId },
      {
        id: msgId2,
        catId: 'fable5',
        content: 'replacement answer',
        mentions: [],
        extra: {
          freshness: {
            kind: 'closure_replacement',
            closureId: 'closure-fable',
            targetCatId: 'fable5',
            originTriggerMessageId: msgId1,
          },
        },
        threadId,
      },
    ]);

    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
    });

    assert.equal(result.stale, false);
    assert.equal(result.reason, 'self_only');
  });

  it('IR-6: ignores a sibling result from the same parallel batch', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'original', threadId },
      {
        id: msgId2,
        catId: 'fable5',
        content: 'same-batch sibling answer',
        mentions: [],
        extra: { stream: { parallelBatchId: 'batch-1' } },
        threadId,
      },
    ]);

    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      parallelBatchId: 'batch-1',
      cursorStore,
      messageStore,
    });

    assert.equal(result.stale, false);
    assert.equal(result.reason, 'self_only');
  });

  it('ignores a sibling reply causally rooted in a trigger already covered by this prompt', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      { id: msgId1, catId: null, content: 'M1 only routes Fable', threadId },
      { id: msgId2, catId: null, content: 'M2 asks this cat to look too', threadId },
      {
        id: msgId3,
        catId: 'fable5',
        content: 'Fable answer to M1',
        mentions: [],
        extra: {
          causal: { kind: 'invocation_reply', triggerMessageId: msgId1 },
        },
        threadId,
      },
    ]);

    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      currentTriggerMessageId: msgId2,
      coveredMessageIds: [msgId1, msgId2],
      cursorStore,
      messageStore,
    });

    assert.equal(result.stale, false, 'same-wave sibling answer is already represented by current prompt causality');
    assert.equal(result.reason, 'self_only');
    assert.equal(result.unseenCount, 0);
    assert.deepEqual(result.relevanceSuppressions, { same_user_wave_sibling_reply: 1 });
  });

  it('keeps a same-wave sibling reply relevant when it explicitly directs new work to this cat', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = createMockMessageStore([
      {
        id: msgId3,
        catId: 'fable5',
        content: '@opus please act on this finding',
        mentions: [catId],
        extra: {
          causal: { kind: 'invocation_reply', triggerMessageId: msgId1 },
        },
        threadId,
      },
    ]);

    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      currentTriggerMessageId: msgId2,
      coveredMessageIds: [msgId1, msgId2],
      cursorStore,
      messageStore,
    });

    assert.equal(result.stale, true);
    assert.deepEqual(result.unseenMessageIds, [msgId3]);
  });

  it('keeps a causally independent late cat reply relevant', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const independentTriggerId = '0000000000000000-000001-independent';
    const messageStore = createMockMessageStore([
      {
        id: msgId3,
        catId: 'fable5',
        content: 'new independent finding',
        mentions: [],
        extra: {
          causal: { kind: 'invocation_reply', triggerMessageId: independentTriggerId },
        },
        threadId,
      },
    ]);

    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      currentTriggerMessageId: msgId2,
      coveredMessageIds: [msgId1, msgId2],
      cursorStore,
      messageStore,
    });

    assert.equal(result.stale, true);
    assert.deepEqual(result.unseenMessageIds, [msgId3]);
  });

  // --- Fail-open ---

  it('returns fresh on messageStore error (fail-open, AC-D3)', async () => {
    await cursorStore.ackSeenCursor(userId, catId, threadId, msgId1);
    const messageStore = {
      getByThreadAfter() {
        throw new Error('Redis connection lost');
      },
    };
    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore,
      messageStore,
    });
    assert.equal(result.stale, false);
    assert.equal(result.reason, 'error_failopen');
  });

  it('returns fresh on cursorStore error (fail-open, AC-D3)', async () => {
    const badCursorStore = {
      getSeenCursor() {
        throw new Error('Redis timeout');
      },
    };
    const messageStore = createMockMessageStore([]);
    const result = await checkStreamOutputFreshness({
      userId,
      catId,
      threadId,
      cursorStore: badCursorStore,
      messageStore,
    });
    assert.equal(result.stale, false);
    assert.equal(result.reason, 'error_failopen');
  });
});
