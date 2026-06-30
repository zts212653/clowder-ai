/**
 * F254 Phase B — B3+B4: Freshness re-invoke decider
 *
 * Pure decision function: given pre-fetched data about the invocation's
 * freshness state, decides whether to trigger a re-invoke after the
 * invocation ends.
 *
 * The caller (invoke-single-cat.ts terminal hook) assembles the input
 * from Redis/stores; this module only contains the decision logic.
 *
 * Design (spec §B3+§B4):
 * - B3 trigger: all 4 conditions must be true
 * - B4 skip: any 1 of 5 predicates → skip
 * - High-priority: human/user sender (v1, conservative)
 */

import type { NoticeAttachedEvent } from './FreshnessAttentionEventLog.js';

// --- Input/Output types ---

export interface ReinvokeDeciderInput {
  /** Current seenCursor value for this (cat, thread) */
  seenCursor: string | null;
  /** Latest message ID in the thread */
  threadLatestMessageId: string | null;
  /** Unresolved notices from FreshnessAttentionEventLog */
  unresolvedNotices: Pick<NoticeAttachedEvent, 'unseenSenders' | 'noticeId' | 'maxMessageId'>[];
  /** Whether this invocation has already triggered a re-invoke */
  reinvokeTriggered: boolean;
  /** Whether any parent in the invocation chain triggered a re-invoke */
  parentChainReinvoked: boolean;
  /** Whether a newer invocation exists for this (cat, thread) */
  hasNewerInvocation: boolean;
  /** Whether seenCursor has caught up to threadLatestMessageId */
  seenCursorCaughtUp: boolean;
  /** Whether all unseen messages are self-messages */
  allUnseenAreSelfMessage: boolean;
  /** Whether per-(cat,thread) hourly re-invoke quota is exhausted */
  reinvokeQuotaExhausted: boolean;
}

export type ReinvokeSkipReason =
  | 'no_unresolved_notices'
  | 'already_handled'
  | 'low_priority'
  | 'newer_invocation'
  | 'cursor_caught_up'
  | 'quota_exhausted';

export interface ReinvokeDecision {
  shouldReinvoke: boolean;
  reason: string;
  skipReason?: ReinvokeSkipReason;
  noticeIds: string[];
  senders: string[];
}

// --- High-priority detection ---

/** v1: 'user' sender = human message = high priority */
const HIGH_PRIORITY_SENDERS = new Set(['user']);

function isHighPriority(notice: Pick<NoticeAttachedEvent, 'unseenSenders'>): boolean {
  return notice.unseenSenders.some((s) => HIGH_PRIORITY_SENDERS.has(s));
}

// --- Decision function ---

/**
 * Decide whether to re-invoke a cat for freshness.
 *
 * Gate chain (spec §B3 + §B4):
 * 1. Skip predicates (B4) — any true → skip
 * 2. Trigger conditions (B3) — all must be true
 */
export function decideFreshnessReinvoke(input: ReinvokeDeciderInput): ReinvokeDecision {
  const noMatch: ReinvokeDecision = { shouldReinvoke: false, reason: '', noticeIds: [], senders: [] };

  // === B4 Skip predicates (check first — cheaper than trigger analysis) ===

  // Skip 1: seenCursor caught up (or all unseen are self-messages)
  if (input.seenCursorCaughtUp || input.allUnseenAreSelfMessage) {
    return { ...noMatch, reason: 'skip:cursor_caught_up', skipReason: 'cursor_caught_up' };
  }

  // Skip 2: newer invocation already queued/running
  if (input.hasNewerInvocation) {
    return { ...noMatch, reason: 'skip:newer_invocation', skipReason: 'newer_invocation' };
  }

  // Skip 5: rate limit exhausted
  if (input.reinvokeQuotaExhausted) {
    return { ...noMatch, reason: 'skip:quota_exhausted', skipReason: 'quota_exhausted' };
  }

  // === B3 Trigger conditions ===

  // Condition 1: must have unresolved notices
  if (input.unresolvedNotices.length === 0) {
    return { ...noMatch, reason: 'skip:no_unresolved_notices', skipReason: 'no_unresolved_notices' };
  }

  // Condition 3+4: no prior re-invoke (this invocation or parent chain)
  if (input.reinvokeTriggered || input.parentChainReinvoked) {
    return { ...noMatch, reason: 'skip:already_handled', skipReason: 'already_handled' };
  }

  // Condition 2: must have high-priority unresolved notices
  const highPriorityNotices = input.unresolvedNotices.filter(isHighPriority);
  if (highPriorityNotices.length === 0) {
    return { ...noMatch, reason: 'skip:low_priority', skipReason: 'low_priority' };
  }

  // All conditions met — trigger re-invoke
  const noticeIds = highPriorityNotices.map((n) => n.noticeId);
  const senderSet = new Set<string>();
  for (const notice of highPriorityNotices) {
    for (const sender of notice.unseenSenders) {
      senderSet.add(sender);
    }
  }

  return {
    shouldReinvoke: true,
    reason: 'trigger:high_priority_unseen',
    noticeIds,
    senders: [...senderSet],
  };
}
