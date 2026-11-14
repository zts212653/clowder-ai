import { assertRecoveryCurrent, captureRecoveryFence } from './recovery-deadline.js';

const clients = new WeakMap<object, object>();

/** Only wrappers created here preserve transport identity; never expose an unguarded connection. */
export function sameRecoveryRedisClient(left: object, right: object): boolean {
  return (clients.get(left) ?? left) === (clients.get(right) ?? right);
}

/** Redis command/transaction builders are live I/O resources, not returned business data. */
export function recoveryRedis<T extends object>(redis: T): T {
  function wrap<V extends object>(target: V, fence?: ReturnType<typeof captureRecoveryFence>, owned = false): V {
    if (owned)
      fence?.onAbort(() => {
        const disconnect: unknown = Reflect.get(target, 'disconnect', target);
        if (typeof disconnect === 'function') Reflect.apply(disconnect, target, []);
      });
    const proxy = new Proxy(target, {
      get(object, key) {
        const method: unknown = Reflect.get(object, key, object);
        if (typeof method !== 'function') return method;
        // Disposal changes only this connection's resource state. It must survive cancellation.
        if (
          (owned && ['disconnect', 'quit', 'unwatch'].includes(String(key))) ||
          ['on', 'once', 'off', 'removeListener'].includes(String(key))
        )
          return method.bind(object);
        return (...args: unknown[]) => {
          fence?.assertCurrent();
          assertRecoveryCurrent();
          const result: unknown = Reflect.apply(method, object, args);
          if (result === object) return proxy;
          if (['duplicate', 'multi', 'pipeline'].includes(String(key)) && result && typeof result === 'object')
            return wrap(result, captureRecoveryFence(), key === 'duplicate');
          if (result instanceof Promise)
            return result.then(
              (value) => {
                fence?.assertCurrent();
                assertRecoveryCurrent();
                return value;
              },
              (error) => {
                fence?.assertCurrent();
                assertRecoveryCurrent();
                throw error;
              },
            );
          fence?.assertCurrent();
          assertRecoveryCurrent();
          return result;
        };
      },
    });
    return proxy;
  }
  const client = wrap(redis);
  clients.set(client, clients.get(redis) ?? redis);
  return client;
}
