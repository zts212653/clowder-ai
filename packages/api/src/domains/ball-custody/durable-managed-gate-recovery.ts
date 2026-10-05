import { readFileSync } from 'node:fs';
import { sameUnixProcess, type UnixProcessIdentity } from '../../utils/cli-process-ownership.js';
import type { DurableManagedGateJob } from './durable-managed-gate-job.js';
import {
  appendDurableGateRecoveryEvent,
  durableGateRecoveryOwner,
  durableGateRecoveryRow,
  durableGateRecoveryTransaction,
  openDurableGateRecoveryStore,
} from './durable-managed-gate-recovery-store.js';

export {
  type DurableGateMutationInput,
  type DurableGateRecoveryDecision,
  evaluateDurableGateMutation,
} from './durable-managed-gate-recovery-state.js';

export const DURABLE_MANAGED_GATE_RECOVERY_PROTOCOL_VERSION = 2;

export interface DurableGateFrozenIdentity {
  readonly headSha: string;
  readonly treeSha: string;
  readonly baseSha: string;
  readonly route: string;
  readonly risk: string | null;
  readonly mode: string;
  readonly verificationScope?: 'merge' | 'source_full';
  readonly fingerprint: string;
  readonly runnerFingerprint: string;
  readonly toolchainFingerprint: string;
}

export interface DurableGateRecoverySnapshot {
  readonly state: 'running' | 'reconciling_clock' | 'reconciling_owner' | 'blocked' | 'terminal_intent';
  readonly pauseEpoch: number;
  readonly resumeCount: number;
  readonly ownerIdentity: UnixProcessIdentity;
  readonly lastObservedAt: number;
  readonly reconcileDeadlineAt: number | null;
  readonly terminalIntent: 'cancelled' | 'timed_out' | null;
  readonly blockReason: 'ambiguous_result' | 'child_protocol_unavailable' | 'cleanup_unproven' | null;
  readonly frozenIdentity: DurableGateFrozenIdentity | null;
}

function recoveryConfig(job: DurableManagedGateJob) {
  if (job.kind !== 'resumable_full_gate_v2' || job.recovery?.protocolVersion !== 2) {
    throw new Error(`durable gate recovery is not admitted for job ${job.jobId}`);
  }
  return job.recovery;
}

export function initializeDurableGateRecovery(
  job: DurableManagedGateJob,
  ownerIdentity: UnixProcessIdentity,
  now = Date.now(),
): void {
  recoveryConfig(job);
  const database = openDurableGateRecoveryStore(job);
  try {
    database
      .prepare(
        `INSERT INTO durable_gate_recovery_jobs
           (job_id, protocol_version, state, pause_epoch, owner_pid, owner_ppid, owner_pgid, owner_started_at,
            created_at, last_observed_at, reconcile_deadline_at, terminal_intent, frozen_identity_json,
            last_evidence_id, updated_at)
         VALUES (?, 2, 'running', 0, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)
         ON CONFLICT(job_id) DO NOTHING`,
      )
      .run(
        job.jobId,
        ownerIdentity.pid,
        ownerIdentity.ppid,
        ownerIdentity.pgid,
        ownerIdentity.startedAt,
        now,
        now,
        now,
      );
  } finally {
    database.close();
  }
}

function parseFrozenIdentity(value: unknown): DurableGateFrozenIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const sha40 = /^[0-9a-f]{40}$/u;
  const sha64 = /^[0-9a-f]{64}$/u;
  if (
    (record.protocolVersion !== undefined &&
      record.protocolVersion !== DURABLE_MANAGED_GATE_RECOVERY_PROTOCOL_VERSION) ||
    typeof record.headSha !== 'string' ||
    !sha40.test(record.headSha) ||
    typeof record.treeSha !== 'string' ||
    !sha40.test(record.treeSha) ||
    typeof record.baseSha !== 'string' ||
    !sha40.test(record.baseSha) ||
    typeof record.route !== 'string' ||
    !record.route ||
    (record.risk !== null && typeof record.risk !== 'string') ||
    typeof record.mode !== 'string' ||
    !record.mode ||
    (record.verificationScope !== undefined &&
      record.verificationScope !== 'merge' &&
      record.verificationScope !== 'source_full') ||
    (record.verificationScope === 'source_full' &&
      (record.headSha !== record.baseSha || record.route !== 'full' || record.mode !== 'full')) ||
    typeof record.fingerprint !== 'string' ||
    !sha64.test(record.fingerprint) ||
    typeof record.runnerFingerprint !== 'string' ||
    !sha64.test(record.runnerFingerprint) ||
    typeof record.toolchainFingerprint !== 'string' ||
    !sha64.test(record.toolchainFingerprint)
  )
    return null;
  return {
    headSha: record.headSha,
    treeSha: record.treeSha,
    baseSha: record.baseSha,
    route: record.route,
    risk: record.risk as string | null,
    mode: record.mode,
    ...(record.verificationScope !== undefined ? { verificationScope: record.verificationScope } : {}),
    fingerprint: record.fingerprint,
    runnerFingerprint: record.runnerFingerprint,
    toolchainFingerprint: record.toolchainFingerprint,
  };
}

