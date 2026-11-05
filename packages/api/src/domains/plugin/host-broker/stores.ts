import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { SnapshotReadDiagnostics } from '../diagnostics/observation-work.js';
import type { HostBrokerStore, HostBrokerTransaction } from './ports.js';
import { brokerReadConnection, brokerReadPorts, matchesBrokerPhase } from './read-ports.js';
import { cloneHostBrokerSnapshot, emptyHostBrokerSnapshot, parseHostBrokerSnapshot } from './snapshot.js';
import {
  emptyStaticFeatureLedger,
  mergeStaticFeatures,
  type StaticFeatureLedger,
  selectStaticFeatures,
  updateStaticFeatures,
} from './static-feature-ledger.js';
import { selectFeatureActivation } from './static-feature-selection.js';
import type { BrokerCallRecord, BrokerRuntimeLeaseRecord, BrokerSessionRecord, HostBrokerSnapshot } from './types.js';
import { HOST_BROKER_SCHEMA_VERSION, HostBrokerError } from './types.js';

class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async settled(): Promise<void> {
    await this.tail;
  }
}

const fileQueues = new Map<string, SerialQueue>();

function fileQueue(path: string): SerialQueue {
  let queue = fileQueues.get(path);
  if (!queue) {
    queue = new SerialQueue();
    fileQueues.set(path, queue);
  }
  return queue;
}

class MutableBrokerSnapshot implements HostBrokerTransaction {
  private written = false;
  private featureLedger: StaticFeatureLedger | undefined;
  readonly staticFeatures = {
    getPreference: (id: string, featureId: string) => {
      const record = this.featureLedger?.preferences.find(
        (r) => r.pluginInstanceId === id && r.featureId === featureId,
      );
      return record && structuredClone(record);
    },
    getForActivation: (id: string, featureId: string, sessionId: string) =>
      selectFeatureActivation(this.featureLedger ?? emptyStaticFeatureLedger(), id, featureId, sessionId),
    getActive: (id: string) => {
      const ledger = selectStaticFeatures(this.featureLedger ?? emptyStaticFeatureLedger(), id);
      return { ...ledger, leases: ledger.leases.filter((r) => r.state !== 'revoked') };
    },
    update: (ledger: StaticFeatureLedger) => {
      this.featureLedger = updateStaticFeatures(this.featureLedger ?? emptyStaticFeatureLedger(), ledger);
      this.written = true;
    },
    get: (instanceId?: string) => selectStaticFeatures(this.featureLedger ?? emptyStaticFeatureLedger(), instanceId),
    getLease: (id: string) => {
      const record = this.featureLedger?.leases.find((r) => r.executionLease === id);
      return record && structuredClone(record);
    },
    put: (ledger: StaticFeatureLedger, instanceId?: string) => {
      this.featureLedger = mergeStaticFeatures(this.featureLedger ?? emptyStaticFeatureLedger(), ledger, instanceId);
      this.written = true;
    },
  };
  private readonly sessionRecords = new Map<string, BrokerSessionRecord>();
  private readonly runtimeLeaseRecords = new Map<string, BrokerRuntimeLeaseRecord>();
  private readonly callRecords = new Map<string, BrokerCallRecord>();

  readonly sessions = {
    getByConnectionId: (connectionId: string) => this.clone(this.sessionRecords.get(connectionId)),
    getBySessionId: (brokerSessionId: string) =>
      this.clone([...this.sessionRecords.values()].find((record) => record.brokerSessionId === brokerSessionId)),
    list: (pluginInstanceId?: string, phase?: string | readonly string[]) =>
      [...this.sessionRecords.values()]
        .filter(
          (r) => (!pluginInstanceId || r.pluginInstanceId === pluginInstanceId) && matchesBrokerPhase(r.phase, phase),
        )
        .map((record) => structuredClone(record)),
    put: (record: BrokerSessionRecord) => {
      this.sessionRecords.set(record.connectionId, structuredClone(record));
      this.written = true;
    },
  };

  readonly runtimeLeases = {
    get: (runtimeLeaseId: string) => this.clone(this.runtimeLeaseRecords.get(runtimeLeaseId)),
    list: (state?: string | readonly string[]) =>
      [...this.runtimeLeaseRecords.values()]
        .filter((r) => matchesBrokerPhase(r.state, state))
        .map((record) => structuredClone(record)),
    put: (record: BrokerRuntimeLeaseRecord) => {
      this.runtimeLeaseRecords.set(record.runtimeLeaseId, structuredClone(record));
      this.written = true;
    },
  };

  readonly calls = {
    get: (ledgerKey: string) => this.clone(this.callRecords.get(ledgerKey)),
    list: () => [...this.callRecords.values()].map((record) => structuredClone(record)),
    put: (record: BrokerCallRecord) => {
      this.callRecords.set(record.ledgerKey, structuredClone(record));
      this.written = true;
    },
  };

