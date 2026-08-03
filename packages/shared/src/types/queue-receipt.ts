export type QueueReceiptTargetState = 'queued' | 'notified' | 'awakened' | 'seen' | 'failed' | 'steering' | 'handled';

export type QueueHandledDisposition = 'responded' | 'completed_with_turn';

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
export type QueueReminderMissedReason = 'invocation_ended_before_delivery' | 'delivered_not_read';

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
  invocationId?: string;
  /** Exact time the durable child invocation was created for this target. */
  awakenedAt?: number;
  /** Exact time this target's child invocation first received the persisted message body. */
  seenAt?: number;
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
