import { sameUnixProcess, type UnixProcessIdentity } from '../../utils/cli-process-ownership.js';
import type { DurableManagedGateJob } from './durable-managed-gate-job.js';
import {
  type DurableGatePowerEvidence,
  type DurableGatePowerEvidenceReader,
  readDurableGatePowerEvidence,
} from './durable-managed-gate-power-evidence.js';
import {
  durableGateRawOutcomeIsAmbiguous,
  durableGateRecoveryRowVersion,
  durableGateSleepOverlapMs,
} from './durable-managed-gate-recovery-policy.js';
import {
  appendDurableGateRecoveryEvent,
  type DurableGateRecoveryRow,
  durableGateRecoveryOwner,
  durableGateRecoveryRow,
  durableGateRecoveryTransaction,
  openDurableGateRecoveryStore,
} from './durable-managed-gate-recovery-store.js';

export type DurableGateRecoveryDecision =
  | { readonly action: 'proceed'; readonly pauseEpoch: number; readonly confirmedSleepMs: number }
  | { readonly action: 'wait'; readonly pauseEpoch: number; readonly deadlineAt: number }
  | {
      readonly action: 'self_reconcile';
      readonly pauseEpoch: number;
      readonly confirmedSleepMs: number;
      readonly reconcileFrom: number;
    }
  | {
      readonly action: 'blocked';
      readonly pauseEpoch: number;
      readonly reason: 'ambiguous_result' | 'child_protocol_unavailable' | 'cleanup_unproven';
    }
  | { readonly action: 'terminal_intent'; readonly pauseEpoch: number; readonly intent: 'cancelled' | 'timed_out' };

export interface DurableGateMutationInput {
  readonly ownerIdentity: UnixProcessIdentity;
  readonly mutation: 'heartbeat' | 'timeout' | 'exit' | 'cancel' | 'wall';
  readonly rawOutcome?: unknown;
  readonly now?: number;
  readonly readPowerEvidence?: DurableGatePowerEvidenceReader;
}

type RecoveryDatabase = ReturnType<typeof openDurableGateRecoveryStore>;
type EvidenceRequest = {
  readonly from: number;
  readonly to: number;
  readonly timeoutMs: number;
  readonly rowVersion: string;
};
type PreparedEvaluation = { readonly decision: DurableGateRecoveryDecision } | { readonly evidence: EvidenceRequest };
const RETRY_EVALUATION = Symbol('retry durable gate recovery evaluation');

function recoveryConfig(job: DurableManagedGateJob) {
  if (job.kind !== 'resumable_full_gate_v2' || job.recovery?.protocolVersion !== 2) {
    throw new Error(`durable gate recovery is not admitted for job ${job.jobId}`);
  }
  return job.recovery;
}

function observeProceed(
  database: RecoveryDatabase,
  row: DurableGateRecoveryRow,
  now: number,
): DurableGateRecoveryDecision {
  database
    .prepare(
      "UPDATE durable_gate_recovery_jobs SET state = 'running', last_observed_at = ?, reconcile_deadline_at = NULL, updated_at = ? WHERE job_id = ?",
    )
    .run(now, now, row.job_id);
  return { action: 'proceed', pauseEpoch: row.pause_epoch, confirmedSleepMs: 0 };
}

function terminalIntentFor(
  job: DurableManagedGateJob,
  mutation: DurableGateMutationInput['mutation'],
  row: DurableGateRecoveryRow,
  now: number,
): 'cancelled' | 'timed_out' | null {
  if (mutation === 'wall' || now >= row.created_at + job.wallSlaMs) return 'timed_out';
  if (mutation === 'cancel') return 'cancelled';
  return null;
}

function recordTerminalIntent(
  database: RecoveryDatabase,
  row: DurableGateRecoveryRow,
  intent: 'cancelled' | 'timed_out',
  now: number,
  rawOutcome: unknown,
): DurableGateRecoveryDecision {
  database
    .prepare(
      "UPDATE durable_gate_recovery_jobs SET state = 'terminal_intent', terminal_intent = ?, updated_at = ? WHERE job_id = ?",
    )
    .run(intent, now, row.job_id);
  appendDurableGateRecoveryEvent(database, row, `terminal_intent_${intent}`, now, rawOutcome ?? null);
  return { action: 'terminal_intent', pauseEpoch: row.pause_epoch, intent };
}

function terminalDecision(row: DurableGateRecoveryRow): DurableGateRecoveryDecision | null {
  return row.terminal_intent
    ? { action: 'terminal_intent', pauseEpoch: row.pause_epoch, intent: row.terminal_intent }
    : null;
}

function blockedDecision(row: DurableGateRecoveryRow): DurableGateRecoveryDecision {
  return { action: 'blocked', pauseEpoch: row.pause_epoch, reason: row.block_reason ?? 'ambiguous_result' };
}

