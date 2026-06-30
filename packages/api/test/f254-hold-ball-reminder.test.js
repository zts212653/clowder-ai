/**
 * F254 Phase B — B2: hold_ball reminder tests
 *
 * When a cat calls hold_ball and there are unresolved notices
 * (delivered but not acked via seenCursor advance), the system
 * should return a reminder and record a notice_deferred event.
 *
 * Uses mock stores (unit tests, not Redis-backed).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { FreshnessNoticeService } from '../dist/domains/cats/services/freshness/FreshnessNoticeService.js';

// --- Mock infrastructure ---

function makeMockStateStore(overrides = {}) {
  return {
    get: async () => overrides.state ?? null,
    incrementToolCallCount: async () => overrides.toolCallCount ?? 1,
    recordNoticeDelivered: async () => {},
    ...overrides,
  };
}

function makeMockEventLog(events = []) {
  const recorded = [];
  return {
    append: async (event) => {
      recorded.push(event);
    },
    getUnresolvedNotices: async () => events,
    recorded,
  };
}

function makeMockUnseenChecker(unseen = null) {
  return {
    checkUnseen: async () => unseen,
  };
}

// --- Tests ---

describe('F254 B2: hold_ball reminder', () => {
  let stateStore;
  let eventLog;
  let unseenChecker;
  let service;

  beforeEach(() => {
    stateStore = makeMockStateStore();
    eventLog = makeMockEventLog();
    unseenChecker = makeMockUnseenChecker();
    service = new FreshnessNoticeService(stateStore, eventLog, unseenChecker);
  });

  it('returns null when no notices were delivered this invocation', async () => {
    // No unresolved notices in event log
    eventLog = makeMockEventLog([]);
    service = new FreshnessNoticeService(stateStore, eventLog, unseenChecker);

    const result = await service.checkHoldBallReminder({
      invocationId: 'inv-001',
      threadId: 'thread-001',
      catId: 'opus',
    });

    assert.equal(result, null);
  });

  it('returns null when all notices have been acked', async () => {
    // getUnresolvedNotices returns empty = all acked
    eventLog = makeMockEventLog([]);
    service = new FreshnessNoticeService(stateStore, eventLog, unseenChecker);

    const result = await service.checkHoldBallReminder({
      invocationId: 'inv-001',
      threadId: 'thread-001',
      catId: 'opus',
    });

    assert.equal(result, null);
  });

  it('returns reminder text when there are unresolved notices', async () => {
    eventLog = makeMockEventLog([
      {
        kind: 'notice_attached',
        threadId: 'thread-001',
        catId: 'opus',
        invocationId: 'inv-001',
        timestamp: Date.now(),
        toolName: 'search_evidence',
        unseenSenders: ['user', 'codex'],
        noticeId: 'notice-inv-001-5',
        maxMessageId: 'msg-123',
      },
    ]);
    service = new FreshnessNoticeService(stateStore, eventLog, unseenChecker);

    const result = await service.checkHoldBallReminder({
      invocationId: 'inv-001',
      threadId: 'thread-001',
      catId: 'opus',
    });

    assert.ok(result);
    assert.ok(result.text.includes('未读消息'), 'reminder should mention unread messages');
    assert.ok(result.text.includes('get_thread_context'), 'reminder should suggest get_thread_context');
  });

  it('reminder text includes sender info but NOT message content (privacy)', async () => {
    eventLog = makeMockEventLog([
      {
        kind: 'notice_attached',
        threadId: 'thread-001',
        catId: 'opus',
        invocationId: 'inv-001',
        timestamp: Date.now(),
        toolName: 'search_evidence',
        unseenSenders: ['user', 'codex'],
        noticeId: 'notice-inv-001-5',
        maxMessageId: 'msg-123',
      },
    ]);
    service = new FreshnessNoticeService(stateStore, eventLog, unseenChecker);

    const result = await service.checkHoldBallReminder({
      invocationId: 'inv-001',
      threadId: 'thread-001',
      catId: 'opus',
    });

    assert.ok(result);
    // Should contain senders
    assert.ok(result.text.includes('user'), 'should contain sender: user');
    assert.ok(result.text.includes('codex'), 'should contain sender: codex');
    // Content-free invariant: no message body text
    assert.ok(!result.text.includes('preview'), 'should not contain message previews');
  });

  it('records notice_deferred event for each batch of unresolved notices', async () => {
    const unresolvedNotices = [
      {
        kind: 'notice_attached',
        threadId: 'thread-001',
        catId: 'opus',
        invocationId: 'inv-001',
        timestamp: Date.now(),
        toolName: 'search_evidence',
        unseenSenders: ['user'],
        noticeId: 'notice-inv-001-5',
        maxMessageId: 'msg-123',
      },
      {
        kind: 'notice_attached',
        threadId: 'thread-001',
        catId: 'opus',
        invocationId: 'inv-001',
        timestamp: Date.now(),
        toolName: 'graph_resolve',
        unseenSenders: ['user'],
        noticeId: 'notice-inv-001-10',
        maxMessageId: 'msg-124',
      },
    ];
    eventLog = makeMockEventLog(unresolvedNotices);
    service = new FreshnessNoticeService(stateStore, eventLog, unseenChecker);

    await service.checkHoldBallReminder({
      invocationId: 'inv-001',
      threadId: 'thread-001',
      catId: 'opus',
    });

    // Should record one notice_deferred event with both noticeIds
    const deferred = eventLog.recorded.filter((e) => e.kind === 'notice_deferred');
    assert.equal(deferred.length, 1, 'should record exactly one notice_deferred event');
    assert.deepEqual(
      deferred[0].noticeIds.sort(),
      ['notice-inv-001-10', 'notice-inv-001-5'],
      'should include all unresolved noticeIds',
    );
  });

  it('notice_deferred event has correct metadata', async () => {
    eventLog = makeMockEventLog([
      {
        kind: 'notice_attached',
        threadId: 'thread-001',
        catId: 'opus',
        invocationId: 'inv-001',
        timestamp: Date.now(),
        toolName: 'search_evidence',
        unseenSenders: ['user'],
        noticeId: 'notice-inv-001-5',
        maxMessageId: 'msg-123',
      },
    ]);
    service = new FreshnessNoticeService(stateStore, eventLog, unseenChecker);

    await service.checkHoldBallReminder({
      invocationId: 'inv-001',
      threadId: 'thread-001',
      catId: 'opus',
    });

    const deferred = eventLog.recorded.find((e) => e.kind === 'notice_deferred');
    assert.ok(deferred, 'should have recorded notice_deferred event');
    assert.equal(deferred.threadId, 'thread-001');
    assert.equal(deferred.catId, 'opus');
    assert.equal(deferred.invocationId, 'inv-001');
    assert.equal(typeof deferred.timestamp, 'number');
  });

  // Cursor-resolution tests + text accuracy + sender dedup moved to
  // f254-hold-ball-reminder-cursor.test.js (P1-R3-1: 350-line file limit)
});
