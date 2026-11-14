import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { MessageChannel, Worker } from 'node:worker_threads';
import { currentPluginCallContext, currentPluginOwnerRequestContext } from '../carrier/plugin-call-context.js';
import { currentOwnerOperation, currentOwnerOperationRequest } from '../carrier/plugin-owner-operation-context.js';
import { MAX_PENDING_EXECUTION_REQUESTS, PluginExecutionWorkerError, RetainedRemoteValue } from './protocol.js';
import { ExecutionRpcPeer, type RestoreExecutionContext } from './rpc-peer.js';

interface ExecutionProcess {
  readonly worker: Worker;
  readonly exited: Promise<Error>;
}

/** One lazy execution worker per Host composition; ports and capabilities belong to individual leases. */
export class ModuleExecutionWorker {
  readonly #baseContext = AsyncLocalStorage.snapshot() as RestoreExecutionContext;
  readonly #leases = new Set<ModuleExecutionLease>();
  #worker: ExecutionProcess | undefined;
  readonly #reserved = { business: 0, teardown: 0 };
  #retiring: Promise<unknown> = Promise.resolve();

  async lease(instanceId: string): Promise<ModuleExecutionLease> {
    for (;;) {
      const retiring = this.#retiring;
      await retiring;
      if (retiring === this.#retiring) break;
    }
    let process = this.#worker;
    if (!process) {
      if (this.#leases.size)
        throw new PluginExecutionWorkerError('Close exited execution leases before starting a new generation');
      const extension = new URL(import.meta.url).pathname.endsWith('.ts') ? 'ts' : 'js';
      const worker = new Worker(new URL(`./bootstrap.${extension}`, import.meta.url), { execArgv: [] });
      let complete!: (error: Error) => void;
      const exited = new Promise<Error>((resolve) => {
        complete = resolve;
      });
      const owned = { worker, exited };
      this.#worker = owned;
      process = owned;
      let failure: Error | undefined;
      worker.on('error', (error) => {
        failure = error;
      });
      worker.on('exit', (code) => {
        const error = failure ?? new PluginExecutionWorkerError(`Execution worker exited (${code})`);
        this.#failed(owned, error);
        complete(error);
      });
    }
    const { port1, port2 } = new MessageChannel();
    const synchronousState = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const owned = process;
    const peer = new ExecutionRpcPeer(port1, {
      synchronousState,
      baseContext: this.#baseContext,
      onTransportClose: async () => {
        await owned.worker.terminate();
        return owned.exited;
      },
      captureContext: () =>
        currentPluginCallContext(instanceId) ||
        currentPluginOwnerRequestContext(instanceId) ||
        currentOwnerOperation(instanceId) ||
        currentOwnerOperationRequest()
          ? (AsyncLocalStorage.snapshot() as RestoreExecutionContext)
          : undefined,
      reserve: (teardown) => {
        const lane = teardown ? 'teardown' : 'business';
        if (this.#reserved[lane] >= MAX_PENDING_EXECUTION_REQUESTS)
          throw new PluginExecutionWorkerError('Module execution capacity is busy');
        this.#reserved[lane]++;
        return () => {
          this.#reserved[lane]--;
        };
      },
    });
    const lease: ModuleExecutionLease = new ModuleExecutionLease(peer, (): Promise<void> => this.#release(lease));
    this.#leases.add(lease);
    process.worker.postMessage({ kind: 'open', id: randomUUID(), port: port2, synchronousState }, [port2]);
    return lease;
  }

  #failed(worker: ExecutionProcess, error: Error): void {
    if (this.#worker !== worker) return;
    this.#worker = undefined;
    for (const lease of [...this.#leases]) lease.failed(error);
  }

  async #release(lease: ModuleExecutionLease): Promise<void> {
    this.#leases.delete(lease);
    if (this.#leases.size || !this.#worker) return;
    const worker = this.#worker;
    this.#worker = undefined;
    const retiring = worker.worker.terminate();
    this.#retiring = retiring;
    await retiring;
  }
}

/** Explicit close clears callbacks and package references; no request replay or in-process fallback. */
export class ModuleExecutionLease {
  #closing: Promise<void> | undefined;
  #failed: Error | undefined;
  readonly #completion: Promise<Error | undefined>;
  #resolveCompletion!: (error: Error | undefined) => void;
  readonly #exitListeners = new Set<(error: Error) => void>();
  constructor(
    readonly peer: ExecutionRpcPeer,
    private readonly release: () => Promise<void>,
  ) {
    this.#completion = new Promise((resolve) => {
      this.#resolveCompletion = resolve;
    });
  }
  get exited(): boolean {
    return this.#failed !== undefined;
  }
  get failure(): Error | undefined {
    return this.#failed;
  }
  get completion(): Promise<Error | undefined> {
    return this.#completion;
  }
  onExit(listener: (error: Error) => void): void {
    if (this.#failed) listener(this.#failed);
    else this.#exitListeners.add(listener);
  }
  retain(value: unknown): RetainedRemoteValue {
    return new RetainedRemoteValue(value);
  }
  call<T>(method: string, ...args: readonly unknown[]): Promise<T> {
    return this.peer.call(method, args) as Promise<T>;
  }
  failed(error: Error): void {
    this.#failed = error;
    this.peer.close(error);
    for (const listener of this.#exitListeners) listener(error);
    this.#exitListeners.clear();
    this.#resolveCompletion(error);
  }
  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.peer.close();
      await this.release();
      this.#exitListeners.clear();
      this.#resolveCompletion(undefined);
    })();
    return this.#closing;
  }
}
