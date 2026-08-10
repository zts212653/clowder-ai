import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type {
  BrokerCallStore,
  BrokerRuntimeLeaseStore,
  BrokerSessionStore,
  HostBrokerStore,
  HostBrokerTransaction,
} from './ports.js';
import { cloneHostBrokerSnapshot, emptyHostBrokerSnapshot, parseHostBrokerSnapshot } from './snapshot.js';
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
  private readonly sessionRecords = new Map<string, BrokerSessionRecord>();
  private readonly runtimeLeaseRecords = new Map<string, BrokerRuntimeLeaseRecord>();
  private readonly callRecords = new Map<string, BrokerCallRecord>();

  readonly sessions: BrokerSessionStore = {
    getByConnectionId: (connectionId) => this.clone(this.sessionRecords.get(connectionId)),
    getBySessionId: (brokerSessionId) =>
      this.clone([...this.sessionRecords.values()].find((record) => record.brokerSessionId === brokerSessionId)),
    list: () => [...this.sessionRecords.values()].map((record) => structuredClone(record)),
    put: (record) => this.sessionRecords.set(record.connectionId, structuredClone(record)),
  };

  readonly runtimeLeases: BrokerRuntimeLeaseStore = {
    get: (runtimeLeaseId) => this.clone(this.runtimeLeaseRecords.get(runtimeLeaseId)),
    list: () => [...this.runtimeLeaseRecords.values()].map((record) => structuredClone(record)),
    put: (record) => this.runtimeLeaseRecords.set(record.runtimeLeaseId, structuredClone(record)),
  };

  readonly calls: BrokerCallStore = {
    get: (ledgerKey) => this.clone(this.callRecords.get(ledgerKey)),
    list: () => [...this.callRecords.values()].map((record) => structuredClone(record)),
    put: (record) => this.callRecords.set(record.ledgerKey, structuredClone(record)),
  };

  constructor(snapshot: HostBrokerSnapshot) {
    for (const record of snapshot.sessions) this.sessionRecords.set(record.connectionId, structuredClone(record));
    for (const record of snapshot.runtimeLeases) {
      this.runtimeLeaseRecords.set(record.runtimeLeaseId, structuredClone(record));
    }
    for (const record of snapshot.calls) this.callRecords.set(record.ledgerKey, structuredClone(record));
  }

  toSnapshot(): HostBrokerSnapshot {
    return {
      schemaVersion: HOST_BROKER_SCHEMA_VERSION,
      sessions: this.sessions.list(),
      runtimeLeases: this.runtimeLeases.list(),
      calls: this.calls.list(),
    };
  }

  private clone<T>(value: T | undefined): T | undefined {
    return value === undefined ? undefined : structuredClone(value);
  }
}

export class MemoryHostBrokerStore implements HostBrokerStore {
  private current: HostBrokerSnapshot;
  private readonly queue = new SerialQueue();

  constructor(initial: unknown = emptyHostBrokerSnapshot()) {
    this.current = parseHostBrokerSnapshot(initial);
  }

  async snapshot(): Promise<HostBrokerSnapshot> {
    await this.queue.settled();
    return cloneHostBrokerSnapshot(this.current);
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
  readonly path: string;
  private readonly queue: SerialQueue;
  private readonly fileOps: HostBrokerFileOps;

  constructor(path: string, options: FileHostBrokerStoreOptions = {}) {
    this.path = resolve(path);
    this.queue = fileQueue(this.path);
    this.fileOps = { readFile, mkdir, writeFile, rename, unlink, ...options.fileOps };
  }

  async snapshot(): Promise<HostBrokerSnapshot> {
    await this.queue.settled();
    return cloneHostBrokerSnapshot(await this.load());
  }

  async transaction<T>(work: (transaction: HostBrokerTransaction) => Promise<T> | T): Promise<T> {
    return this.queue.run(async () => {
      const mutable = new MutableBrokerSnapshot(await this.load());
      const result = await work(mutable);
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

  private async load(): Promise<HostBrokerSnapshot> {
    let raw: string;
    try {
      raw = await this.fileOps.readFile(this.path, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return emptyHostBrokerSnapshot();
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HostBrokerError('CORRUPT_SNAPSHOT', `Host Broker snapshot at ${this.path} is not valid JSON`);
    }
    return parseHostBrokerSnapshot(parsed);
  }
}
