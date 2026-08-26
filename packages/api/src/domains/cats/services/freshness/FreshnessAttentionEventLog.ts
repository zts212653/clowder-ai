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
 *   notice_deferred | reinvoke_triggered | reinvoke_skipped | queued_handled
 */

import type {
  CatId,
  FreshnessCarrier,
  FreshnessCarrierDeliverySemantics,
  FreshnessCarrierProvider,
  QueueHandledDisposition,
  QueueTargetOutcomeEvidenceRef,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { FreshnessRelevanceReason } from './FreshnessRelevancePolicy.js';

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
  relevanceSuppressions?: Partial<Record<FreshnessRelevanceReason, number>>;
}

interface ForwardDecisionEvent extends FreshnessEventBase {
  kind: 'forward_decision';
  toolName: string;
  reason: string;
  relevanceSuppressions?: Partial<Record<FreshnessRelevanceReason, number>>;
}

interface NoticeAttachedEvent extends FreshnessEventBase {
  kind: 'notice_attached';
  toolName: string;
  unseenSenders: string[];
  noticeId: string;
  maxMessageId: string;
  /** #1200 Sol R6 P2-2: v2 cursor for maxMessageId position.
   *  New events always set this. Absent on legacy events — consumers
   *  must fall back to canonicalizing maxMessageId or conservatively keep. */
  maxCursor?: string;
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

/** F254 Phase D: stream output was generated while unseen messages existed */
interface StreamStaleDetectedEvent extends FreshnessEventBase {
  kind: 'stream_stale_detected';
  unseenCount: number;
  unseenSenders: string[];
  reason: string;
  relevanceSuppressions?: Partial<Record<FreshnessRelevanceReason, number>>;
}

/** F254 Phase D: stream output freshness check determined output is fresh */
interface StreamFreshEvent extends FreshnessEventBase {
  kind: 'stream_fresh';
  reason: string;
  relevanceSuppressions?: Partial<Record<FreshnessRelevanceReason, number>>;
}

/** F254 D1.2b: queued message was handled by one target cat after a successful invocation */
interface QueuedHandledEvent extends FreshnessEventBase {
  kind: 'queued_handled';
  queueEntryId: string;
  messageIds: string[];
  disposition: QueueHandledDisposition;
  evidenceRef: QueueTargetOutcomeEvidenceRef;
  remainingTargetCats: string[];
}

export type ProviderNativeFreshnessProvider = FreshnessCarrierProvider;
export type ProviderNativeFreshnessCarrier = FreshnessCarrier;
export type ProviderNativeFreshnessDeliverySemantics = FreshnessCarrierDeliverySemantics;
export type ProviderNativeFreshnessToolSurface =
  | 'command_execution'
  | 'file_change'
  | 'mcp_tool_call'
  | 'dynamic_tool_call'
  | 'collab_agent_tool_call'
  | 'sub_agent_activity'
  | 'web_search'
  | 'image_view'
  | 'image_generation'
  | 'sleep'
  | 'unknown'
  | 'other';
export type ProviderNativeFreshnessMissReason =
  | 'unsupported_carrier'
  | 'no_safe_boundary'
  | 'turn_mismatch'
  | 'rpc_rejected'
  | 'turn_completed'
  | 'transport_failed'
  | 'not_read';

interface ProviderNoticeEventBase extends FreshnessEventBase {
  noticeId: string;
  frontier: string;
  /** Exact durable identities used for receipt correlation; legacy events fall back to frontier. */
  correlationMessageIds?: string[];
  provider: ProviderNativeFreshnessProvider;
  carrier: ProviderNativeFreshnessCarrier;
  deliverySemantics: ProviderNativeFreshnessDeliverySemantics;
  toolSurface: ProviderNativeFreshnessToolSurface;
  expectedTurnId: string;
}

export interface ProviderNoticeOpportunityEvent extends ProviderNoticeEventBase {
  kind: 'provider_notice_opportunity';
}

export interface ProviderNoticePreparedEvent extends ProviderNoticeEventBase {
  kind: 'provider_notice_prepared';
}

export interface ProviderNoticeDeliveredEvent extends ProviderNoticeEventBase {
  kind: 'provider_notice_delivered';
  acceptedTurnId: string;
}

export interface ProviderNoticeMissedEvent extends ProviderNoticeEventBase {
  kind: 'provider_notice_missed';
  missReason: ProviderNativeFreshnessMissReason;
}

export interface ProviderNoticeSeenEvent extends ProviderNoticeEventBase {
  kind: 'provider_notice_seen';
  seenMessageIds: string[];
  evidenceKind: 'full_contiguous_thread_context' | 'queue_exact_read';
}

export interface ProviderNoticeHandledEvent extends ProviderNoticeEventBase {
  kind: 'provider_notice_handled';
  queueEntryId: string;
  evidenceRef: QueueTargetOutcomeEvidenceRef;
}

export interface ProviderCarrierCapabilityDeclaredEvent extends FreshnessEventBase {
  kind: 'provider_carrier_capability_declared';
  provider: ProviderNativeFreshnessProvider;
  carrier: ProviderNativeFreshnessCarrier;
  deliverySemantics: ProviderNativeFreshnessDeliverySemantics;
}

export interface ProviderProtocolItemObservedEvent extends FreshnessEventBase {
  kind: 'provider_protocol_item_observed';
  provider: ProviderNativeFreshnessProvider;
  carrier: ProviderNativeFreshnessCarrier;
  deliverySemantics: ProviderNativeFreshnessDeliverySemantics;
  toolSurface: ProviderNativeFreshnessToolSurface;
  /** Low-cardinality census key. Unrecognized provider strings collapse to `unknown`. */
  itemType: string;
  status: string;
  classification: 'safe_boundary' | 'intentional_non_boundary' | 'deferred_no_data' | 'unknown';
  /** At most eight distinct, 64-character samples are persisted per invocation. */
  boundedUnknownSample?: string;
}

export type FreshnessAttentionEvent =
  | HeldDecisionEvent
  | ForwardDecisionEvent
  | NoticeAttachedEvent
  | NoticeImplicitAckedEvent
  | NoticeDeferredEvent
  | ReinvokeTriggeredEvent
  | ReinvokeSkippedEvent
  | StreamStaleDetectedEvent
  | StreamFreshEvent
  | QueuedHandledEvent
  | ProviderNoticeOpportunityEvent
  | ProviderNoticePreparedEvent
  | ProviderNoticeDeliveredEvent
  | ProviderNoticeMissedEvent
  | ProviderNoticeSeenEvent
  | ProviderNoticeHandledEvent
  | ProviderCarrierCapabilityDeclaredEvent
  | ProviderProtocolItemObservedEvent;

// Re-export for consumers
export type { NoticeAttachedEvent };

// --- Constants ---

/** TTL for event log keys: 7 days in seconds */
const EVENT_LOG_TTL_SECONDS = 7 * 24 * 60 * 60; // 604800
const PROVIDER_NATIVE_INDEX_KEY = 'freshness:events:provider-native';

function exactReadCoversProviderNotice(
  notice: Pick<ProviderNoticeEventBase, 'frontier' | 'correlationMessageIds'>,
  exactIds: ReadonlySet<string>,
): boolean {
  const correlationIds = notice.correlationMessageIds ?? [notice.frontier];
  return correlationIds.length > 0 && correlationIds.every((messageId) => exactIds.has(messageId));
}

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
    if (event.kind.startsWith('provider_')) {
      await this.redis.zadd(PROVIDER_NATIVE_INDEX_KEY, String(event.timestamp), serialized);
      await this.redis.zremrangebyscore(
        PROVIDER_NATIVE_INDEX_KEY,
        '-inf',
        String(Date.now() - EVENT_LOG_TTL_SECONDS * 1_000),
      );
    }
  }

  /**
   * Query all events for a given invocation, in append order.
   */
  async queryByInvocation(invocationId: string): Promise<FreshnessAttentionEvent[]> {
    const key = invocationKey(invocationId);
    const raw = await this.redis.lrange(key, 0, -1);
    return raw.map((s: string) => JSON.parse(s) as FreshnessAttentionEvent);
  }

  async queryProviderNativeBetween(startMs: number, endMs: number): Promise<FreshnessAttentionEvent[]> {
    const raw = await this.redis.zrangebyscore(PROVIDER_NATIVE_INDEX_KEY, String(startMs), `(${endMs}`);
    return raw.map((value: string) => JSON.parse(value) as FreshnessAttentionEvent);
  }

  async markProviderNoticesSeen(input: {
    invocationId: string;
    catId: CatId;
    exactMessageIds: readonly string[];
    evidenceKind: ProviderNoticeSeenEvent['evidenceKind'];
  }): Promise<number> {
    if (input.exactMessageIds.length === 0) return 0;
    const events = await this.queryByInvocation(input.invocationId);
    const exactIds = new Set(input.exactMessageIds);
    const delivered = events.filter(
      (event): event is ProviderNoticeDeliveredEvent =>
        event.kind === 'provider_notice_delivered' && event.catId === input.catId,
    );
    const seenIds = new Set(
      events
        .filter((event): event is ProviderNoticeSeenEvent => event.kind === 'provider_notice_seen')
        .map((event) => event.noticeId),
    );
    let marked = 0;
    for (const notice of delivered) {
      if (seenIds.has(notice.noticeId) || !exactReadCoversProviderNotice(notice, exactIds)) continue;
      await this.append({
        ...notice,
        kind: 'provider_notice_seen',
        timestamp: Date.now(),
        seenMessageIds: [...input.exactMessageIds],
        evidenceKind: input.evidenceKind,
      });
      marked++;
    }
    return marked;
  }

  async markProviderNoticesHandled(input: {
    invocationId: string;
    catId: CatId;
    queueEntryId: string;
    messageIds: readonly string[];
    evidenceRef: QueueTargetOutcomeEvidenceRef;
  }): Promise<number> {
    const events = await this.queryByInvocation(input.invocationId);
    const messageIds = new Set(input.messageIds);
    const seen = events.filter(
      (event): event is ProviderNoticeSeenEvent => event.kind === 'provider_notice_seen' && event.catId === input.catId,
    );
    const handledIds = new Set(
      events
        .filter((event): event is ProviderNoticeHandledEvent => event.kind === 'provider_notice_handled')
        .map((event) => event.noticeId),
    );
    let marked = 0;
    for (const notice of seen) {
      if (handledIds.has(notice.noticeId) || !exactReadCoversProviderNotice(notice, messageIds)) continue;
      await this.append({
        ...notice,
        kind: 'provider_notice_handled',
        timestamp: Date.now(),
        queueEntryId: input.queueEntryId,
        evidenceRef: input.evidenceRef,
      });
      marked++;
    }
    return marked;
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
