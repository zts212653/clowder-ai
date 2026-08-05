// F102: SQLite schema — evidence_docs + evidence_fts + edges + markers + schema_version
// Phase C adds: embedding_meta (V2) + evidence_vectors (vec0, decoupled)

import type Database from 'better-sqlite3';

export const EVIDENCE_FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(
  title, summary, keywords,
  content=evidence_docs, content_rowid=rowid
);
`;

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

${EVIDENCE_FTS_SCHEMA}

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
  INSERT INTO evidence_fts(rowid, title, summary, keywords) VALUES (new.rowid, new.title, new.summary, new.keywords);
END`,
  `CREATE TRIGGER IF NOT EXISTS evidence_docs_ad AFTER DELETE ON evidence_docs BEGIN
  INSERT INTO evidence_fts(evidence_fts, rowid, title, summary, keywords) VALUES ('delete', old.rowid, old.title, old.summary, old.keywords);
END`,
  `CREATE TRIGGER IF NOT EXISTS evidence_docs_au AFTER UPDATE ON evidence_docs BEGIN
  INSERT INTO evidence_fts(evidence_fts, rowid, title, summary, keywords) VALUES ('delete', old.rowid, old.title, old.summary, old.keywords);
  INSERT INTO evidence_fts(rowid, title, summary, keywords) VALUES (new.rowid, new.title, new.summary, new.keywords);
END`,
];

