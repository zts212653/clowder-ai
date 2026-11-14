import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { emptyHostBrokerSnapshot, parseHostBrokerSnapshot } from '../host-broker/snapshot.js';
import { emptyStaticFeatureLedger } from '../host-broker/static-feature-ledger.js';
import { emptyPluginInventorySnapshot, parsePluginInventorySnapshot } from '../host-inventory/snapshot.js';
import { requireInventoryWriterLease } from '../host-inventory/writer-lease.js';
import type { StateDomain, StateEntity } from './protocol.js';
import { cachedContract } from './records.js';
export function openStateDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const writer = new Database(`${path}.state.sqlite`);
  chmodSync(`${path}.state.sqlite`, 0o600);
  if (writer.pragma('journal_mode', { simple: true }) !== 'wal') writer.pragma('journal_mode = WAL');
  const initialized = writer.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
  writer.pragma('synchronous = FULL');
  if (!initialized) {
    writer.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS committed_transactions (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS records (
        id INTEGER PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL, plugin_id TEXT, instance_id TEXT, session_id TEXT,
        package_digest TEXT, phase TEXT, json TEXT NOT NULL, hash TEXT NOT NULL, UNIQUE (kind,key));
      CREATE INDEX IF NOT EXISTS by_kind_order ON records(kind,id);
      CREATE INDEX IF NOT EXISTS by_plugin ON records(kind,plugin_id);
      CREATE INDEX IF NOT EXISTS by_instance ON records(kind,instance_id);
      CREATE INDEX IF NOT EXISTS by_instance_phase ON records(kind,instance_id,phase);
      CREATE INDEX IF NOT EXISTS by_session ON records(kind,session_id);
      CREATE INDEX IF NOT EXISTS by_package ON records(kind,package_digest);
      CREATE INDEX IF NOT EXISTS by_phase ON records(kind,phase);
      CREATE INDEX IF NOT EXISTS feature_revision ON records(instance_id,json_extract(json,'$.featureId'),json_extract(json,'$.activationRevision') DESC) WHERE kind='feature';
      CREATE INDEX IF NOT EXISTS epoch_revision ON records(instance_id,json_extract(json,'$.integrityEpoch') DESC) WHERE kind='epoch';
      CREATE UNIQUE INDEX IF NOT EXISTS live_feature ON records(instance_id,json_extract(json,'$.featureId')) WHERE kind='feature' AND phase!='revoked';
      CREATE UNIQUE INDEX IF NOT EXISTS current_instance ON records(plugin_id) WHERE kind='instance' AND phase='installed';
      CREATE UNIQUE INDEX IF NOT EXISTS session_identity ON records(session_id) WHERE kind='session';`);
    writer.pragma('user_version = 1');
  } else if (writer.pragma('user_version', { simple: true }) !== 1) {
    writer.close();
    throw new Error('Unsupported plugin state database format');
  }
  return writer;
}
export function importLegacyState(
  domain: StateDomain,
  path: string,
  writer: Database.Database,
  write: (entity: StateEntity, value: unknown) => void,
): void {
  if (writer.prepare("SELECT value FROM meta WHERE key='imported'").get()) return;
  const release = requireInventoryWriterLease(path);
  try {
    writer.exec('BEGIN IMMEDIATE');
    if (writer.prepare("SELECT value FROM meta WHERE key='imported'").get()) {
      writer.exec('COMMIT');
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if (domain === 'inventory') {
      const snapshot = parsePluginInventorySnapshot(value ?? emptyPluginInventorySnapshot(), cachedContract);
      for (const record of snapshot.packages) write('package', record);
      for (const record of snapshot.instances) write('instance', record);
    } else {
      const snapshot = parseHostBrokerSnapshot(value ?? emptyHostBrokerSnapshot());
      for (const record of snapshot.sessions) write('session', record);
      for (const record of snapshot.runtimeLeases) write('lease', record);
      for (const record of snapshot.calls) write('call', record);
      const ledger = snapshot.staticFeatures ?? emptyStaticFeatureLedger();
      for (const record of ledger.epochs) write('epoch', record);
      for (const record of ledger.preferences) write('preference', record);
      for (const record of ledger.leases) write('feature', record);
    }
    writer.prepare("INSERT INTO meta(key,value) VALUES ('imported','1')").run();
    writer.exec('COMMIT');
  } catch (error) {
    if (writer.inTransaction) writer.exec('ROLLBACK');
    writer.close();
    throw error;
  } finally {
    release();
  }
}
