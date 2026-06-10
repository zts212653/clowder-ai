/**
 * F227 PR-1 — EventMemoryStore (memory cell, SQLite-backed).
 *
 * Typed event index for cognitive-transition events. Single source of truth for
 * magic-word events (归一裁定 2026-06-06). Mirrors TaskOutcomeEpisodeStore's
 * SQLite pattern but lives in the memory domain (design gate OQ-4: a typed
 * sub-store / table, NOT a parallel memory architecture).
 *
 * `trigger` is a SQLite reserved word → stored as column `trigger_type`.
 * `relatedHarness` (string[] | null) is JSON-encoded; `cognitiveTransition`
 * (enum | null) is stored verbatim.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type {
  CognitiveTransition,
  EventConfidence,
  EventMemoryRecord,
  EventTrigger,
  StoredEventMemory,
} from '@cat-cafe/shared';
import { generateEventId, isEventMemoryRecord, isValidOwnerUserId } from '@cat-cafe/shared';
import Database from 'better-sqlite3';

export interface EventMemoryFilter {
  /** Owner scope (cloud-review P1): restrict to one cocreator's events. */
  ownerUserId?: string;
  trigger?: EventTrigger;
  cat?: string;
  type?: string;
  threadId?: string;
  confidence?: EventConfidence;
  cognitiveTransition?: CognitiveTransition;
  /** timestamp >= since (inclusive) */
  since?: number;
  /** timestamp <= until (inclusive) */
  until?: number;
  limit?: number;
  offset?: number;
}

/** Result of an idempotent markEvent: the persisted event + whether THIS call inserted it. */
export interface MarkEventResult {
  event: StoredEventMemory;
  /** true = newly inserted by this call; false = a row with this (threadId,messageId,type) already existed. */
  inserted: boolean;
}

export interface IEventMemoryStore {
  initialize(): Promise<void>;
  /**
   * Atomically idempotent write keyed on UNIQUE(ownerUserId, threadId, messageId, type):
   * mints an eventId and inserts, or — if that owner+coordinate+type already exists —
   * returns the existing event with inserted=false (no duplicate). `ownerUserId` is the
   * required auth scope (cloud-review P1); empty → throws (no fallback, 砚砚). Safe under
   * concurrent backfill / live writes.
   */
  markEvent(record: EventMemoryRecord, ownerUserId: string): MarkEventResult;
  getEvent(eventId: string): StoredEventMemory | null;
  /** Newest-first, filtered + paged. Pass filter.ownerUserId to owner-scope reads. */
  listEvents(filter?: EventMemoryFilter): StoredEventMemory[];
  /** Teleport reverse lookup: events at a (threadId, messageId) coordinate, owner-scoped when provided. */
  getByCoord(threadId: string, messageId: string, ownerUserId?: string): StoredEventMemory[];
  /** P1-3 (砚砚): persist a failed write + its owner scope for replay so events are not lost (最终不丢). */
  appendDeadLetter(record: EventMemoryRecord, ownerUserId: string, errorMessage: string): void;
  /** Read dead-lettered entries (replay / inspection). */
  listDeadLetter(): DeadLetterEntry[];
  health(): boolean;
}

export interface DeadLetterEntry {
  record: EventMemoryRecord;
  /** Owner scope captured at failure time so a replay re-writes without guessing (砚砚 P1). */
  ownerUserId: string;
  error: string;
  failedAt: number;
}

