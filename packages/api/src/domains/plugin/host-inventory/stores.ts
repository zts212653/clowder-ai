import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type {
  GrantStore,
  PackageInventoryStore,
  PluginInstanceStore,
  PluginInventoryStore,
  PluginInventoryTransaction,
} from './ports.js';
import {
  clonePluginInventorySnapshot,
  emptyPluginInventorySnapshot,
  parsePluginInventorySnapshot,
} from './snapshot.js';
import type { PluginGrantRecord, PluginInstanceRecord, PluginInventorySnapshot, PluginPackageRecord } from './types.js';
import { PluginInventoryError } from './types.js';

interface TransactionState {
  readonly packages: Map<string, PluginPackageRecord>;
  readonly instances: Map<string, PluginInstanceRecord>;
  readonly grants: Map<string, PluginGrantRecord>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function transactionFor(snapshot: PluginInventorySnapshot): {
  readonly transaction: PluginInventoryTransaction;
  readonly snapshot: () => PluginInventorySnapshot;
} {
  const state: TransactionState = {
    packages: new Map(snapshot.packages.map((record) => [record.packageDigest, clone(record)])),
    instances: new Map(snapshot.instances.map((record) => [record.pluginInstanceId, clone(record)])),
    grants: new Map(snapshot.grants.map((record) => [record.pluginInstanceId, clone(record)])),
  };
  const packages: PackageInventoryStore = {
    get: (digest) => {
      const value = state.packages.get(digest);
      return value ? clone(value) : undefined;
    },
    list: () => [...state.packages.values()].map(clone),
    put: (record) => state.packages.set(record.packageDigest, clone(record)),
  };
  const instances: PluginInstanceStore = {
    get: (instanceId) => {
      const value = state.instances.get(instanceId);
      return value ? clone(value) : undefined;
    },
    getCurrent: (pluginId) => {
      const value = [...state.instances.values()].find(
        (record) => record.pluginId === pluginId && record.lifecycleState === 'installed',
      );
      return value ? clone(value) : undefined;
    },
    list: () => [...state.instances.values()].map(clone),
    put: (record) => state.instances.set(record.pluginInstanceId, clone(record)),
  };
  const grants: GrantStore = {
    get: (instanceId) => {
      const value = state.grants.get(instanceId);
      return value ? clone(value) : undefined;
    },
    list: () => [...state.grants.values()].map(clone),
    put: (record) => state.grants.set(record.pluginInstanceId, clone(record)),
  };
  return {
    transaction: { packages, instances, grants },
    snapshot: () =>
      parsePluginInventorySnapshot({
        schemaVersion: 1,
        packages: [...state.packages.values()],
        instances: [...state.instances.values()],
        grants: [...state.grants.values()],
      }),
  };
}

class TransactionQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
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

const fileTransactionQueues = new Map<string, TransactionQueue>();

function fileQueue(path: string): TransactionQueue {
  let queue = fileTransactionQueues.get(path);
  if (!queue) {
    queue = new TransactionQueue();
    fileTransactionQueues.set(path, queue);
  }
  return queue;
}

export interface InventoryFileOps {
  readonly readFile: typeof readFile;
  readonly mkdir: typeof mkdir;
  readonly writeFile: typeof writeFile;
  readonly rename: typeof rename;
  readonly unlink: typeof unlink;
}

export interface FilePluginInventoryStoreOptions {
  readonly fileOps?: Partial<InventoryFileOps>;
}

export class MemoryPluginInventoryStore implements PluginInventoryStore {
  private state: PluginInventorySnapshot;
  private readonly queue = new TransactionQueue();

  constructor(initial?: unknown) {
    this.state = initial === undefined ? emptyPluginInventorySnapshot() : parsePluginInventorySnapshot(initial);
  }

  async snapshot(): Promise<PluginInventorySnapshot> {
    await this.queue.settled();
    return clonePluginInventorySnapshot(this.state);
  }

  async transaction<T>(work: (transaction: PluginInventoryTransaction) => Promise<T> | T): Promise<T> {
    return this.queue.run(async () => {
      const candidate = transactionFor(this.state);
      const result = await work(candidate.transaction);
      this.state = candidate.snapshot();
      return result;
    });
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export class FilePluginInventoryStore implements PluginInventoryStore {
  readonly path: string;
  private readonly queue: TransactionQueue;
  private readonly fileOps: InventoryFileOps;

  constructor(path: string, options: FilePluginInventoryStoreOptions = {}) {
    this.path = resolve(path);
    this.queue = fileQueue(this.path);
    this.fileOps = { readFile, mkdir, writeFile, rename, unlink, ...options.fileOps };
  }

  private async load(): Promise<PluginInventorySnapshot> {
    let raw: string;
    try {
      raw = await this.fileOps.readFile(this.path, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return emptyPluginInventorySnapshot();
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new PluginInventoryError('CORRUPT_SNAPSHOT', `plugin inventory at ${this.path} is not valid JSON`);
    }
    return parsePluginInventorySnapshot(parsed);
  }

  async snapshot(): Promise<PluginInventorySnapshot> {
    await this.queue.settled();
    return clonePluginInventorySnapshot(await this.load());
  }

  async transaction<T>(work: (transaction: PluginInventoryTransaction) => Promise<T> | T): Promise<T> {
    return this.queue.run(async () => {
      const candidate = transactionFor(await this.load());
      const result = await work(candidate.transaction);
      const next = candidate.snapshot();
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
}
