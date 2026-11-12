/** Content-free, immutable observations. The request owns retry identity; an empty read has no items. */
export const DIRECT_MEMORY_READ_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_direct_read_requests (
  request_key TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  consumer_cat_id TEXT NOT NULL,
  principal_kind TEXT NOT NULL CHECK(principal_kind IN ('invocation','agent_key')),
  thread_id TEXT,
  invocation_id TEXT,
  request_digest TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  CHECK((principal_kind='invocation' AND thread_id IS NOT NULL AND invocation_id IS NOT NULL)
    OR (principal_kind='agent_key' AND thread_id IS NULL AND invocation_id IS NULL))
);
CREATE TABLE IF NOT EXISTS memory_direct_read_events (
  event_id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL REFERENCES memory_direct_read_requests(request_key),
  resolver_family TEXT NOT NULL CHECK(resolver_family IN ('person_entity','event')),
  source_anchor TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  memory_revision TEXT NOT NULL,
  UNIQUE(request_key,source_anchor,source_revision)
);
CREATE INDEX IF NOT EXISTS idx_memory_direct_reads_source
  ON memory_direct_read_events(resolver_family,source_anchor,memory_revision,request_key);
CREATE INDEX IF NOT EXISTS idx_memory_direct_reads_owner
  ON memory_direct_read_requests(owner_user_id,occurred_at);
CREATE TRIGGER IF NOT EXISTS memory_direct_read_requests_no_update BEFORE UPDATE ON memory_direct_read_requests
  BEGIN SELECT RAISE(ABORT,'memory direct read requests are immutable'); END;
CREATE TRIGGER IF NOT EXISTS memory_direct_read_requests_no_delete BEFORE DELETE ON memory_direct_read_requests
  BEGIN SELECT RAISE(ABORT,'memory direct read requests are immutable'); END;
CREATE TRIGGER IF NOT EXISTS memory_direct_read_events_no_update BEFORE UPDATE ON memory_direct_read_events
  BEGIN SELECT RAISE(ABORT,'memory direct read events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS memory_direct_read_events_no_delete BEFORE DELETE ON memory_direct_read_events
  BEGIN SELECT RAISE(ABORT,'memory direct read events are immutable'); END;
`;