export class EventMemoryStore implements IEventMemoryStore {
  private readonly dbPath: string;
  /** P1-3: dead-letter sits BESIDE the db (separate resource) so a db-write
   * failure can still be recorded. :memory: stores keep it in memory. */
  private readonly deadLetterPath: string | null;
  private readonly inMemoryDeadLetter: string[] = [];
  private db: InstanceType<typeof Database> | undefined;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.deadLetterPath = dbPath === ':memory:' ? null : `${dbPath}.outbox.jsonl`;
  }

  async initialize(): Promise<void> {
    const db = new Database(this.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    this.migrate(db);
    this.db = db;
  }

  private migrate(db: InstanceType<typeof Database>): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS event_memory (
        eventId TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        cat TEXT NOT NULL,
        threadId TEXT NOT NULL,
        messageId TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        summary TEXT NOT NULL,
        cognitiveTransition TEXT,
        relatedHarness TEXT,
        confidence TEXT NOT NULL,
        ownerUserId TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_event_threadId ON event_memory(threadId);
      CREATE INDEX IF NOT EXISTS idx_event_coord ON event_memory(threadId, messageId);
      CREATE INDEX IF NOT EXISTS idx_event_trigger ON event_memory(trigger_type);
      CREATE INDEX IF NOT EXISTS idx_event_timestamp ON event_memory(timestamp);
      CREATE INDEX IF NOT EXISTS idx_event_confidence ON event_memory(confidence);
    `);
    // F227 (cloud-review P1): owner scope. A legacy table (pre-owner) lacks the column —
    // add it so initialize() upgrades in place. Existing un-owned rows get '' and stay
    // unreachable to any real authenticated owner (safe-by-default, no cross-user leak).
    const hasOwner = (db.prepare(`PRAGMA table_info(event_memory)`).all() as Array<{ name: string }>).some(
      (c) => c.name === 'ownerUserId',
    );
    if (!hasOwner) {
      db.exec(`ALTER TABLE event_memory ADD COLUMN ownerUserId TEXT NOT NULL DEFAULT ''`);
    }
    // Atomic idempotency guard, now OWNER-scoped: UNIQUE(ownerUserId, threadId, messageId,
    // type). Dedup pre-existing duplicates (keep the earliest rowid per owner+coord+type)
    // BEFORE the UNIQUE index so initialize() never fails on a DB with duplicates. Drop the
    // pre-owner index it replaces.
    db.exec(`
      DROP INDEX IF EXISTS idx_event_coord_type;
      DELETE FROM event_memory
      WHERE rowid NOT IN (
        SELECT MIN(rowid) FROM event_memory GROUP BY ownerUserId, threadId, messageId, type
      );
      CREATE INDEX IF NOT EXISTS idx_event_owner ON event_memory(ownerUserId);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_event_owner_coord_type
        ON event_memory(ownerUserId, threadId, messageId, type);
    `);
  }

  private ensureOpen(): InstanceType<typeof Database> {
    if (!this.db) throw new Error('EventMemoryStore not initialized — call initialize() first');
    return this.db;
  }

  markEvent(record: EventMemoryRecord, ownerUserId: string): MarkEventResult {
    // 砚砚 (non-blocking): validate untrusted payloads (backfill / tool writers)
    // with the shared guard before they hit SQLite.
    if (!isEventMemoryRecord(record)) {
      throw new Error('EventMemoryStore.markEvent: record failed isEventMemoryRecord guard');
    }
    // Owner scope is REQUIRED (cloud-review P1 / 砚砚): no unknown/default fallback — a
    // writer that can't resolve its authenticated owner must fail, not write unscoped.
    if (!isValidOwnerUserId(ownerUserId)) {
      throw new Error('EventMemoryStore.markEvent: ownerUserId is required (no fallback)');
    }
    const db = this.ensureOpen();
    const eventId = generateEventId();
    // INSERT OR IGNORE against UNIQUE(ownerUserId, threadId, messageId, type): atomically
    // idempotent, so concurrent backfill / live writes on the same coordinate can't
    // double-write.
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO event_memory
          (eventId, type, trigger_type, cat, ownerUserId, threadId, messageId, timestamp, summary, cognitiveTransition, relatedHarness, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        record.type,
        record.trigger,
        record.cat,
        ownerUserId,
        record.threadId,
        record.messageId,
        record.timestamp,
        record.summary,
        record.cognitiveTransition,
        record.relatedHarness === null ? null : JSON.stringify(record.relatedHarness),
        record.confidence,
      );
    if (info.changes === 1) {
      return { event: { eventId, ownerUserId, ...record }, inserted: true };
    }
    // Duplicate (ownerUserId, threadId, messageId, type) already present — no new row.
    // Race resolution (cloud-review P2): if THIS writer has STRICTLY higher confidence than
    // the existing row, upgrade its confidence + metadata. So a real live brake (high) is
    // never left at a backfill grade (mid/low) just because backfill won the insert race;
    // lower/equal confidence leaves the existing row untouched (idempotent).
    db.prepare(
      `UPDATE event_memory
          SET confidence = ?, trigger_type = ?, cat = ?, summary = ?, cognitiveTransition = ?, relatedHarness = ?
        WHERE ownerUserId = ? AND threadId = ? AND messageId = ? AND type = ?
          AND (CASE ? WHEN 'high' THEN 3 WHEN 'mid' THEN 2 ELSE 1 END)
            > (CASE confidence WHEN 'high' THEN 3 WHEN 'mid' THEN 2 ELSE 1 END)`,
    ).run(
      record.confidence,
      record.trigger,
      record.cat,
      record.summary,
      record.cognitiveTransition,
      record.relatedHarness === null ? null : JSON.stringify(record.relatedHarness),
      ownerUserId,
      record.threadId,
      record.messageId,
      record.type,
      record.confidence,
    );
    // Return the existing (possibly just-upgraded) event so the live path still resolves a
    // real eventId (砚砚); no duplicate row is ever written.
    const existing = db
      .prepare(
        'SELECT * FROM event_memory WHERE ownerUserId = ? AND threadId = ? AND messageId = ? AND type = ? LIMIT 1',
      )
      .get(ownerUserId, record.threadId, record.messageId, record.type) as Record<string, unknown> | undefined;
    return { event: existing ? this.rowToEvent(existing) : { eventId, ownerUserId, ...record }, inserted: false };
  }

  getEvent(eventId: string): StoredEventMemory | null {
    const db = this.ensureOpen();
    const row = db.prepare('SELECT * FROM event_memory WHERE eventId = ?').get(eventId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToEvent(row) : null;
  }

  listEvents(filter: EventMemoryFilter = {}): StoredEventMemory[] {
    const db = this.ensureOpen();
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    const eq = (column: string, value: string | undefined): void => {
      if (value !== undefined) {
        clauses.push(`${column} = ?`);
        params.push(value);
      }
    };
    eq('ownerUserId', filter.ownerUserId);
    eq('trigger_type', filter.trigger);
    eq('cat', filter.cat);
    eq('type', filter.type);
    eq('threadId', filter.threadId);
    eq('confidence', filter.confidence);
    eq('cognitiveTransition', filter.cognitiveTransition);
    if (filter.since !== undefined) {
      clauses.push('timestamp >= ?');
      params.push(filter.since);
    }
    if (filter.until !== undefined) {
      clauses.push('timestamp <= ?');
      params.push(filter.until);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = filter.limit ?? -1; // SQLite: LIMIT -1 = unbounded
    const offset = filter.offset ?? 0;

    const rows = db
      .prepare(`SELECT * FROM event_memory ${where} ORDER BY timestamp DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToEvent(r));
  }

  getByCoord(threadId: string, messageId: string, ownerUserId?: string): StoredEventMemory[] {
    const db = this.ensureOpen();
    const where = ownerUserId ? 'threadId = ? AND messageId = ? AND ownerUserId = ?' : 'threadId = ? AND messageId = ?';
    const params = ownerUserId ? [threadId, messageId, ownerUserId] : [threadId, messageId];
    const rows = db
      .prepare(`SELECT * FROM event_memory WHERE ${where} ORDER BY timestamp DESC, rowid DESC`)
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToEvent(r));
  }

  health(): boolean {
    try {
      this.ensureOpen().prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  appendDeadLetter(record: EventMemoryRecord, ownerUserId: string, errorMessage: string): void {
    const line = `${JSON.stringify({ record, ownerUserId, error: errorMessage, failedAt: Date.now() })}\n`;
    if (this.deadLetterPath) {
      appendFileSync(this.deadLetterPath, line);
    } else {
      this.inMemoryDeadLetter.push(line);
    }
  }

  listDeadLetter(): DeadLetterEntry[] {
    let lines: string[];
    if (this.deadLetterPath) {
      lines = existsSync(this.deadLetterPath)
        ? readFileSync(this.deadLetterPath, 'utf8').split('\n').filter(Boolean)
        : [];
    } else {
      lines = this.inMemoryDeadLetter;
    }
    return lines.map((l) => JSON.parse(l) as DeadLetterEntry);
  }

  private rowToEvent(row: Record<string, unknown>): StoredEventMemory {
    return {
      eventId: row.eventId as string,
      ownerUserId: row.ownerUserId as string,
      type: row.type as string,
      trigger: row.trigger_type as EventTrigger,
      cat: row.cat as string,
      threadId: row.threadId as string,
      messageId: row.messageId as string,
      timestamp: row.timestamp as number,
      summary: row.summary as string,
      cognitiveTransition: (row.cognitiveTransition as CognitiveTransition | null) ?? null,
      relatedHarness: row.relatedHarness === null ? null : (JSON.parse(row.relatedHarness as string) as string[]),
      confidence: row.confidence as EventConfidence,
    };
  }
}
