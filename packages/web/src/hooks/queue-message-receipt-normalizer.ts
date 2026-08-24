import type {
  FreshnessCarrierCapability,
  QueueAuthorIntentReceipt,
  QueueMessageReceipt,
  QueueMessageReceiptProjection,
  QueueReceiptTarget,
  QueueReminderAttempt,
  QueueTargetAttempt,
  QueueTargetOutcome,
  QueueTerminalConsumptionWitness,
} from '@cat-cafe/shared';

type UnknownRecord = Record<string, unknown>;

const TARGET_STATES = new Set([
  'queued',
  'notified',
  'awakened',
  'seen',
  'failed',
  'interrupted',
  'steering',
  'withdrawn',
  'handled',
]);
const REMINDER_STATES = new Set(['requested', 'delivered', 'seen', 'missed']);
const REMINDER_MISSED_REASONS = new Set(['invocation_ended_before_delivery', 'delivered_not_read', 'source_withdrawn']);
const ATTEMPT_STATES = new Set(['queued', 'starting', 'appended', 'failed', 'interrupted', 'cancelled', 'handled']);
const ATTEMPT_TERMINAL_REASONS = new Set([
  'invocation_failed',
  'runtime_restart',
  'invocation_cancelled',
  'source_withdrawn',
]);
const WORK_DISPOSITIONS = new Set(['continue_current', 'next_work']);
const HANDLED_DISPOSITIONS = new Set(['responded', 'completed_with_turn', 'managed_hold_disposition']);
const FALLBACK_REASONS = new Set([
  'no_active_parent',
  'carrier_capability_undeclared',
  'unsupported_carrier',
  'parent_terminal_before_exposure',
  'parent_non_success_after_exposure',
]);
const CARRIER_PROVIDERS = new Set(['openai_codex', 'anthropic', 'kimi', 'other']);
const CARRIERS = new Set([
  'codex_app_server',
  'codex_exec_json',
  'claude_print_sdk',
  'claude_stream_json',
  'kimi_stream_json',
  'mcp_result_piggyback',
  'other',
]);
const DELIVERY_SEMANTICS = new Set([
  'exact_active_turn',
  'queued_internal_turn',
  'mcp_result_piggyback',
  'unsupported',
  'undeclared',
]);

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value);
}

function normalizeCarrierCapability(value: unknown): FreshnessCarrierCapability | undefined {
  const candidate = asRecord(value);
  if (
    !candidate ||
    typeof candidate.provider !== 'string' ||
    !CARRIER_PROVIDERS.has(candidate.provider) ||
    typeof candidate.carrier !== 'string' ||
    !CARRIERS.has(candidate.carrier) ||
    typeof candidate.deliverySemantics !== 'string' ||
    !DELIVERY_SEMANTICS.has(candidate.deliverySemantics)
  ) {
    return undefined;
  }
  return candidate as unknown as FreshnessCarrierCapability;
}

function normalizeAuthorIntent(value: unknown): QueueAuthorIntentReceipt | undefined {
  const candidate = asRecord(value);
  if (
    !candidate ||
    typeof candidate.requested !== 'string' ||
    !WORK_DISPOSITIONS.has(candidate.requested) ||
    typeof candidate.effective !== 'string' ||
    !WORK_DISPOSITIONS.has(candidate.effective) ||
    !isOptionalString(candidate.boundParentInvocationId) ||
    !isOptionalNumber(candidate.fallbackAt) ||
    (candidate.fallbackReason !== undefined &&
      (typeof candidate.fallbackReason !== 'string' || !FALLBACK_REASONS.has(candidate.fallbackReason)))
  ) {
    return undefined;
  }
  const carrierCapability =
    candidate.carrierCapability === undefined ? undefined : normalizeCarrierCapability(candidate.carrierCapability);
  if (candidate.carrierCapability !== undefined && !carrierCapability) return undefined;
  return {
    requested: candidate.requested as QueueAuthorIntentReceipt['requested'],
    effective: candidate.effective as QueueAuthorIntentReceipt['effective'],
    ...(carrierCapability ? { carrierCapability } : {}),
    ...(candidate.boundParentInvocationId ? { boundParentInvocationId: candidate.boundParentInvocationId } : {}),
    ...(candidate.fallbackAt !== undefined ? { fallbackAt: candidate.fallbackAt } : {}),
    ...(candidate.fallbackReason
      ? { fallbackReason: candidate.fallbackReason as NonNullable<QueueAuthorIntentReceipt['fallbackReason']> }
      : {}),
  };
}

