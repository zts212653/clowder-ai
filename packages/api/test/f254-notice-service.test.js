/**
 * F254 FreshnessNoticeService Tests (Phase B — B1)
 *
 * Unit tests for the read-only tool notice piggybacking logic.
 * Tests the decision logic: when to attach a "you have unseen messages" notice
 * to a read-only MCP tool response.
 *
 * Uses mock stores (not Redis) — Redis integration tested in B0 tests.
 *
 * Spec constraints:
 * - Only read-only tools get notices
 * - Frequency: every N tool calls (N=5), max 3 per invocation
 * - Content-free: sender names + count only, NO message content
 * - messageFilter: must not notice on hidden messages
 * - Records notice_attached event in FreshnessAttentionEventLog
 * - Updates FreshnessInvocationState counters
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

// We'll import the service from dist after implementation
// For now, define the test expectations

describe('F254 FreshnessNoticeService', () => {
  let FreshnessNoticeService;
  let service;
  let mockStateStore;
  let mockEventLog;
  let mockUnseenChecker;

  // Track calls to mocks for assertions
  let stateStoreCalls;
  let eventLogCalls;

  beforeEach(async () => {
    const mod = await import('../dist/domains/cats/services/freshness/FreshnessNoticeService.js');
    FreshnessNoticeService = mod.FreshnessNoticeService;

    stateStoreCalls = [];
    eventLogCalls = [];

    // In-memory mock of FreshnessInvocationStateStore
    const stateMap = new Map();
    mockStateStore = {
      get: async (invocationId) => stateMap.get(invocationId) ?? null,
      incrementToolCallCount: async (invocationId) => {
        const state = stateMap.get(invocationId) ?? {
          toolCallCount: 0,
          noticeDeliveredCount: 0,
          lastNoticeToolCallNum: 0,
          ackedNoticeIds: [],
          reinvokeTriggered: false,
        };
        state.toolCallCount += 1;
        stateMap.set(invocationId, state);
        stateStoreCalls.push({ method: 'incrementToolCallCount', invocationId });
        return state.toolCallCount;
      },
      recordNoticeDelivered: async (invocationId, toolCallNum) => {
        const state = stateMap.get(invocationId);
        if (state) {
          state.noticeDeliveredCount += 1;
          state.lastNoticeToolCallNum = toolCallNum;
        }
        stateStoreCalls.push({ method: 'recordNoticeDelivered', invocationId, toolCallNum });
      },
      recordNoticeAcked: async (invocationId, noticeId) => {
        stateStoreCalls.push({ method: 'recordNoticeAcked', invocationId, noticeId });
      },
      markReinvokeTriggered: async (invocationId) => {
        stateStoreCalls.push({ method: 'markReinvokeTriggered', invocationId });
      },
    };

    // Mock event log
    mockEventLog = {
      append: async (event) => {
        eventLogCalls.push(event);
      },
    };

    // Default mock unseen checker: returns 2 unseen from 'user'
    mockUnseenChecker = {
      checkUnseen: async (_params) => ({
        count: 2,
        senders: ['user'],
        maxMessageId: '0000000000000020-000001-aaaaaaaa',
      }),
    };

    service = new FreshnessNoticeService(mockStateStore, mockEventLog, mockUnseenChecker);
  });

  const baseParams = {
    invocationId: 'inv-notice-001',
    threadId: 'thread-test',
    catId: 'opus',
    toolName: 'search_evidence',
    isReadOnly: true,
  };

  // --- read-only gate ---

  it('returns null for non-read-only tools', async () => {
    const result = await service.checkAndMaybeNotice({
      ...baseParams,
      toolName: 'post_message',
      isReadOnly: false,
    });
    assert.equal(result, null);
  });

  it('still increments toolCallCount for non-read-only tools', async () => {
    await service.checkAndMaybeNotice({ ...baseParams, isReadOnly: false });
    const incrementCalls = stateStoreCalls.filter((c) => c.method === 'incrementToolCallCount');
    assert.equal(incrementCalls.length, 1);
  });

  // --- frequency gate removed from API (P2-1 fix) ---
  // Frequency gating is now MCP-layer only (server-toolsets.ts).
  // API only checks: isReadOnly → max cap → unseen.

  it('returns notice on first read-only call when unseen messages exist (no API frequency gate)', async () => {
    const result = await service.checkAndMaybeNotice(baseParams);
    assert.notEqual(result, null, 'first read-only call should return notice');
    assert.ok(result.noticeId, 'notice should have an ID');
    assert.ok(result.text.includes('2'), 'notice should include unseen count');
  });

  it('returns null when no unseen messages', async () => {
    // Override unseen checker to return null
    mockUnseenChecker.checkUnseen = async () => null;

    const result = await service.checkAndMaybeNotice(baseParams);
    assert.equal(result, null);
  });

  // --- max cap ---

  it('returns null when noticeDeliveredCount >= 3 (max cap)', async () => {
    // API delivers on every read-only call (no frequency gate).
    // First 3 calls deliver, 4th+ should be capped.
    const results = [];
    for (let i = 0; i < 5; i++) {
      const result = await service.checkAndMaybeNotice(baseParams);
      if (result) results.push(result);
    }

    assert.equal(results.length, 3, 'Should deliver exactly 3 notices (max cap)');
  });

  // --- lastNoticeToolCallNum tracking ---

  it('tracks lastNoticeToolCallNum for subsequent notices', async () => {
    // First notice on call 1 (API has no frequency gate)
    await service.checkAndMaybeNotice(baseParams);
    const deliverCalls = stateStoreCalls.filter((c) => c.method === 'recordNoticeDelivered');
    assert.equal(deliverCalls.length, 1);

    // Second notice on call 2
    await service.checkAndMaybeNotice(baseParams);
    const allDeliverCalls = stateStoreCalls.filter((c) => c.method === 'recordNoticeDelivered');
    assert.equal(allDeliverCalls.length, 2);
  });

  // --- event log recording ---

  it('records notice_attached event when notice is delivered', async () => {
    await service.checkAndMaybeNotice(baseParams);

    const noticeEvents = eventLogCalls.filter((e) => e.kind === 'notice_attached');
    assert.equal(noticeEvents.length, 1);
    assert.equal(noticeEvents[0].toolName, 'search_evidence');
    assert.deepEqual(noticeEvents[0].unseenSenders, ['user']);
    assert.equal(noticeEvents[0].invocationId, 'inv-notice-001');
    assert.ok(noticeEvents[0].noticeId);
    assert.ok(noticeEvents[0].maxMessageId);
  });

  it('does NOT record event when no notice is delivered', async () => {
    // Non-read-only tool → no notice, no event
    await service.checkAndMaybeNotice({ ...baseParams, isReadOnly: false });
    const noticeEvents = eventLogCalls.filter((e) => e.kind === 'notice_attached');
    assert.equal(noticeEvents.length, 0);
  });

  // --- content-free notice ---

  it('notice text contains sender names but NOT message content', async () => {
    mockUnseenChecker.checkUnseen = async () => ({
      count: 3,
      senders: ['user', 'codex'],
      maxMessageId: '0000000000000030-000001-aaaaaaaa',
    });

    const result = await service.checkAndMaybeNotice(baseParams);

    assert.ok(result);
    // Must contain senders
    assert.ok(result.text.includes('user'), 'should include sender "user"');
    assert.ok(result.text.includes('codex'), 'should include sender "codex"');
    // Must contain count
    assert.ok(result.text.includes('3'), 'should include unseen count');
    // Must contain instructions
    assert.ok(result.text.includes('get_thread_context'), 'should suggest get_thread_context');
    assert.ok(!result.text.includes('list_recent'), 'should NOT suggest list_recent (does not advance seenCursor)');
    // Content-free: no message body/preview (we didn't provide any, so this is inherent)
  });

  // --- unseen checker integration ---

  it('passes correct params to unseenChecker', async () => {
    let receivedParams;
    mockUnseenChecker.checkUnseen = async (params) => {
      receivedParams = params;
      return { count: 1, senders: ['user'], maxMessageId: 'msg-1' };
    };

    await service.checkAndMaybeNotice(baseParams);

    assert.equal(receivedParams.threadId, 'thread-test');
    assert.equal(receivedParams.catId, 'opus');
  });
});
