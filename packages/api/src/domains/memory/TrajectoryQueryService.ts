import type Database from 'better-sqlite3';
import type { TaskTrajectory } from './f200-types.js';

interface ListOptions {
  limit?: number;
  days?: number;
  catId?: string;
  verified?: boolean;
  oldestFirst?: boolean;
}

interface TrajectoryRow {
  trajectory_id: string;
  invocation_id: string;
  thread_id: string;
  cat_id: string;
  task_context: string | null;
  search_event_ids_json: string;
  files_read_json: string;
  files_modified_json: string;
  output_verified: number;
  output_verified_signals_json: string;
  total_token_cost: number;
  duration: number;
  created_at: number;
  updated_at: number;
}

function rowToTrajectory(row: TrajectoryRow): TaskTrajectory {
  return {
    trajectoryId: row.trajectory_id,
    invocationId: row.invocation_id,
    threadId: row.thread_id,
    catId: row.cat_id,
    taskContext: row.task_context,
    searchEventIds: JSON.parse(row.search_event_ids_json),
    filesRead: JSON.parse(row.files_read_json),
    filesModified: JSON.parse(row.files_modified_json),
    outputVerified: row.output_verified === 1,
    outputVerifiedSignals: JSON.parse(row.output_verified_signals_json),
    totalTokenCost: row.total_token_cost,
    duration: row.duration,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TrajectoryQueryService {
  constructor(private readonly db: Database.Database) {}

  listRecent(opts: ListOptions): TaskTrajectory[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.days) {
      const cutoff = Date.now() - opts.days * 86_400_000;
      conditions.push('created_at >= ?');
      params.push(cutoff);
    }
    if (opts.catId) {
      conditions.push('cat_id = ?');
      params.push(opts.catId);
    }
    if (opts.verified !== undefined) {
      conditions.push('output_verified = ?');
      params.push(opts.verified ? 1 : 0);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(Math.max(1, opts.limit ?? 20), 100);
    const order = opts.oldestFirst ? 'ASC' : 'DESC';
    const sql = `SELECT * FROM task_trajectories ${where} ORDER BY created_at ${order} LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(params) as TrajectoryRow[];
    return rows.map(rowToTrajectory);
  }

  getById(trajectoryId: string): TaskTrajectory | null {
    const row = this.db.prepare('SELECT * FROM task_trajectories WHERE trajectory_id = ?').get([trajectoryId]) as
      | TrajectoryRow
      | undefined;
    return row ? rowToTrajectory(row) : null;
  }

  markVerified(trajectoryId: string, signals: string[]): void {
    this.db
      .prepare(
        'UPDATE task_trajectories SET output_verified = 1, output_verified_signals_json = ?, updated_at = ? WHERE trajectory_id = ?',
      )
      .run([JSON.stringify(signals), Date.now(), trajectoryId]);
  }

  countUnverified(days: number): number {
    const cutoff = Date.now() - days * 86_400_000;
    const row = this.db
      .prepare('SELECT COUNT(*) as cnt FROM task_trajectories WHERE output_verified = 0 AND created_at >= ?')
      .get([cutoff]) as { cnt: number };
    return row.cnt;
  }
}
