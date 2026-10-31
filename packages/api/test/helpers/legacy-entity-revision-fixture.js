import { installLegacyEntityMentionFixture } from './legacy-entity-mention-fixture.js';

/** V41/V43 snapshots already contain the V32 audit ledger. Keep pre-V32 fixtures
 * on the older mention helper so their migration still creates this ledger. */
export function installLegacyEntityRevisionFixture(db) {
  installLegacyEntityMentionFixture(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_revision_events (
      revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('create', 'update')),
      before_json TEXT,
      after_json TEXT NOT NULL,
      source TEXT NOT NULL,
      actor_id TEXT,
      proposal_id TEXT,
      reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entity_revision_events_entity_time
      ON entity_revision_events(entity_id, revision_id);
    CREATE TRIGGER IF NOT EXISTS entity_revision_events_no_update
    BEFORE UPDATE ON entity_revision_events
    BEGIN
      SELECT RAISE(ABORT, 'entity revision events are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS entity_revision_events_no_delete
    BEFORE DELETE ON entity_revision_events
    BEGIN
      SELECT RAISE(ABORT, 'entity revision events are append-only');
    END;
  `);
}
