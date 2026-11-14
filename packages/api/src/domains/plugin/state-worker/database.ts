import Database from 'better-sqlite3';
import { parseHostBrokerSnapshot } from '../host-broker/snapshot.js';
import { parseStaticFeatureLedger, type StaticFeatureLedger } from '../host-broker/static-feature-ledger.js';
import type { BrokerSessionRecord } from '../host-broker/types.js';
import { parsePluginInventorySnapshot } from '../host-inventory/snapshot.js';
import { serializeInventoryPackage } from '../host-inventory/stored-manifest.js';
import type { PluginInstanceRecord, PluginPackageRecord } from '../host-inventory/types.js';
import { requireInventoryWriterLease } from '../host-inventory/writer-lease.js';
import { importLegacyState, openStateDatabase } from './database-opening.js';
import { readFeatureActivation, readFeatures } from './feature-records.js';
import type { StateDomain, StateEntity, StateIndex, StateQuery } from './protocol.js';
import { cachedContract, contentHash, decodeRecord, recordColumns } from './records.js';

type Row = { kind: StateEntity; key: string; json: string; hash: string };
const columns: Record<StateIndex, string> = {
  key: 'key',
  pluginId: 'plugin_id',
  instanceId: 'instance_id',
  sessionId: 'session_id',
  packageDigest: 'package_digest',
  phase: 'phase',
};
const entities: Record<StateDomain, readonly StateEntity[]> = {
  inventory: ['package', 'instance'],
  broker: ['session', 'lease', 'call', 'epoch', 'preference', 'feature'],
};

/** Synchronous SQLite is deliberately confined to the dedicated worker. */
export class PluginStateDatabase {
  private readonly writer: Database.Database;
  private readonly reader: Database.Database;
  private active?: string;
  private releaseWriter?: () => void;
  private readonly changed = new Map<string, Row>();
  constructor(
    readonly domain: StateDomain,
    readonly path: string,
  ) {
    this.writer = openStateDatabase(path);
    importLegacyState(domain, path, this.writer, (entity, value) => this.write(entity, value));
    this.changed.clear();
    this.reader = new Database(`${path}.state.sqlite`, { readonly: true });
  }

  hasRecords(): boolean {
    return this.reader.prepare('SELECT id FROM records LIMIT 1').get() !== undefined;
  }

  begin(transaction: string, acknowledgedTransaction?: string): void {
    if (this.active) throw new Error('Plugin state transaction already active');
    const release = requireInventoryWriterLease(this.path);
    try {
      this.writer.exec('BEGIN IMMEDIATE');
      // Retire only a caller-confirmed receipt, atomically with the next mutation.
      if (acknowledgedTransaction)
        this.writer.prepare('DELETE FROM committed_transactions WHERE id=?').run(acknowledgedTransaction);
    } catch (error) {
      if (this.writer.inTransaction) this.writer.exec('ROLLBACK');
      release();
      throw error;
    }
    this.releaseWriter = release;
    this.active = transaction;
    this.changed.clear();
  }

  finish(transaction: string, commit: boolean): void {
    this.connection(transaction);
    let finished = false;
    try {
      if (commit) {
        this.validateChanges();
        this.writer.prepare('INSERT INTO committed_transactions(id) VALUES (?)').run(transaction);
      }
      if (this.writer.inTransaction) this.writer.exec(commit ? 'COMMIT' : 'ROLLBACK');
      finished = true;
    } catch (error) {
      if (this.writer.inTransaction) this.writer.exec('ROLLBACK');
      // The caller compensates its synchronous external write before releasing this lease.
      throw error;
    } finally {
      if (finished) {
        this.active = undefined;
        this.changed.clear();
        this.releaseWriter?.();
        this.releaseWriter = undefined;
      }
    }
  }