function recordAmbiguousResult(
  database: RecoveryDatabase,
  row: DurableGateRecoveryRow,
  input: DurableGateMutationInput,
  now: number,
): DurableGateRecoveryDecision {
  database
    .prepare(
      "UPDATE durable_gate_recovery_jobs SET state = 'blocked', block_reason = 'ambiguous_result', updated_at = ? WHERE job_id = ?",
    )
    .run(now, row.job_id);
  appendDurableGateRecoveryEvent(database, row, 'ambiguous_result_blocked', now, input.rawOutcome ?? null);
  return blockedDecision(row);
}

function requireOwnedRow(
  database: RecoveryDatabase,
  job: DurableManagedGateJob,
  ownerIdentity: UnixProcessIdentity,
): DurableGateRecoveryRow {
  const row = durableGateRecoveryRow(database, job.jobId);
  if (!row) throw new Error(`durable gate recovery is not initialized: ${job.jobId}`);
  if (!sameUnixProcess(durableGateRecoveryOwner(row), ownerIdentity)) {
    throw new Error(`durable gate recovery owner identity mismatch: ${job.jobId}`);
  }
  return row;
}

function reconcileUnavailableEvidence(
  database: RecoveryDatabase,
  row: DurableGateRecoveryRow,
  now: number,
  reconciliationBudgetMs: number,
  evidence: Extract<DurableGatePowerEvidence, { status: 'unavailable' }>,
  gapMs: number,
): DurableGateRecoveryDecision {
  const deadlineAt = row.reconcile_deadline_at ?? now + reconciliationBudgetMs;
  if (now < deadlineAt) {
    database
      .prepare(
        "UPDATE durable_gate_recovery_jobs SET state = 'reconciling_clock', reconcile_deadline_at = ?, updated_at = ? WHERE job_id = ?",
      )
      .run(deadlineAt, now, row.job_id);
    return { action: 'wait', pauseEpoch: row.pause_epoch, deadlineAt };
  }
  const decision = observeProceed(database, row, now);
  appendDurableGateRecoveryEvent(database, row, 'unknown_gap_deadline', now, { reason: evidence.reason, gapMs });
  return decision;
}

function reconcileAvailableEvidence(
  database: RecoveryDatabase,
  row: DurableGateRecoveryRow,
  input: DurableGateMutationInput,
  now: number,
  reconciliationBudgetMs: number,
  evidence: Extract<DurableGatePowerEvidence, { status: 'available' }>,
): DurableGateRecoveryDecision {
  const intervals = evidence.confirmedSleep.filter(
    (interval) => interval.startedAt < now && interval.endedAt > row.last_observed_at,
  );
  const evidenceId = intervals
    .map((interval) => interval.evidenceId)
    .sort()
    .join('|');
  const confirmedSleepMs = durableGateSleepOverlapMs(intervals, row.last_observed_at, now);
  if (!evidenceId || confirmedSleepMs === 0 || evidenceId === row.last_evidence_id) {
    return observeProceed(database, row, now);
  }
  const pauseEpoch = row.pause_epoch + 1;
  const deadlineAt = now + reconciliationBudgetMs;
  database
    .prepare(`UPDATE durable_gate_recovery_jobs
      SET state = 'reconciling_owner', pause_epoch = ?, reconcile_deadline_at = ?,
          last_evidence_id = ?, updated_at = ? WHERE job_id = ?`)
    .run(pauseEpoch, deadlineAt, evidenceId, now, row.job_id);
  appendDurableGateRecoveryEvent(database, { ...row, pause_epoch: pauseEpoch }, 'confirmed_sleep_reconciliation', now, {
    confirmedSleepMs,
    mutation: input.mutation,
    rawOutcome: input.rawOutcome ?? null,
    evidenceIds: intervals.map((interval) => interval.evidenceId),
  });
  return { action: 'self_reconcile', pauseEpoch, confirmedSleepMs, reconcileFrom: row.last_observed_at };
}

function reconcileEvidence(
  database: RecoveryDatabase,
  row: DurableGateRecoveryRow,
  input: DurableGateMutationInput,
  now: number,
  reconciliationBudgetMs: number,
  evidence: DurableGatePowerEvidence,
): DurableGateRecoveryDecision {
  const gapMs = Math.max(0, now - row.last_observed_at);
  if (evidence.status === 'unavailable') {
    return reconcileUnavailableEvidence(database, row, now, reconciliationBudgetMs, evidence, gapMs);
  }
  const relevantIntervals = evidence.confirmedSleep.filter(
    (interval) => interval.startedAt < now && interval.endedAt > row.last_observed_at,
  );
  const hasFullWake = relevantIntervals.some(
    (interval) => (interval as { readonly wakeKind?: 'dark' | 'full' }).wakeKind !== 'dark',
  );
  if (!hasFullWake && relevantIntervals.length > 0) {
    return reconcileUnavailableEvidence(
      database,
      row,
      now,
      reconciliationBudgetMs,
      { status: 'unavailable', reason: 'full wake was not observed' },
      gapMs,
    );
  }
  return reconcileAvailableEvidence(database, row, input, now, reconciliationBudgetMs, evidence);
}

