import type Database from 'better-sqlite3';
import { PROACTIVE_RELATIONSHIP_SCHEMA } from './proactive-schema.js';

export const AUTO_DREAM_SCHEMA_VERSION = 4;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS auto_dream_schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS present_loop_runs (
  run_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  cat_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('awakened', 'settled', 'wake_failed', 'wake_expired')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('diary', 'quiet', 'daze')),
  scheduled_at INTEGER,
  fired_at INTEGER NOT NULL,
  lateness_ms INTEGER NOT NULL DEFAULT 0,
  missed_slots INTEGER NOT NULL DEFAULT 0,
  settlement_invocation_id TEXT,
  settlement_hash TEXT,
  diary_id TEXT,
  sleep_posture_id TEXT,
  continuity_posture_id TEXT,
  failure_reason TEXT,
  awakened_at INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  settled_at INTEGER,
  failed_at INTEGER,
  expired_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (owner_user_id, task_id, scheduled_at),
  CHECK (
    (state = 'awakened' AND outcome IS NULL AND settled_at IS NULL AND failed_at IS NULL AND expired_at IS NULL)
    OR (state = 'settled' AND outcome IS NOT NULL AND settled_at IS NOT NULL AND failed_at IS NULL AND expired_at IS NULL)
    OR (state = 'wake_failed' AND outcome IS NULL AND failed_at IS NOT NULL AND expired_at IS NULL)
    OR (state = 'wake_expired' AND outcome IS NULL AND failed_at IS NULL AND expired_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_present_loop_runs_owner_cat_state
  ON present_loop_runs(owner_user_id, cat_id, state, awakened_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_present_loop_one_awakened
  ON present_loop_runs(owner_user_id, cat_id) WHERE state = 'awakened';

CREATE TABLE IF NOT EXISTS dream_diary_entries (
  diary_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  dream_run_id TEXT NOT NULL REFERENCES present_loop_runs(run_id),
  cat_id TEXT NOT NULL,
  local_date TEXT NOT NULL,
  written_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('published', 'archived')),
  doc_kind TEXT NOT NULL DEFAULT 'diary' CHECK (doc_kind = 'diary'),
  entry_kind TEXT NOT NULL CHECK (entry_kind IN ('evidence', 'souvenir')),
  trace_kind TEXT NOT NULL CHECK (trace_kind IN ('work', 'non_work', 'mixed')),
  tense_marker TEXT NOT NULL DEFAULT 'historical' CHECK (tense_marker = 'historical'),
  volume_no INTEGER NOT NULL DEFAULT 1 CHECK (volume_no > 0),
  headline TEXT NOT NULL,
  summary TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  observations_json TEXT NOT NULL DEFAULT '[]',
  produced_actions_json TEXT NOT NULL DEFAULT '{}',
  created_by_invocation_id TEXT NOT NULL,
  source_thread_id TEXT NOT NULL,
  source_message_id TEXT,
  archived_at INTEGER,
  sealed_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (owner_user_id, dream_run_id)
);
CREATE INDEX IF NOT EXISTS idx_dream_diary_owner_written
  ON dream_diary_entries(owner_user_id, written_at DESC);
CREATE INDEX IF NOT EXISTS idx_dream_diary_owner_cat_written
  ON dream_diary_entries(owner_user_id, cat_id, written_at DESC);

CREATE TABLE IF NOT EXISTS dream_diary_citations (
  citation_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  from_diary_id TEXT NOT NULL REFERENCES dream_diary_entries(diary_id),
  to_kind TEXT NOT NULL,
  to_ref_id TEXT NOT NULL,
  resolver_json TEXT NOT NULL,
  cited_at INTEGER NOT NULL,
  UNIQUE (owner_user_id, from_diary_id, to_kind, to_ref_id)
);
CREATE INDEX IF NOT EXISTS idx_dream_diary_citations_target
  ON dream_diary_citations(owner_user_id, to_kind, to_ref_id);

CREATE TABLE IF NOT EXISTS sleep_postures (
  posture_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  cat_id TEXT NOT NULL,
  source_run_id TEXT NOT NULL REFERENCES present_loop_runs(run_id),
  author_invocation_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'archived')),
  consumed_by_run_id TEXT REFERENCES present_loop_runs(run_id),
  consumed_at INTEGER,
  archived_at INTEGER,
  archive_reason TEXT CHECK (archive_reason IS NULL OR archive_reason IN ('consumed', 'superseded')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (status = 'pending' AND consumed_by_run_id IS NULL AND consumed_at IS NULL
      AND archived_at IS NULL AND archive_reason IS NULL)
    OR (status = 'archived' AND archived_at IS NOT NULL AND archive_reason IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sleep_posture_one_pending
  ON sleep_postures(owner_user_id, cat_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_sleep_posture_history
  ON sleep_postures(owner_user_id, cat_id, created_at DESC);

CREATE TABLE IF NOT EXISTS auto_dream_events (
  event_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  cat_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES present_loop_runs(run_id),
  event_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auto_dream_events_owner_cat
  ON auto_dream_events(owner_user_id, cat_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dream_projection_state (
  owner_user_id TEXT NOT NULL,
  diary_id TEXT NOT NULL REFERENCES dream_diary_entries(diary_id),
  product_revision INTEGER NOT NULL,
  projected_revision INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_attempt_at INTEGER,
  projected_at INTEGER,
  PRIMARY KEY (owner_user_id, diary_id)
);
`;

const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS cat_life_configs (
  owner_user_id TEXT NOT NULL,
  cat_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  settings_json TEXT NOT NULL,
  derived_json TEXT NOT NULL,
  bedroom_thread_id TEXT NOT NULL,
  projection_task_id TEXT NOT NULL,
  projection_status TEXT NOT NULL CHECK (projection_status IN ('pending', 'ready', 'error')),
  projection_error TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_user_id, cat_id)
);

CREATE TABLE IF NOT EXISTS cat_life_previews (
  preview_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  cat_id TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  derived_json TEXT NOT NULL,
  bedroom_thread_id TEXT NOT NULL,
  projection_task_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('rendered', 'confirmed', 'cancelled', 'expired')),
  expires_at INTEGER NOT NULL,
  decision_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cat_life_previews_owner_cat
  ON cat_life_previews(owner_user_id, cat_id, created_at DESC);

CREATE TABLE IF NOT EXISTS diary_engagement_events (
  engagement_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  diary_id TEXT NOT NULL REFERENCES dream_diary_entries(diary_id),
  cat_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('open', 'reaction')),
  client_event_id TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL,
  UNIQUE (owner_user_id, diary_id, kind, client_event_id),
  CHECK (kind = 'reaction' OR active = 1)
);
CREATE INDEX IF NOT EXISTS idx_diary_engagement_owner_cat
  ON diary_engagement_events(owner_user_id, cat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_diary_engagement_owner_diary
  ON diary_engagement_events(owner_user_id, diary_id, created_at DESC);
`;

const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS private_cues (
  cue_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  cat_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'desire_cue'),
  normalized_claim TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_ref_json TEXT NOT NULL,
  producer TEXT NOT NULL CHECK (producer = 'f271-session-close-v1'),
  source_output_id TEXT NOT NULL,
  source_created_at TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'adopted', 'rejected')),
  decided_by_run_id TEXT REFERENCES present_loop_runs(run_id),
  owned_seed_id TEXT,
  decided_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (owner_user_id, producer, source_output_id),
  CHECK (
    (status = 'pending' AND decided_by_run_id IS NULL AND owned_seed_id IS NULL AND decided_at IS NULL)
    OR (status = 'adopted' AND decided_by_run_id IS NOT NULL AND owned_seed_id IS NOT NULL AND decided_at IS NOT NULL)
    OR (status = 'rejected' AND decided_by_run_id IS NOT NULL AND owned_seed_id IS NULL AND decided_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_private_cues_owner_cat_status
  ON private_cues(owner_user_id, cat_id, status, created_at, cue_id);

CREATE TABLE IF NOT EXISTS owned_seeds (
  seed_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  cat_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('cue', 'originated')),
  source_cue_id TEXT UNIQUE REFERENCES private_cues(cue_id),
  claim TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('owned', 'dormant', 'retired')),
  source_run_id TEXT NOT NULL REFERENCES present_loop_runs(run_id),
  created_by_invocation_id TEXT NOT NULL,
  dormant_at INTEGER,
  retired_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (owner_user_id, source_run_id),
  CHECK (
    (source_kind = 'cue' AND source_cue_id IS NOT NULL)
    OR (source_kind = 'originated' AND source_cue_id IS NULL)
  ),
  CHECK (
    (status = 'owned' AND dormant_at IS NULL AND retired_at IS NULL)
    OR (status = 'dormant' AND dormant_at IS NOT NULL AND retired_at IS NULL)
    OR (status = 'retired' AND retired_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_owned_seeds_owner_cat_status
  ON owned_seeds(owner_user_id, cat_id, status, created_at, seed_id);
`;

export function applyAutoDreamMigrations(db: Database.Database, now = Date.now()): void {
  db.exec(`CREATE TABLE IF NOT EXISTS auto_dream_schema_version (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);
  const currentVersion =
    (
      db.prepare('SELECT MAX(version) AS version FROM auto_dream_schema_version').get() as {
        version: number | null;
      }
    )?.version ?? 0;
  if (currentVersion < 1) {
    db.transaction(() => {
      db.exec(SCHEMA_V1);
      db.prepare('INSERT INTO auto_dream_schema_version (version, applied_at) VALUES (?, ?)').run(1, now);
    })();
  }
  if (currentVersion < 2) {
    db.transaction(() => {
      db.exec(SCHEMA_V2);
      db.prepare('INSERT INTO auto_dream_schema_version (version, applied_at) VALUES (?, ?)').run(2, now);
    })();
  }
  if (currentVersion < 3) {
    db.transaction(() => {
      db.exec(SCHEMA_V3);
      db.prepare('INSERT INTO auto_dream_schema_version (version, applied_at) VALUES (?, ?)').run(3, now);
    })();
  }
  if (currentVersion < 4) {
    db.transaction(() => {
      db.exec(PROACTIVE_RELATIONSHIP_SCHEMA);
      db.prepare('INSERT INTO auto_dream_schema_version (version, applied_at) VALUES (?, ?)').run(4, now);
    })();
  }
}
