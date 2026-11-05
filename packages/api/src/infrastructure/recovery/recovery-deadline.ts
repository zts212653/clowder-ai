import { AsyncLocalStorage } from 'node:async_hooks';

interface RecoveryScope {
  controller: AbortController;
  deadline: number;
  clock(): number;
}
const scopes = new AsyncLocalStorage<RecoveryScope>();
export class RecoveryDeadlineExceeded extends Error {
  constructor() {
    super('recovery_deadline_exceeded');
  }
}

/** Owner I/O boundaries use this fence before entering and after returning from an await. */
export function assertRecoveryCurrent(): void {
  const scope = scopes.getStore();
  assertScope(scope);
}

function assertScope(scope: RecoveryScope | undefined): void {
  if (scope && (scope.controller.signal.aborted || scope.clock() >= scope.deadline))
    throw new RecoveryDeadlineExceeded();
}

/** A resource created by an attempt retains that attempt's fence, including outside its async caller. */
export function captureRecoveryFence(): { assertCurrent(): void; onAbort(cleanup: () => void): void } {
  const scope = scopes.getStore();
  return {
    assertCurrent() {
      assertScope(scope);
      assertRecoveryCurrent();
    },
    onAbort(cleanup) {
      if (!scope) return;
      if (scope.controller.signal.aborted) cleanup();
      else scope.controller.signal.addEventListener('abort', cleanup, { once: true });
    },
  };
}

/** Durable Queue admission transfers responsibility to its own execution, never the sweep's deadline. */
export function outsideRecoveryDeadline<T>(action: () => T): T {
  if (!scopes.getStore()) return action();
  assertRecoveryCurrent();
  return scopes.exit(action);
}

export async function withinRecoveryDeadline<T>(
  deadline: number,
  clock: () => number,
  action: () => T | Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => {
        controller.abort();
        reject(new RecoveryDeadlineExceeded());
      },
      Math.max(0, deadline - clock()),
    );
  });
  try {
    return await scopes.run({ controller, deadline, clock }, async () => {
      assertRecoveryCurrent();
      return await Promise.race([Promise.resolve().then(action), expired]);
    });
  } finally {
    if (timer) clearTimeout(timer);
    // Retained continuations keep their original aborted scope, never a later batch's authority.
    controller.abort();
  }
}

/** Preserve original owner objects and CAS policy; add cancellation checkpoints to their I/O ports. */
export function recoveryGuarded<T extends object>(port: T): T {
  const cache = new WeakMap<object, object>();
  function wrap<V extends object>(target: V): V {
    const old = cache.get(target);
    if (old) return old as V;
    const proxy = new Proxy(target, {
      get(object, key) {
        const value: unknown = Reflect.get(object, key, object);
        if (typeof value === 'function')
          return (...args: unknown[]) => {
            assertRecoveryCurrent();
            const result: unknown = Reflect.apply(value, object, args);
            if (result instanceof Promise)
              return result.then(
                (value) => {
                  assertRecoveryCurrent();
                  return value;
                },
                (error) => {
                  assertRecoveryCurrent();
                  throw error;
                },
              );
            assertRecoveryCurrent();
            return result;
          };
        return value && typeof value === 'object' ? wrap(value) : value;
      },
    });
    cache.set(target, proxy);
    return proxy;
  }
  return wrap(port);
}
