import { z } from 'zod';

export type VideoProjectJsonValue =
  | null
  | boolean
  | number
  | string
  | VideoProjectJsonValue[]
  | { [key: string]: VideoProjectJsonValue };
export const videoProjectJsonLimits = { depth: 32, nodes: 20000, bytes: 1048576 } as const;

function isJsonPrimitive(value: unknown): boolean {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && value.length <= videoProjectJsonLimits.bytes;
}

function hasDenseArrayIndices(array: unknown[], keys: readonly PropertyKey[]): boolean {
  return (
    keys.length === array.length &&
    keys.every((key) => typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < array.length)
  );
}

/** Reject accessors and serialization side channels instead of invoking user code. */
function jsonObjectChildren(value: object): unknown[] | null {
  const array = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!array && prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value).filter((key) => !(array && key === 'length'));
  if (keys.length > videoProjectJsonLimits.nodes || keys.some((key) => typeof key !== 'string')) return null;
  if (array && !hasDenseArrayIndices(value, keys)) return null;
  const children: unknown[] = [];
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !('value' in property) || !property.enumerable) return null;
    children.push(property.value);
  }
  return children;
}

/** Iterative preflight bounds work before serialization; recursive z.lazy can overflow first. */
function isBoundedJson(value: unknown): value is VideoProjectJsonValue {
  const pending: JsonVisit[] = [{ kind: 'enter', value, depth: 0 }];
  const ancestors = new Set<object>();
  let nodes = 0;
  for (let next = pending.pop(); next; next = pending.pop()) {
    if (next.kind === 'leave') {
      ancestors.delete(next.value);
      continue;
    }
    if (++nodes > videoProjectJsonLimits.nodes || next.depth > videoProjectJsonLimits.depth) return false;
    const current = next.value;
    if (current === null || typeof current !== 'object') {
      if (!isJsonPrimitive(current)) return false;
      continue;
    }
    if (!appendJsonObject(current, next.depth, pending, ancestors, nodes)) return false;
  }
  const serialized = JSON.stringify(value);
  return (
    typeof serialized === 'string' && new TextEncoder().encode(serialized).byteLength <= videoProjectJsonLimits.bytes
  );
}

type JsonVisit = { kind: 'enter'; value: unknown; depth: number } | { kind: 'leave'; value: object };

function appendJsonObject(
  value: object,
  depth: number,
  pending: JsonVisit[],
  ancestors: Set<object>,
  nodes: number,
): boolean {
  if (ancestors.has(value)) return false;
  const children = jsonObjectChildren(value);
  if (children === null || children.length + nodes + pending.length > videoProjectJsonLimits.nodes) return false;
  ancestors.add(value);
  pending.push({ kind: 'leave', value });
  for (const child of children) pending.push({ kind: 'enter', value: child, depth: depth + 1 });
  return true;
}

/** Like z.object parsing, custom JSON must snapshot caller-owned values before any await. */
export const videoProjectJsonSchema = z
  .custom<VideoProjectJsonValue>(isBoundedJson, 'Expected bounded JSON data')
  .transform((value) => structuredClone(value));
