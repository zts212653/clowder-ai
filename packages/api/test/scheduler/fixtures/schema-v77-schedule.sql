-- Historical schedule tables, unchanged between schema v35 and v77.
      CREATE TABLE IF NOT EXISTS schedule_mutation_proposals (
        proposal_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        requester_cat_id TEXT NOT NULL,
        mutation_kind TEXT NOT NULL CHECK (mutation_kind IN ('create', 'delete')),
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
      CREATE INDEX IF NOT EXISTS idx_schedule_mutation_proposals_owner_status
        ON schedule_mutation_proposals(owner_user_id, status, created_at);

      CREATE TABLE IF NOT EXISTS schedule_mutation_audit (
        audit_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        actor_kind TEXT NOT NULL CHECK (actor_kind IN ('cvo', 'cat')),
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('create', 'pause', 'resume', 'delete')),
        task_id TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_schedule_mutation_audit_owner_time
        ON schedule_mutation_audit(owner_user_id, created_at);
      CREATE TRIGGER IF NOT EXISTS schedule_mutation_audit_no_update
      BEFORE UPDATE ON schedule_mutation_audit
      BEGIN
        SELECT RAISE(ABORT, 'schedule mutation audit is append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS schedule_mutation_audit_no_delete
      BEFORE DELETE ON schedule_mutation_audit
      BEGIN
        SELECT RAISE(ABORT, 'schedule mutation audit is append-only');
      END;