function normalizeConsumption(value: unknown): QueueTerminalConsumptionWitness | undefined {
  const candidate = asRecord(value);
  if (!candidate || typeof candidate.kind !== 'string') return undefined;
  if (
    candidate.kind === 'terminal_silent' &&
    candidate.projectionState === 'covered_empty' &&
    candidate.wake === 'coordination_terminal'
  ) {
    return candidate as unknown as QueueTerminalConsumptionWitness;
  }
  if (
    candidate.kind === 'source_response' &&
    Array.isArray(candidate.outputMessageIds) &&
    candidate.outputMessageIds.every(isNonEmptyString)
  ) {
    return { kind: 'source_response', outputMessageIds: candidate.outputMessageIds };
  }
  if (
    candidate.kind === 'managed_hold_continued' &&
    isNonEmptyString(candidate.sourceMessageId) &&
    isNonEmptyString(candidate.taskId) &&
    (candidate.transition === 'reheld' ||
      candidate.transition === 'event_wait' ||
      candidate.transition === 'transferred')
  ) {
    return candidate as unknown as QueueTerminalConsumptionWitness;
  }
  if (
    candidate.kind === 'dispatch_handled_continuation' &&
    isNonEmptyString(candidate.sourceMessageId) &&
    isNonEmptyString(candidate.dispositionEventId) &&
    isFiniteNumber(candidate.dispositionAt)
  ) {
    return candidate as unknown as QueueTerminalConsumptionWitness;
  }
  return undefined;
}

function normalizeOutcome(value: unknown): QueueTargetOutcome | undefined {
  const candidate = asRecord(value);
  const evidenceRef = asRecord(candidate?.evidenceRef);
  if (
    !candidate ||
    !isNonEmptyString(candidate.invocationId) ||
    typeof candidate.disposition !== 'string' ||
    !HANDLED_DISPOSITIONS.has(candidate.disposition) ||
    !evidenceRef ||
    evidenceRef.kind !== 'invocation_lineage' ||
    !isNonEmptyString(evidenceRef.invocationId) ||
    !isFiniteNumber(candidate.handledAt)
  ) {
    return undefined;
  }
  const consumption = candidate.consumption === undefined ? undefined : normalizeConsumption(candidate.consumption);
  if (candidate.consumption !== undefined && !consumption) return undefined;
  return {
    invocationId: candidate.invocationId,
    disposition: candidate.disposition as QueueTargetOutcome['disposition'],
    evidenceRef: { kind: 'invocation_lineage', invocationId: evidenceRef.invocationId },
    handledAt: candidate.handledAt,
    ...(consumption ? { consumption } : {}),
  };
}

function normalizeTargetAttempt(value: unknown): QueueTargetAttempt | undefined {
  const candidate = asRecord(value);
  if (
    !candidate ||
    !isNonEmptyString(candidate.id) ||
    !isNonEmptyString(candidate.targetCatId) ||
    !Number.isInteger(candidate.sequence) ||
    (candidate.sequence as number) < 1 ||
    typeof candidate.state !== 'string' ||
    !ATTEMPT_STATES.has(candidate.state) ||
    !isFiniteNumber(candidate.createdAt) ||
    !isFiniteNumber(candidate.updatedAt) ||
    !isOptionalString(candidate.invocationId) ||
    !isOptionalNumber(candidate.seenAt) ||
    (candidate.terminalReason !== undefined &&
      (typeof candidate.terminalReason !== 'string' || !ATTEMPT_TERMINAL_REASONS.has(candidate.terminalReason)))
  ) {
    return undefined;
  }
  return candidate as unknown as QueueTargetAttempt;
}

function hasReceiptTargetIdentity(candidate: UnknownRecord): boolean {
  return isNonEmptyString(candidate.catId) && typeof candidate.state === 'string' && TARGET_STATES.has(candidate.state);
}

function hasValidReceiptTargetOptionals(candidate: UnknownRecord): boolean {
  return (
    isOptionalString(candidate.invocationId) &&
    isOptionalNumber(candidate.awakenedAt) &&
    isOptionalNumber(candidate.seenAt) &&
    isOptionalNumber(candidate.withdrawnAt) &&
    (candidate.retryable === undefined || typeof candidate.retryable === 'boolean') &&
    (candidate.attempts === undefined || Array.isArray(candidate.attempts))
  );
}

interface NormalizedReceiptTargetNested {
  authorIntent?: QueueAuthorIntentReceipt;
  outcome?: QueueTargetOutcome;
  attempts?: QueueTargetAttempt[];
}

