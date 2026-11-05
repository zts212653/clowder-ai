import { ExternalPluginRuntimeError } from '../external-runtime/types.js';

function refuse(message: string): never {
  throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', message);
}

/** Protocol data only: no accessors, prototypes, symbols, functions or mutable aliases. */
export function snapshotPluginProtocolData(value: unknown, depth = 0): unknown {
  if (depth > 32) refuse('Predicate data nesting exceeds limit');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object') refuse('Predicate data must be plain JSON');
  const array = Array.isArray(value);
  if (!array && ![null, Object.prototype].includes(Object.getPrototypeOf(value))) refuse('Predicate data prototype');
  const keys = Reflect.ownKeys(value).filter((key) => !(array && key === 'length'));
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      refuse('Predicate data must contain only own enumerable data fields');
    }
    result[key] = snapshotPluginProtocolData(descriptor.value, depth + 1);
  }
  if (array) {
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index)))
      refuse('Invalid predicate array');
    return Object.freeze(keys.map((key) => result[key as string]));
  }
  // A plain own-data record also matches the independently published SDK context contract.
  return Object.freeze({ ...result });
}
