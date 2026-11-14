import type { NativeReadResources } from '../../infrastructure/sqlite-native-read-resources.js';
import type { CjkReadSnapshot } from './message-cjk-read-diagnostics.js';

type SqlEvent = 'sql-start' | 'sql-finish';
interface SqlProgress {
  sqlFingerprint: string;
  event: SqlEvent;
  elapsedMs?: number;
  rows?: number | null;
}
interface NativeInput {
  kind: 'vector-knn';
  requestedK: number;
  dimensions: number;
  resourcesBefore?: Partial<NativeReadResources> | null;
  resourcesAfter?: Partial<NativeReadResources> | null;
  resourceDelta?: Partial<NativeReadResources> | null;
}
export interface NativeMessageReadProgress {
  phase:
    | 'queue'
    | 'worker-startup'
    | 'database-initialization'
    | 'worker-processing'
    | 'sql-read'
    | 'embedding-load'
    | 'embedding-reprobeIfNeeded'
    | 'embedding-embed';
  outcome: 'pending' | 'fulfilled' | 'rejected';
  elapsedMs: number;
  queueMs?: number;
  observationAgeMs: number;
  sqlObservations?: number;
  observedSqlMs?: number;
  lastObservedSql?: SqlProgress;
  nativeVectorRead?: Omit<SqlProgress, 'rows'> & { native: NativeInput };
  cjk?: CjkReadSnapshot;
}

const phases = new Set([
  'queue',
  'worker-startup',
  'database-initialization',
  'worker-processing',
  'sql-read',
  'embedding-load',
  'embedding-reprobeIfNeeded',
  'embedding-embed',
]);
const states = new Set(['pending', 'fulfilled', 'rejected']);
const resourceKeys = [
  'userCpuUs',
  'systemCpuUs',
  'fsReadOperations',
  'fsWriteOperations',
  'voluntaryContextSwitches',
  'involuntaryContextSwitches',
  'maxRssKiB',
] as const;
const record = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
export const finiteDuration = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const count = (v: unknown): v is number => finiteDuration(v) && Number.isSafeInteger(v);

function sqlProgress(value: unknown, includeRows = true): SqlProgress | undefined {
  const v = record(value);
  if (!v) return;
  const { sqlFingerprint, event } = v;
  if (
    typeof sqlFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(sqlFingerprint) ||
    (event !== 'sql-start' && event !== 'sql-finish')
  )
    return;
  const elapsedMs = event === 'sql-finish' ? v.elapsedMs : undefined;
  const rows = event === 'sql-finish' && includeRows ? v.rows : undefined;
  return {
    sqlFingerprint,
    event,
    ...(finiteDuration(elapsedMs) ? { elapsedMs } : {}),
    ...(includeRows && event === 'sql-finish' && (rows === null || count(rows)) ? { rows } : {}),
  };
}
function resources(value: unknown, delta = false): Partial<NativeReadResources> | null | undefined {
  if (value === null) return null;
  const v = record(value);
  if (!v) return;
  const result: Partial<NativeReadResources> = {};
  for (const key of resourceKeys) {
    if (delta && key === 'maxRssKiB') continue;
    const n = v[key];
    if (finiteDuration(n)) result[key] = n;
  }
  return Object.keys(result).length ? result : undefined;
}
function nativeProgress(value: unknown): NativeMessageReadProgress['nativeVectorRead'] {
  const sql = sqlProgress(value, false);
  const v = record(record(value)?.native);
  if (!sql || !v) return;
  const { kind, requestedK, dimensions } = v;
  if (kind !== 'vector-knn' || !count(requestedK) || requestedK === 0 || !count(dimensions) || dimensions === 0) return;
  const before = resources(v.resourcesBefore),
    after = sql.event === 'sql-finish' ? resources(v.resourcesAfter) : undefined,
    delta = sql.event === 'sql-finish' ? resources(v.resourceDelta, true) : undefined;
  return {
    sqlFingerprint: sql.sqlFingerprint,
    event: sql.event,
    ...(sql.elapsedMs !== undefined ? { elapsedMs: sql.elapsedMs } : {}),
    native: {
      kind: 'vector-knn',
      requestedK,
      dimensions,
      ...(before !== undefined ? { resourcesBefore: before } : {}),
      ...(after !== undefined ? { resourcesAfter: after } : {}),
      ...(delta !== undefined ? { resourceDelta: delta } : {}),
    },
  };
}
function cjkProgress(value: unknown): CjkReadSnapshot | undefined {
  const v = record(value);
  if (!v) return;
  const { bodyVisits, bodyUtf16, checkpoints, checkpointLimit, elapsedMs, outcome, complete, returnedRows } = v;
  if (
    !count(bodyVisits) ||
    !count(bodyUtf16) ||
    !count(checkpoints) ||
    checkpoints > 8 ||
    checkpointLimit !== 8 ||
    !finiteDuration(elapsedMs) ||
    (outcome !== 'running' && outcome !== 'fulfilled' && outcome !== 'rejected') ||
    complete !== (outcome !== 'running') ||
    (outcome === 'fulfilled' ? !count(returnedRows) : returnedRows !== null)
  )
    return;
  return {
    bodyVisits,
    bodyUtf16,
    checkpoints,
    checkpointLimit: 8,
    outcome,
    complete,
    returnedRows: returnedRows as number | null,
    elapsedMs,
  };
}

/** Single last SQL/native witness and fixed CJK/resource scalars only. No SQL, bindings, identity or body. */
export function safeNativeReadProgress(value: unknown): NativeMessageReadProgress | undefined {
  try {
    const v = record(value);
    if (!v) return;
    const { phase, outcome, elapsedMs } = v;
    if (
      typeof phase !== 'string' ||
      !phases.has(phase) ||
      typeof outcome !== 'string' ||
      !states.has(outcome) ||
      !finiteDuration(elapsedMs)
    )
      return;
    const { queueMs, observationAgeMs, sqlObservations, observedSqlMs } = v;
    const lastObservedSql = sqlProgress(v.lastObservedSql),
      nativeVectorRead = nativeProgress(v.nativeVectorRead),
      cjk = cjkProgress(v.cjk);
    return {
      phase: phase as NativeMessageReadProgress['phase'],
      outcome: outcome as NativeMessageReadProgress['outcome'],
      elapsedMs,
      ...(finiteDuration(queueMs) ? { queueMs } : {}),
      observationAgeMs: finiteDuration(observationAgeMs) ? observationAgeMs : 0,
      ...(count(sqlObservations) ? { sqlObservations } : {}),
      ...(finiteDuration(observedSqlMs) ? { observedSqlMs } : {}),
      ...(lastObservedSql ? { lastObservedSql } : {}),
      ...(nativeVectorRead ? { nativeVectorRead } : {}),
      ...(cjk ? { cjk } : {}),
    };
  } catch {
    return;
  }
}