function prepareEvaluation(
  database: RecoveryDatabase,
  job: DurableManagedGateJob,
  input: DurableGateMutationInput,
  now: number,
): PreparedEvaluation {
  const row = requireOwnedRow(database, job, input.ownerIdentity);
  const existingTerminal = terminalDecision(row);
  if (existingTerminal) return { decision: existingTerminal };
  const intent = terminalIntentFor(job, input.mutation, row, now);
  if (intent) return { decision: recordTerminalIntent(database, row, intent, now, input.rawOutcome) };
  if (row.state === 'blocked') return { decision: blockedDecision(row) };
  if (durableGateRawOutcomeIsAmbiguous(input.mutation, input.rawOutcome)) {
    return { decision: recordAmbiguousResult(database, row, input, now) };
  }
  if (!row.frozen_identity_json) return { decision: observeProceed(database, row, now) };
  if (row.state === 'reconciling_owner') {
    return {
      decision: { action: 'wait', pauseEpoch: row.pause_epoch, deadlineAt: row.reconcile_deadline_at ?? now },
    };
  }
  const config = recoveryConfig(job);
  const gapMs = Math.max(0, now - row.last_observed_at);
  if (gapMs <= config.eventLoopGapMs && input.mutation === 'heartbeat') {
    return { decision: observeProceed(database, row, now) };
  }
  return {
    evidence: {
      from: row.last_observed_at,
      to: now,
      timeoutMs: Math.max(1, Math.min(config.reconciliationBudgetMs, 5_000)),
      rowVersion: durableGateRecoveryRowVersion(row),
    },
  };
}

function applyEvidence(
  database: RecoveryDatabase,
  job: DurableManagedGateJob,
  input: DurableGateMutationInput,
  expectedVersion: string,
  evidence: DurableGatePowerEvidence,
  now: number,
): DurableGateRecoveryDecision | typeof RETRY_EVALUATION {
  const row = requireOwnedRow(database, job, input.ownerIdentity);
  const existingTerminal = terminalDecision(row);
  if (existingTerminal) return existingTerminal;
  const intent = terminalIntentFor(job, input.mutation, row, now);
  if (intent) return recordTerminalIntent(database, row, intent, now, input.rawOutcome);
  if (row.state === 'blocked') return blockedDecision(row);
  if (durableGateRecoveryRowVersion(row) !== expectedVersion) return RETRY_EVALUATION;
  return reconcileEvidence(database, row, input, now, recoveryConfig(job).reconciliationBudgetMs, evidence);
}

function prepareWithFreshStore(
  job: DurableManagedGateJob,
  input: DurableGateMutationInput,
  now: number,
): PreparedEvaluation {
  const database = openDurableGateRecoveryStore(job);
  try {
    return durableGateRecoveryTransaction(database, () => prepareEvaluation(database, job, input, now));
  } finally {
    database.close();
  }
}

function applyWithFreshStore(
  job: DurableManagedGateJob,
  input: DurableGateMutationInput,
  expectedVersion: string,
  evidence: DurableGatePowerEvidence,
  now: number,
): DurableGateRecoveryDecision | typeof RETRY_EVALUATION {
  const database = openDurableGateRecoveryStore(job);
  try {
    return durableGateRecoveryTransaction(database, () =>
      applyEvidence(database, job, input, expectedVersion, evidence, now),
    );
  } finally {
    database.close();
  }
}

export function evaluateDurableGateMutation(
  job: DurableManagedGateJob,
  input: DurableGateMutationInput,
): DurableGateRecoveryDecision {
  const config = recoveryConfig(job);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const prepared = prepareWithFreshStore(job, input, input.now ?? Date.now());
    if ('decision' in prepared) return prepared.decision;
    const readEvidence =
      input.readPowerEvidence ?? ((window) => readDurableGatePowerEvidence(config.powerEvidenceSource, window));
    const evidence = readEvidence({
      from: prepared.evidence.from,
      to: prepared.evidence.to,
      timeoutMs: prepared.evidence.timeoutMs,
    });
    const applied = applyWithFreshStore(job, input, prepared.evidence.rowVersion, evidence, input.now ?? Date.now());
    if (applied !== RETRY_EVALUATION) return applied;
  }
  const database = openDurableGateRecoveryStore(job);
  try {
    const row = requireOwnedRow(database, job, input.ownerIdentity);
    return {
      action: 'wait',
      pauseEpoch: row.pause_epoch,
      deadlineAt: row.reconcile_deadline_at ?? (input.now ?? Date.now()) + config.pollMs,
    };
  } finally {
    database.close();
  }
}
