/**
 * F192 Phase G — SQLite-backed store for Task Outcome Episodes.
 *
 * Episodes are the evaluation unit. Signals (permission cancel, magic word,
 * A1 world truth, proxy) are appended to episodes as they occur.
 * Verdicts are set by eval cat after analysis.
 *
 * Schema:
 *   episodes(episodeId PK, trigger, threadId, participants JSON, artifacts JSON,
 *            terminalState, verdict, createdAt)
 *   episode_signals(id INTEGER PK, episodeId FK, category, record JSON, createdAt)
 */
import Database from 'better-sqlite3';

import type { TaskOutcomeVerdict } from './task-outcome-episode.js';

// ---- Public types ----

export interface CreateEpisodeInput {
  trigger: 'user_ask' | 'task_created' | 'cat_initiated';
  threadId: string;
  participants: string[];
  artifacts?: string[];
}

export interface StoredEpisode {
  episodeId: string;
  trigger: string;
  threadId: string;
  participants: string[];
  artifacts: string[];
  terminalState: string;
  verdict: string | null;
  createdAt: string;
}

export interface StoredSignal {
  id: number;
  episodeId: string;
  category: 'a1' | 'a2' | 'proxy';
  record: Record<string, unknown>;
  createdAt: string;
}

export interface AppendSignalInput {
  category: 'a1' | 'a2' | 'proxy';
  record: Record<string, unknown>;
}

// ---- Terminal states that are "done" (ready for verdict) ----

const TERMINAL_DONE_STATES = ['completed', 'abandoned', 'escalated_cvo', 'corrected_then_completed'];

// ---- Store ----

export class TaskOutcomeEpisodeStore {
  private db: InstanceType<typeof Database>;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_outcome_episodes (
        episodeId TEXT PRIMARY KEY,
        trigger_type TEXT NOT NULL,
        threadId TEXT NOT NULL,
        participants TEXT NOT NULL DEFAULT '[]',
        artifacts TEXT NOT NULL DEFAULT '[]',
        terminalState TEXT NOT NULL DEFAULT 'in_progress',
        verdict TEXT,
        createdAt TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_episodes_threadId
        ON task_outcome_episodes(threadId);
      CREATE INDEX IF NOT EXISTS idx_episodes_terminalState
        ON task_outcome_episodes(terminalState);

      CREATE TABLE IF NOT EXISTS task_outcome_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        episodeId TEXT NOT NULL REFERENCES task_outcome_episodes(episodeId),
        category TEXT NOT NULL,
        record TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_signals_episodeId
        ON task_outcome_signals(episodeId);
    `);
  }

  createEpisode(input: CreateEpisodeInput): StoredEpisode {
    const episodeId = `ep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO task_outcome_episodes
         (episodeId, trigger_type, threadId, participants, artifacts, terminalState, verdict, createdAt)
         VALUES (?, ?, ?, ?, ?, 'in_progress', NULL, ?)`,
      )
      .run(
        episodeId,
        input.trigger,
        input.threadId,
        JSON.stringify(input.participants),
        JSON.stringify(input.artifacts ?? []),
        now,
      );

    return {
      episodeId,
      trigger: input.trigger,
      threadId: input.threadId,
      participants: input.participants,
      artifacts: input.artifacts ?? [],
      terminalState: 'in_progress',
      verdict: null,
      createdAt: now,
    };
  }

  getEpisode(episodeId: string): StoredEpisode | null {
    const row = this.db.prepare('SELECT * FROM task_outcome_episodes WHERE episodeId = ?').get(episodeId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return this.rowToEpisode(row);
  }

  appendSignal(episodeId: string, input: AppendSignalInput): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO task_outcome_signals (episodeId, category, record, createdAt)
         VALUES (?, ?, ?, ?)`,
      )
      .run(episodeId, input.category, JSON.stringify(input.record), now);
  }

  getSignals(episodeId: string): StoredSignal[] {
    const rows = this.db
      .prepare('SELECT * FROM task_outcome_signals WHERE episodeId = ? ORDER BY id ASC')
      .all(episodeId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToSignal(r));
  }

  updateTerminalState(episodeId: string, state: string): void {
    this.db.prepare('UPDATE task_outcome_episodes SET terminalState = ? WHERE episodeId = ?').run(state, episodeId);
  }

  updateVerdict(episodeId: string, verdict: TaskOutcomeVerdict): void {
    this.db.prepare('UPDATE task_outcome_episodes SET verdict = ? WHERE episodeId = ?').run(verdict, episodeId);
  }

  listByThread(threadId: string): StoredEpisode[] {
    const rows = this.db
      .prepare('SELECT * FROM task_outcome_episodes WHERE threadId = ? ORDER BY createdAt DESC')
      .all(threadId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToEpisode(r));
  }

  /**
   * Episodes that are in a terminal done state but have no verdict yet.
   * These are candidates for eval cat analysis.
   */
  listNeedingVerdict(limit = 50): StoredEpisode[] {
    const placeholders = TERMINAL_DONE_STATES.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM task_outcome_episodes
         WHERE verdict IS NULL AND terminalState IN (${placeholders})
         ORDER BY createdAt ASC LIMIT ?`,
      )
      .all(...TERMINAL_DONE_STATES, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToEpisode(r));
  }

  /**
   * Get the latest in_progress episode for a thread (for signal binding).
   */
  getActiveEpisode(threadId: string): StoredEpisode | null {
    const row = this.db
      .prepare(
        `SELECT * FROM task_outcome_episodes
         WHERE threadId = ? AND terminalState = 'in_progress'
         ORDER BY createdAt DESC LIMIT 1`,
      )
      .get(threadId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToEpisode(row);
  }

  private rowToEpisode(row: Record<string, unknown>): StoredEpisode {
    return {
      episodeId: row.episodeId as string,
      trigger: row.trigger_type as string,
      threadId: row.threadId as string,
      participants: JSON.parse(row.participants as string) as string[],
      artifacts: JSON.parse(row.artifacts as string) as string[],
      terminalState: row.terminalState as string,
      verdict: (row.verdict as string | null) ?? null,
      createdAt: row.createdAt as string,
    };
  }

  private rowToSignal(row: Record<string, unknown>): StoredSignal {
    return {
      id: row.id as number,
      episodeId: row.episodeId as string,
      category: row.category as StoredSignal['category'],
      record: JSON.parse(row.record as string) as Record<string, unknown>,
      createdAt: row.createdAt as string,
    };
  }
}
