import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isMainThread, MessageChannel, type MessagePort, receiveMessageOnPort } from 'node:worker_threads';
import {
  MAX_PENDING_EXECUTION_REQUESTS,
  PluginExecutionWorkerError,
  type RemoteCallContext,
  type RemoteMessage,
  type RemoteValue,
} from './protocol.js';
import { RemoteValues } from './remote-values.js';
import { messageTransfers, valueTransfers } from './transfer-values.js';

export type RestoreExecutionContext = <T>(run: () => T) => T;
export interface RpcPeerOptions {
  readonly baseContext?: RestoreExecutionContext;
  readonly captureContext?: () => RestoreExecutionContext | undefined;
  readonly reserve?: (teardown: boolean) => (() => void) | undefined;
  readonly synchronousState?: SharedArrayBuffer;
  readonly onTransportClose?: () => Promise<Error>;
}
interface Pending {
  readonly resolve: (value: RemoteValue) => void;
  readonly reject: (error: unknown) => void;
  readonly teardown: boolean;
}
interface IncomingCallScope {
  readonly context: RemoteCallContext;
  active: boolean;
}

/** Asynchronous on the API side; only an execution worker may wait on a synchronous Host assertion. */
export class ExecutionRpcPeer {
  readonly #values: RemoteValues;
  readonly #pending = new Map<string, Pending>();
  readonly #contexts = new Map<string, RestoreExecutionContext>();
  readonly #context = new AsyncLocalStorage<IncomingCallScope>();
  #closed: Error | undefined;
  #transportClosing = false;
  readonly #pendingCounts = { business: 0, teardown: 0 };
  readonly #closeListeners = new Set<(error: Error) => void>();
  readonly #synchronousState: Int32Array;

