export const PROACTIVE_RELATIONSHIP_SCHEMA = `
CREATE TABLE IF NOT EXISTS proactive_intents (
  intent_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  cat_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES present_loop_runs(run_id),
  seed_id TEXT NOT NULL REFERENCES owned_seeds(seed_id),
  status TEXT NOT NULL CHECK (status IN ('settled_silent', 'ready', 'visit_reserved', 'projected', 'echoed', 'settled')),
  visibility_kind TEXT NOT NULL CHECK (visibility_kind IN ('silence', 'body_language', 'message')),
  expression_kind TEXT NOT NULL CHECK (expression_kind IN ('want', 'discover', 'care')),
  first_action_kind TEXT NOT NULL CHECK (first_action_kind IN ('research', 'sketch', 'evidence_check', 'attentive_pause')),
  first_action_summary TEXT NOT NULL,
  first_action_artifact_ref TEXT,
  visibility_block_reason TEXT CHECK (visibility_block_reason IS NULL OR visibility_block_reason IN ('quiet_hours', 'budget_exhausted')),
  settled_at INTEGER,
  created_by_invocation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (owner_user_id, run_id),
  CHECK (
    (visibility_kind = 'silence' AND status = 'settled_silent' AND settled_at IS NOT NULL)
    OR (visibility_kind != 'silence' AND status != 'settled_silent')
  ),
  CHECK (visibility_block_reason IS NULL OR status = 'ready')
);
CREATE INDEX IF NOT EXISTS idx_proactive_intents_owner_cat_status
  ON proactive_intents(owner_user_id, cat_id, status, created_at, intent_id);

CREATE TABLE IF NOT EXISTS proactive_visits (
  visit_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  cat_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES present_loop_runs(run_id),
  intent_id TEXT NOT NULL UNIQUE REFERENCES proactive_intents(intent_id),
  seed_id TEXT NOT NULL REFERENCES owned_seeds(seed_id),
  expression_kind TEXT NOT NULL CHECK (expression_kind IN ('want', 'discover', 'care')),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'projected', 'echoed', 'settled', 'cancelled_unseen')),
  household_local_date TEXT NOT NULL,
  budget_claim_state TEXT NOT NULL CHECK (budget_claim_state IN ('claimed', 'consumed', 'released')),
  home_thread_id TEXT NOT NULL,
  pending_message_body TEXT,
  canonical_message_thread_id TEXT,
  canonical_message_id TEXT,
  projected_surfaces_json TEXT NOT NULL DEFAULT '[]',
  echoed_at INTEGER,
  settled_at INTEGER,
  cancelled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (owner_user_id, run_id),
  CHECK (
    (canonical_message_thread_id IS NULL AND canonical_message_id IS NULL)
    OR (canonical_message_thread_id IS NOT NULL AND canonical_message_id IS NOT NULL)
  ),
  CHECK (
    (status = 'cancelled_unseen' AND budget_claim_state = 'released' AND cancelled_at IS NOT NULL)
    OR status != 'cancelled_unseen'
  )
);
CREATE INDEX IF NOT EXISTS idx_proactive_visits_owner_cat_status
  ON proactive_visits(owner_user_id, cat_id, status, created_at, visit_id);

CREATE TABLE IF NOT EXISTS foreground_visit_budget_days (
  owner_user_id TEXT NOT NULL,
  household_local_date TEXT NOT NULL,
  active_claims INTEGER NOT NULL DEFAULT 0 CHECK (active_claims >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_user_id, household_local_date)
);

CREATE TABLE IF NOT EXISTS foreground_visit_budget_claims (
  owner_user_id TEXT NOT NULL,
  household_local_date TEXT NOT NULL,
  visit_id TEXT NOT NULL UNIQUE REFERENCES proactive_visits(visit_id),
  state TEXT NOT NULL CHECK (state IN ('claimed', 'consumed', 'released')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  released_at INTEGER,
  PRIMARY KEY (owner_user_id, household_local_date, visit_id),
  CHECK (
    (state = 'released' AND released_at IS NOT NULL)
    OR (state != 'released' AND released_at IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_foreground_visit_budget_active
  ON foreground_visit_budget_claims(owner_user_id, household_local_date, state);

CREATE TABLE IF NOT EXISTS proactive_echoes (
  echo_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  cat_id TEXT NOT NULL,
  visit_id TEXT NOT NULL REFERENCES proactive_visits(visit_id),
  seed_id TEXT NOT NULL REFERENCES owned_seeds(seed_id),
  echo_kind TEXT NOT NULL CHECK (echo_kind IN ('natural_reply', 'seen', 'helpful', 'wrong', 'not_now', 'companion')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('typed', 'natural_reply')),
  client_event_id TEXT,
  source_thread_id TEXT,
  source_message_id TEXT,
  created_at INTEGER NOT NULL,
  CHECK (
    (source_kind = 'typed' AND client_event_id IS NOT NULL AND source_thread_id IS NULL AND source_message_id IS NULL)
    OR (source_kind = 'natural_reply' AND client_event_id IS NULL AND source_thread_id IS NOT NULL AND source_message_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_proactive_echoes_owner_cat_created
  ON proactive_echoes(owner_user_id, cat_id, created_at, echo_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_proactive_echoes_typed_source
  ON proactive_echoes(owner_user_id, client_event_id) WHERE source_kind = 'typed';
CREATE UNIQUE INDEX IF NOT EXISTS idx_proactive_echoes_natural_source
  ON proactive_echoes(owner_user_id, source_thread_id, source_message_id) WHERE source_kind = 'natural_reply';
`;
