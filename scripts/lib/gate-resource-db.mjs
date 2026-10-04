import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const WAL_RETRY_TIMEOUT_MS = 5_000;
const WAL_RETRY_DELAY_MS = 10;
const synchronousWait = new Int32Array(new SharedArrayBuffer(4));

function isSqliteBusy(error) {
  return error?.errcode === 5 || error?.code === 'SQLITE_BUSY' || error?.errstr === 'database is locked';
}

function enableWalMode(database) {
  const deadlineAt = Date.now() + WAL_RETRY_TIMEOUT_MS;
  while (true) {
    try {
      database.exec('PRAGMA journal_mode = WAL');
      return;
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadlineAt) throw error;
      // DatabaseSync has no asynchronous busy hook for this cold-start pragma.
      Atomics.wait(synchronousWait, 0, 0, WAL_RETRY_DELAY_MS);
    }
  }
}

function ensureColumn(database, table, name, definition) {
  const hasColumn = () =>
    database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((column) => column.name === name);
  if (hasColumn()) return;
  try {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  } catch (error) {
    // Multiple first-use runners can observe the same pre-migration schema.
    // SQLite serializes ALTER TABLE, so the loser re-reads schema truth instead
    // of treating the winner's column as a startup failure.
    if (!hasColumn()) throw error;
  }
}

