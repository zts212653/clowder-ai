export interface PluginStorageProjection {
  readonly index: string;
  readonly score: number | null;
}
export interface PluginStorageDueInput {
  readonly index: string;
  readonly before: number;
  readonly limit: number;
}
export type PluginStorageDuePage =
  | { readonly status: 'not_ready' }
  | {
      readonly status: 'ready';
      readonly version: string;
      readonly entries: Readonly<Record<string, { readonly revision: number; readonly value: unknown }>>;
    };
export interface PluginStorageIndexState {
  token: string;
  status: 'not_ready' | 'building' | 'ready';
  count: number;
  cursor: string;
  previousToken?: string;
}
export function assertPluginStorageIndex(index: string): void {
  if (typeof index !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(index))
    throw new TypeError('invalid plugin storage index name');
}
export function assertPluginStorageProjection(projection: PluginStorageProjection): void {
  assertPluginStorageIndex(projection?.index);
  if (projection.score !== null && (!Number.isSafeInteger(projection.score) || projection.score < 0))
    throw new TypeError('plugin storage index score must be null or a non-negative safe integer');
}
export function pluginStorageRecord(raw: string): {
  revision: number;
  value: unknown;
  projection?: PluginStorageProjection;
} {
  const match = /^(\d+):([vi]):([\s\S]*)$/.exec(raw);
  const revision = match ? Number(match[1]) : NaN;
  if (!match || !Number.isSafeInteger(revision) || revision < 1)
    throw new TypeError('plugin storage record is malformed');
  let value: unknown;
  try {
    value = JSON.parse(match[3]!);
  } catch (cause) {
    throw new TypeError('plugin storage record is malformed', { cause });
  }
  if (match[2] === 'v') return { revision, value };
  const indexed = value as { v?: unknown; value?: unknown; projection?: PluginStorageProjection } | null;
  if (!indexed || indexed.v !== 1 || !Object.hasOwn(indexed, 'value') || !indexed.projection)
    throw new TypeError('plugin storage indexed record is malformed');
  assertPluginStorageProjection(indexed.projection);
  return { revision, value: indexed.value, projection: indexed.projection };
}
export function pluginStorageIndexState(raw: string | null): PluginStorageIndexState | null {
  if (!raw) return null;
  const state = JSON.parse(raw) as PluginStorageIndexState;
  if (
    !state ||
    typeof state.token !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(state.token) ||
    !['not_ready', 'building', 'ready'].includes(state.status) ||
    !Number.isSafeInteger(state.count) ||
    state.count < 0 ||
    typeof state.cursor !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(state.cursor)
  )
    throw new TypeError('invalid plugin storage index state');
  return state;
}
