import type Database from 'better-sqlite3';
import type { StaticFeatureLedger } from '../host-broker/static-feature-ledger.js';
import type { StateEntity, StateQuery } from './protocol.js';
import { decodeRecord } from './records.js';

type Query = (query: StateQuery) => unknown[];

export function readFeatures(query: Query, instanceId?: string, activeOnly = false): StaticFeatureLedger {
  if (!activeOnly) {
    const read = (entity: StateEntity) =>
      query({ entity, ...(instanceId ? { index: 'instanceId' as const, value: instanceId } : {}) });
    return { epochs: read('epoch'), preferences: read('preference'), leases: read('feature') } as StaticFeatureLedger;
  }
  if (!instanceId) throw new Error('Active feature query requires an instance');
  const leases = query({
    entity: 'feature',
    index: 'instanceId',
    value: instanceId,
    phases: ['active', 'provisioning'],
  }) as StaticFeatureLedger['leases'];
  return withReferences(query, instanceId, leases);
}

/** Current siblings plus three indexed historical facts; unrelated history never leaves SQLite. */
export function readFeatureActivation(
  database: Database.Database,
  query: Query,
  instanceId: string,
  featureId: string,
  sessionId: string,
): StaticFeatureLedger {
  const selected = readFeatures(query, instanceId, true);
  const indexed = <T>(sql: string, ...parameters: string[]): T | undefined => {
    const row = database.prepare(sql).get(...parameters) as
      | { kind: StateEntity; json: string; hash: string }
      | undefined;
    return row && (decodeRecord(row.kind, row.json, row.hash) as T);
  };
  const latest = indexed<StaticFeatureLedger['leases'][number]>(
    `SELECT kind,json,hash FROM records WHERE kind='feature' AND instance_id=?
     AND json_extract(json,'$.featureId')=? ORDER BY json_extract(json,'$.activationRevision') DESC LIMIT 1`,
    instanceId,
    featureId,
  );
  const firstInSession = indexed<StaticFeatureLedger['leases'][number]>(
    `SELECT kind,json,hash FROM records WHERE kind='feature' AND session_id=? ORDER BY id LIMIT 1`,
    sessionId,
  );
  const maximumEpoch = indexed<StaticFeatureLedger['epochs'][number]>(
    `SELECT kind,json,hash FROM records WHERE kind='epoch' AND instance_id=?
     ORDER BY json_extract(json,'$.integrityEpoch') DESC LIMIT 1`,
    instanceId,
  );
  const leases = new Map(selected.leases.map((r) => [r.executionLease, r]));
  for (const row of [latest, firstInSession]) if (row) leases.set(row.executionLease, row);
  const result = withReferences(query, instanceId, [...leases.values()], [featureId]);
  if (maximumEpoch && !result.epochs.some((r) => r.integrityEpoch === maximumEpoch.integrityEpoch))
    result.epochs.push(maximumEpoch);
  return result;
}

function withReferences(
  query: Query,
  instanceId: string,
  leases: StaticFeatureLedger['leases'],
  featureIds: string[] = [],
): StaticFeatureLedger {
  const epochs = new Map<string, StaticFeatureLedger['epochs'][number]>();
  const preferences = new Map<string, StaticFeatureLedger['preferences'][number]>();
  for (const lease of leases) {
    const key = JSON.stringify([instanceId, lease.integrityEpoch]);
    const epoch = query({ entity: 'epoch', index: 'key', value: key })[0] as
      | StaticFeatureLedger['epochs'][number]
      | undefined;
    if (epoch) epochs.set(key, epoch);
    featureIds.push(lease.featureId);
  }
  for (const featureId of new Set(featureIds)) {
    const key = JSON.stringify([instanceId, featureId]);
    const preference = query({ entity: 'preference', index: 'key', value: key })[0] as
      | StaticFeatureLedger['preferences'][number]
      | undefined;
    if (preference) preferences.set(key, preference);
  }
  return { leases, epochs: [...epochs.values()], preferences: [...preferences.values()] };
}
