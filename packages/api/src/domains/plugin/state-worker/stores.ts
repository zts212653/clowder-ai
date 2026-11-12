import type { HostBrokerStore, HostBrokerTransaction } from '../host-broker/ports.js';
import type { HostBrokerSnapshot } from '../host-broker/types.js';
import type { PackageAdmissionContractRuntime, VerifiedPackageAdmission } from '../host-inventory/manifest-verifier.js';
import type {
  InventoryAuthority,
  InventorySnapshotSelection,
  PluginInventoryStore,
  PluginInventoryTransaction,
} from '../host-inventory/ports.js';
import { parsePackage } from '../host-inventory/snapshot.js';
import type {
  PackageAdmissionCandidate,
  PluginInventorySnapshot,
  PluginPackageRecord,
} from '../host-inventory/types.js';
import { PluginStateClient } from './client.js';
import type { StateQuery } from './protocol.js';
import { StateStore } from './state-store.js';

export class SqlitePluginInventoryStore implements PluginInventoryStore {
  readonly path: string;
  readonly read: PluginInventoryTransaction;
  private readonly state: StateStore;
  constructor(
    path: string,
    private readonly options: {
      client?: PluginStateClient;
      contract?: PackageAdmissionContractRuntime;
    } = {},
  ) {
    this.state = new StateStore('inventory', path, options.client ?? new PluginStateClient());
    this.path = this.state.path;
    this.read = this.ports();
  }
  async hasRecords(): Promise<boolean> {
    await this.state.ready();
    return this.state.client.request({ op: 'hasRecords', domain: 'inventory' });
  }
  async verifyAdmission(candidate: PackageAdmissionCandidate, now: number): Promise<VerifiedPackageAdmission> {
    await this.state.ready();
    return this.state.client.request({ op: 'verifyAdmission', domain: 'inventory', candidate, now });
  }
  initialize(): Promise<void> {
    return this.state.ready();
  }
  private ports(transaction?: string): PluginInventoryTransaction {
    const getPackage = async (query: StateQuery) => {
      const record = await this.state.get<PluginPackageRecord | undefined>(query, transaction);
      // Test/custom Host policies can carry mutable closures: they deliberately have no cache identity.
      return record && this.options.contract ? parsePackage(record, 0, this.options.contract) : record;
    };
    return {
      packages: {
        get: (digest) => getPackage({ entity: 'package', index: 'key', value: digest }),
        list: async (packageState) => {
          const records = await this.state.list<PluginPackageRecord>(
            { entity: 'package', ...(packageState ? { phase: packageState } : {}) },
            transaction,
          );
          return this.options.contract
            ? records.map((record) => parsePackage(record, 0, this.options.contract!))
            : records;
        },
        put: (record) => this.state.put('package', record, transaction),
      },
      instances: {
        get: (id) => this.state.get({ entity: 'instance', index: 'key', value: id }, transaction),
        getCurrent: (pluginId) =>
          this.state.get({ entity: 'instance', index: 'pluginId', value: pluginId, phase: 'installed' }, transaction),
        list: (pluginId, lifecycleState) =>
          this.state.list(
            {
              entity: 'instance',
              ...(lifecycleState ? { phase: lifecycleState } : {}),
              ...(pluginId ? { index: 'pluginId' as const, value: pluginId } : {}),
            },
            transaction,
          ),
        put: (record) => this.state.put('instance', record, transaction),
      },
    };
  }
  async readAuthority(instanceId: string): Promise<InventoryAuthority | undefined> {
    await this.state.ready();
    const authority = await this.state.client.request<InventoryAuthority | undefined>({
      op: 'authority',
      domain: 'inventory',
      instanceId,
    });
    if (authority?.packageRecord && this.options.contract)
      return { ...authority, packageRecord: parsePackage(authority.packageRecord, 0, this.options.contract) };
    return authority;
  }
  async readCurrentAuthority(pluginId: string): Promise<InventoryAuthority | undefined> {
    await this.state.ready();
    const authority = await this.state.client.request<InventoryAuthority | undefined>({
      op: 'authority',
      domain: 'inventory',
      instanceId: pluginId,
      byPlugin: true,
    });
    return authority?.packageRecord && this.options.contract
      ? { ...authority, packageRecord: parsePackage(authority.packageRecord, 0, this.options.contract) }
      : authority;
  }
  /** Compatibility export for explicit catalogue/backup consumers; authority queries use read.*. */
  async snapshot(selection?: InventorySnapshotSelection): Promise<PluginInventorySnapshot> {
    if (selection?.pluginId || selection?.pluginInstanceId) {
      const authority = selection.pluginId
        ? await this.readCurrentAuthority(selection.pluginId)
        : await this.readAuthority(selection.pluginInstanceId!);
      const instances = authority ? [authority.instance] : [];
      const packages = new Map<string, PluginPackageRecord>();
      if (authority?.packageRecord) packages.set(authority.packageRecord.packageDigest, authority.packageRecord);
      for (const digest of selection.packageDigests ?? []) {
        if (packages.has(digest)) continue;
        const record = await this.read.packages.get(digest);
        if (record) packages.set(digest, record);
      }
      return { schemaVersion: 1, instances, packages: [...packages.values()] };
    }
    const instances = await this.read.instances.list(undefined, selection?.currentOnly ? 'installed' : undefined);
    if (!selection?.currentOnly) return { schemaVersion: 1, instances, packages: await this.read.packages.list() };
    const digests = [...new Set([...instances.map((row) => row.packageDigest), ...(selection.packageDigests ?? [])])];
    const records = await Promise.all(digests.map((digest) => this.read.packages.get(digest)));
    return {
      schemaVersion: 1,
      instances,
      packages: records.filter((row): row is PluginPackageRecord => row !== undefined),
    };
  }
  transaction<T>(
    work: (tx: PluginInventoryTransaction) => T | Promise<T>,
    options?: { onCommitFailure?(): void },
  ): Promise<T> {
    return this.state.run(async (token) => work(this.ports(token)), options?.onCommitFailure);
  }
  close(): Promise<void> {
    return this.state.client.close();
  }
}

