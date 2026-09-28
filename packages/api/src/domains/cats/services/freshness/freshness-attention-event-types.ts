import type {
  CatId,
  FreshnessCarrier,
  FreshnessCarrierDeliverySemantics,
  FreshnessCarrierProvider,
  QueueHandledDisposition,
  QueueTargetOutcomeEvidenceRef,
} from '@cat-cafe/shared';
import type { FreshnessRelevanceReason } from './FreshnessRelevancePolicy.js';

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

export interface NoticeAttachedEvent extends FreshnessEventBase {
  kind: 'notice_attached';
  toolName: string;
  unseenSenders: string[];
  noticeId: string;
  maxMessageId: string;
  /** New events carry the v2 cursor; legacy events may omit it. */
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

interface StreamStaleDetectedEvent extends FreshnessEventBase {
  kind: 'stream_stale_detected';
  unseenCount: number;
  unseenSenders: string[];
  reason: string;
  relevanceSuppressions?: Partial<Record<FreshnessRelevanceReason, number>>;
}

interface StreamFreshEvent extends FreshnessEventBase {
  kind: 'stream_fresh';
  reason: string;
  relevanceSuppressions?: Partial<Record<FreshnessRelevanceReason, number>>;
}

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

export interface ProviderNoticeEventBase extends FreshnessEventBase {
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
  itemType: string;
  status: string;
  classification: 'safe_boundary' | 'intentional_non_boundary' | 'deferred_no_data' | 'unknown';
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

export type FreshnessEventWindowCoverage =
  | { status: 'complete'; completeFromMs: number; observedThroughMs: number }
  | {
      status: 'incomplete';
      completeFromMs: number;
      observedThroughMs: number;
      reason:
        | 'window_starts_before_coverage'
        | 'window_ends_after_observed_through'
        | 'unscoped_events_present'
        | 'event_append_gap';
    }
  | { status: 'unavailable'; observedThroughMs: number; reason: 'coverage_not_initialized' };

export interface FreshnessAttentionEventWindow {
  events: FreshnessAttentionEvent[];
  coverage: FreshnessEventWindowCoverage;
}
