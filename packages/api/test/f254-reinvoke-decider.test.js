/**
 * F254 Phase B — B3+B4: Freshness re-invoke decider tests
 *
 * Tests the decision logic for whether to re-invoke a cat after its
 * invocation ends with unacknowledged high-priority notices.
 *
 * Pure function tests — no Redis/stores, just data in → decision out.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideFreshnessReinvoke } from '../dist/domains/cats/services/freshness/FreshnessReinvokeDecider.js';

// --- Test helpers ---

function makeBaseInput(overrides = {}) {
  return {
    seenCursor: 'msg-100',
    threadLatestMessageId: 'msg-200',
    unresolvedNotices: [
      {
        kind: 'notice_attached',
        threadId: 'thread-001',
        catId: 'opus',
        invocationId: 'inv-001',
        timestamp: Date.now(),
        toolName: 'search_evidence',
        unseenSenders: ['user'],
        noticeId: 'notice-inv-001-5',
        maxMessageId: 'msg-200',
      },
    ],
    reinvokeTriggered: false,
    parentChainReinvoked: false,
    hasNewerInvocation: false,
    seenCursorCaughtUp: false,
    allUnseenAreSelfMessage: false,
    reinvokeQuotaExhausted: false,
    ...overrides,
  };
}

// --- Tests ---

describe('F254 B3+B4: Freshness re-invoke decider', () => {
  // === B3: Trigger conditions (all must be true) ===

  it('triggers re-invoke when all conditions met (human message, unseen, no prior re-invoke)', () => {
    const input = makeBaseInput();
    const result = decideFreshnessReinvoke(input);

    assert.equal(result.shouldReinvoke, true);
    assert.ok(result.reason.includes('high_priority'));
    assert.deepEqual(result.noticeIds, ['notice-inv-001-5']);
  });

  it('does NOT trigger when seenCursor has caught up to latest', () => {
    const input = makeBaseInput({ seenCursorCaughtUp: true });
    const result = decideFreshnessReinvoke(input);

    assert.equal(result.shouldReinvoke, false);
    assert.equal(result.skipReason, 'cursor_caught_up');
  });

  it('does NOT trigger when no unresolved notices', () => {
    const input = makeBaseInput({ unresolvedNotices: [] });
    const result = decideFreshnessReinvoke(input);

    assert.equal(result.shouldReinvoke, false);
    assert.equal(result.skipReason, 'no_unresolved_notices');
  });

  it('does NOT trigger when reinvokeTriggered is already true', () => {
    const input = makeBaseInput({ reinvokeTriggered: true });
    const result = decideFreshnessReinvoke(input);

    assert.equal(result.shouldReinvoke, false);
    assert.equal(result.skipReason, 'already_handled');
  });

  it('does NOT trigger when parent chain already re-invoked', () => {
    const input = makeBaseInput({ parentChainReinvoked: true });
    const result = decideFreshnessReinvoke(input);

    assert.equal(result.shouldReinvoke, false);
    assert.equal(result.skipReason, 'already_handled');
  });

  // === B3: High-priority detection ===

  it('detects human/user sender as high priority', () => {
    const input = makeBaseInput({
      unresolvedNotices: [
        {
          kind: 'notice_attached',
          unseenSenders: ['user'],
          noticeId: 'n1',
          maxMessageId: 'msg-200',
        },
      ],
    });
    const result = decideFreshnessReinvoke(input);

    assert.equal(result.shouldReinvoke, true);
  });

  it('does NOT trigger for only non-human senders (cat chatter)', () => {
    const input = makeBaseInput({
      unresolvedNotices: [
        {
          kind: 'notice_attached',
          unseenSenders: ['sonnet', 'codex'],
          noticeId: 'n1',
          maxMessageId: 'msg-200',
        },
      ],
    });
    const result = decideFreshnessReinvoke(input);

    assert.equal(result.shouldReinvoke, false);
    assert.equal(result.skipReason, 'low_priority');
  });

  it('detects mixed senders with user as high priority', () => {
    const input = makeBaseInput({
      unresolvedNotices: [
        {
          kind: 'notice_attached',
          unseenSenders: ['codex', 'user'],
          noticeId: 'n1',
          maxMessageId: 'msg-200',
        },
      ],
    });
    const result = decideFreshnessReinvoke(input);

    assert.equal(result.shouldReinvoke, true);
  });

  // === B4: Skip predicates ===

  it('skips when newer invocation exists', () => {
    const input = makeBaseInput({ hasNewerInvocation: true });
    const result = decideFreshnessReinvoke(input);

    assert.equal(result.shouldReinvoke, false);
    assert.equal(result.skipReason, 'newer_invocation');
  });

  it('skips when all unseen messages are self-messages', () => {
    const input = makeBaseInput({ allUnseenAreSelfMessage: true });
    const result = decideFreshnessReinvoke(input);

    assert.equal(result.shouldReinvoke, false);
    assert.equal(result.skipReason, 'cursor_caught_up');
  });

  it('skips when per-(cat,thread) hourly quota exhausted', () => {
    const input = makeBaseInput({ reinvokeQuotaExhausted: true });
    const result = decideFreshnessReinvoke(input);

    assert.equal(result.shouldReinvoke, false);
    assert.equal(result.skipReason, 'quota_exhausted');
  });

  // === Edge cases ===

  it('collects all notice IDs from unresolved high-priority notices', () => {
    const input = makeBaseInput({
      unresolvedNotices: [
        { kind: 'notice_attached', unseenSenders: ['user'], noticeId: 'n1', maxMessageId: 'msg-200' },
        { kind: 'notice_attached', unseenSenders: ['codex'], noticeId: 'n2', maxMessageId: 'msg-201' },
        { kind: 'notice_attached', unseenSenders: ['user', 'sonnet'], noticeId: 'n3', maxMessageId: 'msg-202' },
      ],
    });
    const result = decideFreshnessReinvoke(input);

    assert.equal(result.shouldReinvoke, true);
    // Only high-priority notice IDs (ones with 'user' in senders)
    assert.deepEqual(result.noticeIds.sort(), ['n1', 'n3']);
  });

  it('returns aggregated senders for the re-invoke prompt', () => {
    const input = makeBaseInput({
      unresolvedNotices: [
        { kind: 'notice_attached', unseenSenders: ['user'], noticeId: 'n1', maxMessageId: 'msg-200' },
        { kind: 'notice_attached', unseenSenders: ['user', 'codex'], noticeId: 'n2', maxMessageId: 'msg-201' },
      ],
    });
    const result = decideFreshnessReinvoke(input);

    assert.ok(result.senders);
    assert.ok(result.senders.includes('user'));
  });
});
