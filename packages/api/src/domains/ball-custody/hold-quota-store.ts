/**
 * F167 #1449 Slice 2: Durable hold quota with true sliding window.
 *
 * Each hold is stored as an individual event with its own timestamp.
 * Window count = number of events within [now - windowMs, now).
 * This gives a true sliding window: hold at T=0, T=50min, T=100min
 * allows the third hold (only 1 prior hold within the last 60 min at T=100min).
 *
 * Compensation: `tryAdmit()` returns a unique `eventId`. Failed downstream
 * operations call `releaseByEventId(eventId, threadId, catId)` to delete the
 * exact reservation. This is pair-fenced: the (threadId, catId) must match,
 * preventing cross-pair deletion.
 *
 * Implementations:
 * - `RedisHoldQuotaStore` (primary): shared authority across API nodes via Redis
 *   sorted sets + Lua scripts. Atomic admission serialized by Redis single-threaded
 *   Lua executor. Required in normal mode (MEMORY_STORE unset).
 * - `SqliteHoldQuotaStore` (degraded): per-node SQLite, for MEMORY_STORE=1 only.
 *   Not shared across nodes. Uses IMMEDIATE transactions for same-node atomicity.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

/** Result of an atomic admission attempt. */
export interface AdmissionResult {
  readonly admitted: boolean;
  /** Count of holds in the window after the attempt (includes the new hold if admitted). */
  readonly count: number;
  /** When the next hold would be admitted (absolute, authority clock). Only set when rejected. */
  readonly retryAtMs?: number;
  /**
   * Milliseconds until the next hold would be admitted, computed by the same
   * authority clock as `retryAtMs`. Route handlers MUST use this instead of
   * subtracting `Date.now()` from `retryAtMs` — cross-clock-domain subtraction
   * produces self-contradictory 429 responses when nodes have clock skew.
   * Only set when rejected.
   */
  readonly retryAfterMs?: number;
  /**
   * Unique event identifier. Only present when `admitted === true`.
   * Use with `releaseByEventId()` for exact compensation on downstream failure.
   */
  readonly eventId?: string;
}

/**
 * Port for hold quota stores. All methods are async to support both
 * Redis (primary, shared authority) and SQLite (MEMORY_STORE=1 degraded).
 */
export interface IHoldQuotaStore {
  /**
   * Atomically check quota and reserve a slot if admitted.
   * This is the ONLY correct admission path — no separate getCount + insert.
   */
  tryAdmit(threadId: string, catId: string, maxHolds: number, windowMs: number, now?: number): Promise<AdmissionResult>;

  /**
   * Compensate a specific reservation by its eventId (from tryAdmit().eventId).
   * Pair-fenced: the (threadId, catId) must also match, preventing cross-pair deletion.
   */
  releaseByEventId(eventId: string, threadId: string, catId: string): Promise<boolean>;

  /**
   * Count holds within the sliding window [now - windowMs, now).
   * Read-only — use for diagnostics / observability, NOT for admission decisions.
   */
  getCount(threadId: string, catId: string, windowMs: number, now?: number): Promise<number>;

  close(): Promise<void>;
}

export interface SqliteHoldQuotaStoreOptions {
  /** SQLite file path. Use ':memory:' for tests. */
  readonly dbPath: string;
}

/**
 * SQLite-backed hold quota store. MEMORY_STORE=1 degraded mode only.
 * Per-node scope — NOT shared across API nodes.
 *
 * Admission atomicity: IMMEDIATE transactions acquire RESERVED lock at BEGIN,
 * serializing concurrent callers at the transaction boundary.
 */
export class SqliteHoldQuotaStore implements IHoldQuotaStore {
  private readonly db: Database.Database;

  private readonly stmtCount: Database.Statement;
  private readonly stmtInsert: Database.Statement;
  private readonly stmtPrune: Database.Statement;
  private readonly stmtRetryAt: Database.Statement;
  private readonly stmtReleaseById: Database.Statement;

  private readonly txnTryAdmit: Database.Transaction<
    (threadId: string, catId: string, maxHolds: number, windowMs: number, now: number) => AdmissionResult
  >;

