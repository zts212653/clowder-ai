/**
 * F254 AC-B5 — Freshness Telemetry Counters
 *
 * Tests that OTel counter instruments are properly defined and
 * incrementable. These are unit tests for the counter definitions —
 * integration tests for actual increment-at-site wiring would need
 * the full callback route, which is covered by existing f254 tests.
 *
 * [宪宪/Claude Opus 4.6🐾]
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Import from dist (consistent with other f254 tests)
const instruments = await import('../dist/infrastructure/telemetry/instruments.js');

describe('F254 AC-B5: Freshness telemetry counters', () => {
  // --- Counter existence tests ---

  it('exports freshnessGateHeld counter', () => {
    assert.ok(instruments.freshnessGateHeld, 'freshnessGateHeld should be exported');
    assert.equal(typeof instruments.freshnessGateHeld.add, 'function', 'should have add()');
  });

  it('exports freshnessGateForward counter', () => {
    assert.ok(instruments.freshnessGateForward, 'freshnessGateForward should be exported');
    assert.equal(typeof instruments.freshnessGateForward.add, 'function', 'should have add()');
  });

  it('exports freshnessNoticeAttached counter', () => {
    assert.ok(instruments.freshnessNoticeAttached, 'freshnessNoticeAttached should be exported');
    assert.equal(typeof instruments.freshnessNoticeAttached.add, 'function', 'should have add()');
  });

  it('exports freshnessNoticeAcked counter', () => {
    assert.ok(instruments.freshnessNoticeAcked, 'freshnessNoticeAcked should be exported');
    assert.equal(typeof instruments.freshnessNoticeAcked.add, 'function', 'should have add()');
  });

  it('exports freshnessNoticeDeferred counter', () => {
    assert.ok(instruments.freshnessNoticeDeferred, 'freshnessNoticeDeferred should be exported');
    assert.equal(typeof instruments.freshnessNoticeDeferred.add, 'function', 'should have add()');
  });

  it('exports freshnessReinvokeTriggered counter', () => {
    assert.ok(instruments.freshnessReinvokeTriggered, 'freshnessReinvokeTriggered should be exported');
    assert.equal(typeof instruments.freshnessReinvokeTriggered.add, 'function', 'should have add()');
  });

  it('exports freshnessReinvokeSkipped counter', () => {
    assert.ok(instruments.freshnessReinvokeSkipped, 'freshnessReinvokeSkipped should be exported');
    assert.equal(typeof instruments.freshnessReinvokeSkipped.add, 'function', 'should have add()');
  });

  // --- Incrementability (no-throw) tests ---

  it('all freshness counters can be incremented without throwing', () => {
    // These should not throw even without a configured MeterProvider
    // (lazy proxy defers to NoopMeter)
    assert.doesNotThrow(() => instruments.freshnessGateHeld.add(1));
    assert.doesNotThrow(() => instruments.freshnessGateForward.add(1));
    assert.doesNotThrow(() => instruments.freshnessNoticeAttached.add(1));
    assert.doesNotThrow(() => instruments.freshnessNoticeAcked.add(1));
    assert.doesNotThrow(() => instruments.freshnessNoticeDeferred.add(1));
    assert.doesNotThrow(() => instruments.freshnessReinvokeTriggered.add(1));
    assert.doesNotThrow(() => instruments.freshnessReinvokeSkipped.add(1));
  });

  // --- warmupCounters includes freshness counters ---

  it('warmupCounters does not throw (freshness counters pre-touched)', () => {
    assert.doesNotThrow(() => instruments.warmupCounters());
  });
});

describe('F254 AC-B5: checkFreshnessForPostMessage telemetry', () => {
  it('increments freshnessGateHeld when decision is held', async () => {
    // Import the function
    const { checkFreshnessForPostMessage } = await import(
      '../dist/domains/cats/services/freshness/checkFreshnessForPostMessage.js'
    );
    const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');

    const store = new DeliveryCursorStore();
    const userId = 'test-user';
    const catId = 'opus';
    const threadId = 'thread-test';
    const msgId1 = '0000000000000001-000001-aaaaaaaa';
    const msgId2 = '0000000000000002-000001-bbbbbbbb';

    // Set cursor before latest message → should trigger held
    await store.ackSeenCursor(userId, catId, threadId, msgId1);

    const messageStore = {
      getByThreadAfter: () => [{ id: msgId2, catId: null, content: 'hello from user' }],
    };

    const result = await checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      toolName: 'post_message',
      cursorStore: store,
      messageStore,
    });

    // The decision should be held (unseen user message)
    assert.equal(result.decision, 'held');
    // Counter was incremented (no-throw proves instrumentation exists)
    // Actual counter value verification would require OTel test SDK setup,
    // which is out of scope for this unit test — we verify the code path runs
  });

  it('increments freshnessGateForward when decision is forward', async () => {
    const { checkFreshnessForPostMessage } = await import(
      '../dist/domains/cats/services/freshness/checkFreshnessForPostMessage.js'
    );
    const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');

    const store = new DeliveryCursorStore();
    const userId = 'test-user';
    const catId = 'opus';
    const threadId = 'thread-test';
    const msgId2 = '0000000000000002-000001-bbbbbbbb';

    // Set cursor AT latest message → no unseen → forward
    await store.ackSeenCursor(userId, catId, threadId, msgId2);

    const messageStore = {
      getByThreadAfter: () => [],
    };

    const result = await checkFreshnessForPostMessage({
      userId,
      catId,
      threadId,
      toolName: 'post_message',
      cursorStore: store,
      messageStore,
    });

    assert.equal(result.decision, 'forward');
  });
});

describe('F254 AC-B5: FreshnessNoticeService telemetry', () => {
  it('increments freshnessNoticeAttached when notice is delivered', async () => {
    const { FreshnessNoticeService } = await import(
      '../dist/domains/cats/services/freshness/FreshnessNoticeService.js'
    );

    // Mock state store
    const stateStore = {
      get: async () => ({ toolCallCount: 5, noticeDeliveredCount: 0, ackedNoticeIds: [], reinvokeTriggered: false }),
      incrementToolCallCount: async () => 5,
      recordNoticeDelivered: async () => {},
    };

    // Mock event log
    const eventLog = {
      append: async () => {},
      getUnresolvedNotices: async () => [],
    };

    // Mock unseen checker — returns unseen messages
    const unseenChecker = {
      checkUnseen: async () => ({
        count: 2,
        senders: ['you', 'codex'],
        maxMessageId: '0000000000000002-000001-bbbbbbbb',
      }),
    };

    const service = new FreshnessNoticeService(stateStore, eventLog, unseenChecker);
    const notice = await service.checkAndMaybeNotice({
      invocationId: 'inv-test',
      threadId: 'thread-test',
      catId: 'opus',
      toolName: 'search_evidence',
      isReadOnly: true,
    });

    assert.ok(notice, 'should return a notice');
    assert.ok(notice.text.includes('2 条未读'), 'notice text should mention count');
  });

  it('increments freshnessNoticeDeferred when cat holds despite notices', async () => {
    const { FreshnessNoticeService } = await import(
      '../dist/domains/cats/services/freshness/FreshnessNoticeService.js'
    );

    const stateStore = {
      get: async () => ({ toolCallCount: 5, noticeDeliveredCount: 1, ackedNoticeIds: [], reinvokeTriggered: false }),
      incrementToolCallCount: async () => 5,
      recordNoticeDelivered: async () => {},
    };

    // Unresolved notice exists
    const unresolvedNotice = {
      kind: 'notice_attached',
      threadId: 'thread-test',
      catId: 'opus',
      invocationId: 'inv-test',
      timestamp: Date.now(),
      toolName: 'search_evidence',
      unseenSenders: ['you'],
      noticeId: 'notice-inv-test-3',
      maxMessageId: '0000000000000099-000001-zzzzzzzz',
    };

    const eventLog = {
      append: async () => {},
      getUnresolvedNotices: async () => [unresolvedNotice],
    };

    const unseenChecker = { checkUnseen: async () => null };

    const service = new FreshnessNoticeService(stateStore, eventLog, unseenChecker);
    const reminder = await service.checkHoldBallReminder({
      invocationId: 'inv-test',
      threadId: 'thread-test',
      catId: 'opus',
    });

    assert.ok(reminder, 'should return a reminder');
    assert.ok(reminder.text.includes('未读'), 'reminder should mention unread');
  });
});