  constructor(
    private readonly port: MessagePort,
    private readonly options: RpcPeerOptions = {},
  ) {
    this.#synchronousState = new Int32Array(
      options.synchronousState ?? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2),
    );
    this.#values = new RemoteValues({
      call: (id, args, teardown) => this.call(id, args, teardown),
      callSync: (id, args) => this.#callSync(id, args),
      abort: (id, reason) => this.#post({ kind: 'abort', id, reason }),
      release: (id) => this.#post({ kind: 'release', ids: [id] }),
    });
    port.on('message', (message: RemoteMessage) => this.#receive(message));
    port.on('messageerror', () =>
      this.#transportLost(new PluginExecutionWorkerError('Execution message could not be decoded')),
    );
    port.on('close', () => this.#transportLost(new PluginExecutionWorkerError('Execution lease closed')));
    port.start();
  }

  expose(id: string, fn: (...args: unknown[]) => unknown): void {
    this.#values.expose(id, fn);
  }
  get closed(): boolean {
    return this.#closed !== undefined;
  }
  onClose(listener: (error: Error) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  #post(message: RemoteMessage): void {
    if (this.#closed) return;
    try {
      this.port.postMessage(message, messageTransfers(message));
    } catch (error) {
      this.#transportLost(error instanceof Error ? error : new PluginExecutionWorkerError('Execution message failed'));
    }
  }

  async call(target: string, args: readonly unknown[], teardown = false): Promise<unknown> {
    if (this.#closed) throw this.#closed;
    if (this.#transportClosing) throw new PluginExecutionWorkerError('Execution teardown is pending');
    const inherited = this.#inheritedContext();
    const disposing = teardown || inherited?.teardown === true;
    const lane = disposing ? 'teardown' : 'business';
    if (this.#pendingCounts[lane] >= MAX_PENDING_EXECUTION_REQUESTS)
      throw new PluginExecutionWorkerError('Execution request capacity is busy');
    const release = this.options.reserve?.(disposing);
    const id = randomUUID();
    const { context, finish } = this.#callContext(id, disposing, inherited);
    let retain = false;
    try {
      const encoded = this.#values.encode(args, id);
      const result = new Promise<RemoteValue>((resolve, reject) => {
        this.#pending.set(id, { resolve, reject, teardown: disposing });
        this.#pendingCounts[lane]++;
      });
      this.#post({
        kind: 'call',
        id,
        target,
        args: encoded,
        context,
      });
      const decoded = this.#values.decodeResponse(await result, finish);
      retain = decoded.retained;
      return decoded.value;
    } finally {
      release?.();
      if (!retain) finish();
    }
  }

  #inheritedContext(): RemoteCallContext | undefined {
    const scope = this.#context.getStore();
    return scope?.active ? scope.context : undefined;
  }

  #callContext(id: string, teardown: boolean, inherited: RemoteCallContext | undefined) {
    const restore = this.options.captureContext?.();
    const authorityId = restore ? randomUUID() : inherited?.authorityId;
    if (restore && authorityId) this.#contexts.set(authorityId, restore);
    const context: RemoteCallContext = {
      ...(inherited && !isMainThread ? inherited : { rootId: id }),
      ...(authorityId ? { authorityId } : {}),
      ...(teardown ? { teardown: true } : {}),
    };
    return {
      context,
      finish: () => {
        this.#values.end(id);
        if (restore && authorityId) this.#contexts.delete(authorityId);
      },
    };
  }

  #callSync(target: string, args: readonly unknown[]): unknown {
    if (isMainThread) throw new PluginExecutionWorkerError('API execution cannot synchronously wait on a plugin');
    if (this.#closed) throw this.#closed;
    const id = randomUUID();
    const context = this.#inheritedContext() ?? { rootId: id };
    const { port1, port2 } = new MessageChannel();
    const state = this.#synchronousState.buffer as SharedArrayBuffer;
    try {
      if (Atomics.load(this.#synchronousState, 1)) throw new PluginExecutionWorkerError('Execution lease closed');
      Atomics.store(this.#synchronousState, 0, 0);
      if (Atomics.load(this.#synchronousState, 1)) throw new PluginExecutionWorkerError('Execution lease closed');
      const encoded = this.#values.encode(args, id);
      this.port.postMessage(
        {
          kind: 'call',
          id,
          target,
          args: encoded,
          context,
          synchronous: { port: port2, state },
        } satisfies RemoteMessage,
        [port2, ...valueTransfers(encoded)],
      );
      Atomics.wait(this.#synchronousState, 0, 0);
      if (Atomics.load(this.#synchronousState, 1)) throw new PluginExecutionWorkerError('Execution lease closed');
      const reply = receiveMessageOnPort(port1)?.message as Extract<RemoteMessage, { kind: 'result' }> | undefined;
      if (!reply) throw new PluginExecutionWorkerError('Synchronous Host assertion lost its response');
      const value = this.#values.decode(reply.value);
      if (!reply.returned) throw value;
      return value;
    } finally {
      this.#values.end(id);
      port1.close();
      port2.close();
    }
  }

  #receive(message: RemoteMessage): void {
    if (this.#closed) return;
    if (message.kind === 'abort') {
      this.#values.abort(message.id, message.reason);
      return;
    }
    if (message.kind === 'release') {
      this.#values.release(message.ids);
      return;
    }
    if (message.kind === 'result') {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      this.#pendingCounts[pending.teardown ? 'teardown' : 'business']--;
      try {
        if (message.returned) pending.resolve(message.value);
        else pending.reject(this.#values.decode(message.value));
      } catch (error) {
        pending.reject(error);
      }
      return;
    }
    void this.#serve(message);
  }

  async #serve(message: Extract<RemoteMessage, { kind: 'call' }>): Promise<void> {
    let returned = false;
    let value: RemoteValue;
    const incoming: IncomingCallScope = { context: message.context, active: true };
    const finish = () => {
      incoming.active = false;
    };
    let retain = false;
    const scope = isMainThread && this.#pending.has(message.context.rootId) ? message.context.rootId : 'retained';
    try {
      const restore = message.context.authorityId
        ? this.#contexts.get(message.context.authorityId)
        : this.options.baseContext;
      if (isMainThread && message.context.authorityId && !restore)
        throw new PluginExecutionWorkerError('Calling authority has ended');
      const run = () =>
        this.#context.run(incoming, () =>
          this.#values.invoke(message.target, this.#values.decode(message.args) as unknown[]),
        );
      const result = await (restore ? restore(run) : run());
      if (this.#closed) {
        message.synchronous?.port.close();
        return;
      }
      const encode = () => this.#context.run(incoming, () => this.#values.encodeResponse(result, scope, finish));
      const encoded = restore ? restore(encode) : encode();
      value = encoded.value;
      retain = encoded.retained;
      returned = true;
    } catch (error) {
      if (this.#closed) {
        message.synchronous?.port.close();
        return;
      }
      value = this.#values.encode(error, scope);
    } finally {
      // Detached work keeps its activation but must not inherit a completed call's authority.
      if (!retain) finish();
    }
    const reply: RemoteMessage = { kind: 'result', id: message.id, returned, value };
    this.#reply(message, reply);
  }

  #reply(message: Extract<RemoteMessage, { kind: 'call' }>, reply: Extract<RemoteMessage, { kind: 'result' }>): void {
    if (message.synchronous) {
      try {
        message.synchronous.port.postMessage(reply, messageTransfers(reply));
      } catch (error) {
        this.close(error instanceof Error ? error : new PluginExecutionWorkerError('Host assertion response failed'));
      } finally {
        Atomics.store(new Int32Array(message.synchronous.state), 0, 1);
        Atomics.notify(new Int32Array(message.synchronous.state), 0);
        message.synchronous.port.close();
      }
    } else this.#post(reply);
  }

  close(error = new PluginExecutionWorkerError('Execution lease closed')): void {
    if (this.#closed) return;
    this.#closed = error;
    Atomics.store(this.#synchronousState, 1, 1);
    Atomics.store(this.#synchronousState, 0, 2);
    Atomics.notify(this.#synchronousState, 0);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#pendingCounts.business = 0;
    this.#pendingCounts.teardown = 0;
    this.#contexts.clear();
    this.#values.close();
    this.port.close();
    for (const listener of this.#closeListeners) listener(error);
    this.#closeListeners.clear();
  }

  #transportLost(error: Error): void {
    if (this.#closed || this.#transportClosing) return;
    if (!this.options.onTransportClose) {
      this.close(error);
      return;
    }
    this.#transportClosing = true;
    void this.options.onTransportClose().then(
      (exit) => this.close(exit),
      (failure: unknown) => {
        this.close(
          failure instanceof Error ? failure : new PluginExecutionWorkerError('Execution teardown could not be proven'),
        );
      },
    );
  }
}
