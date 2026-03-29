import type Database from 'better-sqlite3';
import type { RunLedgerRow, RunStats } from './types.js';

export class RunLedger {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  record(row: RunLedgerRow): void {
    this.db
      .prepare(
        `INSERT INTO task_run_ledger (task_id, subject_key, outcome, signal_summary, duration_ms, started_at, assigned_cat_id, error_summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.task_id,
        row.subject_key,
        row.outcome,
        row.signal_summary,
        row.duration_ms,
        row.started_at,
        row.assigned_cat_id,
        row.error_summary ?? null,
      );
  }

  query(taskId: string, limit: number): RunLedgerRow[] {
    return this.db
      .prepare(
        `SELECT task_id, subject_key, outcome, signal_summary, duration_ms, started_at, assigned_cat_id, error_summary
         FROM task_run_ledger WHERE task_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(taskId, limit) as RunLedgerRow[];
  }

  /** Phase 2: query runs filtered by exact subject_key */
  queryBySubject(taskId: string, subjectKey: string, limit: number): RunLedgerRow[] {
    return this.db
      .prepare(
        `SELECT task_id, subject_key, outcome, signal_summary, duration_ms, started_at, assigned_cat_id, error_summary
         FROM task_run_ledger WHERE task_id = ? AND subject_key = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(taskId, subjectKey, limit) as RunLedgerRow[];
  }

  /** Phase 2: aggregate outcome stats for a task */
  stats(taskId: string): RunStats {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN outcome = 'RUN_DELIVERED' THEN 1 ELSE 0 END) as delivered,
           SUM(CASE WHEN outcome = 'RUN_FAILED' THEN 1 ELSE 0 END) as failed,
           SUM(CASE WHEN outcome IN ('SKIP_NO_SIGNAL','SKIP_DISABLED','SKIP_OVERLAP') THEN 1 ELSE 0 END) as skipped
         FROM task_run_ledger WHERE task_id = ?`,
      )
      .get(taskId) as { total: number; delivered: number; failed: number; skipped: number } | undefined;
    return {
      total: row?.total ?? 0,
      delivered: row?.delivered ?? 0,
      failed: row?.failed ?? 0,
      skipped: row?.skipped ?? 0,
    };
  }
}
