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
    ensureColumn(database, 'gate_resource_holders', 'holder_started_at', 'TEXT');
    ensureColumn(database, 'gate_resource_holders', 'resource_class', "TEXT NOT NULL DEFAULT 'host-heavy'");
    ensureColumn(database, 'gate_resource_holders', 'heartbeat_at', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(database, 'gate_resource_bridge', 'leader_started_at', 'TEXT');
    ensureColumn(database, 'gate_resource_bridge', 'leader_heartbeat_at', 'INTEGER NOT NULL DEFAULT 0');
    database.exec(`
      CREATE TABLE IF NOT EXISTS gate_resource_class_config (
        resource_class TEXT PRIMARY KEY,
        capacity INTEGER NOT NULL
      );
    `);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