  query(query: StateQuery, transaction?: string): unknown[] {
    if (!entities[this.domain].includes(query.entity)) throw new Error('Wrong plugin state domain');
    const parameters: (string | number)[] = [query.entity];
    let where = 'kind = ?';
    if (query.index !== undefined) {
      where += ` AND ${columns[query.index]} = ?`;
      parameters.push(query.value ?? '');
    }
    if (query.phase !== undefined) {
      where += ' AND phase = ?';
      parameters.push(query.phase);
    }
    if (query.phases?.length) {
      where += ` AND phase IN (${query.phases.map(() => '?').join(',')})`;
      parameters.push(...query.phases);
    }
    if (query.afterRowid !== undefined) {
      where += ' AND id > ?';
      parameters.push(query.afterRowid);
    }
    const rows = this.connection(transaction)
      .prepare(
        `SELECT kind,key,json,hash FROM records WHERE ${where} ORDER BY id${query.limit === undefined ? '' : ' LIMIT ?'}`,
      )
      .all(...(query.limit === undefined ? parameters : [...parameters, query.limit])) as Row[];
    return rows.map((row) => decodeRecord(row.kind, row.json, row.hash));
  }

  page(query: StateQuery, transaction?: string) {
    const records = this.query(query, transaction);
    const last = records.at(-1);
    let afterRowid: number | undefined;
    if (records.length === query.limit && last !== undefined) {
      const key = recordColumns(query.entity, last).key;
      const row = this.connection(transaction)
        .prepare('SELECT id FROM records WHERE kind=? AND key=?')
        .get(query.entity, key) as { id: number };
      afterRowid = row.id;
    }
    return { records, afterRowid };
  }

  put(entity: StateEntity, value: unknown, transaction: string): void {
    this.connection(transaction);
    if (!entities[this.domain].includes(entity)) throw new Error('Wrong plugin state write domain');
    this.write(entity, value);
  }

  features(instanceId?: string, transaction?: string, activeOnly = false): StaticFeatureLedger {
    return readFeatures((query) => this.query(query, transaction), instanceId, activeOnly);
  }

  featureActivation(
    instanceId: string,
    featureId: string,
    sessionId: string,
    transaction?: string,
  ): StaticFeatureLedger {
    return readFeatureActivation(
      this.connection(transaction),
      (query) => this.query(query, transaction),
      instanceId,
      featureId,
      sessionId,
    );
  }

  putFeatures(value: unknown, instanceId: string | undefined, transaction: string, updateOnly = false): void {
    const db = this.connection(transaction);
    const ledger = value as StaticFeatureLedger;
    const sessions = new Map<string, BrokerSessionRecord>();
    for (const lease of ledger.leases) {
      if (instanceId && lease.pluginInstanceId !== instanceId) throw new Error('Feature update escaped instance');
      const session = this.query(
        { entity: 'session', index: 'sessionId', value: lease.brokerSessionId },
        transaction,
      )[0] as BrokerSessionRecord | undefined;
      if (session) sessions.set(session.brokerSessionId, session);
    }
    const parsed = parseStaticFeatureLedger(value, [...sessions.values()]);
    for (const [entity, records] of [
      ['epoch', parsed.epochs],
      ['preference', parsed.preferences],
      ['feature', parsed.leases],
    ] as const) {
      if (instanceId && records.some((r) => r.pluginInstanceId !== instanceId))
        throw new Error('Feature update escaped instance');
      if (!updateOnly)
        db.prepare(`DELETE FROM records WHERE kind=?${instanceId ? ' AND instance_id=?' : ''}`).run(
          ...(instanceId ? [entity, instanceId] : [entity]),
        );
      for (const record of records) this.write(entity, record);
    }
  }

  authority(instanceId: string, byPlugin = false) {
    this.reader.exec('BEGIN');
    try {
      const instance = this.query({
        entity: 'instance',
        index: byPlugin ? 'pluginId' : 'key',
        value: instanceId,
        ...(byPlugin ? { phase: 'installed' } : {}),
      })[0] as PluginInstanceRecord | undefined;
      if (!instance) return undefined;
      const current = this.query({
        entity: 'instance',
        index: 'pluginId',
        value: instance.pluginId,
        phase: 'installed',
      })[0];
      const packageRecord = this.query({ entity: 'package', index: 'key', value: instance.packageDigest })[0];
      return { instance, current, packageRecord };
    } finally {
      this.reader.exec('COMMIT');
    }
  }

