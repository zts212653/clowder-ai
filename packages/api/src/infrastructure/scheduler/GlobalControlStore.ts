import type Database from 'better-sqlite3';

export interface GlobalControl {
  enabled: boolean;
  reason: string | null;
  updatedBy: string;
  updatedAt: string;
}

export interface TaskOverride {
  taskId: string;
  enabled: boolean;
  updatedBy: string;
  updatedAt: string;
}

export class GlobalControlStore {
  constructor(private db: Database.Database) {}

  getGlobalEnabled(): boolean {
    const row = this.db.prepare('SELECT enabled FROM scheduler_global_control WHERE id = 1').get() as
      | { enabled: number }
      | undefined;
    return row ? row.enabled === 1 : true;
  }

  getGlobalState(): GlobalControl {
    const row = this.db
      .prepare('SELECT enabled, reason, updated_by, updated_at FROM scheduler_global_control WHERE id = 1')
      .get() as { enabled: number; reason: string | null; updated_by: string; updated_at: string } | undefined;
    if (!row) return { enabled: true, reason: null, updatedBy: 'system', updatedAt: new Date().toISOString() };
    return {
      enabled: row.enabled === 1,
      reason: row.reason,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    };
  }

  setGlobalEnabled(enabled: boolean, reason: string | null, updatedBy: string): void {
    this.db
      .prepare(
        `UPDATE scheduler_global_control
         SET enabled = ?, reason = ?, updated_by = ?, updated_at = ?
         WHERE id = 1`,
      )
      .run(enabled ? 1 : 0, reason, updatedBy, new Date().toISOString());
  }

  getTaskOverride(taskId: string): TaskOverride | null {
    const row = this.db
      .prepare('SELECT task_id, enabled, updated_by, updated_at FROM scheduler_task_overrides WHERE task_id = ?')
      .get(taskId) as { task_id: string; enabled: number; updated_by: string; updated_at: string } | undefined;
    if (!row) return null;
    return {
      taskId: row.task_id,
      enabled: row.enabled === 1,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    };
  }

  setTaskOverride(taskId: string, enabled: boolean, updatedBy: string): void {
    this.db
      .prepare(
        `INSERT INTO scheduler_task_overrides (task_id, enabled, updated_by, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET enabled = ?, updated_by = ?, updated_at = ?`,
      )
      .run(
        taskId,
        enabled ? 1 : 0,
        updatedBy,
        new Date().toISOString(),
        enabled ? 1 : 0,
        updatedBy,
        new Date().toISOString(),
      );
  }

  removeTaskOverride(taskId: string): boolean {
    const result = this.db.prepare('DELETE FROM scheduler_task_overrides WHERE task_id = ?').run(taskId);
    return result.changes > 0;
  }

  listOverrides(): TaskOverride[] {
    const rows = this.db
      .prepare('SELECT task_id, enabled, updated_by, updated_at FROM scheduler_task_overrides ORDER BY updated_at DESC')
      .all() as { task_id: string; enabled: number; updated_by: string; updated_at: string }[];
    return rows.map((r) => ({
      taskId: r.task_id,
      enabled: r.enabled === 1,
      updatedBy: r.updated_by,
      updatedAt: r.updated_at,
    }));
  }
}
