import { isDeepStrictEqual } from 'node:util';
import { closeSupervisorStore, transaction } from './managed-job-database.js';
import type { LegacyManagedJobRead } from './managed-job-legacy-read.js';
import { type LegacyManagedJobReference, openLegacyReferenceStore } from './managed-job-legacy-reference-store.js';
import { parseTerminalResult, parseTerminalStatus } from './managed-job-record-codec.js';
import { terminalManagedJobRecovery } from './managed-job-recovery-state.js';

/** Original result/history and the ref's migration disposition share one native-ledger transaction. */
export function importLegacyManagedJobHistory(
  dataRoot: string,
  ref: LegacyManagedJobReference,
  read: Extract<LegacyManagedJobRead, { kind: 'record' }>,
  now: number,
): boolean {
  const record = read.record;
  if (
    record.state !== 'terminal' ||
    !parseTerminalStatus(record.terminalStatus) ||
    (record.result !== undefined && !parseTerminalResult(record.result))
  )
    throw new Error('legacy_terminal_evidence_unproven');
  const db = openLegacyReferenceStore(dataRoot);
  try {
    return transaction(db, () => {
      const current = db
        .prepare('SELECT recovery_revision FROM managed_job_legacy_refs WHERE job_id=?')
        .get(ref.jobId) as { recovery_revision: number } | undefined;
      if (current?.recovery_revision !== ref.revision) return false;
      const existing = db.prepare('SELECT record_json FROM managed_jobs WHERE job_id=?').get(ref.jobId) as
        | { record_json: string }
        | undefined;
      if (
        existing &&
        !isDeepStrictEqual((JSON.parse(existing.record_json) as Record<string, unknown>).result, record.result)
      )
        throw new Error('legacy_import_identity_conflict');
      const revision =
        Number.isSafeInteger(record.revision) && Number(record.revision) > 0 ? Number(record.revision) : 1;
      const imported = {
        ...record,
        ...(read.job ? { descriptor: read.job } : {}),
        legacyProvenance: { adapter: 'legacy_file_v1', sourcePath: read.sourcePath, importedAt: now },
      };
      const target = read.job?.wakeTarget;
      const principal = target
        ? JSON.stringify([target.userId, target.threadId, target.catId])
        : `legacy-unattributed:${ref.jobId}`;
      db.prepare(`INSERT OR IGNORE INTO managed_jobs(job_id,principal_key,idempotency_key,state,revision,record_json,recovery_json)
      VALUES (?,?,?,'terminal',?,?,?)`).run(
        ref.jobId,
        principal,
        `legacy_migrated:${ref.jobId}`,
        revision,
        JSON.stringify(imported),
        JSON.stringify({ version: 1, attempts: 0, nextAttemptAt: null }),
      );
      db.prepare(`INSERT OR IGNORE INTO managed_job_transitions(job_id,revision,supervisor_epoch,fencing_token,state,recorded_at,record_json)
      VALUES (?,?,?,?,'terminal',?,?)`).run(
        ref.jobId,
        revision,
        String(record.supervisorEpoch ?? 'legacy'),
        Number(record.supervisorFence) || 0,
        Number(record.updatedAt) || now,
        JSON.stringify(imported),
      );
      // Historical import alone never produces a wake. Only a previously followed live execution has this responsibility.
      const recovery =
        ref.wasLive && read.job
          ? terminalManagedJobRecovery(read.job, revision, now, ref.recovery)
          : { ...ref.recovery, nextAttemptAt: ref.recovery.wakeIntent?.status === 'pending' ? now : null };
      db.prepare(`UPDATE managed_job_legacy_refs SET disposition='legacy_migrated',descriptor_json=?,
      recovery_json=?,recovery_revision=recovery_revision+1 WHERE job_id=? AND recovery_revision=?`).run(
        read.job ? JSON.stringify(read.job) : null,
        JSON.stringify(recovery),
        ref.jobId,
        ref.revision,
      );
      return true;
    });
  } finally {
    closeSupervisorStore(db);
  }
}