function normalizeReceiptTargetNested(candidate: UnknownRecord): NormalizedReceiptTargetNested | undefined {
  const authorIntent = candidate.authorIntent === undefined ? undefined : normalizeAuthorIntent(candidate.authorIntent);
  if (candidate.authorIntent !== undefined && !authorIntent) return undefined;
  const outcome = candidate.outcome === undefined ? undefined : normalizeOutcome(candidate.outcome);
  if (candidate.outcome !== undefined && !outcome) return undefined;
  const attempts = Array.isArray(candidate.attempts)
    ? candidate.attempts.flatMap((attempt) => {
        const normalized = normalizeTargetAttempt(attempt);
        return normalized ? [normalized] : [];
      })
    : undefined;
  return { authorIntent, outcome, attempts };
}

function buildReceiptTarget(candidate: UnknownRecord, nested: NormalizedReceiptTargetNested): QueueReceiptTarget {
  const target: QueueReceiptTarget = {
    catId: candidate.catId as string,
    state: candidate.state as QueueReceiptTarget['state'],
  };
  if (nested.authorIntent) target.authorIntent = nested.authorIntent;
  if (candidate.invocationId !== undefined) target.invocationId = candidate.invocationId as string;
  if (candidate.awakenedAt !== undefined) target.awakenedAt = candidate.awakenedAt as number;
  if (candidate.seenAt !== undefined) target.seenAt = candidate.seenAt as number;
  if (candidate.withdrawnAt !== undefined) target.withdrawnAt = candidate.withdrawnAt as number;
  if (nested.outcome) target.outcome = nested.outcome;
  if (nested.attempts) target.attempts = nested.attempts;
  if (candidate.retryable !== undefined) target.retryable = candidate.retryable as boolean;
  return target;
}

function normalizeReceiptTarget(value: unknown): QueueReceiptTarget | undefined {
  const candidate = asRecord(value);
  if (!candidate || !hasReceiptTargetIdentity(candidate) || !hasValidReceiptTargetOptionals(candidate)) {
    return undefined;
  }
  const nested = normalizeReceiptTargetNested(candidate);
  return nested ? buildReceiptTarget(candidate, nested) : undefined;
}

function normalizeReminderAttempt(value: unknown): QueueReminderAttempt | undefined {
  const candidate = asRecord(value);
  if (
    !candidate ||
    !isNonEmptyString(candidate.id) ||
    !isNonEmptyString(candidate.targetCatId) ||
    !isNonEmptyString(candidate.invocationId) ||
    typeof candidate.state !== 'string' ||
    !REMINDER_STATES.has(candidate.state) ||
    !isFiniteNumber(candidate.requestedAt) ||
    !isOptionalNumber(candidate.deliveredAt) ||
    !isOptionalNumber(candidate.seenAt) ||
    !isOptionalNumber(candidate.missedAt) ||
    (candidate.missedReason !== undefined &&
      (typeof candidate.missedReason !== 'string' || !REMINDER_MISSED_REASONS.has(candidate.missedReason)))
  ) {
    return undefined;
  }
  return candidate as unknown as QueueReminderAttempt;
}

function normalizeMessageReceipt(value: unknown): QueueMessageReceipt | undefined {
  const candidate = asRecord(value);
  if (
    !candidate ||
    candidate.version !== 1 ||
    !isNonEmptyString(candidate.entryId) ||
    (candidate.scope !== undefined &&
      candidate.scope !== 'primary_trigger' &&
      candidate.scope !== 'cross_thread_delivery') ||
    !Array.isArray(candidate.targets) ||
    !Array.isArray(candidate.reminderAttempts)
  ) {
    return undefined;
  }
  return {
    version: 1,
    entryId: candidate.entryId,
    ...(candidate.scope ? { scope: candidate.scope } : {}),
    targets: candidate.targets.flatMap((target) => {
      const normalized = normalizeReceiptTarget(target);
      return normalized ? [normalized] : [];
    }),
    reminderAttempts: candidate.reminderAttempts.flatMap((attempt) => {
      const normalized = normalizeReminderAttempt(attempt);
      return normalized ? [normalized] : [];
    }),
  };
}

export function normalizeQueueMessageReceiptProjections(value: unknown): QueueMessageReceiptProjection[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((projection) => {
    const candidate = asRecord(projection);
    if (!candidate || !isNonEmptyString(candidate.messageId)) return [];
    const queueReceipt = normalizeMessageReceipt(candidate.queueReceipt);
    return queueReceipt ? [{ messageId: candidate.messageId, queueReceipt }] : [];
  });
}
