/**
 * F254 AC-A6 + AC-A7 Tests
 *
 * AC-A6: cross_post_message + multi_mention freshness gate coverage
 * AC-A7: held/forward decisions recorded as FreshnessAttentionEvent
 *
 * Tests the checkFreshnessForPostMessage wiring layer with event log recording.
 * FreshnessGateService core logic is tested separately in f254-freshness-gate.test.js.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

/** @type {typeof import('../dist/domains/cats/services/freshness/checkFreshnessForPostMessage.js')} */
let wireModule;

const userId = 'user-1';
const catId = 'opus';
const threadId = 'thread-1';
const invocationId = 'inv-a6a7';

// Lexicographically sortable message IDs
const msg1 = '0000000001-000001-aaa';
const msg2 = '0000000002-000001-bbb';
const msg3 = '0000000003-000001-ccc';

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

/** In-memory mock for FreshnessAttentionEventLog */
function makeMockEventLog() {
  const events = [];
  return {
    events,
    append: mock.fn(async (event) => {
      events.push(event);
    }),
    queryByInvocation: mock.fn(async () => events),
    getUnresolvedNotices: mock.fn(async () => []),
  };
}

describe('F254 AC-A6: cross_post_message + multi_mention tool coverage', async () => {
  wireModule = await import('../dist/domains/cats/services/freshness/checkFreshnessForPostMessage.js');

  it('cross_post_message toolName is preserved in held decision', async () => {
    const cursorStore = makeMockCursorStore(msg1);
    const messageStore = makeMockMessageStore([{ id: msg2, catId: 'codex', content: 'Wait!', threadId }]);

    const result = await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'cross_post_message', // AC-A6: cross_post uses its own name
      cursorStore,
      messageStore,
    });

    assert.equal(result.decision, 'held');
    assert.equal(result.toolName, 'cross_post_message');
  });

  it('cross_post_message toolName is preserved in forward decision', async () => {
    const cursorStore = makeMockCursorStore(msg3); // cursor caught up
    const messageStore = makeMockMessageStore([]);

    const result = await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'cross_post_message',
      cursorStore,
      messageStore,
    });

    assert.equal(result.decision, 'forward');
    assert.equal(result.toolName, 'cross_post_message');
  });

  it('multi_mention toolName is preserved in held decision', async () => {
    const cursorStore = makeMockCursorStore(msg1);
    const messageStore = makeMockMessageStore([{ id: msg2, catId: null, content: 'New user message', threadId }]);

    const result = await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'multi_mention', // AC-A6: multi_mention coverage
      cursorStore,
      messageStore,
    });

    assert.equal(result.decision, 'held');
    assert.equal(result.toolName, 'multi_mention');
  });

  it('multi_mention fail-open when seenCursor missing', async () => {
    const cursorStore = makeMockCursorStore(undefined);
    const messageStore = makeMockMessageStore([]);

    const result = await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'multi_mention',
      cursorStore,
      messageStore,
    });

    assert.equal(result.decision, 'forward');
    assert.equal(result.reason, 'cursor_missing_fail_open');
  });

  it('multi_mention messageFilter excludes deleted messages from unseen count (P1 fix)', async () => {
    const cursorStore = makeMockCursorStore(msg1);
    // msg2 is deleted, msg3 is alive — only msg3 should count as unseen
    const messageStore = makeMockMessageStore([
      { id: msg2, catId: 'codex', content: 'Deleted message', threadId, deletedAt: Date.now() },
      { id: msg3, catId: 'codex', content: 'Live message', threadId },
    ]);

    // Without filter: both messages count
    const unfiltered = await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'multi_mention',
      cursorStore,
      messageStore,
    });
    assert.equal(unfiltered.decision, 'held');
    assert.equal(unfiltered.unseenCount, 2, 'without filter: both count');

    // With filter: deleted message excluded
    const filtered = await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'multi_mention',
      cursorStore,
      messageStore,
      messageFilter: (msg) => !msg.deletedAt,
    });
    assert.equal(filtered.decision, 'held');
    assert.equal(filtered.unseenCount, 1, 'with filter: deleted excluded');
  });

  it('multi_mention messageFilter forwards when all unseen are invisible (P1 fix)', async () => {
    const cursorStore = makeMockCursorStore(msg1);
    // All unseen messages are deleted → should forward, not hold
    const messageStore = makeMockMessageStore([
      { id: msg2, catId: 'codex', content: 'Deleted', threadId, deletedAt: Date.now() },
    ]);

    const result = await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'multi_mention',
      cursorStore,
      messageStore,
      messageFilter: (msg) => !msg.deletedAt,
    });
    assert.equal(result.decision, 'forward');
    assert.equal(result.reason, 'no_unseen');
  });
});

