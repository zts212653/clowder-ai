import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { isMainThread } from 'node:worker_threads';
import { ExternalPluginRuntimeError, type ExternalPluginRuntimeErrorCode } from '../external-runtime/types.js';
import { PluginExecutionWorkerError, type RemoteValue, RetainedRemoteValue, TeardownRemoteValue } from './protocol.js';
import { ResponseLifetime } from './response-lifetime.js';

type Callable = (...args: unknown[]) => unknown;
interface FunctionEntry {
  readonly value: Callable;
  readonly receiver: unknown;
  readonly scope: Scope;
}
interface Scope {
  readonly functions: Set<string>;
  readonly cleanups: Set<() => void>;
}
export interface RemoteValueCalls {
  call(id: string, args: readonly unknown[], teardown?: boolean): Promise<unknown>;
  callSync(id: string, args: readonly unknown[]): unknown;
  abort(id: string, reason: RemoteValue): void;
  release(id: string): void;
}

/** Values, callable capabilities, pull streams and cancellation; never a Host store snapshot. */
export class RemoteValues {
  readonly #functions = new Map<string, FunctionEntry>();
  readonly #errors = new Map<string, WeakRef<Error>>();
  readonly #remoteErrors = new WeakMap<Error, string>();
  readonly #signals = new Map<string, AbortController>();
  readonly #scopes = new Map<string, Scope>();
  readonly #readables = new Set<Readable>();
  readonly #finalizedErrors = new FinalizationRegistry<string>((id) => this.#errors.delete(id));
  readonly #remoteFunctions = new Map<string, WeakRef<Callable>>();
  readonly #finalizedFunctions = new FinalizationRegistry<string>((id) => {
    this.#remoteFunctions.delete(id);
    this.calls.release(id);
  });

  constructor(private readonly calls: RemoteValueCalls) {}

  #scope(id: string): Scope {
    let scope = this.#scopes.get(id);
    if (!scope) {
      scope = { functions: new Set(), cleanups: new Set() };
      this.#scopes.set(id, scope);
    }
    return scope;
  }

  expose(id: string, value: Callable): void {
    const scope = this.#scope('retained');
    this.#functions.set(id, { value, receiver: undefined, scope });
    scope.functions.add(id);
  }

  invoke(id: string, args: readonly unknown[]): unknown {
    const entry = this.#functions.get(id);
    if (!entry) throw new PluginExecutionWorkerError('Execution capability is no longer current');
    return Reflect.apply(entry.value, entry.receiver, args);
  }

  release(ids: readonly string[]): void {
    for (const id of ids) {
      this.#functions.get(id)?.scope.functions.delete(id);
      this.#functions.delete(id);
    }
  }

  end(scopeId: string): void {
    const scope = this.#scopes.get(scopeId);
    if (!scope) return;
    for (const id of scope.functions) this.#functions.delete(id);
    for (const cleanup of scope.cleanups) cleanup();
    this.#scopes.delete(scopeId);
  }

  close(): void {
    for (const stream of this.#readables) stream.destroy();
    this.#readables.clear();
    for (const id of [...this.#scopes.keys()]) this.end(id);
    this.#functions.clear();
    this.#errors.clear();
    for (const controller of this.#signals.values())
      controller.abort(new DOMException('Execution lease ended', 'AbortError'));
    this.#signals.clear();
    this.#remoteFunctions.clear();
  }

  encodeResponse(value: unknown, scopeId: string, retire: () => void): { value: RemoteValue; retained: boolean } {
    const lifetime = new ResponseLifetime(retire);
    const encoded = this.encode(value, scopeId, [], undefined, lifetime);
    return { value: encoded, retained: lifetime.complete() };
  }

  decodeResponse(value: RemoteValue, retire: () => void): { value: unknown; retained: boolean } {
    const lifetime = new ResponseLifetime(retire);
    const decoded = this.decode(value, lifetime);
    return { value: decoded, retained: lifetime.complete() };
  }

  encode(
    value: unknown,
    scopeId: string,
    path: readonly string[] = [],
    receiver?: unknown,
    lifetime?: ResponseLifetime,
  ): RemoteValue {
    if (value instanceof RetainedRemoteValue) return this.encode(value.value, 'retained', path, receiver, lifetime);
    if (value instanceof TeardownRemoteValue) {
      if (typeof value.value !== 'function') throw new TypeError('Execution disposer must be callable');
      return this.#encodeFunction(value.value as Callable, scopeId, receiver, 'teardown');
    }
    if (typeof value === 'function') {
      return this.#encodeCallable(value as Callable, scopeId, path, receiver);
    }
    if (value instanceof Error) return this.#encodeError(value, scopeId, lifetime);
    if (value instanceof AbortSignal) {
      return this.#encodeSignal(value, scopeId, lifetime);
    }
    if (value instanceof Readable) {
      this.#trackReadable(value, scopeId);
      lifetime?.readable(value);
      return {
        kind: 'readable',
        objectMode: value.readableObjectMode,
        highWaterMark: value.readableHighWaterMark,
        stream: Readable.toWeb(value, { strategy: { highWaterMark: 1, size: () => 1 } }),
      };
    }
    if (value && typeof value === 'object' && Symbol.asyncIterator in value) {
      return this.#encodeIterator(value as AsyncIterable<unknown>, scopeId, lifetime);
    }
    if (Array.isArray(value))
      return { kind: 'array', items: value.map((item) => this.encode(item, scopeId, [], undefined, lifetime)) };
    if (
      value &&
      typeof value === 'object' &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    ) {
      return {
        kind: 'object',
        entries: Object.entries(value).map(
          ([key, child]) => [key, this.encode(child, scopeId, [...path, key], value, lifetime)] as const,
        ),
      };
    }
    return { kind: 'data', value };
  }

  #encodeIterator(value: AsyncIterable<unknown>, scopeId: string, lifetime?: ResponseLifetime): RemoteValue {
    const source = value[Symbol.asyncIterator]();
    const iterator = lifetime ? lifetime.iterator(source) : source;
    return {
      kind: 'iterator',
      next: this.encode((...args: unknown[]) => iterator.next(...(args as [] | [unknown])), scopeId),
      end: this.encode(
        new TeardownRemoteValue(async () => {
          await iterator.return?.();
          return { done: true };
        }),
        scopeId,
      ),
    };
  }

  decode(value: RemoteValue, lifetime?: ResponseLifetime): unknown {
    switch (value.kind) {
      case 'data':
        return value.value;
      case 'array':
        return value.items.map((item) => this.decode(item, lifetime));
      case 'object':
        return Object.fromEntries(value.entries.map(([key, item]) => [key, this.decode(item, lifetime)]));
      case 'return-error': {
        const original = this.#errors.get(value.id)?.deref();
        if (original && !lifetime) return original;
        return this.#decodeError(value, lifetime, original);
      }
      case 'error': {
        return this.#decodeError(value, lifetime);
      }
      case 'function':
        return this.#function(value);
      case 'readable': {
        const stream = Readable.fromWeb(value.stream, {
          objectMode: value.objectMode,
          highWaterMark: value.highWaterMark,
        });
        this.#trackReadable(stream);
        lifetime?.readable(stream);
        return stream;
      }
      case 'iterator': {
        const next = this.decode(value.next) as () => Promise<IteratorResult<unknown>>;
        const end = this.decode(value.end) as () => Promise<IteratorResult<unknown>>;
        const iterator = {
          [Symbol.asyncIterator]() {
            return this;
          },
          next,
          return: end,
        };
        return lifetime ? lifetime.iterator(iterator) : iterator;
      }
      case 'signal': {
        const controller = new AbortController();
        const flag = new Int32Array(value.state);
        const reason = this.decode(value.reason, lifetime);
        if (Atomics.load(flag, 0)) controller.abort(reason);
        this.#signals.set(value.id, controller);
        const signal = controller.signal;
        const originalThrow = signal.throwIfAborted.bind(signal);
        Object.defineProperty(signal, 'aborted', { get: () => Atomics.load(flag, 0) !== 0 });
        signal.throwIfAborted = () => {
          if (Atomics.load(flag, 0) && controller.signal.reason === undefined)
            throw new DOMException('Aborted', 'AbortError');
          originalThrow();
        };
        return signal;
      }
    }
  }

  abort(id: string, reason: RemoteValue): void {
    this.#signals.get(id)?.abort(this.decode(reason));
    this.#signals.delete(id);
  }

  #trackReadable(stream: Readable, scopeId?: string): void {
    if (stream.closed) return;
    if (!this.#readables.has(stream)) {
      this.#readables.add(stream);
      // The consumer still receives errors; a transfer may fail before it attaches a reader.
      stream.on('error', () => {});
      stream.once('close', () => this.#readables.delete(stream));
    }
    if (scopeId && !stream.closed) {
      const scope = this.#scope(scopeId);
      const dispose = () => {
        stream.destroy();
      };
      scope.cleanups.add(dispose);
      stream.once('close', () => scope.cleanups.delete(dispose));
    }
  }

  #encodeCallable(value: Callable, scopeId: string, path: readonly string[], receiver: unknown): RemoteValue {
    const mode =
      path.slice(-2).join('.') === 'streams.read'
        ? 'stream'
        : isMainThread && ['assertWriteCurrent', 'readSessionId'].includes(path.at(-1) ?? '')
          ? 'sync'
          : 'async';
    return this.#encodeFunction(value, scopeId, receiver, mode);
  }

  #encodeError(value: Error, scopeId: string, lifetime?: ResponseLifetime): RemoteValue {
    const remoteId = this.#remoteErrors.get(value);
    const id = remoteId ?? randomUUID();
    if (!remoteId) {
      this.#errors.set(id, new WeakRef(value));
      this.#finalizedErrors.register(value, id);
    }
    return {
      kind: remoteId ? 'return-error' : 'error',
      id,
      name: value.name,
      message: value.message,
      ...(value.stack === undefined ? {} : { stack: value.stack }),
      fields: this.encode(Object.fromEntries(Object.entries(value)), scopeId, [], undefined, lifetime),
    };
  }

  #encodeSignal(value: AbortSignal, scopeId: string, lifetime?: ResponseLifetime): RemoteValue {
    const id = randomUUID();
    const state = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const flag = new Int32Array(state);
    const abort = () => {
      Atomics.store(flag, 0, 1);
      this.calls.abort(id, this.encode(value.reason, scopeId));
    };
    if (value.aborted) Atomics.store(flag, 0, 1);
    else value.addEventListener('abort', abort, { once: true });
    this.#scope(scopeId).cleanups.add(() => {
      value.removeEventListener('abort', abort);
      Atomics.store(flag, 0, 1);
      this.calls.abort(id, this.encode(new DOMException('Execution call ended', 'AbortError'), 'retained'));
    });
    return { kind: 'signal', id, state, reason: this.encode(value.reason, scopeId, [], undefined, lifetime) };
  }

  #decodeError(
    value: Extract<RemoteValue, { kind: 'error' | 'return-error' }>,
    lifetime?: ResponseLifetime,
    original?: Error,
  ): Error {
    const fields = this.decode(value.fields, lifetime) as Record<string, unknown>;
    const error =
      original ??
      (value.name === 'ExternalPluginRuntimeError' && typeof fields.code === 'string'
        ? new ExternalPluginRuntimeError(fields.code as ExternalPluginRuntimeErrorCode, value.message)
        : new Error(value.message));
    if (!original) {
      error.name = value.name;
      if (value.stack) error.stack = value.stack;
      this.#remoteErrors.set(error, value.id);
    }
    Object.assign(error, fields);
    return error;
  }

  #encodeFunction(
    value: Callable,
    scopeId: string,
    receiver: unknown,
    mode: Extract<RemoteValue, { kind: 'function' }>['mode'],
  ): RemoteValue {
    const id = randomUUID();
    const scope = this.#scope(scopeId);
    this.#functions.set(id, { value, receiver, scope });
    scope.functions.add(id);
    return { kind: 'function', id, mode };
  }

  #function(value: Extract<RemoteValue, { kind: 'function' }>): Callable {
    const prior = this.#remoteFunctions.get(value.id)?.deref();
    if (prior) return prior;
    const calls = this.calls;
    const fn: Callable =
      value.mode === 'stream'
        ? async function* (...args) {
            const stream = (await calls.call(value.id, args)) as AsyncIterable<unknown>;
            yield* stream;
          }
        : value.mode === 'sync' && !isMainThread
          ? (...args) => calls.callSync(value.id, args)
          : (...args) => calls.call(value.id, args, value.mode === 'teardown');
    this.#remoteFunctions.set(value.id, new WeakRef(fn));
    this.#finalizedFunctions.register(fn, value.id);
    return fn;
  }
}