export class SqliteHostBrokerStore implements HostBrokerStore {
  readonly path: string;
  readonly read: HostBrokerTransaction;
  private readonly state: StateStore;
  constructor(path: string, client = new PluginStateClient()) {
    this.state = new StateStore('broker', path, client);
    this.path = this.state.path;
    this.read = this.ports();
  }
  initialize(): Promise<void> {
    return this.state.ready();
  }
  private ports(transaction?: string): HostBrokerTransaction {
    return {
      sessions: {
        getByConnectionId: (id) => this.state.get({ entity: 'session', index: 'key', value: id }, transaction),
        getBySessionId: (id) => this.state.get({ entity: 'session', index: 'sessionId', value: id }, transaction),
        list: (instanceId, phase) =>
          this.state.list(
            {
              entity: 'session',
              ...(phase ? (typeof phase === 'string' ? { phase } : { phases: phase }) : {}),
              ...(instanceId ? { index: 'instanceId' as const, value: instanceId } : {}),
            },
            transaction,
          ),
        put: (r) => this.state.put('session', r, transaction),
      },
      runtimeLeases: {
        get: (id) => this.state.get({ entity: 'lease', index: 'key', value: id }, transaction),
        list: (state) =>
          this.state.list(
            { entity: 'lease', ...(state ? (typeof state === 'string' ? { phase: state } : { phases: state }) : {}) },
            transaction,
          ),
        put: (r) => this.state.put('lease', r, transaction),
      },
      calls: {
        get: (id) => this.state.get({ entity: 'call', index: 'key', value: id }, transaction),
        list: () => this.state.list({ entity: 'call' }, transaction),
        put: (r) => this.state.put('call', r, transaction),
      },
      staticFeatures: {
        getPreference: (instanceId, featureId) =>
          this.state.get(
            { entity: 'preference', index: 'key', value: JSON.stringify([instanceId, featureId]) },
            transaction,
          ),
        getForActivation: async (instanceId, featureId, sessionId) => {
          await this.state.ready();
          return this.state.client.request({
            op: 'activation',
            domain: 'broker',
            instanceId,
            featureId,
            sessionId,
            transaction,
          });
        },
        getActive: async (instanceId) => {
          await this.state.ready();
          return this.state.client.request({
            op: 'features',
            domain: 'broker',
            instanceId,
            activeOnly: true,
            transaction,
          });
        },
        update: async (value) => {
          if (!transaction) throw new Error('Read port cannot write');
          await this.state.client.request({
            op: 'putFeatures',
            domain: 'broker',
            value,
            updateOnly: true,
            transaction,
          });
        },
        getLease: (id) => this.state.get({ entity: 'feature', index: 'key', value: id }, transaction),
        get: async (instanceId) => {
          if (instanceId !== undefined) {
            await this.state.ready();
            return this.state.client.request({ op: 'features', domain: 'broker', instanceId, transaction });
          }
          return {
            epochs: await this.state.list({ entity: 'epoch' }, transaction),
            preferences: await this.state.list({ entity: 'preference' }, transaction),
            leases: await this.state.list({ entity: 'feature' }, transaction),
          };
        },
        put: async (value, instanceId) => {
          if (!transaction) throw new Error('Plugin state read port cannot write');
          await this.state.client.request({ op: 'putFeatures', domain: 'broker', instanceId, value, transaction });
        },
      },
    };
  }
  async readConnection(connectionId: string): Promise<Awaited<ReturnType<HostBrokerStore['readConnection']>>> {
    await this.state.ready();
    return this.state.client.request({ op: 'connection', domain: 'broker', connectionId });
  }
  async snapshot(): Promise<HostBrokerSnapshot> {
    return {
      schemaVersion: 1,
      sessions: await this.read.sessions.list(),
      runtimeLeases: await this.read.runtimeLeases.list(),
      calls: await this.read.calls.list(),
      staticFeatures: await this.read.staticFeatures.get(),
    };
  }
  transaction<T>(work: (tx: HostBrokerTransaction) => T | Promise<T>): Promise<T> {
    return this.state.run(async (token) => work(this.ports(token)));
  }
  close(): Promise<void> {
    return this.state.client.close();
  }
}
