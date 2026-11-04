/** Canonical memory facts: no FK to the rebuildable evidence index, no TTL. */
export const MATTER_MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_matters (
  matter_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_matters_owner ON memory_matters(owner_user_id, matter_id);
CREATE TABLE IF NOT EXISTS memory_matter_entries (
  entry_id TEXT PRIMARY KEY,
  matter_id TEXT NOT NULL REFERENCES memory_matters(matter_id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  source_json TEXT NOT NULL CHECK (json_valid(source_json)),
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'retired')),
  superseded_by TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(matter_id, source_key)
);
CREATE INDEX IF NOT EXISTS idx_memory_matter_entries ON memory_matter_entries(matter_id, entry_id);
CREATE TABLE IF NOT EXISTS memory_matter_requests (
  owner_user_id TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  matter_id TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  PRIMARY KEY(owner_user_id, actor_key, request_id)
);
CREATE TABLE IF NOT EXISTS memory_matter_forget_fences (
  owner_user_id TEXT NOT NULL,
  matter_id TEXT NOT NULL,
  forgotten_at INTEGER NOT NULL,
  PRIMARY KEY(owner_user_id, matter_id)
);
`;