  constructor(snapshot: HostBrokerSnapshot) {
    this.featureLedger = snapshot.staticFeatures === undefined ? undefined : structuredClone(snapshot.staticFeatures);
    for (const record of snapshot.sessions) this.sessionRecords.set(record.connectionId, structuredClone(record));
    for (const record of snapshot.runtimeLeases) {
      this.runtimeLeaseRecords.set(record.runtimeLeaseId, structuredClone(record));
    }
    for (const record of snapshot.calls) this.callRecords.set(record.ledgerKey, structuredClone(record));
  }

  hasWrites(): boolean {
    return this.written;
  }

  toSnapshot(): HostBrokerSnapshot {
    return {
      schemaVersion: HOST_BROKER_SCHEMA_VERSION,
      sessions: this.sessions.list(),
      runtimeLeases: this.runtimeLeases.list(),
      calls: this.calls.list(),
      ...(this.featureLedger === undefined ? {} : { staticFeatures: structuredClone(this.featureLedger) }),
    };
  }

  private clone<T>(value: T | undefined): T | undefined {
    return value === undefined ? undefined : structuredClone(value);
  }
}

export class MemoryHostBrokerStore implements HostBrokerStore {
  readonly read = brokerReadPorts(this);
  readConnection(id: string) {
    return brokerReadConnection(this, id);
  }
  private current: HostBrokerSnapshot;
  private readonly queue = new SerialQueue();

  constructor(initial: unknown = emptyHostBrokerSnapshot()) {
    this.current = parseHostBrokerSnapshot(initial);
  }

  async snapshot(diagnostics?: SnapshotReadDiagnostics): Promise<HostBrokerSnapshot> {
    if (diagnostics) await diagnostics.measure('queue', () => this.queue.settled());
    else await this.queue.settled();
    const clone = () => cloneHostBrokerSnapshot(this.current);
    return diagnostics ? diagnostics.sync('clone', clone) : clone();
  }

  async transaction<T>(work: (transaction: HostBrokerTransaction) => Promise<T> | T): Promise<T> {
    return this.queue.run(async () => {
      const mutable = new MutableBrokerSnapshot(this.current);
      const result = await work(mutable);
      this.current = mutable.toSnapshot();
      return result;
    });
  }
}

export interface HostBrokerFileOps {
  readonly readFile: typeof readFile;
  readonly mkdir: typeof mkdir;
  readonly writeFile: typeof writeFile;
  readonly rename: typeof rename;
  readonly unlink: typeof unlink;
}

export interface FileHostBrokerStoreOptions {
  readonly fileOps?: Partial<HostBrokerFileOps>;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export class FileHostBrokerStore implements HostBrokerStore {
  readonly read = brokerReadPorts(this);
  readConnection(id: string) {
    return brokerReadConnection(this, id);
  }
  readonly path: string;
  private readonly queue: SerialQueue;
  private readonly fileOps: HostBrokerFileOps;

  constructor(path: string, options: FileHostBrokerStoreOptions = {}) {
    this.path = resolve(path);
    this.queue = fileQueue(this.path);
    this.fileOps = { readFile, mkdir, writeFile, rename, unlink, ...options.fileOps };
  }

  async snapshot(diagnostics?: SnapshotReadDiagnostics): Promise<HostBrokerSnapshot> {
    if (diagnostics) await diagnostics.measure('queue', () => this.queue.settled());
    else await this.queue.settled();
    const loaded = await this.load(diagnostics);
    const clone = () => cloneHostBrokerSnapshot(loaded);
    return diagnostics ? diagnostics.sync('clone', clone) : clone();
  }

  async transaction<T>(work: (transaction: HostBrokerTransaction) => Promise<T> | T): Promise<T> {
    return this.queue.run(async () => {
      const mutable = new MutableBrokerSnapshot(await this.load());
      const result = await work(mutable);
      // Keep the fresh read and serialized authority/effect boundary. A callback
      // that used no write port must not turn a check into a full JSON commit.
      if (!mutable.hasWrites()) return result;
      const next = mutable.toSnapshot();
      await this.fileOps.mkdir(dirname(this.path), { recursive: true });
      const temporaryPath = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
      await this.fileOps.writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      try {
        await this.fileOps.rename(temporaryPath, this.path);
      } catch (error) {
        try {
          await this.fileOps.unlink(temporaryPath);
        } catch {
          // Preserve the commit failure; temporary cleanup is best effort.
        }
        throw error;
      }
      return result;
    });
  }

  private async load(diagnostics?: SnapshotReadDiagnostics): Promise<HostBrokerSnapshot> {
    let migrated = false;
    try {
      await access(`${this.path}.state.sqlite`);
      migrated = true;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (migrated)
      throw new HostBrokerError('BROKER_INVARIANT', 'Legacy JSON store was migrated; use the SQLite state owner');
    let raw: string;
    try {
      const read = () => this.fileOps.readFile(this.path, 'utf8');
      raw = await (diagnostics ? diagnostics.measure('read', read) : read());
    } catch (error) {
      if (isNotFound(error)) return emptyHostBrokerSnapshot();
      throw error;
    }
    const parse = () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new HostBrokerError('CORRUPT_SNAPSHOT', `Host Broker snapshot at ${this.path} is not valid JSON`);
      }
      return parseHostBrokerSnapshot(parsed);
    };
    return diagnostics ? diagnostics.sync('parse', parse) : parse();
  }
}
