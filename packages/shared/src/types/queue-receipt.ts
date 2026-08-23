export type QueueReceiptTargetState =
  | 'queued'
  | 'notified'
  | 'awakened'
  | 'seen'
  | 'failed'
  | 'interrupted'
  | 'steering'
  | 'withdrawn'
  | 'handled';

export type QueueHandledDisposition = 'responded' | 'completed_with_turn' | 'managed_hold_disposition';

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

/** Existing structured tools consumed one managed wake by establishing its successor condition. */
export interface QueueManagedHoldContinuationWitness {
  kind: 'managed_hold_continued';
  sourceMessageId: string;
  taskId: string;
  transition: 'reheld' | 'event_wait' | 'transferred';
}

/**
 * Durable proof that an exact A2A carrier was terminally handled while the
 * provider ended before independently grounded owner work could continue.
 */
export interface QueueDispatchHandledContinuationWitness {
  kind: 'dispatch_handled_continuation';
  sourceMessageId: string;
  dispositionEventId: string;
  dispositionAt: number;
}

export type QueueTerminalConsumptionWitness =
  | QueueTerminalSilentConsumptionWitness
  | QueueSourceResponseConsumptionWitness
  | QueueManagedHoldContinuationWitness
  | QueueDispatchHandledContinuationWitness;

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

/**
 * One immutable delivery attempt for one target of an authored Queue message.
 * A retry always appends a new attempt; it never rewrites the failed one or
 * creates a second user message.
 */
export type QueueTargetAttemptState =
  | 'queued'
  | 'starting'
  | 'appended'
  | 'failed'
  | 'interrupted'
  | 'cancelled'
  | 'handled';
export type QueueTargetAttemptTerminalReason =
  | 'invocation_failed'
  | 'runtime_restart'
  | 'invocation_cancelled'
  | 'source_withdrawn';

export interface QueueTargetAttempt {
  id: string;
  targetCatId: string;
  sequence: number;
  state: QueueTargetAttemptState;
  createdAt: number;
  updatedAt: number;
  invocationId?: string;
  /** Exact prompt-body exposure time when this attempt reached a reply. */
  seenAt?: number;
  terminalReason?: QueueTargetAttemptTerminalReason;
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
  /** Append-only target-local delivery history. Missing only on legacy receipts. */
  attempts?: QueueTargetAttempt[];
  /** False when cross-thread dispatch never created a durable carrier to retry. */
  retryable?: boolean;
}

export interface QueueMessageReceipt {
  version: 1;
  entryId: string;
  /** The message started this invocation; it is not a work-period receipt surface. */
  scope?: 'primary_trigger' | 'cross_thread_delivery';
  targets: QueueReceiptTarget[];
  reminderAttempts: QueueReminderAttempt[];
}

/** Message-bound receipt delta for live Queue publication after its actionable row disappears. */
export interface QueueMessageReceiptProjection {
  messageId: string;
  queueReceipt: QueueMessageReceipt;
}
