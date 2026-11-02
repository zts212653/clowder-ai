-- Frozen V71 publication DDL from reviewed HEAD 64942728466ee4c2359b4529f4ce6b4690c0841f.

CREATE TABLE IF NOT EXISTS message_search_answer_publications (
  publication_ref TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version=1),
  operation_key TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL,
  producer_key TEXT NOT NULL,
  producer_cat_id TEXT NOT NULL,
  invocation_id TEXT,
  target_thread_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('searching','prepared','failed')),
  response_json TEXT CHECK(response_json IS NULL OR length(response_json) <= 24000),
  response_digest TEXT,
  bound_message_id TEXT,
  block_id TEXT,
  failure_code TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS message_search_answer_invocation
  ON message_search_answer_publications(owner_user_id, producer_cat_id, invocation_id)
  WHERE invocation_id IS NOT NULL;
