import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { canonicalInventoryPath } from '../host-inventory/writer-lease.js';
import { PluginStateClient, PluginStateWorkerExit } from './client.js';
import type { StateDomain, StateEntity, StateQuery } from './protocol.js';

const queues = new Map<string, Promise<void>>();
const acknowledged = new Map<string, string>();
export class StateStore {
  readonly path: string;
  private readonly queueKey: string;
  constructor(
    readonly domain: StateDomain,
    path: string,
    readonly client: PluginStateClient,
  ) {
    this.path = resolve(path);
    this.queueKey = canonicalInventoryPath(path);
  }
  async ready(): Promise<void> {
    await this.client.open(this.domain, this.path);
  }
  async get<T>(query: StateQuery, transaction?: string): Promise<T> {
    await this.ready();
    return this.client.request({ op: 'get', domain: this.domain, query, transaction });
  }
  async list<T>(query: StateQuery, transaction?: string): Promise<T[]> {
    await this.ready();
    const result: T[] = [];
    // Compatibility list callers explicitly request all matches. The worker only sends bounded row pages.
    const limit = 64;
    let afterRowid: number | undefined;
    for (;;) {
      const page = await this.client.request<{ records: T[]; afterRowid?: number }>({
        op: 'list',
        domain: this.domain,
        query: { ...query, limit, afterRowid },
        transaction,
      });
      result.push(...page.records);
      if (page.afterRowid === undefined) return result;
      afterRowid = page.afterRowid;
    }
  }
  async put(entity: StateEntity, value: unknown, transaction?: string): Promise<void> {
    if (!transaction) throw new Error('Plugin state read port cannot write');
    await this.client.request({ op: 'put', domain: this.domain, entity, value, transaction });
  }
  async run<T>(work: (transaction: string) => Promise<T>, onCommitFailure?: () => void): Promise<T> {
    const previous = queues.get(this.queueKey) ?? Promise.resolve();
    let release = () => {};
    const tail = new Promise<void>((done) => {
      release = done;
    });
    queues.set(this.queueKey, tail);
    await previous;
    const transaction = randomUUID();
    let active = false;
    let commitRequested = false;
    let result: T | undefined;
    try {
      await this.ready();
      await this.client.request({
        op: 'begin',
        domain: this.domain,
        transaction,
        acknowledgedTransaction: acknowledged.get(this.queueKey),
      });
      active = true;
      result = await work(transaction);
      commitRequested = true;
      await this.client.request({ op: 'commit', domain: this.domain, transaction });
      active = false;
      acknowledged.set(this.queueKey, transaction);
      return result;
    } catch (error) {
      if (commitRequested && error instanceof PluginStateWorkerExit) {
        const reader = new PluginStateClient();
        try {
          if (await reader.request<boolean>({ op: 'outcome', domain: this.domain, path: this.path, transaction })) {
            acknowledged.set(this.queueKey, transaction);
            return result as T;
          }
        } finally {
          await reader.close();
        }
      }
      try {
        onCommitFailure?.();
      } finally {
        if (active && this.client.running)
          await this.client.request({ op: 'rollback', domain: this.domain, transaction });
      }
      throw error;
    } finally {
      release();
      if (queues.get(this.queueKey) === tail) queues.delete(this.queueKey);
    }
  }
}
