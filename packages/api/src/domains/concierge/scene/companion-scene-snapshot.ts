/**
 * F336 Phase C: the living cat's persisted scene (pose, paper ball, hat, activity progress).
 *
 * The body page owns what each field means. The API only bounds the envelope, so that
 * every snapshot it accepts can always be read back and compare-and-swapped (the Lua
 * script decodes the stored value, and cjson has a nesting limit).
 */

export const COMPANION_SCENE_SCHEMA_VERSION = 1;
export const COMPANION_SCENE_MAX_BYTES = 16 * 1024;
/** Containers deeper than this are rejected; the snapshot object itself is depth 0. */
const MAX_DEPTH = 8;
const SNAPSHOT_FIELDS = new Set(['schemaVersion', 'pose', 'ball', 'paper', 'hat', 'activity', 'lastSolo']);

export type CompanionSceneJson =
  | null
  | boolean
  | number
  | string
  | CompanionSceneJson[]
  | { [key: string]: CompanionSceneJson };

export interface CompanionSceneSnapshot {
  schemaVersion: typeof COMPANION_SCENE_SCHEMA_VERSION;
  pose?: CompanionSceneJson;
  ball?: CompanionSceneJson;
  paper?: CompanionSceneJson;
  hat?: CompanionSceneJson;
  activity?: CompanionSceneJson;
  lastSolo?: CompanionSceneJson;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isBoundedJson(value: unknown, depth: number): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (depth >= MAX_DEPTH) return false;
  if (Array.isArray(value)) return value.every((item) => isBoundedJson(item, depth + 1));
  return isPlainObject(value) && Object.values(value).every((item) => isBoundedJson(item, depth + 1));
}

/** Why a value cannot be stored as a scene snapshot, or undefined when it can. */
export function companionSceneSnapshotError(value: unknown): string | undefined {
  if (!isPlainObject(value)) return 'snapshot must be an object';
  if (value.schemaVersion !== COMPANION_SCENE_SCHEMA_VERSION) return 'unsupported snapshot schemaVersion';
  const unknown = Object.keys(value).find((field) => !SNAPSHOT_FIELDS.has(field));
  if (unknown !== undefined) return `unknown snapshot field: ${unknown}`;
  if (!isBoundedJson(value, 0)) return 'snapshot must be plain JSON with finite numbers, at most 8 levels deep';
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > COMPANION_SCENE_MAX_BYTES) return 'snapshot exceeds 16 KB';
  return undefined;
}

export function isCompanionSceneSnapshot(value: unknown): value is CompanionSceneSnapshot {
  return companionSceneSnapshotError(value) === undefined;
}
