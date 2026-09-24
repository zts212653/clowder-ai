import type {
  CatId,
  FreshnessCarrier,
  FreshnessCarrierDeliverySemantics,
  FreshnessCarrierProvider,
  QueueHandledDisposition,
  QueueTargetOutcomeEvidenceRef,
} from '@cat-cafe/shared';

interface FreshnessEventBase {
  threadId: string;
  catId: CatId;
  invocationId: string;
  timestamp: number;
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