  connectionState(connectionId: string) {
    this.reader.exec('BEGIN');
    try {
      const session = this.query({ entity: 'session', index: 'key', value: connectionId })[0] as
        | BrokerSessionRecord
        | undefined;
      const lease = session && this.query({ entity: 'lease', index: 'key', value: session.runtimeLeaseId })[0];
      return { session, lease };
    } finally {
      this.reader.exec('COMMIT');
    }
  }

  close(): void {
    if (this.writer.inTransaction) this.writer.exec('ROLLBACK');
    this.releaseWriter?.();
    this.reader.close();
    this.writer.close();
  }

  private connection(transaction?: string): Database.Database {
    if (transaction === undefined) return this.reader;
    if (this.active !== transaction) throw new Error('Plugin state transaction is no longer active');
    return this.writer;
  }

  private write(entity: StateEntity, value: unknown): void {
    const raw = entity === 'package' ? serializeInventoryPackage(value as PluginPackageRecord) : value;
    const json = JSON.stringify(raw);
    const hash = contentHash(json);
    const parsed = decodeRecord(entity, json, hash);
    const c = recordColumns(entity, parsed);
    const previous = this.writer.prepare('SELECT hash FROM records WHERE kind=? AND key=?').get(entity, c.key) as
      | { hash: string }
      | undefined;
    if (previous?.hash === hash) return;
    this.writer
      .prepare(`INSERT INTO records (kind,key,plugin_id,instance_id,session_id,package_digest,phase,json,hash)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET plugin_id=excluded.plugin_id,
      instance_id=excluded.instance_id,session_id=excluded.session_id,package_digest=excluded.package_digest,
      phase=excluded.phase,json=excluded.json,hash=excluded.hash`)
      .run(entity, c.key, c.pluginId, c.instanceId, c.sessionId, c.packageDigest, c.phase, json, hash);
    this.changed.set(`${entity}:${c.key}`, { kind: entity, key: c.key, json, hash });
  }

  private validateChanges(): void {
    // Validate touched authority neighborhoods, never the call-history table.
    const instances = new Set<string>();
    const sessions = new Set<string>();
    const calls: unknown[] = [];
    for (const row of this.changed.values()) {
      const r = JSON.parse(row.json) as Record<string, unknown>;
      if (this.domain === 'inventory') {
        if (row.kind === 'instance') instances.add(String(r.pluginInstanceId));
        if (row.kind === 'package')
          for (const instance of this.query(
            { entity: 'instance', index: 'packageDigest', value: String(r.packageDigest) },
            this.active,
          ) as PluginInstanceRecord[])
            instances.add(instance.pluginInstanceId);
      } else {
        if (r.brokerSessionId) sessions.add(String(r.brokerSessionId));
        if (row.kind === 'call') calls.push(r);
      }
    }
    if (this.domain === 'inventory') {
      for (const id of instances) {
        const instance = this.query(
          { entity: 'instance', index: 'key', value: id },
          this.active,
        )[0] as PluginInstanceRecord;
        const pkg = this.query({ entity: 'package', index: 'key', value: instance.packageDigest }, this.active)[0];
        parsePluginInventorySnapshot(
          { schemaVersion: 1, instances: [instance], packages: pkg ? [pkg] : [] },
          cachedContract,
        );
      }
    } else
      for (const id of sessions) {
        const current = this.query({ entity: 'session', index: 'sessionId', value: id }, this.active);
        const leases = this.query({ entity: 'lease', index: 'sessionId', value: id }, this.active);
        parseHostBrokerSnapshot({
          schemaVersion: 1,
          sessions: current,
          runtimeLeases: leases,
          calls: calls.filter((r) => (r as Record<string, unknown>).brokerSessionId === id),
        });
      }
  }
}

/** Used after a proven worker exit: the receipt commits atomically with the mutation. */
export function readCommittedOutcome(path: string, transaction: string): boolean {
  const database = new Database(`${path}.state.sqlite`, { readonly: true, fileMustExist: true });
  try {
    return database.prepare('SELECT id FROM committed_transactions WHERE id=?').get(transaction) !== undefined;
  } finally {
    database.close();
  }
}
