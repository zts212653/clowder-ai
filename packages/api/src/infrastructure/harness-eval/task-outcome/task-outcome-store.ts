/**
 * F192 Phase G — SQLite-backed store for Task Outcome Episodes.
 * Signals (permission cancel, magic word, A1, proxy) appended to episodes.
 * Verdicts set by eval cat after analysis.
 */
import Database from 'better-sqlite3';
import { findActiveEpisodeRow } from './task-outcome-active-episode-query.js';
import {
  type CreateEpisodeAttributionInput,
  type EpisodeAttributionLookup,
  normalizeEpisodeAttribution,
  readStoredEpisodeAttribution,
} from './task-outcome-attribution-store.js';
import { type TaskOutcomeAttribution, type TaskOutcomeVerdict, TERMINAL_DONE_STATES } from './task-outcome-episode.js';
import { migrateTaskOutcomeStore } from './task-outcome-store-migrations.js';
import { updateEpisodeVerdictsIdempotently } from './task-outcome-verdict-writeback.js';

interface CreateEpisodeBaseInput {
  trigger: 'user_ask' | 'task_created' | 'cat_initiated';
  threadId: string;
  participants: string[];
  artifacts?: string[];
}

export type CreateEpisodeInput = CreateEpisodeBaseInput & CreateEpisodeAttributionInput;
export type { EpisodeAttributionLookup } from './task-outcome-attribution-store.js';

export interface StoredEpisode {
  episodeId: string;
  trigger: string;
  threadId: string;
  participants: string[];
  artifacts: string[];
  attribution: TaskOutcomeAttribution;
  workId: string | null;
  attemptId: string | null;
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
  /** Optional idempotency key; same (episodeId, key) pair is silently deduped. */
  idempotencyKey?: string;
}

export interface AppendSignalResult {
  /** true if a new row was inserted; false if deduped by idempotencyKey. */
  appended: boolean;
}

export interface PendingEpisodeVerdictUpdate {
  episodeId: string;
  verdict: TaskOutcomeVerdict;
}

export interface PendingEpisodeVerdictUpdateFailure {
  episodeId: string;
  current: StoredEpisode | null;
}

