/**
 * F254 Phase B — B2: hold_ball reminder cursor-resolution tests
 *
 * Split from f254-hold-ball-reminder.test.js (P1-R3-1: file over 350-line limit).
 * Tests cursor-based notice resolution, text accuracy, and sender dedup.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { FreshnessNoticeService } from '../dist/domains/cats/services/freshness/FreshnessNoticeService.js';

// --- Mock infrastructure (shared with f254-hold-ball-reminder.test.js) ---

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
    getUnresolvedNotices: async () => events.filter((e) => e.kind === 'notice_attached'),
    _recorded: recorded,
  };
}

function makeMockUnseenChecker(result = null) {
  return { checkUnseen: async () => result };
}

describe('F254 B2: hold_ball reminder — cursor resolution', () => {
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

  // === P1-2 fix: cursor-based resolution ===

  it('returns null when seenCursor has caught up past all notice maxMessageIds', async () => {
    // Notice was delivered at maxMessageId 'msg-123', but cat later read
    // thread context which advanced seenCursor to 'msg-200' → resolved
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

    const result = await service.checkHoldBallReminder({
      invocationId: 'inv-001',
      threadId: 'thread-001',
      catId: 'opus',
      currentSeenCursor: 'msg-200', // cursor past notice → resolved
    });

    assert.equal(result, null, 'should return null when cursor caught up past all notices');
  });

  it('still reminds for notices beyond the current seenCursor', async () => {
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
        maxMessageId: 'msg-300', // beyond cursor
      },
    ]);
    service = new FreshnessNoticeService(stateStore, eventLog, unseenChecker);

    const result = await service.checkHoldBallReminder({
      invocationId: 'inv-001',
      threadId: 'thread-001',
      catId: 'opus',
      currentSeenCursor: 'msg-100', // cursor before notice
    });

    assert.ok(result, 'should still remind for notices beyond cursor');
  });

  it('filters mix of resolved (cursor past) and unresolved notices', async () => {
    eventLog = makeMockEventLog([
      {
        kind: 'notice_attached',
        threadId: 'thread-001',
        catId: 'opus',
        invocationId: 'inv-001',
        timestamp: Date.now(),
        toolName: 'search_evidence',
        unseenSenders: ['codex'],
        noticeId: 'notice-inv-001-5',
        maxMessageId: 'msg-100', // cursor caught up → resolved
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
        maxMessageId: 'msg-300', // beyond cursor → still unresolved
      },
    ]);
    service = new FreshnessNoticeService(stateStore, eventLog, unseenChecker);

    const result = await service.checkHoldBallReminder({
      invocationId: 'inv-001',
      threadId: 'thread-001',
      catId: 'opus',
      currentSeenCursor: 'msg-200',
    });

    assert.ok(result, 'should still remind for unresolved notice');
    assert.ok(result.text.includes('user'), 'should include unresolved sender');
    assert.ok(!result.text.includes('codex'), 'should NOT include resolved sender');
  });

  // === P2-2 fix: notice text accuracy ===

  it('B2 reminder text says get_thread_context not list_recent', async () => {
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
        maxMessageId: 'msg-300',
      },
    ]);
    service = new FreshnessNoticeService(stateStore, eventLog, unseenChecker);

    const result = await service.checkHoldBallReminder({
      invocationId: 'inv-001',
      threadId: 'thread-001',
      catId: 'opus',
      currentSeenCursor: 'msg-100',
    });

    assert.ok(result);
    assert.ok(result.text.includes('get_thread_context'), 'should reference get_thread_context');
    assert.ok(!result.text.includes('list_recent'), 'should NOT reference list_recent');
  });

  // === Sender aggregation ===

  it('aggregates senders from multiple unresolved notices (deduped)', async () => {
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
      {
        kind: 'notice_attached',
        threadId: 'thread-001',
        catId: 'opus',
        invocationId: 'inv-001',
        timestamp: Date.now(),
        toolName: 'graph_resolve',
        unseenSenders: ['user', 'sonnet'],
        noticeId: 'notice-inv-001-10',
        maxMessageId: 'msg-124',
      },
    ]);
    service = new FreshnessNoticeService(stateStore, eventLog, unseenChecker);

    const result = await service.checkHoldBallReminder({
      invocationId: 'inv-001',
      threadId: 'thread-001',
      catId: 'opus',
    });

    assert.ok(result);
    // Should contain all unique senders
    assert.ok(result.text.includes('user'));
    assert.ok(result.text.includes('codex'));
    assert.ok(result.text.includes('sonnet'));
  });
});