export const CURRENT_SCHEMA_VERSION = 38;

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
          result_count INTEGER,
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

  // V24: F209 Phase B — entity registry, aliases, and mention index.
  if (currentVersion < 24) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS entity_registry (
          entity_id TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL,
          canonical_name TEXT NOT NULL,
          provenance_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
    } catch {}
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS entity_aliases (
          entity_id TEXT NOT NULL,
          alias TEXT NOT NULL,
          alias_norm TEXT NOT NULL,
          provenance_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (entity_id, alias_norm),
          FOREIGN KEY (entity_id) REFERENCES entity_registry(entity_id) ON DELETE CASCADE
        )
      `);
    } catch {}
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_entity_aliases_norm ON entity_aliases(alias_norm)');
    } catch {}
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS entity_mentions (
          entity_id TEXT NOT NULL,
          doc_anchor TEXT NOT NULL,
          passage_id TEXT NOT NULL DEFAULT '',
          surface TEXT NOT NULL,
          surface_norm TEXT NOT NULL,
          source TEXT NOT NULL,
          provenance_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (entity_id, doc_anchor, passage_id, surface_norm),
          FOREIGN KEY (entity_id) REFERENCES entity_registry(entity_id) ON DELETE CASCADE,
          FOREIGN KEY (doc_anchor) REFERENCES evidence_docs(anchor) ON DELETE CASCADE
        )
      `);
    } catch {}
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_entity_mentions_entity ON entity_mentions(entity_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_entity_mentions_doc ON entity_mentions(doc_anchor)');
    } catch {}
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(24, new Date().toISOString());
  }

  // V25: F102 bugfix — add thread_id to recall_events for RecallFeed history persistence
  if (currentVersion < 25) {
    try {
      db.exec("ALTER TABLE recall_events ADD COLUMN thread_id TEXT DEFAULT ''");
    } catch {}
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_recall_events_thread ON recall_events(thread_id)');
    } catch {}
    // Backfill: recover thread_id for existing recall_events via task_trajectories
    // (task_trajectories already stores thread_id ↔ invocation_id mapping from F200 Phase D)
    try {
      db.exec(`
        UPDATE recall_events SET thread_id = (
          SELECT t.thread_id FROM task_trajectories t
          WHERE t.invocation_id = recall_events.invocation_id
          LIMIT 1
        ) WHERE thread_id = '' AND EXISTS (
          SELECT 1 FROM task_trajectories t
          WHERE t.invocation_id = recall_events.invocation_id
        )
      `);
    } catch {}
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(25, new Date().toISOString());
  }

  // V26: RecallFeed history — preserve reported hit count separately from
  // candidates_json. Thread-scope search_evidence results can report Found N
  // without anchor candidate rows, so candidates_json.length is not resultCount.
  if (currentVersion < 26) {
    try {
      db.exec('ALTER TABLE recall_events ADD COLUMN result_count INTEGER');
    } catch {}
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(26, new Date().toISOString());
  }

  // V27: Recall result outcome status — producer/search side contract. Nullable
  // so pre-V27 rows stay distinguishable as legacy_unknown at read time.
  if (currentVersion < 27) {
    try {
      db.exec('ALTER TABLE recall_events ADD COLUMN result_status TEXT');
    } catch {}
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(27, new Date().toISOString());
  }

  // V28: include keywords in evidence_fts. Rebuild the external-content FTS table
  // because SQLite cannot ALTER an existing FTS5 table to add a column.
  if (currentVersion < 28) {
    db.transaction(() => {
      for (const trigger of ['evidence_docs_ai', 'evidence_docs_ad', 'evidence_docs_au']) {
        db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
      }
      db.exec('DROP TABLE IF EXISTS evidence_fts');
      db.exec(EVIDENCE_FTS_SCHEMA);
      for (const stmt of FTS_TRIGGER_STATEMENTS) db.exec(stmt);
      db.exec(`
        INSERT INTO evidence_fts(rowid, title, summary, keywords)
        SELECT rowid, title, summary, keywords FROM evidence_docs
      `);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(28, new Date().toISOString());
    })();
  }

  // V29: F139/F245 scheduler sleep-wake observability.
  if (currentVersion < 29) {
    for (const statement of [
      'ALTER TABLE task_run_ledger ADD COLUMN scheduled_at TEXT',
      'ALTER TABLE task_run_ledger ADD COLUMN fired_at TEXT',
      'ALTER TABLE task_run_ledger ADD COLUMN lateness_ms INTEGER',
      'ALTER TABLE task_run_ledger ADD COLUMN missed_slots INTEGER',
      'ALTER TABLE task_run_ledger ADD COLUMN trigger_kind TEXT',
      'ALTER TABLE task_run_ledger ADD COLUMN misfire_policy TEXT',
    ]) {
      try {
        db.exec(statement);
      } catch {
        // Column may already exist from a partial migration.
      }
    }
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(29, new Date().toISOString());
  }

  // V30: F260 Phase A — doc_aliases table (KD-5: separate from entity_registry)
  // + entity_registry extensions (stance, visibility_scope, status).
  if (currentVersion < 30) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS doc_aliases (
          alias_norm TEXT NOT NULL,
          alias TEXT NOT NULL,
          doc_anchor TEXT NOT NULL,
          source TEXT NOT NULL,
          authority_tier TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (alias_norm, doc_anchor)
        )
      `);
    } catch {}
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_doc_aliases_anchor ON doc_aliases(doc_anchor)');
    } catch {}
    for (const statement of [
      "ALTER TABLE entity_registry ADD COLUMN stance TEXT NOT NULL DEFAULT 'unknown'",
      "ALTER TABLE entity_registry ADD COLUMN visibility_scope TEXT NOT NULL DEFAULT 'workspace'",
      "ALTER TABLE entity_registry ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
    ]) {
      try {
        db.exec(statement);
      } catch {
        // Column may already exist from a partial migration.
      }
    }
    // F260 Phase A T4: clean existing dev/test entity pollution.
    // Conservative GLOB approximation of DEV_TEST_CAT_PATTERN from entity-seeds.ts.
    // GLOB is case-sensitive; catIds are lowercase by convention.
    // try/catch: entity_registry may not exist in minimal test fixtures (e.g. V28 FTS test).
    try {
      db.exec(`
        DELETE FROM entity_registry WHERE entity_type = 'cat' AND (
          entity_id GLOB 'cat:*-test' OR entity_id GLOB 'cat:*_test' OR
          entity_id GLOB 'cat:*-dev' OR entity_id GLOB 'cat:*_dev' OR
          entity_id GLOB 'cat:*-staging' OR entity_id GLOB 'cat:*_staging' OR
          entity_id GLOB 'cat:*-sandbox' OR entity_id GLOB 'cat:*_sandbox' OR
          entity_id GLOB 'cat:cat-[a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]' OR
          entity_id GLOB 'cat:cat-[a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]' OR
          entity_id GLOB 'cat:cat-[a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]'
        )
      `);
    } catch {
      // entity_registry may not exist (e.g. partial migration test fixtures)
    }

    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(30, new Date().toISOString());
  }

  // V31: F263 Phase B — unify pull and push recall behavior telemetry.
  if (currentVersion < 31) {
    for (const statement of [
      "ALTER TABLE recall_events ADD COLUMN source TEXT NOT NULL DEFAULT 'pull'",
      'ALTER TABLE recall_events ADD COLUMN push_surface TEXT',
      'ALTER TABLE recall_events ADD COLUMN presented INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE recall_events ADD COLUMN inspected INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE recall_events ADD COLUMN outcome TEXT',
    ]) {
      try {
        db.exec(statement);
      } catch {
        // Column may already exist from a partial migration.
      }
    }
    try {
      db.exec(`
        UPDATE recall_events
        SET inspected = CASE WHEN consumed_json <> '[]' THEN 1 ELSE 0 END,
            outcome = CASE WHEN consumed_json <> '[]' THEN 'used' ELSE 'ignored' END
        WHERE outcome IS NULL
      `);
    } catch {}
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_recall_events_source ON recall_events(source, push_surface)');
    } catch {}
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(31, new Date().toISOString());
  }

  // V32: F260 post-close stopgap — append-only entity registry revision ledger.
  // No foreign key on entity_id: retiring/deleting a current projection must not
  // erase the audit lineage that explains what previously existed.
  if (currentVersion < 32) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS entity_revision_events (
        revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('create', 'update')),
        before_json TEXT,
        after_json TEXT NOT NULL,
        source TEXT NOT NULL,
        actor_id TEXT,
        proposal_id TEXT,
        reason TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_entity_revision_events_entity_time
        ON entity_revision_events(entity_id, revision_id);
      CREATE TRIGGER IF NOT EXISTS entity_revision_events_no_update
      BEFORE UPDATE ON entity_revision_events
      BEGIN
        SELECT RAISE(ABORT, 'entity revision events are append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS entity_revision_events_no_delete
      BEFORE DELETE ON entity_revision_events
      BEGIN
        SELECT RAISE(ABORT, 'entity revision events are append-only');
      END;
    `);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(32, new Date().toISOString());
  }

  // V33: F263 Phase C — lifecycle trace substrate (append-only, shadow).
  // storable:false / indexable:false — these records MUST NOT enter
  // evidence/search/ranking. The table is the observation backbone
  // for harmful consumption, unmet demand, verification events, and
  // attention cost traces.
  if (currentVersion < 33) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS lifecycle_traces (
        trace_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        category TEXT,
        source_family TEXT NOT NULL,
        recall_id TEXT,
        thread_id TEXT,
        target_anchor TEXT,
        query_text TEXT,
        claim_kind TEXT,
        check_source TEXT,
        verdict TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        observed_at INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        -- P1 fix: stable idempotency key derived from source event identity.
        -- Preferred: _toolUseId (Claude API tool_use_id, unique per call).
        -- Fallback: invocationId:turnIndex (stable position in event array).
        -- Unlike recall_id (randomUUID() per correlateWindow() call), this is
        -- deterministic across retries of the same source event.
        source_event_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_lifecycle_traces_kind
        ON lifecycle_traces(kind, observed_at);
      CREATE INDEX IF NOT EXISTS idx_lifecycle_traces_category
        ON lifecycle_traces(kind, category, observed_at);
      CREATE INDEX IF NOT EXISTS idx_lifecycle_traces_source
        ON lifecycle_traces(source_family, observed_at);
      CREATE INDEX IF NOT EXISTS idx_lifecycle_traces_recall
        ON lifecycle_traces(recall_id);
      CREATE INDEX IF NOT EXISTS idx_lifecycle_traces_target
        ON lifecycle_traces(target_anchor);
      CREATE INDEX IF NOT EXISTS idx_lifecycle_traces_thread
        ON lifecycle_traces(thread_id, observed_at);
      -- P1 fix: idempotency — prevent duplicate traces from retry paths.
      -- Keyed on source_event_id (stable across retries) instead of
      -- recall_id (unstable — new randomUUID() each correlateWindow() call).
      CREATE UNIQUE INDEX IF NOT EXISTS idx_lifecycle_traces_source_event_dedup
        ON lifecycle_traces(source_event_id, kind) WHERE source_event_id IS NOT NULL;

      -- Append-only enforcement: shadow data must never be mutated or deleted.
      CREATE TRIGGER IF NOT EXISTS lifecycle_traces_no_update
      BEFORE UPDATE ON lifecycle_traces
      BEGIN
        SELECT RAISE(ABORT, 'lifecycle traces are append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS lifecycle_traces_no_delete
      BEFORE DELETE ON lifecycle_traces
      BEGIN
        SELECT RAISE(ABORT, 'lifecycle traces are append-only');
      END;
    `);

    // P1 fix: add source_event_id to recall_events for retry idempotency.
    // RecallEventCorrelator generates randomUUID() recallIds each call, so the
    // PK-based INSERT OR IGNORE doesn't prevent duplicates on retry. Adding a
    // stable source_event_id (from _toolUseId or invocationId:turnIndex) lets
    // the same INSERT OR IGNORE deduplicate recall_events AND lifecycle_traces.
    try {
      db.exec('ALTER TABLE recall_events ADD COLUMN source_event_id TEXT');
    } catch {
      // Column may already exist (idempotent migration)
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_recall_events_source_event_dedup
        ON recall_events(source_event_id) WHERE source_event_id IS NOT NULL
    `);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(33, new Date().toISOString());
  }

  // V34: F271 Phase A — persistent reflection supply ledger + private-cue outbox.
  if (currentVersion < 34) {
    const evidenceColumns = db.prepare('PRAGMA table_info(evidence_docs)').all() as Array<{ name: string }>;
    if (!evidenceColumns.some((column) => column.name === 'drill_down_json')) {
      db.exec('ALTER TABLE evidence_docs ADD COLUMN drill_down_json TEXT');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS reflection_outputs (
        output_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        household_local_date TEXT NOT NULL,
        cat_id TEXT NOT NULL,
        source_ref_json TEXT NOT NULL,
        output_kind TEXT NOT NULL CHECK (
          output_kind IN ('decision', 'correction', 'identity_relationship', 'open_loop', 'desire_cue')
        ),
        normalized_claim TEXT,
        reason TEXT,
        claim_fingerprint TEXT NOT NULL CHECK (length(claim_fingerprint) = 64),
        destination TEXT NOT NULL CHECK (destination IN ('public_evidence', 'f255_private_cue')),
        projection_state TEXT NOT NULL CHECK (projection_state IN ('pending', 'delivered')),
        projection_ref TEXT,
        producer TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        CHECK (
          (destination = 'public_evidence' AND normalized_claim IS NOT NULL AND reason IS NOT NULL)
          OR
          (destination = 'f255_private_cue' AND (
            (projection_state = 'pending' AND normalized_claim IS NOT NULL AND reason IS NOT NULL)
            OR
            (projection_state = 'delivered' AND normalized_claim IS NULL AND reason IS NULL)
          ))
        ),
        UNIQUE (owner_user_id, cat_id, destination, output_kind, claim_fingerprint)
      );
      CREATE INDEX IF NOT EXISTS idx_reflection_outputs_owner_day
        ON reflection_outputs(owner_user_id, household_local_date);
      CREATE INDEX IF NOT EXISTS idx_reflection_outputs_pending_cues
        ON reflection_outputs(owner_user_id, cat_id, projection_state, destination, created_at);
    `);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(34, new Date().toISOString());
  }

  // V35: F246 Phase I Wave 1 — durable F139 proposals, effect checkpoints and direct mutation audit.
  if (currentVersion < 35) {
    db.exec(`
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
    `);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(35, new Date().toISOString());
  }

  // V36: F192 — origin column on f163_logs to distinguish user vs eval/diagnostic searches.
  // Eval cron reprobes contaminate f188 health metrics when mixed with real user searches.
  if (currentVersion < 36) {
    try {
      db.exec("ALTER TABLE f163_logs ADD COLUMN origin TEXT DEFAULT 'user'");
    } catch {
      // Column may already exist from a partial migration
    }
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_f163_logs_origin ON f163_logs(log_type, origin)');
    } catch {
      // Index may already exist
    }
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(36, new Date().toISOString());
  }

  // V37: F287 Phase C — content-free, append-only Memory Cue episode ledger.
  // Cue/source bodies and model reasoning remain derived and ephemeral; this
  // table persists only server-bound coordinates and enum outcomes with TTL=0.
  if (currentVersion < 37) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_cue_events (
        event_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        cue_id TEXT NOT NULL,
        opportunity_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        resolver_family TEXT NOT NULL CHECK (
          resolver_family IN ('person_entity', 'operational_precedent', 'taste', 'profile', 'project_knowledge')
        ),
        source_anchor TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        axis TEXT NOT NULL CHECK (axis IN ('consumption', 'invalidation')),
        consumption_outcome TEXT CHECK (
          consumption_outcome IN ('presented', 'drilled', 'applied', 'dismissed')
        ),
        invalidation_reason TEXT CHECK (
          invalidation_reason IN ('source_corrected', 'source_forgotten', 'scope_revoked', 'superseded', 'expired')
        ),
        catalog_version INTEGER NOT NULL,
        resolver_version INTEGER NOT NULL,
        occurred_at INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        CHECK (
          (axis = 'consumption' AND consumption_outcome IS NOT NULL AND invalidation_reason IS NULL)
          OR
          (axis = 'invalidation' AND invalidation_reason IS NOT NULL AND consumption_outcome IS NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS idx_memory_cue_events_cue_scope
        ON memory_cue_events(owner_user_id, cue_id, occurred_at);
      CREATE INDEX IF NOT EXISTS idx_memory_cue_events_opportunity
        ON memory_cue_events(owner_user_id, opportunity_id, occurred_at);
      CREATE TRIGGER IF NOT EXISTS memory_cue_events_no_update
      BEFORE UPDATE ON memory_cue_events
      BEGIN
        SELECT RAISE(ABORT, 'memory cue events are append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS memory_cue_events_no_delete
      BEFORE DELETE ON memory_cue_events
      BEGIN
        SELECT RAISE(ABORT, 'memory cue events are append-only');
      END;
    `);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(37, new Date().toISOString());
  }

  // V38: F256 Wave 1b — durable, versioned expansion health funnel.
  // One JSON object per recall row preserves the natural top-k denominator,
  // query timestamp/window, source revision, gate/drop reason, and the
  // correlated presented/followed/used stages beyond ToolEventLog's 7-day TTL.
  if (currentVersion < 38) {
    try {
      db.exec('ALTER TABLE recall_events ADD COLUMN expansion_funnel_json TEXT');
    } catch {
      // Column may already exist from a partial migration.
    }
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(38, new Date().toISOString());
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

/**
 * Ensure passage-level vec0 table exists for raw semantic / hybrid recall.
 * Kept separate from evidence_vectors because hydration target is
 * evidence_passages, not evidence_docs.
 */
export function ensurePassageVectorTable(db: Database.Database, dim: number): boolean {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS passage_vectors USING vec0(
        passage_key TEXT PRIMARY KEY,
        embedding float[${dim}]
      )
    `);
    return true;
  } catch {
    return false; // sqlite-vec not loaded — fail-open
  }
}