export type PendingEpisodeVerdictUpdateResult =
  | { ok: true }
  | { ok: false; failure: PendingEpisodeVerdictUpdateFailure };

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
        attribution TEXT NOT NULL DEFAULT 'unmanaged_not_applicable',
        workId TEXT,
        attemptId TEXT,
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
        idempotencyKey TEXT,
        createdAt TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_signals_episodeId
        ON task_outcome_signals(episodeId);
    `);
    migrateTaskOutcomeStore(this.db);
  }

  createEpisode(input: CreateEpisodeInput): StoredEpisode {
    const episodeId = `ep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const { attribution, workId, attemptId } = normalizeEpisodeAttribution(input);

    this.db
      .prepare(
        `INSERT INTO task_outcome_episodes
         (episodeId, trigger_type, threadId, participants, artifacts, attribution, workId, attemptId,
          terminalState, verdict, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', NULL, ?)`,
      )
      .run(
        episodeId,
        input.trigger,
        input.threadId,
        JSON.stringify(input.participants),
        JSON.stringify(input.artifacts ?? []),
        attribution,
        workId,
        attemptId,
        now,
      );

    return {
      episodeId,
      trigger: input.trigger,
      threadId: input.threadId,
      participants: input.participants,
      artifacts: input.artifacts ?? [],
      attribution,
      workId,
      attemptId,
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

  appendSignal(episodeId: string, input: AppendSignalInput): AppendSignalResult {
    const now = new Date().toISOString();
    if (input.idempotencyKey) {
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO task_outcome_signals (episodeId, category, record, idempotencyKey, createdAt)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(episodeId, input.category, JSON.stringify(input.record), input.idempotencyKey, now) as { changes: number };
      return { appended: result.changes === 1 };
    }
    this.db
      .prepare(
        `INSERT INTO task_outcome_signals (episodeId, category, record, createdAt)
         VALUES (?, ?, ?, ?)`,
      )
      .run(episodeId, input.category, JSON.stringify(input.record), now);
    return { appended: true };
  }

  /**
   * Cross-episode idempotency lookup. Returns the episode that already owns
   * this signal identity so replay can preserve its original coordinate.
   */
  getSignalEpisodeIdByIdempotencyKey(key: string): string | null {
    const row = this.db
      .prepare('SELECT episodeId FROM task_outcome_signals WHERE idempotencyKey = ? LIMIT 1')
      .get(key) as { episodeId: string } | undefined;
    return row?.episodeId ?? null;
  }

  hasSignalByIdempotencyKey(key: string): boolean {
    return this.getSignalEpisodeIdByIdempotencyKey(key) !== null;
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

  updateVerdictIfPending(episodeId: string, verdict: TaskOutcomeVerdict): boolean {
    const placeholders = TERMINAL_DONE_STATES.map(() => '?').join(', ');
    const result = this.db
      .prepare(
        `UPDATE task_outcome_episodes
         SET verdict = ?
         WHERE episodeId = ?
           AND verdict IS NULL
           AND terminalState IN (${placeholders})`,
      )
      .run(verdict, episodeId, ...TERMINAL_DONE_STATES) as { changes: number };
    return result.changes === 1;
  }

  /**
   * Atomically claim pending verdicts while accepting exact same-value replays.
   * A replacement evidence publish may repeat an already-reviewed verdict, but
   * a different value remains immutable and rolls back the entire batch.
   */
  updateVerdictsIdempotently(updates: PendingEpisodeVerdictUpdate[]): PendingEpisodeVerdictUpdateResult {
    return updateEpisodeVerdictsIdempotently(updates, {
      read: (episodeId) => this.getEpisode(episodeId),
      claimPending: (update) => this.updateVerdictIfPending(update.episodeId, update.verdict),
      // Acquire the writer reservation before the first read. A deferred WAL
      // transaction can otherwise lose a same-value race after observing an
      // older snapshot and fail its write upgrade with SQLITE_BUSY_SNAPSHOT.
      transact: (operation) => this.db.transaction(operation).immediate(),
    });
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
   * F245 Phase B — 只读时间窗查询（cancel 通道源）。
   * createdAt 是 ISO TEXT（字典序 == 时间序），半开窗 [sinceMs, untilMs)：含下界、不含上界。
   * 可选 category 粗筛（真实列 a1/a2/proxy）；record.type 精筛留给 Adapter 层。
   * 纯 SELECT，不碰写侧（KD-4 read-model 边界）。
   */
  listSignalsInWindow(sinceMs: number, untilMs: number, categories?: Array<'a1' | 'a2' | 'proxy'>): StoredSignal[] {
    const sinceIso = new Date(sinceMs).toISOString();
    const untilIso = new Date(untilMs).toISOString();
    const params: unknown[] = [sinceIso, untilIso];
    let sql = 'SELECT * FROM task_outcome_signals WHERE createdAt >= ? AND createdAt < ?';
    if (categories && categories.length > 0) {
      const placeholders = categories.map(() => '?').join(', ');
      sql += ` AND category IN (${placeholders})`;
      params.push(...categories);
    }
    sql += ' ORDER BY createdAt ASC, id ASC';
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToSignal(r));
  }

  /** Legacy read-only compatibility; task-level writers must use explicit attribution. */
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

  /** F275: task-level writers join only by explicit attribution coordinates. */
  getActiveEpisodeByAttribution(input: EpisodeAttributionLookup): StoredEpisode | null {
    const row = findActiveEpisodeRow(this.db, input);
    return row ? this.rowToEpisode(row) : null;
  }

  private rowToEpisode(row: Record<string, unknown>): StoredEpisode {
    const attribution = readStoredEpisodeAttribution(row);
    return {
      episodeId: row.episodeId as string,
      trigger: row.trigger_type as string,
      threadId: row.threadId as string,
      participants: JSON.parse(row.participants as string) as string[],
      artifacts: JSON.parse(row.artifacts as string) as string[],
      ...attribution,
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
