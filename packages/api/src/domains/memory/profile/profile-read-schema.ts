/** Content-free read evidence in the existing memory database; no new profile authority. */
export const PROFILE_READ_SCHEMA = `
CREATE TABLE IF NOT EXISTS profile_read_events (
  event_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  consumer_cat_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  principal_kind TEXT NOT NULL CHECK (principal_kind IN ('invocation', 'agent_key')),
  thread_id TEXT,
  invocation_id TEXT,
  occurred_at INTEGER NOT NULL,
  CHECK ((principal_kind = 'invocation' AND thread_id IS NOT NULL AND invocation_id IS NOT NULL)
      OR (principal_kind = 'agent_key' AND thread_id IS NULL AND invocation_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_profile_reads_source ON profile_read_events(owner_user_id, memory_id, source_revision, occurred_at);
CREATE TRIGGER IF NOT EXISTS profile_read_events_no_update BEFORE UPDATE ON profile_read_events
BEGIN SELECT RAISE(ABORT, 'Profile read evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS profile_read_events_no_delete BEFORE DELETE ON profile_read_events
BEGIN SELECT RAISE(ABORT, 'Profile read evidence is immutable'); END;
`;
