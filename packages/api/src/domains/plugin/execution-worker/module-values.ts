import { TeardownRemoteValue } from './protocol.js';

/** Only callable ABI surfaces cross the boundary; class internals and package globals stay in the worker. */
export function moduleActions(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.getOwnPropertyNames(value).map((key) => {
      const source = value as Record<string, unknown>;
      const method = source[key];
      return [
        key,
        typeof method === 'function'
          ? (...args: unknown[]) => {
              const current = source[key];
              if (typeof current !== 'function') throw new TypeError('Module action is no longer available');
              return Reflect.apply(current, source, args);
            }
          : method,
      ];
    }),
  );
}

export function moduleActivation(value: unknown): unknown {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value;
  const source = value as Record<string, unknown>;
  return {
    actions: moduleActions(source.actions),
    ...Object.fromEntries(
      ['stop', 'preStop', 'configRefresh', 'dispose']
        .filter((key) => typeof source[key] === 'function')
        .map((key) => {
          const invoke = (...args: unknown[]) =>
            Reflect.apply(source[key] as (...input: unknown[]) => unknown, source, args);
          return [key, key === 'configRefresh' ? invoke : new TeardownRemoteValue(invoke)];
        }),
    ),
    ...(source.streams &&
    typeof source.streams === 'object' &&
    'read' in source.streams &&
    typeof source.streams.read === 'function'
      ? { streams: { read: source.streams.read.bind(source.streams) } }
      : {}),
  };
}
