import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { TaskTrajectory } from './f200-types.js';
import { parseShellReadPaths } from './parse-shell-read-paths.js';

const FILE_TOOLS_READ = new Set(['Read']);
const FILE_TOOLS_MODIFY = new Set(['Edit', 'Write']);

interface MinimalEvent {
  invocationId: string;
  threadId: string;
  catId: string;
  toolName: string;
  timestamp: number;
  summary: Record<string, unknown>;
}

export class TrajectoryAggregator {
  private readonly queryRecallEvents: ReturnType<Database.Database['prepare']>;
  private readonly insertTrajectory: ReturnType<Database.Database['prepare']>;

  constructor(db: Database.Database) {
    this.queryRecallEvents = db.prepare(
      'SELECT recall_id, query, token_cost FROM recall_events WHERE invocation_id = ? ORDER BY timestamp ASC',
    );
    this.insertTrajectory = db.prepare(`
      INSERT OR IGNORE INTO task_trajectories
        (trajectory_id, invocation_id, thread_id, cat_id, task_context,
         search_event_ids_json, files_read_json, files_modified_json,
         output_verified, output_verified_signals_json,
         total_token_cost, duration, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  aggregate(invocationId: string, threadId: string, catId: string, events: MinimalEvent[]): TaskTrajectory | null {
    const recallRows = this.queryRecallEvents.all(invocationId) as Array<{
      recall_id: string;
      query: string;
      token_cost: number;
    }>;
    if (recallRows.length === 0) return null;

    const searchEventIds = recallRows.map((r) => r.recall_id);
    const totalTokenCost = recallRows.reduce((sum, r) => sum + (r.token_cost || 0), 0);

    const queries = [...new Set(recallRows.map((r) => r.query).filter(Boolean))];
    const taskContext = queries.length > 0 ? queries.join(' → ') : null;

    const filesRead: string[] = [];
    const filesModified: string[] = [];
    const seenRead = new Set<string>();
    const seenModified = new Set<string>();

    for (const e of events) {
      // F200 HW-4 根因②c: Codex shell-reads (sed/nl/cat/rg) are logged as
      // command_execution — reuse the same parser as RecallEventCorrelator
      // (single source of truth) so trajectory filesRead matches consumption.
      if (e.toolName === 'command_execution') {
        const cmd = typeof e.summary?.command === 'string' ? e.summary.command : '';
        for (const p of parseShellReadPaths(cmd)) {
          if (!seenRead.has(p)) {
            filesRead.push(p);
            seenRead.add(p);
          }
        }
        continue;
      }
      const filePath = (e.summary?.file_path as string) ?? (e.summary?.path as string) ?? null;
      if (!filePath) continue;

      if (FILE_TOOLS_READ.has(e.toolName) && !seenRead.has(filePath)) {
        filesRead.push(filePath);
        seenRead.add(filePath);
      }
      if (FILE_TOOLS_MODIFY.has(e.toolName) && !seenModified.has(filePath)) {
        filesModified.push(filePath);
        seenModified.add(filePath);
      }
    }

    const timestamps = events.map((e) => e.timestamp).filter((t) => t > 0);
    const duration = timestamps.length >= 2 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;
    const now = Date.now();

    return {
      trajectoryId: randomUUID(),
      invocationId,
      threadId,
      catId,
      taskContext,
      searchEventIds,
      filesRead,
      filesModified,
      outputVerified: false,
      outputVerifiedSignals: [],
      totalTokenCost,
      duration,
      createdAt: now,
      updatedAt: now,
    };
  }

  persist(trajectory: TaskTrajectory): void {
    const params = [
      trajectory.trajectoryId,
      trajectory.invocationId,
      trajectory.threadId,
      trajectory.catId,
      trajectory.taskContext,
      JSON.stringify(trajectory.searchEventIds),
      JSON.stringify(trajectory.filesRead),
      JSON.stringify(trajectory.filesModified),
      trajectory.outputVerified ? 1 : 0,
      JSON.stringify(trajectory.outputVerifiedSignals),
      trajectory.totalTokenCost,
      trajectory.duration,
      trajectory.createdAt,
      trajectory.updatedAt,
    ];
    this.insertTrajectory.run(params);
  }
}
