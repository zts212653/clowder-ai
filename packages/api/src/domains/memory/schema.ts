// F102: SQLite schema — evidence_docs + evidence_fts + edges + markers + schema_version
// Phase C adds: embedding_meta (V2) + evidence_vectors (vec0, decoupled)

import type Database from 'better-sqlite3';

export const PRAGMA_SETUP = `
PRAGMA journal_mode = WAL;
PRAGMA journal_size_limit = 67108864;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`;

export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS evidence_docs (
  anchor TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  keywords TEXT,
  source_path TEXT,
  source_hash TEXT,
  superseded_by TEXT,
  materialized_from TEXT,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(
  title, summary,
  content=evidence_docs, content_rowid=rowid
);

CREATE TABLE IF NOT EXISTS edges (
  from_anchor TEXT NOT NULL,
  to_anchor TEXT NOT NULL,
  relation TEXT NOT NULL,
  PRIMARY KEY (from_anchor, to_anchor, relation)
);

CREATE TABLE IF NOT EXISTS markers (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT DEFAULT 'captured',
  target_kind TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`;

// FTS5 external-content sync triggers — must be executed one statement at a time
export const FTS_TRIGGER_STATEMENTS = [
  `CREATE TRIGGER IF NOT EXISTS evidence_docs_ai AFTER INSERT ON evidence_docs BEGIN
  INSERT INTO evidence_fts(rowid, title, summary) VALUES (new.rowid, new.title, new.summary);
END`,
  `CREATE TRIGGER IF NOT EXISTS evidence_docs_ad AFTER DELETE ON evidence_docs BEGIN
  INSERT INTO evidence_fts(evidence_fts, rowid, title, summary) VALUES ('delete', old.rowid, old.title, old.summary);
END`,
  `CREATE TRIGGER IF NOT EXISTS evidence_docs_au AFTER UPDATE ON evidence_docs BEGIN
  INSERT INTO evidence_fts(evidence_fts, rowid, title, summary) VALUES ('delete', old.rowid, old.title, old.summary);
  INSERT INTO evidence_fts(rowid, title, summary) VALUES (new.rowid, new.title, new.summary);
END`,
];

export const CURRENT_SCHEMA_VERSION = 23;

// F163 Phase A: experiment infrastructure tables (cohorts, suggestions, logs)
export const SCHEMA_V13_TABLES = `
CREATE TABLE IF NOT EXISTS f163_cohorts (
  thread_id TEXT PRIMARY KEY,
  variant_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS f163_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  capability TEXT NOT NULL,
  target_anchor TEXT NOT NULL,
  action TEXT NOT NULL,
  payload TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS f163_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  log_type TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  effective_flags TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_f163_logs_type ON f163_logs(log_type);
CREATE INDEX IF NOT EXISTS idx_f163_logs_variant ON f163_logs(variant_id);
`;

// Phase C: embedding metadata (model/dim version anchor)
export const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS embedding_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Phase E: evidence_passages table (per-message granularity)
export const SCHEMA_V3_TABLE = `
CREATE TABLE IF NOT EXISTS evidence_passages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_anchor TEXT NOT NULL,
  passage_id TEXT NOT NULL,
  content TEXT NOT NULL,
  speaker TEXT,
  position INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(doc_anchor, passage_id)
);
`;

// Phase E: passage_fts virtual table — executed separately (tokenchars needs careful quoting)
export const SCHEMA_V3_FTS =
  'CREATE VIRTUAL TABLE IF NOT EXISTS passage_fts USING fts5(content, content=evidence_passages, content_rowid=rowid, tokenize="unicode61 tokenchars \'_-\'")';

// FTS5 external-content sync triggers for passage_fts — executed one statement at a time
export const PASSAGE_FTS_TRIGGER_STATEMENTS = [
  `CREATE TRIGGER IF NOT EXISTS evidence_passages_ai AFTER INSERT ON evidence_passages BEGIN
  INSERT INTO passage_fts(rowid, content) VALUES (new.rowid, new.content);
END`,
  `CREATE TRIGGER IF NOT EXISTS evidence_passages_ad AFTER DELETE ON evidence_passages BEGIN
  INSERT INTO passage_fts(passage_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END`,
  `CREATE TRIGGER IF NOT EXISTS evidence_passages_au AFTER UPDATE ON evidence_passages BEGIN
  INSERT INTO passage_fts(passage_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO passage_fts(rowid, content) VALUES (new.rowid, new.content);
END`,
];

// Phase G: summary_segments (append-only ledger) + summary_state (watermark)
export const SCHEMA_V4 = `
CREATE TABLE IF NOT EXISTS summary_segments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  from_message_id TEXT NOT NULL,
  to_message_id TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  summary TEXT NOT NULL,
  topic_key TEXT NOT NULL,
  topic_label TEXT NOT NULL,
  boundary_reason TEXT,
  boundary_confidence TEXT DEFAULT 'medium',
  related_segment_ids TEXT,
  candidates TEXT,
  supersedes_segment_ids TEXT,
  model_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  generated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_segments_thread ON summary_segments(thread_id);
CREATE INDEX IF NOT EXISTS idx_segments_thread_level ON summary_segments(thread_id, level);
CREATE INDEX IF NOT EXISTS idx_segments_topic ON summary_segments(topic_key);

CREATE TABLE IF NOT EXISTS summary_state (
  thread_id TEXT PRIMARY KEY,
  last_summarized_message_id TEXT,
  pending_message_count INTEGER NOT NULL DEFAULT 0,
  pending_token_count INTEGER NOT NULL DEFAULT 0,
  pending_signal_flags INTEGER NOT NULL DEFAULT 0,
  carry_over INTEGER NOT NULL DEFAULT 0,
  summary_type TEXT NOT NULL DEFAULT 'concat',
  last_abstractive_at TEXT,
  abstractive_token_count INTEGER
);
`;

// F139 Phase 1a: task run ledger
export const SCHEMA_V5 = `
CREATE TABLE IF NOT EXISTS task_run_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  outcome TEXT NOT NULL,
  signal_summary TEXT,
  duration_ms INTEGER NOT NULL,
  started_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_ledger_task ON task_run_ledger(task_id);
CREATE INDEX IF NOT EXISTS idx_run_ledger_subject ON task_run_ledger(subject_key);
`;

// F129 Phase A: pack-scoped knowledge isolation
export const SCHEMA_V6 = `
ALTER TABLE evidence_docs ADD COLUMN pack_id TEXT;
CREATE INDEX IF NOT EXISTS idx_evidence_docs_pack ON evidence_docs(pack_id);
`;

// F139 Phase 1b: actor receipt tracking
export const SCHEMA_V7 = `
ALTER TABLE task_run_ledger ADD COLUMN assigned_cat_id TEXT;
`;

// F139 Phase 3A: dynamic task definitions + error tracking
export const SCHEMA_V8_DYNAMIC_TASKS = `
CREATE TABLE IF NOT EXISTS dynamic_task_defs (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  trigger_json TEXT NOT NULL,
  params_json TEXT NOT NULL,
  display_json TEXT NOT NULL,
  delivery_thread_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

/**
 * Apply all schema migrations up to CURRENT_SCHEMA_VERSION.
 * Safe to call on empty DB (creates schema_version table first).
 * Idempotent — skips already-applied versions.
 */
export function applyMigrations(db: Database.Database): void {
  // P1 fix (codex review R2): schema_version may not exist on empty DB.
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const currentVersion =
    (db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null })?.v ?? 0;

  if (currentVersion < 1) {
    db.exec(SCHEMA_V1);
    for (const stmt of FTS_TRIGGER_STATEMENTS) db.exec(stmt);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
  }

  if (currentVersion < 2) {
    db.exec(SCHEMA_V2);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(2, new Date().toISOString());
  }

  if (currentVersion < 3) {
    db.exec(SCHEMA_V3_TABLE);
    db.exec(SCHEMA_V3_FTS);
    for (const stmt of PASSAGE_FTS_TRIGGER_STATEMENTS) db.exec(stmt);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(3, new Date().toISOString());
  }

  if (currentVersion < 4) {
    db.exec(SCHEMA_V4);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(4, new Date().toISOString());
  }

  if (currentVersion < 5) {
    db.exec(SCHEMA_V5);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(5, new Date().toISOString());
  }

  if (currentVersion < 6) {
    // ALTER TABLE cannot be combined; execute each statement separately
    try {
      db.exec('ALTER TABLE evidence_docs ADD COLUMN pack_id TEXT');
    } catch {
      // Column may already exist from a partial migration
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_evidence_docs_pack ON evidence_docs(pack_id)');
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(6, new Date().toISOString());
  }

  if (currentVersion < 7) {
    db.exec(SCHEMA_V7);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(7, new Date().toISOString());
  }

  if (currentVersion < 8) {
    db.exec(SCHEMA_V8_DYNAMIC_TASKS);
    try {
      db.exec('ALTER TABLE task_run_ledger ADD COLUMN error_summary TEXT');
    } catch {
      // Column may already exist from a partial migration
    }
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(8, new Date().toISOString());
  }

  if (currentVersion < 9) {
    // F139 Phase 3B: governance (global control + task overrides) + emissions + pack templates
    db.exec(`
      CREATE TABLE IF NOT EXISTS scheduler_global_control (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 1,
        reason TEXT,
        updated_by TEXT NOT NULL DEFAULT 'system',
        updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO scheduler_global_control (id, enabled, updated_by, updated_at)
        VALUES (1, 1, 'system', datetime('now'));
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS scheduler_task_overrides (
        task_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS scheduler_emissions (
        emission_id TEXT PRIMARY KEY,
        origin_task_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        suppression_until TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_emissions_thread
        ON scheduler_emissions(thread_id, suppression_until);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS pack_template_defs (
        template_id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        label TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL,
        subject_kind TEXT NOT NULL,
        default_trigger_json TEXT NOT NULL,
        param_schema_json TEXT NOT NULL,
        builtin_template_ref TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pack_templates_pack
        ON pack_template_defs(pack_id);
    `);

    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(9, new Date().toISOString());
  }

  if (currentVersion < 10) {
    // F152 Phase A: provenance tracking for scanner-produced evidence
    try {
      db.exec('ALTER TABLE evidence_docs ADD COLUMN provenance_tier TEXT');
    } catch {
      // Column may already exist from a partial migration
    }
    try {
      db.exec('ALTER TABLE evidence_docs ADD COLUMN provenance_source TEXT');
    } catch {
      // Column may already exist from a partial migration
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_evidence_docs_provenance ON evidence_docs(provenance_tier)');
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(10, new Date().toISOString());
  }

  if (currentVersion < 11) {
    // F152 Phase B: expedition bootstrap state machine
    db.exec(`
      CREATE TABLE IF NOT EXISTS index_state (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'missing'
          CHECK(status IN ('missing', 'stale', 'building', 'ready', 'failed')),
        fingerprint TEXT NOT NULL DEFAULT '',
        last_scan_at TEXT,
        snoozed_until TEXT,
        docs_indexed INTEGER DEFAULT 0,
        docs_total INTEGER DEFAULT 0,
        error_message TEXT,
        summary_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_index_state_project ON index_state(project_path);
    `);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(11, new Date().toISOString());
  }

  if (currentVersion < 12) {
    // F152 Phase C: generalizable flag for global lesson distillation
    try {
      db.exec('ALTER TABLE evidence_docs ADD COLUMN generalizable INTEGER DEFAULT NULL');
    } catch {
      // Column may already exist from a partial migration
    }
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(12, new Date().toISOString());
  }

  if (currentVersion < 13) {
    // F163 Phase A: multi-axis metadata + experiment infrastructure
    try {
      db.exec("ALTER TABLE evidence_docs ADD COLUMN authority TEXT DEFAULT 'observed'");
    } catch {
      // Column may already exist from a partial migration
    }
    try {
      db.exec("ALTER TABLE evidence_docs ADD COLUMN activation TEXT DEFAULT 'query'");
    } catch {
      // Column may already exist from a partial migration
    }
    try {
      db.exec('ALTER TABLE evidence_docs ADD COLUMN verified_at TEXT');
    } catch {
      // Column may already exist from a partial migration
    }
    db.exec(SCHEMA_V13_TABLES);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(13, new Date().toISOString());
  }

  if (currentVersion < 14) {
    // F163 Phase B: non-replacement compression columns
    try {
      db.exec('ALTER TABLE evidence_docs ADD COLUMN source_ids TEXT');
    } catch {
      // Column may already exist from a partial migration
    }
    try {
      db.exec('ALTER TABLE evidence_docs ADD COLUMN summary_of_anchor TEXT');
    } catch {
      // Column may already exist from a partial migration
    }
    try {
      db.exec('ALTER TABLE evidence_docs ADD COLUMN compression_rationale TEXT');
    } catch {
      // Column may already exist from a partial migration
    }
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(14, new Date().toISOString());
  }

  if (currentVersion < 15) {
    try {
      db.exec('ALTER TABLE evidence_docs ADD COLUMN contradicts TEXT');
    } catch {
      // Column may already exist from a partial migration
    }
    try {
      db.exec('ALTER TABLE evidence_docs ADD COLUMN invalid_at TEXT');
    } catch {
      // Column may already exist from a partial migration
    }
    try {
      db.exec('ALTER TABLE evidence_docs ADD COLUMN review_cycle_days INTEGER');
    } catch {
      // Column may already exist from a partial migration
    }
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(15, new Date().toISOString());
  }

  // V16: F093 world scope — world_id / scene_id on evidence_docs for world-scoped recall
  if (currentVersion < 16) {
    try {
      db.exec('ALTER TABLE evidence_docs ADD COLUMN world_id TEXT');
    } catch {
      // Column may already exist from a partial migration
    }
    try {
      db.exec('ALTER TABLE evidence_docs ADD COLUMN scene_id TEXT');
    } catch {
      // Column may already exist from a partial migration
    }
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_evidence_docs_world ON evidence_docs(world_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_evidence_docs_world_scene ON evidence_docs(world_id, scene_id)');
    } catch {
      // Indexes may already exist
    }
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(16, new Date().toISOString());
  }

  // V17: F186 Phase A — collection-aware columns + marker routing
  if (currentVersion < 17) {
    try {
      db.exec('ALTER TABLE evidence_docs ADD COLUMN collection_id TEXT');
    } catch {}
    try {
      db.exec('ALTER TABLE evidence_docs ADD COLUMN review_status TEXT');
    } catch {}
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_evidence_docs_collection ON evidence_docs(collection_id)');
    } catch {}
    try {
      db.exec('ALTER TABLE markers ADD COLUMN source_collection_id TEXT');
    } catch {}
    try {
      db.exec('ALTER TABLE markers ADD COLUMN source_sensitivity TEXT');
    } catch {}
    try {
      db.exec('ALTER TABLE markers ADD COLUMN target_collection_id TEXT');
    } catch {}
    try {
      db.exec('ALTER TABLE markers ADD COLUMN promote_review_status TEXT');
    } catch {}
    try {
      db.exec('ALTER TABLE markers ADD COLUMN secret_scan_fingerprint TEXT');
    } catch {}
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(17, new Date().toISOString());
  }

  // V18: F186 Phase F — extended edges with collection/sensitivity/provenance
  if (currentVersion < 18) {
    try {
      db.exec('ALTER TABLE edges ADD COLUMN from_collection_id TEXT');
    } catch {}
    try {
      db.exec('ALTER TABLE edges ADD COLUMN to_collection_id TEXT');
    } catch {}
    try {
      db.exec('ALTER TABLE edges ADD COLUMN edge_sensitivity TEXT');
    } catch {}
    try {
      db.exec('ALTER TABLE edges ADD COLUMN provenance TEXT');
    } catch {}
    try {
      db.exec('ALTER TABLE edges ADD COLUMN created_at TEXT');
    } catch {}
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(18, new Date().toISOString());
  }

  // V19: F200 Phase A — recall_events table + edge traversal columns
  if (currentVersion < 19) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS recall_events (
          recall_id TEXT PRIMARY KEY,
          cat_id TEXT NOT NULL,
          invocation_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          query TEXT NOT NULL,
          mode TEXT,
          scope TEXT,
          candidates_json TEXT NOT NULL,
          consumed_json TEXT NOT NULL,
          reformulated INTEGER NOT NULL DEFAULT 0,
          fell_back_to_grep INTEGER NOT NULL DEFAULT 0,
          abandoned INTEGER NOT NULL DEFAULT 0,
          next_graph_resolve_after_read INTEGER NOT NULL DEFAULT 0,
          token_cost INTEGER NOT NULL DEFAULT 0,
          timestamp INTEGER NOT NULL
        )
      `);
    } catch {}
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_recall_events_cat ON recall_events(cat_id)');
    } catch {}
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_recall_events_ts ON recall_events(timestamp)');
    } catch {}
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_recall_events_inv ON recall_events(invocation_id)');
    } catch {}
    try {
      db.exec('ALTER TABLE edges ADD COLUMN traversal_count INTEGER DEFAULT 0');
    } catch {}
    try {
      db.exec('ALTER TABLE edges ADD COLUMN last_traversed_at TEXT');
    } catch {}
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(19, new Date().toISOString());
  }

  // V20: F200 Phase B — anchor_recall_metrics table for popularity/dormancy
  if (currentVersion < 20) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS anchor_recall_metrics (
          anchor TEXT PRIMARY KEY,
          consumed_count_30d INTEGER NOT NULL DEFAULT 0,
          exposure_count_30d INTEGER NOT NULL DEFAULT 0,
          last_consumed_at TEXT,
          dormancy_days INTEGER,
          updated_at TEXT NOT NULL
        )
      `);
    } catch {}
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_anchor_metrics_dormancy ON anchor_recall_metrics(dormancy_days)');
    } catch {}
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(20, new Date().toISOString());
  }

  // V21: F200 Phase C — global CTR baseline + first_indexed_at + shadow ranking
  if (currentVersion < 21) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS global_ctr_baseline (
          doc_kind TEXT PRIMARY KEY,
          mean_ctr REAL NOT NULL DEFAULT 0.2,
          sample_count INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL DEFAULT 0
        )
      `);
    } catch {}
    try {
      db.exec('ALTER TABLE evidence_docs ADD COLUMN first_indexed_at INTEGER NOT NULL DEFAULT 0');
    } catch {}
    try {
      db.exec('ALTER TABLE recall_events ADD COLUMN shadow_ranking_json TEXT');
    } catch {}
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(21, new Date().toISOString());
  }

  // V22: F200 Phase D — task trajectories
  if (currentVersion < 22) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_trajectories (
          trajectory_id TEXT PRIMARY KEY,
          invocation_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          cat_id TEXT NOT NULL,
          task_context TEXT,
          search_event_ids_json TEXT NOT NULL DEFAULT '[]',
          files_read_json TEXT NOT NULL DEFAULT '[]',
          files_modified_json TEXT NOT NULL DEFAULT '[]',
          output_verified INTEGER NOT NULL DEFAULT 0,
          output_verified_signals_json TEXT NOT NULL DEFAULT '[]',
          total_token_cost INTEGER NOT NULL DEFAULT 0,
          duration INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
    } catch {}
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_trajectories_inv ON task_trajectories(invocation_id)');
    } catch {}
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_trajectories_thread ON task_trajectories(thread_id)');
    } catch {}
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_trajectories_cat ON task_trajectories(cat_id)');
    } catch {}
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_trajectories_verified ON task_trajectories(output_verified)');
    } catch {}
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(22, new Date().toISOString());
  }

  // V23: F200 HW-4 根因③ — ambiguity-aware attribution (砚砚 audit Round 1
  // Result 3): bundle id for same-invocation search groups + clean/ambiguous
  // attribution clarity. Per-consumed provenance lives in consumed_json.
  if (currentVersion < 23) {
    try {
      db.exec('ALTER TABLE recall_events ADD COLUMN result_set_id TEXT');
    } catch {}
    try {
      db.exec('ALTER TABLE recall_events ADD COLUMN attribution_clarity TEXT');
    } catch {}
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(23, new Date().toISOString());
  }
}

/**
 * Ensure vec0 virtual table exists — called separately from migration.
 * Requires sqlite-vec extension to be loaded first.
 * Safe to call multiple times (IF NOT EXISTS).
 * Returns true if table was created/exists, false if extension unavailable.
 */
export function ensureVectorTable(db: Database.Database, dim: number): boolean {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS evidence_vectors USING vec0(
        anchor TEXT PRIMARY KEY,
        embedding float[${dim}]
      )
    `);
    return true;
  } catch {
    return false; // sqlite-vec not loaded — fail-open
  }
}
