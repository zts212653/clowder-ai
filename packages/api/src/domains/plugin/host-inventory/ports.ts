import type { VerifiedPackageAdmission } from './manifest-verifier.js';
export type Awaitable<T> = T | Promise<T>;

import type {
  PackageAdmissionCandidate,
  PluginInstanceRecord,
  PluginInventorySnapshot,
  PluginPackageRecord,
} from './types.js';

export interface PackageInventoryStore {
  get(packageDigest: string): Awaitable<PluginPackageRecord | undefined>;
  list(packageState?: string): Awaitable<readonly PluginPackageRecord[]>;
  put(record: PluginPackageRecord): Awaitable<void>;
}

export interface PluginInstanceStore {
  get(pluginInstanceId: string): Awaitable<PluginInstanceRecord | undefined>;
  getCurrent(pluginId: string): Awaitable<PluginInstanceRecord | undefined>;
  list(pluginId?: string, lifecycleState?: string): Awaitable<readonly PluginInstanceRecord[]>;
  put(record: PluginInstanceRecord): Awaitable<void>;
}

export interface PluginInventoryTransaction {
  readonly packages: PackageInventoryStore;
  readonly instances: PluginInstanceStore;
}

export interface PluginInventoryStore {
  readonly read: PluginInventoryTransaction;
  readAuthority(pluginInstanceId: string): Promise<InventoryAuthority | undefined>;
  readCurrentAuthority(pluginId: string): Promise<InventoryAuthority | undefined>;
  close?(): Promise<void>;
  hasRecords(): Promise<boolean>;
  verifyAdmission?(input: PackageAdmissionCandidate, now: number): Promise<VerifiedPackageAdmission>;
  snapshot(selection?: InventorySnapshotSelection): Promise<PluginInventorySnapshot>;
  transaction<T>(
    work: (transaction: PluginInventoryTransaction) => Promise<T> | T,
    options?: {
      /** Synchronous compensation runs before the transaction queue is released. */
      onCommitFailure?(): void;
    },
  ): Promise<T>;
}

export interface InventoryAuthority {
  readonly instance: PluginInstanceRecord;
  readonly current?: PluginInstanceRecord;
  readonly packageRecord?: PluginPackageRecord;
}

export interface InventorySnapshotSelection {
  readonly pluginId?: string;
  readonly pluginInstanceId?: string;
  readonly currentOnly?: boolean;
  readonly packageDigests?: readonly string[];
}
