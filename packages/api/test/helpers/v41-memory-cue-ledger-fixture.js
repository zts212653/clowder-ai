export function installV41CueLedgerFixture(db) {
  db.exec(`
    CREATE TABLE schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    INSERT INTO schema_version (version, applied_at)
      VALUES (41, '2026-08-01T00:00:00.000Z');

    CREATE TABLE memory_cue_events (
      event_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      cue_id TEXT NOT NULL,
      opportunity_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      resolver_family TEXT NOT NULL CHECK (
        resolver_family IN ('person_entity', 'operational_precedent', 'taste', 'profile', 'event', 'project_knowledge')
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
      ON memory_cue_events(owner_user_id, cue_id, occurred_at);
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

  const insert = db.prepare(`
    INSERT INTO memory_cue_events (
      event_id, idempotency_key, cue_id, opportunity_id,
      owner_user_id, thread_id, invocation_id, resolver_family,
      source_anchor, source_revision, axis, consumption_outcome,
      invalidation_reason, catalog_version, resolver_version, occurred_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'consumption', 'presented', NULL, 1, 1, ?, ?)
  `);
  insert.run(
    'v41-person-event',
    'v41-person-idempotency',
    'v41-person-cue',
    'v41-person-opportunity',
    'owner-1',
    'thread-1',
    'invocation-1',
    'person_entity',
    'person:alden',
    'sha256:v41-person-revision',
    1_000,
    '2026-08-01T00:00:01.000Z',
  );
  insert.run(
    'v41-event-event',
    'v41-event-idempotency',
    'v41-event-cue',
    'v41-event-opportunity',
    'owner-1',
    'thread-1',
    'invocation-1',
    'event',
    'event-memory:evt_v41',
    'sha256:v41-event-revision',
    2_000,
    '2026-08-01T00:00:02.000Z',
  );
}
