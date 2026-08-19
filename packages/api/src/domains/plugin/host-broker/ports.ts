import type { BrokerCallRecord, BrokerRuntimeLeaseRecord, BrokerSessionRecord, HostBrokerSnapshot } from './types.js';

export interface BrokerSessionStore {
  getByConnectionId(connectionId: string): BrokerSessionRecord | undefined;
  getBySessionId(brokerSessionId: string): BrokerSessionRecord | undefined;
  list(): readonly BrokerSessionRecord[];
  put(record: BrokerSessionRecord): void;
}

export interface BrokerRuntimeLeaseStore {
  get(runtimeLeaseId: string): BrokerRuntimeLeaseRecord | undefined;
  list(): readonly BrokerRuntimeLeaseRecord[];
  put(record: BrokerRuntimeLeaseRecord): void;
}

export interface BrokerCallStore {
  get(ledgerKey: string): BrokerCallRecord | undefined;
  list(): readonly BrokerCallRecord[];
  put(record: BrokerCallRecord): void;
}

export interface HostBrokerTransaction {
  readonly sessions: BrokerSessionStore;
  readonly runtimeLeases: BrokerRuntimeLeaseStore;
  readonly calls: BrokerCallStore;
}

export interface HostBrokerStore {
  snapshot(): Promise<HostBrokerSnapshot>;
  transaction<T>(work: (transaction: HostBrokerTransaction) => Promise<T> | T): Promise<T>;
}