  constructor(options: SqliteHoldQuotaStoreOptions) {
    if (options.dbPath !== ':memory:') {
      mkdirSync(dirname(options.dbPath), { recursive: true });
    }
    this.db = new Database(options.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hold_quota_events (
        thread_id TEXT NOT NULL,
        cat_id    TEXT NOT NULL,
        held_at   INTEGER NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_hold_quota_window
        ON hold_quota_events (thread_id, cat_id, held_at)
    `);

    this.stmtCount = this.db.prepare(
      'SELECT COUNT(*) AS cnt FROM hold_quota_events WHERE thread_id = ? AND cat_id = ? AND held_at > ?',
    );
    this.stmtInsert = this.db.prepare('INSERT INTO hold_quota_events (thread_id, cat_id, held_at) VALUES (?, ?, ?)');
    this.stmtPrune = this.db.prepare('DELETE FROM hold_quota_events WHERE held_at <= ?');
    this.stmtRetryAt = this.db.prepare(
      `SELECT held_at FROM hold_quota_events
       WHERE thread_id = ? AND cat_id = ? AND held_at > ?
       ORDER BY held_at ASC
       LIMIT 1 OFFSET ?`,
    );
    this.stmtReleaseById = this.db.prepare(
      'DELETE FROM hold_quota_events WHERE rowid = ? AND thread_id = ? AND cat_id = ?',
    );

    // Build the atomic admission transaction. Within the RESERVED lock (IMMEDIATE),
    // count and insert are serialized — no TOCTOU race between concurrent callers.
    this.txnTryAdmit = this.db.transaction((threadId, catId, maxHolds, windowMs, now) => {
      const cutoff = now - windowMs;
      const count = (this.stmtCount.get(threadId, catId, cutoff) as { cnt: number }).cnt;

      if (count >= maxHolds) {
        // Rejected — compute retryAtMs within the same transaction
        const offset = count - maxHolds;
        const row = this.stmtRetryAt.get(threadId, catId, cutoff, offset) as { held_at: number } | undefined;
        const retryAtMs = row ? row.held_at + windowMs : now;
        const retryAfterMs = Math.max(0, retryAtMs - now);
        return { admitted: false, count, retryAtMs, retryAfterMs };
      }

      // Admitted — insert event and lazy-prune old entries.
      // Capture the rowid as eventId string for exact compensation on downstream failure.
      const insertResult = this.stmtInsert.run(threadId, catId, now);
      const eventId = String(insertResult.lastInsertRowid);
      const aggressiveCutoff = now - windowMs * 2;
      this.stmtPrune.run(aggressiveCutoff);
      return { admitted: true, count: count + 1, eventId };
    });
  }

  async tryAdmit(
    threadId: string,
    catId: string,
    maxHolds: number,
    windowMs: number,
    now: number = Date.now(),
  ): Promise<AdmissionResult> {
    return this.txnTryAdmit.immediate(threadId, catId, maxHolds, windowMs, now);
  }

  async getCount(threadId: string, catId: string, windowMs: number, now: number = Date.now()): Promise<number> {
    const cutoff = now - windowMs;
    return (this.stmtCount.get(threadId, catId, cutoff) as { cnt: number }).cnt;
  }

  async releaseByEventId(eventId: string, threadId: string, catId: string): Promise<boolean> {
    // eventId is the SQLite rowid as string; parse back to number for the query
    const result = this.stmtReleaseById.run(Number(eventId), threadId, catId);
    return result.changes > 0;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/**
 * Create a SqliteHoldQuotaStore backed by a SQLite file at the given path.
 * For tests, pass ':memory:'. MEMORY_STORE=1 degraded mode only.
 */
export function createSqliteHoldQuotaStore(dbPath: string): SqliteHoldQuotaStore {
  return new SqliteHoldQuotaStore({ dbPath });
}

/** @deprecated Use SqliteHoldQuotaStore. Value alias preserved for migration. */
export const HoldQuotaStore = SqliteHoldQuotaStore;
/** @deprecated Use createSqliteHoldQuotaStore. */
export const createHoldQuotaStore = createSqliteHoldQuotaStore;
