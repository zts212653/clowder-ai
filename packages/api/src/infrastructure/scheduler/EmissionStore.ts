import type Database from 'better-sqlite3';

export interface EmissionRecord {
  originTaskId: string;
  threadId: string;
  messageId: string;
  suppressionMs: number;
}

export interface EmissionRow {
  emissionId: string;
  originTaskId: string;
  threadId: string;
  messageId: string;
  suppressionUntil: string;
  createdAt: string;
}

export class EmissionStore {
  constructor(private db: Database.Database) {}

  record(emission: EmissionRecord): void {
    const now = new Date();
    const suppressionUntil = new Date(now.getTime() + emission.suppressionMs);
    const emissionId = `em-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.db
      .prepare(
        `INSERT INTO scheduler_emissions (emission_id, origin_task_id, thread_id, message_id, suppression_until, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        emissionId,
        emission.originTaskId,
        emission.threadId,
        emission.messageId,
        suppressionUntil.toISOString(),
        now.toISOString(),
      );
  }

  isSuppressed(taskId: string, threadId: string): boolean {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        `SELECT 1 FROM scheduler_emissions
         WHERE origin_task_id = ? AND thread_id = ? AND suppression_until > ?
         LIMIT 1`,
      )
      .get(taskId, threadId, now);
    return !!row;
  }

  cleanup(): number {
    const now = new Date().toISOString();
    const result = this.db.prepare('DELETE FROM scheduler_emissions WHERE suppression_until <= ?').run(now);
    return result.changes;
  }

  listActive(): EmissionRow[] {
    const now = new Date().toISOString();
    const rows = this.db
      .prepare(
        `SELECT emission_id, origin_task_id, thread_id, message_id, suppression_until, created_at
         FROM scheduler_emissions WHERE suppression_until > ? ORDER BY created_at DESC`,
      )
      .all(now) as {
      emission_id: string;
      origin_task_id: string;
      thread_id: string;
      message_id: string;
      suppression_until: string;
      created_at: string;
    }[];
    return rows.map((r) => ({
      emissionId: r.emission_id,
      originTaskId: r.origin_task_id,
      threadId: r.thread_id,
      messageId: r.message_id,
      suppressionUntil: r.suppression_until,
      createdAt: r.created_at,
    }));
  }
}
