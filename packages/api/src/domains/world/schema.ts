import type Database from 'better-sqlite3';

export const CURRENT_SCHEMA_VERSION = 1;

export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS worlds (
  world_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  constitution TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  thread_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS world_characters (
  character_id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(world_id),
  core_identity TEXT NOT NULL,
  inner_drive TEXT NOT NULL,
  relationship_tension TEXT NOT NULL,
  voice_and_image TEXT NOT NULL,
  growth_state TEXT NOT NULL,
  mask_overlay TEXT,
  base_cat_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_world_characters_world ON world_characters(world_id);

CREATE TABLE IF NOT EXISTS world_scenes (
  scene_id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(world_id),
  name TEXT NOT NULL,
  description TEXT,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  active_character_ids TEXT NOT NULL DEFAULT '[]',
  setting TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_world_scenes_world ON world_scenes(world_id);

CREATE TABLE IF NOT EXISTS canon_promotion_records (
  record_id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(world_id),
  scene_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  summary TEXT NOT NULL,
  category TEXT,
  proposed_by TEXT NOT NULL,
  decided_by TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_canon_world ON canon_promotion_records(world_id);
CREATE INDEX IF NOT EXISTS idx_canon_status ON canon_promotion_records(world_id, status);

CREATE TABLE IF NOT EXISTS world_event_log (
  event_id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(world_id),
  scene_id TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  character_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  canon_record_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_world_scene ON world_event_log(world_id, scene_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON world_event_log(world_id, scene_id, created_at);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`;

export function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const currentVersion =
    (db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null })?.v ?? 0;

  if (currentVersion < 1) {
    db.exec(SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
  }
}
