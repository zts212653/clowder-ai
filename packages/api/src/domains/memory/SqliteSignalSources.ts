import type Database from 'better-sqlite3';
import type { OutputVerifiedSignalSources } from './output-verified-detector.js';

export class SqliteSignalSources implements OutputVerifiedSignalSources {
  constructor(private readonly db: Database.Database) {}

  async getInvocationStatus(invocationId: string): Promise<string | null> {
    const row = this.db
      .prepare('SELECT COUNT(*) as cnt FROM recall_events WHERE invocation_id = ?')
      .get([invocationId]) as { cnt: number };
    return row.cnt > 0 ? 'succeeded' : null;
  }

  async isPrMergedForThread(_threadId: string): Promise<boolean> {
    // v1: PR merge detection requires F140 PR tracking integration.
    // External systems inject pr_merged via POST /api/recall/trajectories/:id/signals.
    return false;
  }
}
