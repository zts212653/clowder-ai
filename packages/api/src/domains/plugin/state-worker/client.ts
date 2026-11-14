import { Worker } from 'node:worker_threads';
import { HostBrokerError } from '../host-broker/types.js';
import { PluginInventoryError } from '../host-inventory/types.js';
import type { StateDomain, StateOperation, StateRequest, StateResponse } from './protocol.js';

export class PluginStateWorkerExit extends Error {}

/** One lazy worker per Host composition. Pending work keeps it alive; idle state does not. */
export class PluginStateClient {
  private worker?: Worker;
  private sequence = 0;
  private readonly opened = new Map<string, Promise<void>>();
  private workerError?: Error;
  get running(): boolean {
    return this.worker !== undefined && !this.closed;
  }
  open(domain: StateDomain, path: string): Promise<void> {
    const key = JSON.stringify([domain, path]);
    let pending = this.opened.get(key);
    if (!pending) {
      pending = this.request<void>({ op: 'open', domain, path });
      this.opened.set(key, pending);
    }
    return pending;
  }
  private closed = false;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  request<T>(operation: StateOperation): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Plugin state worker is closed'));
    const worker = this.worker ?? this.start();
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      worker.ref();
      try {
        worker.postMessage({ id, operation } satisfies StateRequest);
      } catch (error) {
        this.pending.delete(id);
        if (!this.pending.size) worker.unref();
        reject(error);
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.worker?.terminate();
    this.worker = undefined;
  }

  private start(): Worker {
    const extension = new URL(import.meta.url).pathname.endsWith('.ts') ? 'ts' : 'js';
    const worker = new Worker(new URL(`./bootstrap.${extension}`, import.meta.url), { execArgv: [] });
    worker.unref();
    worker.on('message', (response: StateResponse) => {
      const callback = this.pending.get(response.id);
      if (!callback) return;
      this.pending.delete(response.id);
      if ('error' in response) {
        const { name, message, code } = response.error;
        const error =
          name === 'PluginInventoryError'
            ? new PluginInventoryError(code as PluginInventoryError['code'], message)
            : name === 'HostBrokerError'
              ? new HostBrokerError(code as HostBrokerError['code'], message)
              : Object.assign(new Error(message), { name, ...(code ? { code } : {}) });
        callback.reject(error);
      } else callback.resolve(response.value);
      if (!this.pending.size) worker.unref();
    });
    worker.on('error', (error) => {
      this.workerError = error;
    });
    worker.on('exit', (code) => {
      this.worker = undefined;
      this.opened.clear();
      this.fail(new PluginStateWorkerExit(this.workerError?.message ?? `Plugin state worker exited (${code})`));
      this.workerError = undefined;
    });
    this.worker = worker;
    return worker;
  }

  private fail(error: Error): void {
    for (const callback of this.pending.values()) callback.reject(error);
    this.pending.clear();
  }
}
