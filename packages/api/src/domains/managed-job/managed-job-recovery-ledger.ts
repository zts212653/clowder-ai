import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { closeSupervisorStore, openSupervisorStore } from './managed-job-database.js';
import { MANAGED_JOB_RECOVERY_DUE_EXPRESSION } from './managed-job-recovery-schema.js';
import {
  initialManagedJobRecovery,
  type ManagedJobRecoveryFact,
  parseManagedJobRecovery,
  terminalManagedJobRecovery,
} from './managed-job-recovery-state.js';
import type { DurableManagedGateJob } from './managed-job-types.js';

export interface ManagedJobRecoveryRow {
  readonly jobId: string;
  readonly revision: number;
  readonly recovery: ManagedJobRecoveryFact;
  readonly record: Record<string, unknown>;
}

interface RecoveryRow {
  job_id: string;
  recovery_revision: number;
  recovery_json: string;
  record_json: string;
}

function recoveryTable(job: DurableManagedGateJob): 'managed_jobs' | 'managed_job_legacy_refs' {
  return job.recordStorage === 'sqlite_v1' ? 'managed_jobs' : 'managed_job_legacy_refs';
}

function recoveryDatabase(job: DurableManagedGateJob): Database.Database {
  return openSupervisorStore(
    job.recordStorage === 'sqlite_v1'
      ? job
      : { recordPath: join(dirname(dirname(job.recordPath)), 'managed-jobs', 'ledger.json') },
  );
}

function decode(row: RecoveryRow): ManagedJobRecoveryRow {
  try {
    return {
      jobId: row.job_id,
      revision: row.recovery_revision,
      recovery: parseManagedJobRecovery(row.recovery_json),
      record: JSON.parse(row.record_json) as Record<string, unknown>,
    };
  } catch {
    // Keep the original business bytes. The row processor records a permanent disposition for this identity.
    return { jobId: row.job_id, revision: row.recovery_revision, record: {}, recovery: initialManagedJobRecovery(0) };
  }
}

/** A fixed batch reads/decodes a fixed number of due owner rows, regardless of historical ledger size. */
export function selectManagedJobRecoveryDue(
  database: Database.Database,
  now: number,
  limit: number,
): ManagedJobRecoveryRow[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('invalid_managed_job_batch_limit');
  const rows = database
    .prepare(`SELECT job_id, recovery_revision, recovery_json, record_json FROM managed_jobs
    WHERE ${MANAGED_JOB_RECOVERY_DUE_EXPRESSION} IS NOT NULL AND ${MANAGED_JOB_RECOVERY_DUE_EXPRESSION} <= ?
    ORDER BY ${MANAGED_JOB_RECOVERY_DUE_EXPRESSION}, job_id LIMIT ?`)
    .all(now, limit) as RecoveryRow[];
  return rows.map(decode);
}

export function listManagedJobRecoveryDue(
  job: DurableManagedGateJob,
  now: number,
  limit = 100,
): ManagedJobRecoveryRow[] {
  const database = openSupervisorStore(job);
  try {
    return selectManagedJobRecoveryDue(database, now, limit);
  } finally {
    closeSupervisorStore(database);
  }
}

export function readManagedJobRecovery(job: DurableManagedGateJob): ManagedJobRecoveryRow | null {
  const database = recoveryDatabase(job);
  try {
    const record = job.recordStorage === 'sqlite_v1' ? 'record_json' : "'{}' AS record_json";
    const row = database
      .prepare(`SELECT job_id, recovery_revision, recovery_json, ${record}
      FROM ${recoveryTable(job)} WHERE job_id=?`)
      .get(job.jobId) as RecoveryRow | undefined;
    return row ? decode(row) : null;
  } finally {
    closeSupervisorStore(database);
  }
}

/** Upgrade an exact still-active original wait, never the surrounding historical terminal rows. */
export function ensureManagedJobWakeIntent(
  job: DurableManagedGateJob,
  now: number,
  original?: Record<string, unknown>,
): ManagedJobRecoveryRow | null {
  const current = readManagedJobRecovery(job);
  if (!current || current.recovery.wakeIntent || current.recovery.disposition) return current;
  const terminal = job.recordStorage === 'sqlite_v1' ? current.record : original;
  if (terminal?.state !== 'terminal' || (job.recordStorage === 'sqlite_v1' && !terminal.admissionMessageId))
    return current;
  const epoch = Number(terminal.revision) || (job.recordStorage === 'sqlite_v1' ? 0 : 1);
  if (!Number.isSafeInteger(epoch) || epoch < 1) return current;
  updateManagedJobRecovery(job, current.revision, terminalManagedJobRecovery(job, epoch, now, current.recovery));
  return readManagedJobRecovery(job);
}

/** This CAS cannot change record_json, business revision, transitions, concurrency or resource ownership. */
export function updateManagedJobRecovery(
  job: DurableManagedGateJob,
  expectedRevision: number,
  recovery: ManagedJobRecoveryFact,
): boolean {
  const database = recoveryDatabase(job);
  try {
    return (
      database
        .prepare(`UPDATE ${recoveryTable(job)} SET recovery_json=?, recovery_revision=recovery_revision+1
      WHERE job_id=? AND recovery_revision=?`)
        .run(JSON.stringify(recovery), job.jobId, expectedRevision).changes === 1
    );
  } finally {
    closeSupervisorStore(database);
  }
}

export function acknowledgeManagedJobWake(
  job: DurableManagedGateJob,
  key: string,
  messageId: string,
  now: number,
): boolean {
  const current = readManagedJobRecovery(job);
  if (!current?.recovery.wakeIntent || current.recovery.wakeIntent.key !== key || !messageId) return false;
  const intent = current.recovery.wakeIntent;
  if (intent.status === 'delivered') return intent.messageId === messageId;
  return updateManagedJobRecovery(job, current.revision, {
    ...current.recovery,
    nextAttemptAt:
      current.recovery.notification &&
      !current.recovery.notification.deliveredAt &&
      current.recovery.notification.attempts < 5
        ? now
        : null,
    disposition: undefined,
    reasonCode: undefined,
    wakeIntent: { ...intent, status: 'delivered', messageId, deliveredAt: now },
  });
}

/** Exact retired wait evidence closes production responsibility without inventing a delivery receipt. */
export function retireManagedJobWake(job: DurableManagedGateJob, key: string, ownerWaitRef: string): boolean {
  const current = readManagedJobRecovery(job);
  const intent = current?.recovery.wakeIntent;
  if (!current || !intent || intent.key !== key || !ownerWaitRef) return false;
  if (intent.status !== 'pending') return intent.status === 'not_applicable' && intent.ownerWaitRef === ownerWaitRef;
  return updateManagedJobRecovery(job, current.revision, {
    ...current.recovery,
    nextAttemptAt: null,
    wakeIntent: { ...intent, status: 'not_applicable', ownerWaitRef },
  });
}
