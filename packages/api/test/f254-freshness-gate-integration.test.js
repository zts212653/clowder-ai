/**
 * F254 Freshness Gate Integration Tests (Phase A — Layer 3)
 *
 * Tests the freshness gate wiring in the post_message callback context:
 * - checkFreshnessForPostMessage helper extracts unseen messages and delegates to FreshnessGateService
 * - Held envelope response format matches spec
 * - acknowledgeHeld escape hatch
 * - seenCursor push on forward
 * - Self-message exclusion in the wiring layer
 *
 * These tests use mock stores — Layer 1 (Redis-backed) and Layer 2 (pure logic)
 * are independently tested.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

/** @type {typeof import('../dist/domains/cats/services/freshness/FreshnessGateService.js')} */
let freshnessModule;
/** @type {typeof import('../dist/domains/cats/services/freshness/checkFreshnessForPostMessage.js')} */
let wireModule;

describe('F254 Freshness Gate Integration', async () => {
  freshnessModule = await import('../dist/domains/cats/services/freshness/FreshnessGateService.js');
  wireModule = await import('../dist/domains/cats/services/freshness/checkFreshnessForPostMessage.js');

  const userId = 'user-1';
  const catId = 'opus';
  const threadId = 'thread-1';
  const invocationId = 'inv-1';

  // Message IDs: lexicographic ordering
  const msg1 = '0000000001-000001-aaa'; // oldest
  const msg2 = '0000000002-000001-bbb';
  const msg3 = '0000000003-000001-ccc'; // newest

  function makeMockCursorStore(seenCursor = undefined) {
    return {
      getSeenCursor: mock.fn(async () => seenCursor),
      ackSeenCursor: mock.fn(async () => {}),
      getCursor: mock.fn(async () => null),
      ackCursor: mock.fn(async () => {}),
      deleteByThreadForUser: mock.fn(async () => {}),
    };
  }

  function makeMockMessageStore(messages = []) {
    return {
      getByThreadAfter: mock.fn(async () => messages),
      getByThread: mock.fn(async () => messages),
    };
  }

  /**
   * Paginating mock: respects afterId and limit like real stores.
   * Messages must be sorted by id (lexicographic).
   */
  function makePaginatingMessageStore(allMessages = []) {
    return {
      getByThreadAfter: mock.fn(async (_threadId, afterId, limit = 20) => {
        const startIdx = afterId ? allMessages.findIndex((m) => m.id > afterId) : 0;
        if (startIdx < 0) return [];
        return allMessages.slice(startIdx, startIdx + limit);
      }),
      getByThread: mock.fn(async () => allMessages),
    };
  }

  // -- AC-A1: held when there are unseen messages --

  it('returns held when thread has unseen messages from another cat', async () => {
    const cursorStore = makeMockCursorStore(msg1); // seen up to msg1
    const messageStore = makeMockMessageStore([
      { id: msg2, catId: 'codex', content: 'Wait, I found a bug!', threadId },
      { id: msg3, catId: null, content: 'Yeah hold on', threadId }, // user message
    ]);

    const result = await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'post_message',
      cursorStore,
      messageStore,
    });

    assert.equal(result.decision, 'held');
    assert.equal(result.unseenCount, 2);
    assert.ok(result.previews.length > 0, 'should have previews');
    assert.equal(result.previews[0].from, 'codex');
  });

  // -- AC-A5: acknowledgeHeld forces forward --

  it('returns forward when acknowledgeHeld is true even with unseen', async () => {
    const cursorStore = makeMockCursorStore(msg1);
    const messageStore = makeMockMessageStore([{ id: msg2, catId: 'codex', content: 'Hold on!', threadId }]);

    const result = await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'post_message',
      cursorStore,
      messageStore,
      acknowledgeHeld: true,
    });

    assert.equal(result.decision, 'forward');
    assert.equal(result.reason, 'acknowledge_held');
  });

  // -- AC-A3: fail-open when no seenCursor --

  it('returns forward (fail-open) when seenCursor does not exist', async () => {
    const cursorStore = makeMockCursorStore(undefined); // no cursor
    const messageStore = makeMockMessageStore([]);

    const result = await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'post_message',
      cursorStore,
      messageStore,
    });

    assert.equal(result.decision, 'forward');
    assert.equal(result.reason, 'cursor_missing_fail_open');
  });

  // -- Self-message exclusion --

  it('returns forward when all unseen messages are from self', async () => {
    const cursorStore = makeMockCursorStore(msg1);
    const messageStore = makeMockMessageStore([
      { id: msg2, catId: 'opus', content: 'My own message', threadId },
      { id: msg3, catId: 'opus', content: 'Another one from me', threadId },
    ]);

    const result = await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'post_message',
      cursorStore,
      messageStore,
    });

    assert.equal(result.decision, 'forward');
    assert.equal(result.reason, 'all_self_messages');
  });

  // -- AC-A2: seenCursor already caught up --

  it('returns forward when seenCursor >= latestMessageId (no unseen)', async () => {
    const cursorStore = makeMockCursorStore(msg3); // cursor at latest
    const messageStore = makeMockMessageStore([]); // no messages after cursor

    const result = await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'post_message',
      cursorStore,
      messageStore,
    });

    assert.equal(result.decision, 'forward');
  });

  // -- AC-A4: preview capping --

  it('caps previews at 3 and reports omittedCount', async () => {
    const cursorStore = makeMockCursorStore(msg1);
    const messageStore = makeMockMessageStore([
      { id: 'msg-a', catId: 'codex', content: 'Message 1', threadId },
      { id: 'msg-b', catId: null, content: 'Message 2', threadId },
      { id: 'msg-c', catId: 'sonnet', content: 'Message 3', threadId },
      { id: 'msg-d', catId: 'codex', content: 'Message 4', threadId },
      { id: 'msg-e', catId: null, content: 'Message 5', threadId },
    ]);

    const result = await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'post_message',
      cursorStore,
      messageStore,
    });

    assert.equal(result.decision, 'held');
    assert.equal(result.unseenCount, 5);
    assert.equal(result.previews.length, 3);
    assert.equal(result.omittedCount, 2);
  });

  // -- P1 fix: messageFilter excludes invisible messages from previews --

  it('messageFilter excludes invisible messages from held count and previews', async () => {
    const cursorStore = makeMockCursorStore(msg1);
    const messageStore = makeMockMessageStore([
      { id: msg2, catId: 'codex', content: 'Visible message', threadId, origin: 'callback' },
      { id: msg3, catId: 'sonnet', content: 'Hidden stream message', threadId, origin: 'stream' },
    ]);

    // Filter that excludes stream-origin messages (simulates play-mode filtering)
    const messageFilter = (msg) => msg.origin !== 'stream';

    const result = await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'post_message',
      cursorStore,
      messageStore,
      messageFilter,
    });

    assert.equal(result.decision, 'held');
    assert.equal(result.unseenCount, 1, 'only visible message should count');
    assert.equal(result.previews.length, 1);
    assert.equal(result.previews[0].from, 'codex');
  });

  it('messageFilter excluding ALL messages results in forward (not unclearable hold)', async () => {
    const cursorStore = makeMockCursorStore(msg1);
    const messageStore = makeMockMessageStore([
      { id: msg2, catId: 'sonnet', content: 'Hidden stream 1', threadId, origin: 'stream' },
      { id: msg3, catId: 'codex', content: 'Hidden stream 2', threadId, origin: 'stream' },
    ]);

    // All messages filtered out by play-mode rules
    const messageFilter = (msg) => msg.origin !== 'stream';

    const result = await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'post_message',
      cursorStore,
      messageStore,
      messageFilter,
    });

    assert.equal(result.decision, 'forward', 'no visible unseen messages → forward, not an unclearable hold');
  });

  // -- R3 P1 fix: pagination past filtered-out batches --

  it('paginates past 20 invisible messages to find the 21st relevant one', async () => {
    const cursorStore = makeMockCursorStore('0000000000-000000-start');
    // 20 hidden stream messages + 1 visible user message
    const allMessages = [];
    for (let i = 1; i <= 20; i++) {
      allMessages.push({
        id: `0000000${String(i).padStart(3, '0')}-000001-hidden`,
        catId: 'sonnet',
        content: `Hidden stream ${i}`,
        threadId,
        origin: 'stream',
      });
    }
    allMessages.push({
      id: '0000000021-000001-visible',
      catId: null,
      content: 'User changed their mind!',
      threadId,
      origin: 'user',
    });
    const messageStore = makePaginatingMessageStore(allMessages);

    // Play-mode filter: exclude stream from other cats
    const messageFilter = (msg) => msg.origin !== 'stream';

    const result = await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'post_message',
      cursorStore,
      messageStore,
      messageFilter,
    });

    assert.equal(result.decision, 'held', 'must paginate past hidden batch to find relevant message');
    assert.equal(result.unseenCount, 1);
    assert.equal(result.previews[0].preview, 'User changed their mind!');
    // Verify pagination happened: getByThreadAfter called at least twice
    assert.ok(messageStore.getByThreadAfter.mock.calls.length >= 2, 'should have paginated');
  });

  it('paginates past 20 self-messages to find the 21st from another cat', async () => {
    const cursorStore = makeMockCursorStore('0000000000-000000-start');
    const allMessages = [];
    for (let i = 1; i <= 20; i++) {
      allMessages.push({
        id: `0000000${String(i).padStart(3, '0')}-000001-self`,
        catId: 'opus', // same as the calling cat
        content: `My own message ${i}`,
        threadId,
      });
    }
    allMessages.push({
      id: '0000000021-000001-other',
      catId: 'codex',
      content: 'Wait, I found a bug!',
      threadId,
    });
    const messageStore = makePaginatingMessageStore(allMessages);

    const result = await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'post_message',
      cursorStore,
      messageStore,
    });

    assert.equal(result.decision, 'held', 'must paginate past self-messages to find other cat message');
    assert.ok(result.previews.some((p) => p.from === 'codex'));
  });

  // -- R4 P1 fix: fail-closed when pagination cap reached without thread exhaustion --

  it('holds (fail-closed) when pagination limit reached on filtered-out messages', async () => {
    const cursorStore = makeMockCursorStore('0000000000-000000-start');
    // Exactly 100 stream messages = 5 full batches of 20, all filtered.
    // Store indicates more may exist (each batch.length === 20).
    const allMessages = [];
    for (let i = 1; i <= 100; i++) {
      allMessages.push({
        id: `0000000${String(i).padStart(3, '0')}-000001-stream`,
        catId: 'sonnet',
        content: `Hidden stream ${i}`,
        threadId,
        origin: 'stream',
      });
    }
    const messageStore = makePaginatingMessageStore(allMessages);

    // Play-mode filter: exclude stream from other cats
    const messageFilter = (msg) => msg.origin !== 'stream';

    const result = await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'post_message',
      cursorStore,
      messageStore,
      messageFilter,
    });

    // Must NOT false-forward — we can't prove "no unseen"
    assert.equal(result.decision, 'held', 'pagination cap + thread not exhausted → fail-closed hold');
    assert.equal(result.reason, 'pagination_limit_uncertain');
  });

  it('holds (fail-closed) when pagination limit reached on self-messages', async () => {
    const cursorStore = makeMockCursorStore('0000000000-000000-start');
    // Exactly 100 self-messages = 5 full batches of 20.
    const allMessages = [];
    for (let i = 1; i <= 100; i++) {
      allMessages.push({
        id: `0000000${String(i).padStart(3, '0')}-000001-self`,
        catId: 'opus', // same as calling cat
        content: `My own message ${i}`,
        threadId,
      });
    }
    const messageStore = makePaginatingMessageStore(allMessages);

    const result = await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'post_message',
      cursorStore,
      messageStore,
    });

    // Must NOT false-forward — there might be a non-self message at #101
    assert.equal(result.decision, 'held', 'pagination cap + all self + not exhausted → fail-closed hold');
    assert.equal(result.reason, 'pagination_limit_uncertain');
  });

  // -- R2 P1 fix: deleted and briefing messages are excluded by messageFilter --

  it('messageFilter excludes deleted messages (prevents false holds on tombstones)', async () => {
    const cursorStore = makeMockCursorStore(msg1);
    const messageStore = makeMockMessageStore([
      { id: msg2, catId: 'codex', content: 'Deleted message', threadId, deletedAt: '2026-06-27T00:00:00Z' },
      { id: msg3, catId: 'sonnet', content: 'Live message', threadId, deletedAt: null },
    ]);

    // Baseline filter: exclude deleted messages (applies in all modes)
    const messageFilter = (msg) => !msg.deletedAt;

    const result = await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'post_message',
      cursorStore,
      messageStore,
      messageFilter,
    });

    assert.equal(result.decision, 'held');
    assert.equal(result.unseenCount, 1, 'deleted message should not count');
    assert.equal(result.previews[0].from, 'sonnet');
  });

  it('messageFilter excludes briefing-origin messages', async () => {
    const cursorStore = makeMockCursorStore(msg1);
    const messageStore = makeMockMessageStore([
      { id: msg2, catId: null, content: 'System briefing', threadId, origin: 'briefing' },
      { id: msg3, catId: null, content: 'Regular user message', threadId, origin: 'user' },
    ]);

    // Baseline filter: exclude briefing origin
    const messageFilter = (msg) => msg.origin !== 'briefing';

    const result = await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'post_message',
      cursorStore,
      messageStore,
      messageFilter,
    });

    assert.equal(result.decision, 'held');
    assert.equal(result.unseenCount, 1, 'briefing message should not count');
    assert.equal(result.previews[0].preview, 'Regular user message');
  });

  // -- getByThreadAfter called with correct seenCursor --

  it('queries messageStore.getByThreadAfter with the seenCursor', async () => {
    const cursorStore = makeMockCursorStore(msg2);
    const messageStore = makeMockMessageStore([]);

    await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'post_message',
      cursorStore,
      messageStore,
    });

    assert.equal(messageStore.getByThreadAfter.mock.calls.length, 1);
    const [callThreadId, callAfterId] = messageStore.getByThreadAfter.mock.calls[0].arguments;
    assert.equal(callThreadId, threadId);
    assert.equal(callAfterId, msg2, 'should query after the seenCursor value');
  });
});
