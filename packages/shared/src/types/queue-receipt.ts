export type QueueReceiptTargetState =
  | 'queued'
  | 'notified'
  | 'awakened'
  | 'seen'
  | 'failed'
  | 'steering'
  | 'withdrawn'
  | 'handled';

export type QueueHandledDisposition = 'responded' | 'completed_with_turn';

export type MessageWorkDisposition = 'continue_current' | 'next_work';

/** Exact provider + concrete transport truth used by composer, Queue and receipts. */
export type FreshnessCarrierProvider = 'openai_codex' | 'anthropic' | 'kimi' | 'other';
export type FreshnessCarrier =
  | 'codex_app_server'
  | 'codex_exec_json'
  | 'claude_print_sdk'
  | 'claude_stream_json'
  | 'kimi_stream_json'
  | 'mcp_result_piggyback'
  | 'other';
export type FreshnessCarrierDeliverySemantics =
  | 'exact_active_turn'
  | 'queued_internal_turn'
  | 'mcp_result_piggyback'
  | 'unsupported'
  | 'undeclared';

export interface FreshnessCarrierCapability {
  provider: FreshnessCarrierProvider;
  carrier: FreshnessCarrier;
  deliverySemantics: FreshnessCarrierDeliverySemantics;
}

export type QueueAuthorIntentFallbackReason =
  | 'no_active_parent'
  | 'carrier_capability_undeclared'
  | 'unsupported_carrier'
  | 'parent_terminal_before_exposure'
  | 'parent_non_success_after_exposure';

/**
 * Immutable author request plus an append-only fail-closed fallback fact.
 * `continue_current` is only an exposure permission; it is never read/handled proof.
 */
export interface QueueAuthorIntent {
  requested: MessageWorkDisposition;
  /** Immutable admission-time snapshot; missing is accepted only for legacy stored receipts. */
  carrierCapability?: FreshnessCarrierCapability;
  boundParentInvocationId?: string;
  fallbackAt?: number;
  fallbackReason?: QueueAuthorIntentFallbackReason;
}

export interface QueueAuthorIntentReceipt extends QueueAuthorIntent {
  effective: MessageWorkDisposition;
}

export interface QueueLineageEvidenceRef {
  kind: 'invocation_lineage';
  invocationId: string;
}

export interface QueueTerminalSilentConsumptionWitness {
  kind: 'terminal_silent';
  projectionState: 'covered_empty';
  wake: 'coordination_terminal';
}

/**
 * Durable proof that this exact child published one or more user-visible
 * outputs which explicitly name the enclosing Queue source message.
 */
export interface QueueSourceResponseConsumptionWitness {
  kind: 'source_response';
  outputMessageIds: string[];
}

export type QueueTerminalConsumptionWitness =
  | QueueTerminalSilentConsumptionWitness
  | QueueSourceResponseConsumptionWitness;

export interface QueueTargetOutcome {
  invocationId: string;
  disposition: QueueHandledDisposition;
  evidenceRef: QueueLineageEvidenceRef;
  handledAt: number;
  consumption?: QueueTerminalConsumptionWitness;
}

export type QueueReminderAttemptState = 'requested' | 'delivered' | 'seen' | 'missed';
export type QueueReminderMissedReason = 'invocation_ended_before_delivery' | 'delivered_not_read' | 'source_withdrawn';

export interface QueueReminderAttempt {
  id: string;
  targetCatId: string;
  invocationId: string;
  state: QueueReminderAttemptState;
  requestedAt: number;
  deliveredAt?: number;
  seenAt?: number;
  missedAt?: number;
  missedReason?: QueueReminderMissedReason;
}

export interface QueueReceiptTarget {
  catId: string;
  state: QueueReceiptTargetState;
  authorIntent?: QueueAuthorIntentReceipt;
  invocationId?: string;
  /** Exact time the durable child invocation was created for this target. */
  awakenedAt?: number;
  /** Exact time this target's child invocation first received the persisted message body. */
  seenAt?: number;
  /** Exact time the author removed this target from actionable Queue custody. */
  withdrawnAt?: number;
  outcome?: QueueTargetOutcome;
}

export interface QueueMessageReceipt {
  version: 1;
  entryId: string;
  /** The message started this invocation; it is not a work-period receipt surface. */
  scope?: 'primary_trigger' | 'cross_thread_delivery';
  targets: QueueReceiptTarget[];
  reminderAttempts: QueueReminderAttempt[];
}
