import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface IndexStateRow {
  id: string;
  project_path: string;
  status: 'missing' | 'stale' | 'building' | 'ready' | 'failed';
  fingerprint: string;
  last_scan_at: string | null;
  snoozed_until: string | null;
  docs_indexed: number;
  docs_total: number;
  error_message: string | null;
  summary_json: string | null;
  created_at: string;
  updated_at: string;
}

const MISSING_STATE: IndexStateRow = {
  id: '',
  project_path: '',
  status: 'missing',
  fingerprint: '',
  last_scan_at: null,
  snoozed_until: null,
  docs_indexed: 0,
  docs_total: 0,
  error_message: null,
  summary_json: null,
  created_at: '',
  updated_at: '',
};

function projectId(projectPath: string): string {
  return createHash('sha256').update(projectPath).digest('hex');
}

export class IndexStateManager {
  constructor(private db: Database.Database) {}

  getState(projectPath: string, currentFingerprint?: string): IndexStateRow {
    const row = this.db.prepare('SELECT * FROM index_state WHERE project_path = ?').get(projectPath) as
      | IndexStateRow
      | undefined;

    if (!row) return { ...MISSING_STATE, project_path: projectPath };

    if (currentFingerprint && row.status === 'ready' && row.fingerprint !== currentFingerprint) {
      return { ...row, status: 'stale' };
    }

    return row;
  }

  shouldBootstrap(projectPath: string, fingerprint: string): boolean {
    if (this.isSnoozed(projectPath)) return false;

    const state = this.getState(projectPath, fingerprint);
    return state.status === 'missing' || state.status === 'stale' || state.status === 'failed';
  }

  startBuilding(projectPath: string, fingerprint: string): void {
    const id = projectId(projectPath);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO index_state (id, project_path, status, fingerprint, created_at, updated_at)
         VALUES (?, ?, 'building', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = 'building',
           fingerprint = excluded.fingerprint,
           error_message = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(id, projectPath, fingerprint, now, now);
  }

  markReady(projectPath: string, docsIndexed: number, summaryJson: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE index_state
         SET status = 'ready', docs_indexed = ?, summary_json = ?, last_scan_at = ?, error_message = NULL, updated_at = ?
         WHERE project_path = ?`,
      )
      .run(docsIndexed, summaryJson, now, now, projectPath);
  }

  markFailed(projectPath: string, error: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE index_state SET status = 'failed', error_message = ?, updated_at = ? WHERE project_path = ?`)
      .run(error, now, projectPath);
  }

  snooze(projectPath: string, days = 7): void {
    const id = projectId(projectPath);
    const now = new Date();
    const snoozedUntil = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
    const nowIso = now.toISOString();

    this.db
      .prepare(
        `INSERT INTO index_state (id, project_path, status, snoozed_until, created_at, updated_at)
         VALUES (?, ?, 'missing', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           snoozed_until = excluded.snoozed_until,
           updated_at = excluded.updated_at`,
      )
      .run(id, projectPath, snoozedUntil, nowIso, nowIso);
  }

  isSnoozed(projectPath: string): boolean {
    const row = this.db.prepare('SELECT snoozed_until FROM index_state WHERE project_path = ?').get(projectPath) as
      | { snoozed_until: string | null }
      | undefined;

    if (!row?.snoozed_until) return false;
    return new Date(row.snoozed_until) > new Date();
  }
}
