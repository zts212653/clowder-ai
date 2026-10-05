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

/** Ephemeral server projection of completed children while an exact auxiliary child finishes. */
export interface QueueInvocationSettlement {
  activeTurnInvocationId: string;
  completedTurnInvocationIds: string[];
}

export type QueueHandledDisposition =
  | 'responded'
  | 'completed_with_turn'
  | 'managed_hold_disposition'
  | 'dispatch_disposition';

export type MessageWorkDisposition = 'continue_current' | 'next_work';

/** Exact provider + concrete transport truth used by composer, Queue and receipts. */
export const FRESHNESS_CARRIER_PROVIDERS = ['openai_codex', 'anthropic', 'kimi', 'google', 'other'] as const;
export const FRESHNESS_CARRIERS = [
  'codex_app_server',
  'codex_exec_json',
  'claude_print_sdk',
  'claude_agent_sdk',
  'claude_stream_json',
  'kimi_stream_json',
  'agy_stream_json',
  'mcp_result_piggyback',
  'other',
] as const;
export const FRESHNESS_CARRIER_DELIVERY_SEMANTICS = [
  'exact_active_turn',
  'queued_internal_turn',
  'mcp_result_piggyback',
  'unsupported',
  'undeclared',
] as const;

export type FreshnessCarrierProvider = (typeof FRESHNESS_CARRIER_PROVIDERS)[number];
export type FreshnessCarrier = (typeof FRESHNESS_CARRIERS)[number];
export type FreshnessCarrierDeliverySemantics = (typeof FRESHNESS_CARRIER_DELIVERY_SEMANTICS)[number];

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

/** Durable terminal child truth without a persisted timeline lineage. */
export interface QueueTurnExecutionEvidenceRef {
  kind: 'turn_execution';
  invocationId: string;
}

/** Exact durable dispatch terminal; independent of the carrier's eventual execution outcome. */
export interface QueueDispatchDispositionEvidenceRef {
  kind: 'dispatch_disposition';
  invocationId: string;
  sourceMessageId: string;
  handoffEventId: string;
  dispositionEventId: string;
  disposition: 'handled' | 'completed';
  dispositionAt: number;
}

export function isQueueDispatchDispositionEvidence(value: unknown): value is QueueDispatchDispositionEvidenceRef {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    item.kind === 'dispatch_disposition' &&
    ['invocationId', 'sourceMessageId', 'handoffEventId', 'dispositionEventId'].every(
      (key) => typeof item[key] === 'string' && item[key].length > 0,
    ) &&
    (item.disposition === 'handled' || item.disposition === 'completed') &&
    typeof item.dispositionAt === 'number' &&
    Number.isFinite(item.dispositionAt) &&
    item.dispositionAt >= 0
  );
}

export type QueueTargetOutcomeEvidenceRef =
  | QueueLineageEvidenceRef
  | QueueTurnExecutionEvidenceRef
  | QueueDispatchDispositionEvidenceRef;

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
  /** New event_wait commits require this exact private Task registration reference. */
  waitRegistration?: { taskId: string; generation: number };
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
  evidenceRef: QueueTargetOutcomeEvidenceRef;
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
  /** False when no durable retry is possible or the fenced business action is already terminal. */
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

/** One server-projected Queue escape hatch, including its exact executable request. */
export interface QueueRecoveryRequest {
  method: 'POST' | 'DELETE';
  path: string;
  body?: Readonly<Record<string, string>>;
}

export type QueueRecoveryAction =
  | {
      id: string;
      entryId: string;
      kind: 'steer';
      request: QueueRecoveryRequest;
    }
  | {
      id: string;
      entryId: string;
      kind: 'retry_target';
      targetCatId: string;
      request: QueueRecoveryRequest;
    }
  | {
      id: string;
      entryId: string;
      kind: 'force_reset';
      request: QueueRecoveryRequest;
    }
  | {
      id: string;
      entryId: string;
      kind: 'withdraw';
      request: QueueRecoveryRequest;
    };
