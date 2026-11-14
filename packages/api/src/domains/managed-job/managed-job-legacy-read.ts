import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { validateDurableManagedGateJob } from './durable-managed-gate-job-validation.js';
import { closeSupervisorStore, isManagedJobStoreBusy } from './managed-job-database.js';
import { openLegacyReferenceStore, readLegacyManagedJobReference } from './managed-job-legacy-reference-store.js';
import type { DurableManagedGateJob } from './managed-job-types.js';

export type LegacyManagedJobRead =
  | {
      kind: 'record';
      jobId: string;
      sourcePath: string;
      job: DurableManagedGateJob | null;
      record: Record<string, unknown>;
    }
  | { kind: 'unknown'; jobId: string; sourcePath: string | null; reason: string };

export function readImportedLegacyManagedJob(job: DurableManagedGateJob): Record<string, unknown> | null {
  const root = dirname(dirname(job.recordPath));
  if (!existsSync(join(root, 'managed-jobs', 'supervisor.sqlite'))) return null;
  const db = openLegacyReferenceStore(root);
  try {
    const row = db.prepare("SELECT record_json FROM managed_jobs WHERE job_id=? AND state='terminal'").get(job.jobId) as
      | { record_json: string }
      | undefined;
    return row ? (JSON.parse(row.record_json) as Record<string, unknown>) : null;
  } finally {
    closeSupervisorStore(db);
  }
}

/** Named read adapter: return the original execution fact, or an explicit unknown, never just an opaque pointer. */
export function readLegacyManagedJobById(dataRoot: string, jobId: string): LegacyManagedJobRead {
  const ref = readLegacyManagedJobReference(dataRoot, jobId);
  if (!ref) return { kind: 'unknown', jobId, sourcePath: null, reason: 'legacy_reference_missing' };
  if (resolve(ref.sourcePath) !== resolve(dataRoot, 'managed-gate-jobs', `${jobId}.json`))
    return { kind: 'unknown', jobId, sourcePath: ref.sourcePath, reason: 'legacy_source_mismatch' };
  try {
    const db = openLegacyReferenceStore(dataRoot);
    let imported: { record_json: string } | undefined;
    try {
      imported = db
        .prepare("SELECT record_json FROM managed_jobs WHERE job_id=? AND state='terminal'")
        .get(jobId) as typeof imported;
    } finally {
      closeSupervisorStore(db);
    }
    const value: unknown = JSON.parse(imported?.record_json ?? readFileSync(ref.sourcePath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_record');
    const record = value as Record<string, unknown>;
    if (
      record.jobId !== jobId ||
      typeof record.originTaskId !== 'string' ||
      !['queued', 'running', 'waiting', 'cancelling', 'terminal'].includes(String(record.state))
    )
      return { kind: 'unknown', jobId, sourcePath: ref.sourcePath, reason: 'legacy_record_identity_mismatch' };
    const candidate = (record.descriptor ?? ref.job) as DurableManagedGateJob | null;
    const job =
      candidate && candidate.jobId === jobId && validateDurableManagedGateJob(candidate, record.originTaskId, dataRoot)
        ? candidate
        : null;
    return { kind: 'record', jobId, sourcePath: ref.sourcePath, job, record };
  } catch (error) {
    if (isManagedJobStoreBusy(error)) throw error;
    return { kind: 'unknown', jobId, sourcePath: ref.sourcePath, reason: 'legacy_record_unreadable' };
  }
}
