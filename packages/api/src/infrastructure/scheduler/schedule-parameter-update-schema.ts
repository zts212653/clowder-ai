import type Database from 'better-sqlite3';

/** Widen the existing mutation contract without losing its records or append-only guards. */
export function migrateScheduleParameterUpdates(db: Database.Database): void {
  const dependentSchema = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE tbl_name IN ('schedule_mutation_proposals', 'schedule_mutation_audit') AND type IN ('index', 'trigger') AND sql IS NOT NULL",
    )
    .all() as Array<{ sql: string }>;
  db.exec(`
    CREATE TABLE schedule_mutation_proposals_v78 (
      proposal_id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      requester_cat_id TEXT NOT NULL,
      mutation_kind TEXT NOT NULL CHECK (mutation_kind IN ('create', 'delete', 'update')),
      mutation_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'applying', 'approved', 'rejected')),
      publication_json TEXT NOT NULL,
      effect_checkpoint_json TEXT,
      created_at INTEGER NOT NULL,
      claimed_at INTEGER,
      approved_at INTEGER,
      approved_by TEXT,
      rejected_at INTEGER,
      rejected_by TEXT,
      rejection_reason TEXT
    );
    INSERT INTO schedule_mutation_proposals_v78 SELECT * FROM schedule_mutation_proposals;
    DROP TABLE schedule_mutation_proposals;
    ALTER TABLE schedule_mutation_proposals_v78 RENAME TO schedule_mutation_proposals;
    CREATE TABLE schedule_mutation_audit_v78 (
      audit_id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('cvo', 'cat')),
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('create', 'pause', 'resume', 'delete', 'update')),
      task_id TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO schedule_mutation_audit_v78 SELECT * FROM schedule_mutation_audit;
    DROP TABLE schedule_mutation_audit;
    ALTER TABLE schedule_mutation_audit_v78 RENAME TO schedule_mutation_audit;
  `);
  for (const entry of dependentSchema) db.exec(entry.sql);
}
