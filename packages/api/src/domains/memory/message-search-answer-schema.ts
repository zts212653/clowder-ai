import type Database from 'better-sqlite3';

const RECOVERY_INDEX = `CREATE INDEX IF NOT EXISTS message_search_answer_recovery
  ON message_search_answer_publications(recovery_order, publication_ref)
  WHERE invocation_id IS NOT NULL AND state='prepared' AND recovery_order IS NOT NULL;`;

/** Memory owns one durable bounded response; messages contain references only. No TTL. */
export const MESSAGE_SEARCH_ANSWER_SCHEMA = `
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
  recovery_order INTEGER DEFAULT 0 CHECK(recovery_order IS NULL OR recovery_order >= 0),
  failure_code TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS message_search_answer_invocation
  ON message_search_answer_publications(owner_user_id, producer_cat_id, invocation_id)
  WHERE invocation_id IS NOT NULL;
${RECOVERY_INDEX}
`;

/** V72 upgrades an existing V71 record without rewriting its response or binding. */
export function addMessageSearchAnswerRecoveryColumn(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(message_search_answer_publications)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'recovery_order'))
    db.exec(
      'ALTER TABLE message_search_answer_publications ADD COLUMN recovery_order INTEGER DEFAULT 0 CHECK(recovery_order IS NULL OR recovery_order >= 0)',
    );
  db.exec(RECOVERY_INDEX);
}
