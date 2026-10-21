import type Database from 'better-sqlite3';
import type { DurableManagedGateJob, ManagedJobPrincipal } from './durable-managed-gate-job.js';
import { closeSupervisorStore, openSupervisorStore } from './managed-job-database.js';

export function managedJobPrincipalKey(principal: ManagedJobPrincipal): string {
  return JSON.stringify([principal.userId, principal.threadId, principal.catId]);
}

export function readManagedJobLedger(job: DurableManagedGateJob): Record<string, unknown> | null {
  const database = openSupervisorStore(job);
  try {
    const row = database.prepare('SELECT record_json FROM managed_jobs WHERE job_id = ?').get(job.jobId) as
      | { record_json: string }
      | undefined;
    return row ? (JSON.parse(row.record_json) as Record<string, unknown>) : null;
  } finally {
    closeSupervisorStore(database);
  }
}

/** Called inside the supervisor's IMMEDIATE transaction: lease, record and history have one commit point. */
export function writeManagedJobLedger(
  database: Database.Database,
  job: DurableManagedGateJob,
  candidate: Record<string, unknown>,
  exclusive: boolean,
): boolean {
  const current = database.prepare('SELECT revision, record_json FROM managed_jobs WHERE job_id = ?').get(job.jobId) as
    | { revision: number; record_json: string }
    | undefined;
  if (exclusive && current) throw new Error(`managed_job_already_exists:${job.jobId}`);
  const previous = current ? (JSON.parse(current.record_json) as Record<string, unknown>) : null;
  // Terminal truth is immutable, including against a late watcher or an expired worker.
  if (previous?.state === 'terminal') return false;
  if (previous && previous.state !== 'queued' && candidate.state === 'queued') return false;
  const definition = job.definition;
  if (!definition) throw new Error('managed_job_definition_missing');
  const principalKey = managedJobPrincipalKey(definition.principal);
  if (!current) {
    if (!exclusive) return false;
    const active = database
      .prepare(`SELECT COUNT(*) AS total FROM managed_jobs WHERE state != 'terminal'
        AND json_extract(record_json, '$.descriptor.definition.principal.userId') = ?
        AND json_extract(record_json, '$.descriptor.definition.principal.catId') = ?`)
      .get(definition.principal.userId, definition.principal.catId) as { total: number };
    if (active.total >= definition.maxConcurrent) throw new Error('managed_job_budget_exhausted');
  }
  const effective = { ...previous, ...candidate, descriptor: job };
  const semanticRecord = (record: Record<string, unknown>) => {
    const { updatedAt: _time, revision: _revision, ...semantic } = record;
    return JSON.stringify(semantic);
  };
  const changed = !previous || semanticRecord(previous) !== semanticRecord(effective);
  const revision = (current?.revision ?? 0) + (changed ? 1 : 0);
  const record: Record<string, unknown> = { ...previous, ...candidate, revision, descriptor: job };
  const serialized = JSON.stringify(record);
  database
    .prepare(`INSERT INTO managed_jobs(job_id, principal_key, idempotency_key, state, revision, record_json)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET
      state = excluded.state, revision = excluded.revision, record_json = excluded.record_json`)
    .run(job.jobId, principalKey, definition.idempotencyKey, record.state, revision, serialized);
  if (changed)
    database
      .prepare(`INSERT INTO managed_job_transitions
      (job_id, revision, supervisor_epoch, fencing_token, state, recorded_at, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        job.jobId,
        revision,
        record.supervisorEpoch,
        record.supervisorFence,
        record.state,
        record.updatedAt,
        serialized,
      );
  return true;
}

export function listManagedJobLedger(job: DurableManagedGateJob, activeOnly = false): Record<string, unknown>[] {
  const database = openSupervisorStore(job);
  try {
    return (
      database
        .prepare(`SELECT record_json FROM managed_jobs ${activeOnly ? "WHERE state != 'terminal'" : ''} ORDER BY rowid`)
        .all() as { record_json: string }[]
    ).map((row) => JSON.parse(row.record_json) as Record<string, unknown>);
  } finally {
    closeSupervisorStore(database);
  }
}

export function readManagedJobTransitions(job: DurableManagedGateJob): Record<string, unknown>[] {
  const database = openSupervisorStore(job);
  try {
    return (
      database
        .prepare('SELECT record_json FROM managed_job_transitions WHERE job_id = ? ORDER BY revision')
        .all(job.jobId) as { record_json: string }[]
    ).map((row) => JSON.parse(row.record_json) as Record<string, unknown>);
  } finally {
    closeSupervisorStore(database);
  }
}
