export type Awaitable<T> = T | Promise<T>;

import type { SnapshotReadDiagnostics } from '../diagnostics/observation-work.js';
import type { StaticFeatureLease, StaticFeatureLedger } from './static-feature-ledger.js';
import type { BrokerCallRecord, BrokerRuntimeLeaseRecord, BrokerSessionRecord, HostBrokerSnapshot } from './types.js';

export interface BrokerSessionStore {
  getByConnectionId(connectionId: string): Awaitable<BrokerSessionRecord | undefined>;
  getBySessionId(brokerSessionId: string): Awaitable<BrokerSessionRecord | undefined>;
  list(pluginInstanceId?: string, phase?: string | readonly string[]): Awaitable<readonly BrokerSessionRecord[]>;
  put(record: BrokerSessionRecord): Awaitable<void>;
}

export interface BrokerRuntimeLeaseStore {
  get(runtimeLeaseId: string): Awaitable<BrokerRuntimeLeaseRecord | undefined>;
  list(state?: string | readonly string[]): Awaitable<readonly BrokerRuntimeLeaseRecord[]>;
  put(record: BrokerRuntimeLeaseRecord): Awaitable<void>;
}

export interface BrokerCallStore {
  get(ledgerKey: string): Awaitable<BrokerCallRecord | undefined>;
  list(): Awaitable<readonly BrokerCallRecord[]>;
  put(record: BrokerCallRecord): Awaitable<void>;
}

export interface HostBrokerTransaction {
  readonly sessions: BrokerSessionStore;
  readonly runtimeLeases: BrokerRuntimeLeaseStore;
  readonly calls: BrokerCallStore;
  readonly staticFeatures: {
    get(pluginInstanceId?: string): Awaitable<StaticFeatureLedger>;
    getLease(executionLease: string): Awaitable<StaticFeatureLease | undefined>;
    getPreference(
      pluginInstanceId: string,
      featureId: string,
    ): Awaitable<StaticFeatureLedger['preferences'][number] | undefined>;
    getActive(pluginInstanceId: string): Awaitable<StaticFeatureLedger>;
    getForActivation(
      pluginInstanceId: string,
      featureId: string,
      brokerSessionId: string,
    ): Awaitable<StaticFeatureLedger>;
    update(ledger: StaticFeatureLedger): Awaitable<void>;
    put(ledger: StaticFeatureLedger, pluginInstanceId?: string): Awaitable<void>;
  };
}

export interface HostBrokerStore {
  readonly read: HostBrokerTransaction;
  readConnection(connectionId: string): Promise<{ session?: BrokerSessionRecord; lease?: BrokerRuntimeLeaseRecord }>;
  close?(): Promise<void>;
  snapshot(diagnostics?: SnapshotReadDiagnostics): Promise<HostBrokerSnapshot>;
  transaction<T>(work: (transaction: HostBrokerTransaction) => Promise<T> | T): Promise<T>;
}