export function synchronizeDurableGateFrozenIdentity(
  job: DurableManagedGateJob,
  now = Date.now(),
): DurableGateFrozenIdentity | null {
  recoveryConfig(job);
  let receipt: Record<string, unknown>;
  try {
    receipt = JSON.parse(readFileSync(job.gateReceiptPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const recovery = receipt.recovery;
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)) return null;
  const recoveryRecord = recovery as Record<string, unknown>;
  if (recoveryRecord.protocolVersion !== 2) return null;
  const frozenIdentity = parseFrozenIdentity(recoveryRecord.frozenIdentity);
  if (!frozenIdentity || receipt.jobId !== job.jobId) return null;
  const serialized = JSON.stringify(frozenIdentity);
  const database = openDurableGateRecoveryStore(job);
  try {
    return durableGateRecoveryTransaction(database, () => {
      const row = durableGateRecoveryRow(database, job.jobId);
      if (!row) throw new Error(`durable gate recovery is not initialized: ${job.jobId}`);
      if (row.frozen_identity_json && row.frozen_identity_json !== serialized) {
        throw new Error(`durable gate frozen identity changed after begin: ${job.jobId}`);
      }
      database
        .prepare('UPDATE durable_gate_recovery_jobs SET frozen_identity_json = ?, updated_at = ? WHERE job_id = ?')
        .run(serialized, now, job.jobId);
      return frozenIdentity;
    });
  } finally {
    database.close();
  }
}

export function acknowledgeDurableGateSelfRecovery(
  job: DurableManagedGateJob,
  ownerIdentity: UnixProcessIdentity,
  pauseEpoch: number,
  now = Date.now(),
): boolean {
  recoveryConfig(job);
  const database = openDurableGateRecoveryStore(job);
  try {
    return durableGateRecoveryTransaction(database, () => {
      const row = durableGateRecoveryRow(database, job.jobId);
      if (
        !row ||
        row.state !== 'reconciling_owner' ||
        row.pause_epoch !== pauseEpoch ||
        row.terminal_intent !== null ||
        !sameUnixProcess(durableGateRecoveryOwner(row), ownerIdentity)
      )
        return false;
      if (now >= row.created_at + job.wallSlaMs) {
        database
          .prepare(
            "UPDATE durable_gate_recovery_jobs SET state = 'terminal_intent', terminal_intent = 'timed_out', updated_at = ? WHERE job_id = ? AND pause_epoch = ? AND state = 'reconciling_owner' AND terminal_intent IS NULL",
          )
          .run(now, job.jobId, pauseEpoch);
        appendDurableGateRecoveryEvent(database, row, 'terminal_intent_timed_out', now, {
          source: 'self_recovery_ack',
        });
        return false;
      }
      const updated = database
        .prepare(`UPDATE durable_gate_recovery_jobs SET state = 'running', last_observed_at = ?,
        reconcile_deadline_at = NULL, updated_at = ? WHERE job_id = ? AND pause_epoch = ?
        AND state = 'reconciling_owner' AND terminal_intent IS NULL`)
        .run(now, now, job.jobId, pauseEpoch);
      if (updated.changes !== 1) return false;
      appendDurableGateRecoveryEvent(database, row, 'live_owner_reconciled', now);
      return true;
    });
  } finally {
    database.close();
  }
}

export function blockDurableGateSelfRecovery(
  job: DurableManagedGateJob,
  ownerIdentity: UnixProcessIdentity,
  pauseEpoch: number,
  reason: 'child_protocol_unavailable' | 'cleanup_unproven',
  now = Date.now(),
): boolean {
  recoveryConfig(job);
  const database = openDurableGateRecoveryStore(job);
  try {
    return durableGateRecoveryTransaction(database, () => {
      const row = durableGateRecoveryRow(database, job.jobId);
      if (
        !row ||
        row.state !== 'reconciling_owner' ||
        row.pause_epoch !== pauseEpoch ||
        row.terminal_intent !== null ||
        !sameUnixProcess(durableGateRecoveryOwner(row), ownerIdentity)
      ) {
        return false;
      }
      const updated = database
        .prepare(`UPDATE durable_gate_recovery_jobs SET state = 'blocked', block_reason = ?, updated_at = ?
          WHERE job_id = ? AND pause_epoch = ? AND state = 'reconciling_owner' AND terminal_intent IS NULL`)
        .run(reason, now, job.jobId, pauseEpoch);
      if (updated.changes !== 1) return false;
      appendDurableGateRecoveryEvent(database, row, `self_recovery_${reason}`, now);
      return true;
    });
  } finally {
    database.close();
  }
}

export function readDurableGateRecovery(job: DurableManagedGateJob): DurableGateRecoverySnapshot | null {
  recoveryConfig(job);
  const database = openDurableGateRecoveryStore(job);
  try {
    const row = durableGateRecoveryRow(database, job.jobId);
    if (!row) return null;
    const resumeCount = (
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM durable_gate_recovery_events WHERE job_id = ? AND kind = 'live_owner_reconciled'",
        )
        .get(job.jobId) as { count: number }
    ).count;
    return {
      state: row.state,
      pauseEpoch: row.pause_epoch,
      resumeCount,
      ownerIdentity: durableGateRecoveryOwner(row),
      lastObservedAt: row.last_observed_at,
      reconcileDeadlineAt: row.reconcile_deadline_at,
      terminalIntent: row.terminal_intent,
      blockReason: row.block_reason,
      frozenIdentity: row.frozen_identity_json
        ? (JSON.parse(row.frozen_identity_json) as DurableGateFrozenIdentity)
        : null,
    };
  } finally {
    database.close();
  }
}
