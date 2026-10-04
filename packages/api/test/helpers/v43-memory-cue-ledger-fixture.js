import { installLegacyEntityMentionFixture } from './legacy-entity-mention-fixture.js';

/** The physical cue ledger already exists at schema V43; scheduler migration fixtures must include it. */
export function installV43CueLedgerSchemaFixture(db) {
  installLegacyEntityMentionFixture(db);
  db.exec(`
    CREATE TABLE memory_cue_events (
      event_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      cue_id TEXT NOT NULL,
      opportunity_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      consumer_cat_id TEXT NOT NULL,
      resolver_family TEXT NOT NULL CHECK (
        resolver_family IN (
          'person_entity', 'operational_precedent', 'taste', 'profile', 'event', 'decision',
          'project_knowledge', 'cat_owned_seed'
        )
      ),
      source_anchor TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      axis TEXT NOT NULL CHECK (axis IN ('consumption', 'invalidation')),
      consumption_outcome TEXT CHECK (
        consumption_outcome IN ('presented', 'drilled', 'applied', 'dismissed')
      ),
      invalidation_reason TEXT CHECK (
        invalidation_reason IN ('source_corrected', 'source_forgotten', 'scope_revoked', 'superseded', 'expired')
      ),
      catalog_version INTEGER NOT NULL,
      resolver_version INTEGER NOT NULL,
      occurred_at INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      CHECK (
        (axis = 'consumption' AND consumption_outcome IS NOT NULL AND invalidation_reason IS NULL)
        OR
        (axis = 'invalidation' AND invalidation_reason IS NOT NULL AND consumption_outcome IS NULL)
      )
    );
    CREATE INDEX idx_memory_cue_events_cue_scope
      ON memory_cue_events(owner_user_id, thread_id, invocation_id, consumer_cat_id, cue_id, occurred_at);
    CREATE INDEX idx_memory_cue_events_opportunity
      ON memory_cue_events(owner_user_id, opportunity_id, occurred_at);
    CREATE TRIGGER memory_cue_events_no_update
    BEFORE UPDATE ON memory_cue_events
    BEGIN
      SELECT RAISE(ABORT, 'memory cue events are append-only');
    END;
    CREATE TRIGGER memory_cue_events_no_delete
    BEFORE DELETE ON memory_cue_events
    BEGIN
      SELECT RAISE(ABORT, 'memory cue events are append-only');
    END;
  `);
}
