import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { UnixProcessIdentity } from '../../utils/cli-process-ownership.js';
import type { DurableManagedGateJob } from './durable-managed-gate-job.js';

export interface DurableGateRecoveryRow {
  job_id: string;
  state: 'running' | 'reconciling_clock' | 'reconciling_owner' | 'blocked' | 'terminal_intent';
  pause_epoch: number;
  owner_pid: number;
  owner_ppid: number;
  owner_pgid: number;
  owner_started_at: string;
  created_at: number;
  last_observed_at: number;
  reconcile_deadline_at: number | null;
  terminal_intent: 'cancelled' | 'timed_out' | null;
  block_reason: 'ambiguous_result' | 'child_protocol_unavailable' | 'cleanup_unproven' | null;
  frozen_identity_json: string | null;
  last_evidence_id: string | null;
  updated_at: number;
}

export function openDurableGateRecoveryStore(job: DurableManagedGateJob): Database.Database {
  mkdirSync(dirname(job.recordPath), { recursive: true });
  const database = new Database(join(dirname(job.recordPath), 'recovery.sqlite'));
  database.pragma('busy_timeout = 5000');
  database.exec(`
    CREATE TABLE IF NOT EXISTS durable_gate_recovery_jobs (
      job_id TEXT PRIMARY KEY, protocol_version INTEGER NOT NULL, state TEXT NOT NULL,
      pause_epoch INTEGER NOT NULL, owner_pid INTEGER NOT NULL, owner_ppid INTEGER NOT NULL,
      owner_pgid INTEGER NOT NULL, owner_started_at TEXT NOT NULL, created_at INTEGER NOT NULL,
      last_observed_at INTEGER NOT NULL, reconcile_deadline_at INTEGER, terminal_intent TEXT,
      block_reason TEXT, frozen_identity_json TEXT, last_evidence_id TEXT, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS durable_gate_recovery_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, pause_epoch INTEGER NOT NULL,
      kind TEXT NOT NULL, observed_at INTEGER NOT NULL, payload_json TEXT
    );
  `);
  const hasBlockReason = () =>
    database
      .prepare('PRAGMA table_info(durable_gate_recovery_jobs)')
      .all()
      .some((column) => (column as { name?: string }).name === 'block_reason');
  if (!hasBlockReason()) {
    try {
      database.exec('ALTER TABLE durable_gate_recovery_jobs ADD COLUMN block_reason TEXT');
    } catch (error) {
      if (!hasBlockReason()) throw error;
    }
  }
  return database;
}

export function durableGateRecoveryTransaction<T>(database: Database.Database, action: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function durableGateRecoveryRow(database: Database.Database, jobId: string): DurableGateRecoveryRow | undefined {
  return database.prepare('SELECT * FROM durable_gate_recovery_jobs WHERE job_id = ?').get(jobId) as
    | DurableGateRecoveryRow
    | undefined;
}

export function durableGateRecoveryOwner(row: DurableGateRecoveryRow): UnixProcessIdentity {
  return { pid: row.owner_pid, ppid: row.owner_ppid, pgid: row.owner_pgid, startedAt: row.owner_started_at };
}

export function appendDurableGateRecoveryEvent(
  database: Database.Database,
  row: DurableGateRecoveryRow,
  kind: string,
  observedAt: number,
  payload: unknown = null,
): void {
  database
    .prepare(
      'INSERT INTO durable_gate_recovery_events (job_id, pause_epoch, kind, observed_at, payload_json) VALUES (?, ?, ?, ?, ?)',
    )
    .run(row.job_id, row.pause_epoch, kind, observedAt, payload === null ? null : JSON.stringify(payload));
}
