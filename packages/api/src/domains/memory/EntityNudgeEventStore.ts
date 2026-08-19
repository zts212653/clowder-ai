/**
 * F260 PR-5: EntityNudgeEventStore — persistent nudge event tracking.
 *
 * AC-B5 five-bucket outcome tracking:
 *   delivered → followed / conscious_ignore / false_positive /
 *               context_suppressed / recurrence_caught
 *
 * F263 R9 added `no_story_coordinate` for nudges filtered by the
 * renderability gate (pre-delivery). Like context_suppressed and
 * recurrence_caught, it is excluded from lastRenderedAt() so it
 * never creates phantom cooldown.
 *
 * Also serves as the persistence layer for cooldown — replaces the
 * in-memory singleton with a durable (entity_id, thread_id, rendered_at)
 * query via lastRenderedAt().
 *
 * Table: entity_nudge_events (standalone, not tied to schema.ts V31 —
 * the store self-creates on construction for testability).
 *
 * [宪宪/Claude Opus 4.6🐾]
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

/** Valid outcome buckets (AC-B5 five-bucket + initial 'delivered'). */
const VALID_OUTCOMES = new Set([
  'delivered',
  'followed',
  'conscious_ignore',
  'false_positive',
  'context_suppressed',
  'recurrence_caught',
  'no_story_coordinate',
]);

export interface RecordDeliveredInput {
  threadId: string;
  invocationId?: string;
  catId?: string;
  entityId: string;
  aliasMatched: string;
  sourceFamily: string;
  aliasClass: string;
  renderedAt: number;
}

export interface RecordSuppressedInput {
  threadId: string;
  entityId: string;
  aliasMatched: string;
  sourceFamily: string;
  aliasClass: string;
  renderedAt: number;
  /** Must be a valid suppression outcome: context_suppressed, recurrence_caught, etc. */
  reason: string;
}

export interface NudgeEventRow {
  event_id: string;
  thread_id: string;
  invocation_id: string | null;
  cat_id: string | null;
  entity_id: string;
  alias_matched: string;
  source_family: string;
  alias_class: string;
  outcome: string;
  rendered_at: number;
  outcome_at: number | null;
}

export class EntityNudgeEventStore {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly lastRenderedStmt: Database.Statement;
  private readonly resolveOutcomeStmt: Database.Statement;
  private readonly queryByOutcomeStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.ensureTable();

    this.insertStmt = db.prepare(`
      INSERT INTO entity_nudge_events
        (event_id, thread_id, invocation_id, cat_id,
         entity_id, alias_matched, source_family, alias_class,
         outcome, rendered_at, outcome_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.lastRenderedStmt = db.prepare(`
      SELECT MAX(rendered_at) as max_rendered
      FROM entity_nudge_events
      WHERE entity_id = ? AND thread_id = ?
        AND outcome NOT IN ('context_suppressed', 'recurrence_caught', 'no_story_coordinate')
    `);

    this.resolveOutcomeStmt = db.prepare(`
      UPDATE entity_nudge_events
      SET outcome = ?, outcome_at = ?
      WHERE event_id = ?
    `);

    this.queryByOutcomeStmt = db.prepare(`
      SELECT * FROM entity_nudge_events
      WHERE outcome = ?
      ORDER BY rendered_at DESC
    `);
  }

  /**
   * Record a delivered nudge event. Returns the generated event_id.
   * Outcome starts as 'delivered' — can be resolved later via resolveOutcome().
   */
  recordDelivered(input: RecordDeliveredInput): string {
    const eventId = randomUUID();
    this.insertStmt.run(
      eventId,
      input.threadId,
      input.invocationId ?? null,
      input.catId ?? null,
      input.entityId,
      input.aliasMatched,
      input.sourceFamily,
      input.aliasClass,
      'delivered',
      input.renderedAt,
      null,
    );
    return eventId;
  }

  /**
   * Record a suppressed nudge event (context_suppressed, recurrence_caught, etc.).
   * These are terminal — no later resolveOutcome() needed.
   */
  recordSuppressed(input: RecordSuppressedInput): string {
    if (!VALID_OUTCOMES.has(input.reason)) {
      throw new Error(`Invalid suppression reason: ${input.reason}. Valid: ${[...VALID_OUTCOMES].join(', ')}`);
    }
    const eventId = randomUUID();
    this.insertStmt.run(
      eventId,
      input.threadId,
      null,
      null,
      input.entityId,
      input.aliasMatched,
      input.sourceFamily,
      input.aliasClass,
      input.reason,
      input.renderedAt,
      null,
    );
    return eventId;
  }

  /**
   * Get the most recent rendered_at timestamp for a given entity + thread.
   * Used for cooldown: "was this entity nudged in this thread recently?"
   * Returns null if no events exist for the combination.
   */
  lastRenderedAt(entityId: string, threadId: string): number | null {
    const row = this.lastRenderedStmt.get(entityId, threadId) as { max_rendered: number | null } | undefined;
    return row?.max_rendered ?? null;
  }

  /**
   * Resolve a delivered event's outcome (e.g., followed, conscious_ignore).
   * Updates both outcome and outcome_at timestamp.
   */
  resolveOutcome(eventId: string, outcome: string, outcomeAt: number): void {
    if (!VALID_OUTCOMES.has(outcome)) {
      throw new Error(`Invalid outcome: ${outcome}. Valid: ${[...VALID_OUTCOMES].join(', ')}`);
    }
    this.resolveOutcomeStmt.run(outcome, outcomeAt, eventId);
  }

  /**
   * Query events by outcome bucket. Returns rows in reverse chronological order.
   */
  queryByOutcome(outcome: string): NudgeEventRow[] {
    return this.queryByOutcomeStmt.all(outcome) as NudgeEventRow[];
  }

  /** Create the entity_nudge_events table if it doesn't exist. */
  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entity_nudge_events (
        event_id       TEXT PRIMARY KEY,
        thread_id      TEXT NOT NULL,
        invocation_id  TEXT,
        cat_id         TEXT,
        entity_id      TEXT NOT NULL,
        alias_matched  TEXT NOT NULL,
        source_family  TEXT NOT NULL,
        alias_class    TEXT NOT NULL,
        outcome        TEXT NOT NULL,
        rendered_at    INTEGER NOT NULL,
        outcome_at     INTEGER
      )
    `);

    // Indexes for common queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_nudge_events_thread
        ON entity_nudge_events(thread_id);
      CREATE INDEX IF NOT EXISTS idx_nudge_events_entity
        ON entity_nudge_events(entity_id);
      CREATE INDEX IF NOT EXISTS idx_nudge_events_rendered_at
        ON entity_nudge_events(rendered_at);
      CREATE INDEX IF NOT EXISTS idx_nudge_events_cooldown
        ON entity_nudge_events(entity_id, thread_id);
    `);
  }
}
