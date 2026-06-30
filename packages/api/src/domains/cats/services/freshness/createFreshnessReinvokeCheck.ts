/**
 * F254 B3 — Factory for the freshnessReinvokeCheck dependency.
 *
 * Assembles the function that invoke-single-cat.ts calls in its terminal
 * hook to decide whether to re-invoke. This bridges:
 *   - DeliveryCursorStore (real seenCursor — AC-B3 condition 1)
 *   - FreshnessAttentionEventLog (unresolved notices)
 *   - FreshnessInvocationStateStore (reinvokeTriggered flag)
 *   - IMessageStore (threadLatestMessageId)
 *   - decideFreshnessReinvoke (pure decision function)
 *
 * Fail-open: any store error → returns null (no re-invoke, no block).
 */

import type { CatId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { createModuleLogger } from '../../../../infrastructure/logger.js';
import {
  freshnessNoticeAcked,
  freshnessReinvokeSkipped,
  freshnessReinvokeTriggered,
} from '../../../../infrastructure/telemetry/instruments.js';
import type { IMessageStore } from '../stores/ports/MessageStore.js';
import { FreshnessAttentionEventLog } from './FreshnessAttentionEventLog.js';
import { FreshnessInvocationStateStore } from './FreshnessInvocationStateStore.js';
import { decideFreshnessReinvoke, type ReinvokeDecision } from './FreshnessReinvokeDecider.js';

const log = createModuleLogger('freshness-reinvoke-check');

// --- Rate limiter ---

/** Max re-invokes per (cat, thread) per hour */
const MAX_REINVOKES_PER_HOUR = 3;

/** Redis key for hourly rate limit counter */
function quotaKey(catId: string, threadId: string): string {
  return `freshness:reinvoke_quota:${catId}:${threadId}`;
}

// --- Re-invoke prompt (spec §B3) ---

/**
 * Build the content-free re-invoke prompt (spec §B3).
 * Contains sender info + count only, NO message content (AC-B6 privacy).
 */
function buildReinvokePrompt(senders: string[], noticeCount: number): string {
  return `你上一轮 turn 中有来自 ${senders.join(', ')} 的 ${noticeCount} 条未读消息，请调 list_recent 查看并回应。`;
}

// --- Dependencies ---

export interface FreshnessReinvokeCheckDeps {
  redis: RedisClient;
  messageStore: IMessageStore;
  /** Read real seenCursor (F254 Phase A) — per-(user,cat,thread) message ID */
  getSeenCursor?: (userId: string, catId: CatId, threadId: string) => Promise<string | undefined>;
  /** Check if there's a queued or active agent for this cat in this thread */
  hasQueuedOrActiveAgentForCat?: (threadId: string, catId: string) => boolean;
}

// --- Factory ---

export type FreshnessReinvokeCheckFn = (params: {
  invocationId: string;
  threadId: string;
  catId: CatId;
  userId: string;
}) => Promise<(ReinvokeDecision & { reinvokePrompt?: string }) | null>;

/**
 * Create the freshnessReinvokeCheck function for use in InvocationDeps.
 *
 * This is instantiated once per process and shared across invocations.
 * Each call creates fresh store instances (they're lightweight — just
 * hold a Redis reference, no state).
 */
export function createFreshnessReinvokeCheck(deps: FreshnessReinvokeCheckDeps): FreshnessReinvokeCheckFn {
  const eventLog = new FreshnessAttentionEventLog(deps.redis);
  const stateStore = new FreshnessInvocationStateStore(deps.redis);

  return async ({ invocationId, threadId, catId, userId }) => {
    try {
      // 1. Get unresolved notices (B3 condition 2)
      let unresolvedNotices = await eventLog.getUnresolvedNotices(invocationId);

      // 2. Get invocation state (reinvokeTriggered flag)
      const state = await stateStore.get(invocationId);
      const reinvokeTriggered = state?.reinvokeTriggered ?? false;

      // 3. Get real seenCursor from DeliveryCursorStore (B3 condition 1)
      // P1-1 fix: use actual per-(user,cat,thread) message ID cursor, NOT lastNoticeToolCallNum
      let seenCursor: string | null = null;
      if (deps.getSeenCursor) {
        try {
          seenCursor = (await deps.getSeenCursor(userId, catId, threadId)) ?? null;
        } catch (cursorErr) {
          // fail-open: cursor store error → return null (no re-invoke, no block)
          // seenCursor is the primary truth source (spec §B3 condition 1).
          // If we can't read it, we must not guess — returning null matches the
          // factory contract: "any store error → null".
          log.warn(
            { invocationId, threadId, catId: catId as string, err: cursorErr },
            '[F254-B3] getSeenCursor failed, fail-open → null (no re-invoke)',
          );
          return null;
        }
      }

      // 3b. Filter out notices the cat has already read past (GPT52 R2 P1).
      // Matches B2 FreshnessNoticeService.ts:157-172 pattern: notices with
      // maxMessageId <= seenCursor are implicitly resolved (cat advanced past them).
      // Without this filter, a stale high-priority notice can trigger spurious
      // re-invoke when a newer low-priority message arrives (seenCursorCaughtUp=false
      // due to the new message, but the notice's original message was already read).
      // ID comparison is safe here: maxMessageId and seenCursor are both creation-time
      // IDs (generateSortableId), so lexicographic order = creation order.
      const preFilterNoticeCount = unresolvedNotices.length;
      if (seenCursor) {
        unresolvedNotices = unresolvedNotices.filter((n) => n.maxMessageId > seenCursor);
      }
      // Count of notices implicitly acked by cursor advancement (removed by filter).
      // Used for unified ack counting regardless of subsequent reinvoke/skip decision
      // (cloud R2 P2-3 audit: trigger path + other skip paths all need this).
      const cursorFilteredCount = preFilterNoticeCount - unresolvedNotices.length;

      // 4. Get latest message ID in thread (for decider context)
      const recentMessages = await deps.messageStore.getByThread(threadId, 1);
      const threadLatestMessageId = recentMessages.length > 0 ? recentMessages[0]!.id : null;

      // 5. Check if seenCursor caught up — use getByThreadAfter (score-aware) instead
      // of raw ID comparison. markDelivered() updates sorted-set scores to deliveredAt
      // while IDs keep the original send timestamp, so late-delivered queued messages
      // have old IDs but new scores. Raw ID comparison (seenCursor >= latestId) would
      // falsely report "caught up" for these messages. getByThreadAfter handles the
      // score/ID split correctly (see RedisMessageStore.ts:539-546).
      let seenCursorCaughtUp = false;
      if (seenCursor != null && threadLatestMessageId != null) {
        const afterCursor = await deps.messageStore.getByThreadAfter(threadId, seenCursor, 1);
        seenCursorCaughtUp = afterCursor.length === 0;
      }

      // 6. Check newer invocation via queue
      const hasNewerInvocation = deps.hasQueuedOrActiveAgentForCat
        ? deps.hasQueuedOrActiveAgentForCat(threadId, catId as string)
        : false;

      // 7. Check if all unseen are self-messages (v1: simplified — if no notices, moot)
      const allUnseenAreSelfMessage = false; // Conservative: assume not, let decider handle

      // 8. Check quota
      let reinvokeQuotaExhausted = false;
      try {
        const key = quotaKey(catId as string, threadId);
        const count = await deps.redis.get(key);
        reinvokeQuotaExhausted = Number(count ?? 0) >= MAX_REINVOKES_PER_HOUR;
      } catch {
        // fail-open: quota check failure → don't block
      }

      // 9. Call pure decision function
      const decision = decideFreshnessReinvoke({
        seenCursor,
        threadLatestMessageId,
        unresolvedNotices,
        reinvokeTriggered,
        parentChainReinvoked: false, // v1: no parent chain tracking
        hasNewerInvocation,
        seenCursorCaughtUp,
        allUnseenAreSelfMessage,
        reinvokeQuotaExhausted,
      });

      // 10. If triggered, increment quota counter, mark state, build prompt
      if (decision.shouldReinvoke) {
        try {
          const key = quotaKey(catId as string, threadId);
          await deps.redis.incr(key);
          // Set TTL to 1 hour if not already set
          const ttl = await deps.redis.ttl(key);
          if (ttl < 0) {
            await deps.redis.expire(key, 3600);
          }
        } catch {
          // fail-open: quota update failure → don't block
        }

        try {
          await stateStore.markReinvokeTriggered(invocationId);
        } catch {
          // fail-open: state update failure → don't block
        }

        // 10b. AC-B4: Record reinvoke_triggered event to event log (GPT52 R2 P2).
        // triggeredInvocationId is 'queued-pending' because the actual new
        // invocation ID is assigned later by QueueProcessor.
        try {
          await eventLog.append({
            kind: 'reinvoke_triggered',
            invocationId,
            threadId,
            catId,
            timestamp: Date.now(),
            triggeredInvocationId: 'queued-pending',
            sourceNoticeIds: decision.noticeIds,
          });
        } catch {
          // fail-open: audit event failure → don't block
        }

        // AC-B5: OTel counters
        freshnessReinvokeTriggered.add(1);
        // Cloud R2 P2-3: cursor-filtered notices are acked even when remaining
        // notices trigger reinvoke (mixed ack+reinvoke invocations).
        if (cursorFilteredCount > 0) {
          freshnessNoticeAcked.add(cursorFilteredCount);
        }

        // P1-2 fix: build content-free re-invoke prompt (spec §B3)
        return {
          ...decision,
          reinvokePrompt: buildReinvokePrompt(decision.senders, decision.noticeIds.length),
        };
      }

      // 10c. AC-B4: Record reinvoke_skipped event to event log (GPT52 R2 P2).
      // Spec §B4: "每次 skip 记录 reinvoke_skipped 事件（含 reason）"
      if (!decision.shouldReinvoke && decision.skipReason) {
        try {
          await eventLog.append({
            kind: 'reinvoke_skipped',
            invocationId,
            threadId,
            catId,
            timestamp: Date.now(),
            reason: decision.skipReason as
              | 'quota_exhausted'
              | 'already_handled'
              | 'low_priority'
              | 'cursor_caught_up'
              | 'newer_invocation',
          });
        } catch {
          // fail-open: audit event failure → don't block
        }

        // AC-B5: OTel counters
        freshnessReinvokeSkipped.add(1);
        // Unified ack counting (cloud R2 P2-3 audit refactor):
        //   cursor_caught_up → ALL original notices acked (cursor past everything)
        //   Other skip reasons → only cursor-filtered notices acked
        // For no_unresolved_notices: cursorFilteredCount = preFilterNoticeCount
        // (all notices were filtered), so this naturally collapses.
        // Guard: preFilterNoticeCount > 0 prevents counting "ack" when no notices
        // ever existed (gpt52 R2 P1).
        if (decision.skipReason === 'cursor_caught_up' && preFilterNoticeCount > 0) {
          freshnessNoticeAcked.add(preFilterNoticeCount);
        } else if (cursorFilteredCount > 0) {
          freshnessNoticeAcked.add(cursorFilteredCount);
        }
      }

      return decision;
    } catch (err) {
      log.warn(
        { invocationId, threadId, catId: catId as string, err },
        '[F254-B3] freshnessReinvokeCheck failed, fail-open',
      );
      return null;
    }
  };
}