export function openGateResourcePool(databasePath) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    database.exec('PRAGMA foreign_keys = ON');
    enableWalMode(database);
    database.exec(`
    CREATE TABLE IF NOT EXISTS gate_resource_requests (
      request_order INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL UNIQUE,
      holder_pid INTEGER NOT NULL,
      holder_started_at TEXT,
      cwd TEXT NOT NULL,
      stage TEXT NOT NULL,
      mode TEXT NOT NULL,
      weight INTEGER NOT NULL,
      capacity INTEGER NOT NULL,
      queued_at INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL,
      cohort_id TEXT,
      receipt_path TEXT
    );
    CREATE TABLE IF NOT EXISTS gate_resource_holders (
      request_id TEXT PRIMARY KEY,
      request_order INTEGER NOT NULL,
      holder_pid INTEGER NOT NULL,
      holder_started_at TEXT,
      cwd TEXT NOT NULL,
      stage TEXT NOT NULL,
      mode TEXT NOT NULL,
      weight INTEGER NOT NULL,
      capacity INTEGER NOT NULL,
      cohort_id TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL,
      receipt_path TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gate_resource_bridge (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      cohort_id TEXT NOT NULL,
      leader_request_id TEXT NOT NULL,
      leader_pid INTEGER NOT NULL,
      leader_started_at TEXT,
      leader_heartbeat_at INTEGER NOT NULL,
      transfer_from_request_id TEXT,
      transfer_from_pid INTEGER,
      transfer_from_started_at TEXT,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gate_resource_config (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      capacity INTEGER NOT NULL
    );
    `);
    ensureColumn(database, 'gate_resource_requests', 'holder_started_at', 'TEXT');
    ensureColumn(database, 'gate_resource_requests', 'resource_class', "TEXT NOT NULL DEFAULT 'host-heavy'");
    ensureColumn(database, 'gate_resource_requests', 'priority', "TEXT NOT NULL DEFAULT 'interactive'");
    ensureColumn(database, 'gate_resource_requests', 'bypass_count', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(database, 'gate_resource_requests', 'total_bypass_count', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(database, 'gate_resource_requests', 'pressure_starvation_count', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(database, 'gate_resource_requests', 'aging_started_at', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(database, 'gate_resource_requests', 'drain_started_at', 'INTEGER');
    ensureColumn(database, 'gate_resource_requests', 'pressure_blocked_at', 'INTEGER');
    ensureColumn(database, 'gate_resource_requests', 'job_token', 'TEXT');
    ensureColumn(database, 'gate_resource_requests', 'logical_request_key', 'TEXT');
    ensureColumn(database, 'gate_resource_requests', 'request_generation', 'INTEGER');
    ensureColumn(database, 'gate_resource_requests', 'parent_request_id', 'TEXT');
    ensureColumn(database, 'gate_resource_requests', 'request_fingerprint', 'TEXT');
    ensureColumn(database, 'gate_resource_requests', 'claimant_generation', 'INTEGER');
    ensureColumn(database, 'gate_resource_requests', 'claimant_token', 'TEXT');
    ensureColumn(database, 'gate_resource_requests', 'queue_deadline_at', 'INTEGER');
    ensureColumn(database, 'gate_resource_holders', 'holder_started_at', 'TEXT');
    ensureColumn(database, 'gate_resource_holders', 'cwd', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(database, 'gate_resource_holders', 'resource_class', "TEXT NOT NULL DEFAULT 'host-heavy'");
    ensureColumn(database, 'gate_resource_holders', 'priority', "TEXT NOT NULL DEFAULT 'interactive'");
    ensureColumn(database, 'gate_resource_holders', 'job_token', 'TEXT');
    ensureColumn(database, 'gate_resource_holders', 'heartbeat_at', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(database, 'gate_resource_holders', 'logical_request_key', 'TEXT');
    ensureColumn(database, 'gate_resource_holders', 'request_generation', 'INTEGER');
    ensureColumn(database, 'gate_resource_holders', 'parent_request_id', 'TEXT');
    ensureColumn(database, 'gate_resource_holders', 'request_fingerprint', 'TEXT');
    ensureColumn(database, 'gate_resource_holders', 'claimant_generation', 'INTEGER');
    ensureColumn(database, 'gate_resource_holders', 'claimant_token', 'TEXT');
    ensureColumn(database, 'gate_resource_holders', 'queue_deadline_at', 'INTEGER');
    ensureColumn(database, 'gate_resource_bridge', 'leader_started_at', 'TEXT');
    ensureColumn(database, 'gate_resource_bridge', 'leader_heartbeat_at', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(database, 'gate_resource_bridge', 'transfer_from_request_id', 'TEXT');
    ensureColumn(database, 'gate_resource_bridge', 'transfer_from_pid', 'INTEGER');
    ensureColumn(database, 'gate_resource_bridge', 'transfer_from_started_at', 'TEXT');
    database.exec(`
      CREATE TABLE IF NOT EXISTS gate_resource_request_lineage (
        logical_request_key TEXT NOT NULL,
        request_generation INTEGER NOT NULL,
        request_id TEXT NOT NULL UNIQUE,
        parent_request_id TEXT,
        state TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        claimant_generation INTEGER NOT NULL,
        claimant_token TEXT NOT NULL,
        queue_deadline_at INTEGER NOT NULL,
        terminal_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        terminal_at INTEGER,
        PRIMARY KEY (logical_request_key, request_generation)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS gate_resource_request_lineage_active
        ON gate_resource_request_lineage(logical_request_key)
        WHERE state IN ('queued', 'held');
      CREATE TABLE IF NOT EXISTS gate_resource_class_config (
        resource_class TEXT PRIMARY KEY,
        capacity INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gate_resource_dimensions (
        dimension_key TEXT PRIMARY KEY,
        capacity INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gate_resource_request_claims (
        request_id TEXT NOT NULL REFERENCES gate_resource_requests(request_id) ON DELETE CASCADE,
        dimension_key TEXT NOT NULL REFERENCES gate_resource_dimensions(dimension_key),
        units INTEGER NOT NULL,
        PRIMARY KEY (request_id, dimension_key)
      );
      CREATE TABLE IF NOT EXISTS gate_resource_holder_claims (
        request_id TEXT NOT NULL REFERENCES gate_resource_holders(request_id) ON DELETE CASCADE,
        dimension_key TEXT NOT NULL REFERENCES gate_resource_dimensions(dimension_key),
        units INTEGER NOT NULL,
        PRIMARY KEY (request_id, dimension_key)
      );
      CREATE INDEX IF NOT EXISTS gate_resource_request_claim_dimension
        ON gate_resource_request_claims(dimension_key, request_id);
      CREATE INDEX IF NOT EXISTS gate_resource_holder_claim_dimension
        ON gate_resource_holder_claims(dimension_key, request_id);
    `);
    database.exec(`
      UPDATE gate_resource_requests SET aging_started_at = queued_at WHERE aging_started_at = 0;
      INSERT OR IGNORE INTO gate_resource_dimensions (dimension_key, capacity)
        SELECT resource_class, capacity FROM gate_resource_class_config;
      INSERT OR IGNORE INTO gate_resource_dimensions (dimension_key, capacity)
        SELECT resource_class, capacity FROM gate_resource_requests;
      INSERT OR IGNORE INTO gate_resource_dimensions (dimension_key, capacity)
        SELECT resource_class, capacity FROM gate_resource_holders;
      INSERT OR IGNORE INTO gate_resource_request_claims (request_id, dimension_key, units)
        SELECT request_id, resource_class, weight FROM gate_resource_requests;
      INSERT OR IGNORE INTO gate_resource_holder_claims (request_id, dimension_key, units)
        SELECT request_id, resource_class, weight FROM gate_resource_holders;
    `);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
