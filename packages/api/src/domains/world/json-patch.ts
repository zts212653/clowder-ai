import type { JsonPatchOperation } from '@cat-cafe/shared';

export function applyPatch<T>(target: T, operations: JsonPatchOperation[]): T {
  const result = structuredClone(target) as Record<string, unknown>;
  for (const op of operations) {
    const segments = parsePath(op.path);
    if (segments.length === 0) throw new Error(`Invalid path: ${op.path}`);

    if (op.op === 'add' || op.op === 'replace') {
      setNested(result, segments, op.value);
    } else if (op.op === 'remove') {
      removeNested(result, segments);
    }
  }
  return result as T;
}

const PROHIBITED_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function parsePath(path: string): string[] {
  if (!path.startsWith('/')) throw new Error(`Path must start with /: ${path}`);
  const segments = path.slice(1).split('/');
  for (const seg of segments) {
    if (PROHIBITED_SEGMENTS.has(seg)) {
      throw new Error(`Prohibited path segment '${seg}' — prototype pollution blocked`);
    }
  }
  return segments;
}

function setNested(obj: Record<string, unknown>, segments: string[], value: unknown): void {
  let current: unknown = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (Array.isArray(current)) {
      current = current[Number(seg)];
    } else if (current && typeof current === 'object') {
      current = (current as Record<string, unknown>)[seg];
    }
    if (current == null || typeof current !== 'object') {
      throw new Error(`Parent path does not exist at segment '${seg}' in /${segments.slice(0, i + 1).join('/')}`);
    }
  }
  const lastSeg = segments[segments.length - 1];
  if (Array.isArray(current)) {
    if (lastSeg === '-') {
      current.push(value);
    } else {
      current[Number(lastSeg)] = value;
    }
  } else if (current && typeof current === 'object') {
    (current as Record<string, unknown>)[lastSeg] = value;
  }
}

function removeNested(obj: Record<string, unknown>, segments: string[]): void {
  let current: unknown = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (current && typeof current === 'object') {
      current = (current as Record<string, unknown>)[seg];
    }
  }
  const lastSeg = segments[segments.length - 1];
  if (Array.isArray(current)) {
    if (lastSeg === '-') {
      throw new Error("Cannot use '-' index with remove operation");
    }
    const idx = Number(lastSeg);
    if (Number.isNaN(idx)) {
      throw new Error(`Invalid array index '${lastSeg}' for remove`);
    }
    current.splice(idx, 1);
  } else if (current && typeof current === 'object') {
    delete (current as Record<string, unknown>)[lastSeg];
  }
}