describe('F254 AC-A7: held/forward decisions recorded as freshness events', async () => {
  wireModule = await import('../dist/domains/cats/services/freshness/checkFreshnessForPostMessage.js');

  it('records held_decision event when gate holds', async () => {
    const cursorStore = makeMockCursorStore(msg1);
    const messageStore = makeMockMessageStore([
      { id: msg2, catId: 'codex', content: 'Wait, I found a bug!', threadId },
    ]);
    const eventLog = makeMockEventLog();

    const result = await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'post_message',
      cursorStore,
      messageStore,
      eventLog,
    });

    assert.equal(result.decision, 'held');
    assert.equal(eventLog.append.mock.calls.length, 1);

    const recorded = eventLog.events[0];
    assert.equal(recorded.kind, 'held_decision');
    assert.equal(recorded.threadId, threadId);
    assert.equal(recorded.catId, catId);
    assert.equal(recorded.invocationId, invocationId);
    assert.equal(recorded.toolName, 'post_message');
    assert.equal(recorded.unseenCount, 1);
    assert.equal(recorded.reason, 'unseen_available');
    assert.equal(typeof recorded.timestamp, 'number');
  });

  it('records forward_decision event when gate forwards', async () => {
    const cursorStore = makeMockCursorStore(msg3); // cursor caught up
    const messageStore = makeMockMessageStore([]);
    const eventLog = makeMockEventLog();

    const result = await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'post_message',
      cursorStore,
      messageStore,
      eventLog,
    });

    assert.equal(result.decision, 'forward');
    assert.equal(eventLog.append.mock.calls.length, 1);

    const recorded = eventLog.events[0];
    assert.equal(recorded.kind, 'forward_decision');
    assert.equal(recorded.threadId, threadId);
    assert.equal(recorded.catId, catId);
    assert.equal(recorded.invocationId, invocationId);
    assert.equal(recorded.toolName, 'post_message');
    assert.equal(recorded.reason, 'no_unseen');
    assert.equal(typeof recorded.timestamp, 'number');
  });

  it('records forward_decision for acknowledgeHeld bypass', async () => {
    const cursorStore = makeMockCursorStore(msg1);
    const messageStore = makeMockMessageStore([{ id: msg2, catId: 'codex', content: 'Wait!', threadId }]);
    const eventLog = makeMockEventLog();

    const result = await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'post_message',
      cursorStore,
      messageStore,
      acknowledgeHeld: true,
      eventLog,
    });

    assert.equal(result.decision, 'forward');
    assert.equal(result.reason, 'acknowledge_held');
    assert.equal(eventLog.events[0].kind, 'forward_decision');
    assert.equal(eventLog.events[0].reason, 'acknowledge_held');
  });

  it('records forward_decision for fail-open (cursor missing)', async () => {
    const cursorStore = makeMockCursorStore(undefined);
    const messageStore = makeMockMessageStore([]);
    const eventLog = makeMockEventLog();

    const result = await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'post_message',
      cursorStore,
      messageStore,
      eventLog,
    });

    assert.equal(result.decision, 'forward');
    assert.equal(eventLog.events[0].kind, 'forward_decision');
    assert.equal(eventLog.events[0].reason, 'cursor_missing_fail_open');
  });

  it('records correct toolName in events for cross_post_message', async () => {
    const cursorStore = makeMockCursorStore(msg1);
    const messageStore = makeMockMessageStore([{ id: msg2, catId: 'codex', content: 'Hey', threadId }]);
    const eventLog = makeMockEventLog();

    await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'cross_post_message',
      cursorStore,
      messageStore,
      eventLog,
    });

    assert.equal(eventLog.events[0].toolName, 'cross_post_message');
  });

  it('records held_decision with multi_mention toolName and messageFilter (P1 fix combined)', async () => {
    const cursorStore = makeMockCursorStore(msg1);
    const messageStore = makeMockMessageStore([
      { id: msg2, catId: 'codex', content: 'Deleted', threadId, deletedAt: Date.now() },
      { id: msg3, catId: null, content: 'Live user message', threadId },
    ]);
    const eventLog = makeMockEventLog();

    const result = await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'multi_mention',
      cursorStore,
      messageStore,
      messageFilter: (msg) => !msg.deletedAt,
      eventLog,
    });

    assert.equal(result.decision, 'held');
    assert.equal(result.unseenCount, 1, 'deleted message filtered out');
    assert.equal(eventLog.append.mock.calls.length, 1);
    const recorded = eventLog.events[0];
    assert.equal(recorded.kind, 'held_decision');
    assert.equal(recorded.toolName, 'multi_mention');
    assert.equal(recorded.unseenCount, 1);
  });

  it('does not record events when eventLog is not provided', async () => {
    const cursorStore = makeMockCursorStore(msg1);
    const messageStore = makeMockMessageStore([{ id: msg2, catId: 'codex', content: 'Wait!', threadId }]);

    // No eventLog passed — should not throw
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
    // No assertion on events — just verifying no crash
  });

  it('does not record events when invocationId is missing', async () => {
    const cursorStore = makeMockCursorStore(msg3);
    const messageStore = makeMockMessageStore([]);
    const eventLog = makeMockEventLog();

    const result = await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      // invocationId omitted
      toolName: 'post_message',
      cursorStore,
      messageStore,
      eventLog,
    });

    assert.equal(result.decision, 'forward');
    assert.equal(eventLog.append.mock.calls.length, 0, 'no event without invocationId');
  });

  it('event recording is fail-open: gate decision returned even if append throws', async () => {
    const cursorStore = makeMockCursorStore(msg1);
    const messageStore = makeMockMessageStore([{ id: msg2, catId: 'codex', content: 'Wait!', threadId }]);
    const eventLog = {
      ...makeMockEventLog(),
      append: mock.fn(async () => {
        throw new Error('Redis connection lost');
      }),
    };

    // Should not throw — event recording failure is silent
    const result = await wireModule.checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      invocationId,
      toolName: 'post_message',
      cursorStore,
      messageStore,
      eventLog,
    });

    assert.equal(result.decision, 'held');
    assert.equal(eventLog.append.mock.calls.length, 1, 'append was attempted');
  });
});
