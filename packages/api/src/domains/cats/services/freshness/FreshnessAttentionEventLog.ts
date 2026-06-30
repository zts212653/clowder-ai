/**
 * F254 FreshnessAttentionEventLog (Phase B — B0)
 *
 * Append-only event log for freshness attention events.
 * Communication channel between the MCP tool layer (B1/B2 notice delivery)
 * and the harness layer (B3/B4 re-invoke decisions).
 *
 * Uses Redis LIST per invocation (key: freshness:events:inv:{invocationId}).
 * Events have TTL (7 days) for automatic cleanup — unlike BallCustodyEventLog
 * which is permanent. Freshness events are operational, not user-visible state.
 *
 * Closed union type with kind discriminator (spec §B0a):
 *   held_decision | forward_decision | notice_attached | notice_implicit_acked |
 *   notice_deferred | reinvoke_triggered | reinvoke_skipped
 */

import type { CatId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

// --- Event type definitions (closed union) ---

interface FreshnessEventBase {
  threadId: string;
  catId: CatId;
  invocationId: string;
  timestamp: number;
}

interface HeldDecisionEvent extends FreshnessEventBase {
  kind: 'held_decision';
  toolName: string;
  unseenCount: number;
  reason: string;
}

interface ForwardDecisionEvent extends FreshnessEventBase {
  kind: 'forward_decision';
  toolName: string;
  reason: string;
}

interface NoticeAttachedEvent extends FreshnessEventBase {
  kind: 'notice_attached';
  toolName: string;
  unseenSenders: string[];
  noticeId: string;
  maxMessageId: string;
}

interface NoticeImplicitAckedEvent extends FreshnessEventBase {
  kind: 'notice_implicit_acked';
  noticeIds: string[];
  ackedVia: 'seenCursor_advance';
}

interface NoticeDeferredEvent extends FreshnessEventBase {
  kind: 'notice_deferred';
  noticeIds: string[];
}

interface ReinvokeTriggeredEvent extends FreshnessEventBase {
  kind: 'reinvoke_triggered';
  triggeredInvocationId: string;
  sourceNoticeIds: string[];
}

interface ReinvokeSkippedEvent extends FreshnessEventBase {
  kind: 'reinvoke_skipped';
  reason: 'quota_exhausted' | 'already_handled' | 'low_priority' | 'cursor_caught_up' | 'newer_invocation';
}

export type FreshnessAttentionEvent =
  | HeldDecisionEvent
  | ForwardDecisionEvent
  | NoticeAttachedEvent
  | NoticeImplicitAckedEvent
  | NoticeDeferredEvent
  | ReinvokeTriggeredEvent
  | ReinvokeSkippedEvent;

// Re-export for consumers
export type { NoticeAttachedEvent };

// --- Constants ---

/** TTL for event log keys: 7 days in seconds */
const EVENT_LOG_TTL_SECONDS = 7 * 24 * 60 * 60; // 604800

/** Redis key prefix for per-invocation event log */
function invocationKey(invocationId: string): string {
  return `freshness:events:inv:${invocationId}`;
}

// --- Event Log ---

export class FreshnessAttentionEventLog {
  constructor(private readonly redis: RedisClient) {}

  /**
   * Append an event to the invocation's event log.
   * Sets TTL on first write (idempotent — EXPIRE resets if already set).
   */
  async append(event: FreshnessAttentionEvent): Promise<void> {
    const key = invocationKey(event.invocationId);
    const serialized = JSON.stringify(event);

    await this.redis.rpush(key, serialized);
    // Set TTL (resets on every append — last event keeps the log alive)
    await this.redis.expire(key, EVENT_LOG_TTL_SECONDS);
  }

  /**
   * Query all events for a given invocation, in append order.
   */
  async queryByInvocation(invocationId: string): Promise<FreshnessAttentionEvent[]> {
    const key = invocationKey(invocationId);
    const raw = await this.redis.lrange(key, 0, -1);
    return raw.map((s: string) => JSON.parse(s) as FreshnessAttentionEvent);
  }

  /**
   * Get unresolved notices for an invocation.
   * A notice is "unresolved" if it has been attached but NOT explicitly acked.
   *
   * `notice_deferred` does NOT resolve a notice — it means the cat was warned
   * at hold_ball time but chose to exit without reading. B3 should still
   * consider re-invoking for deferred notices (the cat never read the messages).
   * Only `notice_implicit_acked` (seenCursor caught up) truly resolves.
   *
   * This is the key projection for B3 (re-invoke trigger decision).
   */
  async getUnresolvedNotices(invocationId: string): Promise<NoticeAttachedEvent[]> {
    const events = await this.queryByInvocation(invocationId);

    // Only notice_implicit_acked resolves a notice.
    // notice_deferred = "cat was warned but didn't read" — NOT resolved.
    const resolvedIds = new Set<string>();
    for (const e of events) {
      if (e.kind === 'notice_implicit_acked') {
        for (const id of e.noticeIds) {
          resolvedIds.add(id);
        }
      }
    }

    // Return notices that haven't been resolved
    return events.filter((e): e is NoticeAttachedEvent => e.kind === 'notice_attached' && !resolvedIds.has(e.noticeId));
  }
}
