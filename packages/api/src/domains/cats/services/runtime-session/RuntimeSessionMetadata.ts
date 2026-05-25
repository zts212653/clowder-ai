import type { CatId } from '@cat-cafe/shared';

export const RUNTIME_SESSION_RUNTIMES = ['antigravity-desktop'] as const;
export type RuntimeSessionRuntime = (typeof RUNTIME_SESSION_RUNTIMES)[number];

export const RUNTIME_SESSION_SURFACES = ['cat-cafe-dispatch', 'ide-direct'] as const;
export type RuntimeSessionSurface = (typeof RUNTIME_SESSION_SURFACES)[number];

export const RUNTIME_SESSION_LIFECYCLE_STATES = [
  'active',
  'runtime_seal_pending',
  'runtime_conflict_pending',
  'sealed',
] as const;
export type RuntimeSessionLifecycleState = (typeof RUNTIME_SESSION_LIFECYCLE_STATES)[number];

export const RUNTIME_SESSION_DRAIN_RESULTS = [
  'complete',
  'best_effort_quiet_window',
  'skipped_runtime_unreachable',
] as const;
export type RuntimeSessionDrainResult = (typeof RUNTIME_SESSION_DRAIN_RESULTS)[number];

export const RUNTIME_IDENTITY_SOURCES = [
  'session_init',
  'trajectory',
  'external_registration',
  'legacy_json_import',
] as const;
export type RuntimeIdentitySource = (typeof RUNTIME_IDENTITY_SOURCES)[number];

export interface RuntimeIdentityHistoryEntry {
  catId: CatId;
  model: string;
  modelVerified?: boolean;
  provider?: string;
  from: number;
  to?: number;
  source: RuntimeIdentitySource;
}

export interface RuntimeSessionLifecycle {
  state: RuntimeSessionLifecycleState;
  startedAt: number;
  lastObservedAt: number;
  sealReason?: string;
  drainResult?: RuntimeSessionDrainResult;
  pendingSince?: number;
  retryCount?: number;
  lastRetryAt?: number;
  lastFailureReason?: string;
}

export interface RuntimeSessionMetadata {
  sessionId: string;
  runtime: RuntimeSessionRuntime;
  runtimeSessionId: string;
  runtimeConversationId?: string;
  threadId?: string;
  catId: CatId;
  userId?: string;
  surface: RuntimeSessionSurface;
  identityHistory: RuntimeIdentityHistoryEntry[];
  lifecycle: RuntimeSessionLifecycle;
}

export function normalizeRuntimeSessionMetadata(input: unknown): RuntimeSessionMetadata {
  const record = requireRecord(input, 'runtime session metadata');
  const lifecycleRecord = requireRecord(record.lifecycle, 'runtime session lifecycle');
  const lifecycle = normalizeLifecycle(lifecycleRecord);
  const identityHistory = Array.isArray(record.identityHistory)
    ? record.identityHistory.map((entry) => normalizeIdentityHistoryEntry(entry))
    : [];

  return {
    sessionId: requireNonEmptyString(record.sessionId, 'sessionId'),
    runtime: requireOneOf(record.runtime, RUNTIME_SESSION_RUNTIMES, 'runtime'),
    runtimeSessionId: requireNonEmptyString(record.runtimeSessionId, 'runtimeSessionId'),
    ...optionalStringField(record.runtimeConversationId, 'runtimeConversationId'),
    ...optionalStringField(record.threadId, 'threadId'),
    catId: requireNonEmptyString(record.catId, 'catId') as CatId,
    ...optionalStringField(record.userId, 'userId'),
    surface: requireOneOf(record.surface, RUNTIME_SESSION_SURFACES, 'surface'),
    identityHistory,
    lifecycle,
  };
}

export function appendRuntimeIdentity(
  metadata: RuntimeSessionMetadata,
  entry: RuntimeIdentityHistoryEntry,
): RuntimeSessionMetadata {
  const normalizedMetadata = normalizeRuntimeSessionMetadata(metadata);
  const nextEntry = normalizeIdentityHistoryEntry(entry);
  const history = normalizedMetadata.identityHistory.map((identity) => ({ ...identity }));
  const current = history.at(-1);

  if (current) {
    if (nextEntry.from < current.from) {
      throw new Error('identity segment starts before current segment');
    }
    if (current.to !== undefined && nextEntry.from < current.to) {
      throw new Error('identity segment overlaps current segment');
    }
    current.to = nextEntry.from;
  }

  return {
    ...normalizedMetadata,
    identityHistory: [...history, nextEntry],
    lifecycle: {
      ...normalizedMetadata.lifecycle,
      lastObservedAt: Math.max(normalizedMetadata.lifecycle.lastObservedAt, nextEntry.from),
    },
  };
}

function normalizeLifecycle(input: Record<string, unknown>): RuntimeSessionLifecycle {
  const startedAt = requireFiniteNumber(input.startedAt, 'lifecycle.startedAt');
  const observedAt = requireFiniteNumber(input.lastObservedAt, 'lifecycle.lastObservedAt');

  return {
    state: requireOneOf(input.state, RUNTIME_SESSION_LIFECYCLE_STATES, 'runtime session lifecycle state'),
    startedAt,
    lastObservedAt: Math.max(startedAt, observedAt),
    ...optionalStringField(input.sealReason, 'lifecycle.sealReason'),
    ...optionalOneOfField(input.drainResult, RUNTIME_SESSION_DRAIN_RESULTS, 'lifecycle.drainResult'),
    ...optionalNumberField(input.pendingSince, 'lifecycle.pendingSince'),
    ...optionalNumberField(input.retryCount, 'lifecycle.retryCount'),
    ...optionalNumberField(input.lastRetryAt, 'lifecycle.lastRetryAt'),
    ...optionalStringField(input.lastFailureReason, 'lifecycle.lastFailureReason'),
  };
}

function normalizeIdentityHistoryEntry(input: unknown): RuntimeIdentityHistoryEntry {
  const record = requireRecord(input, 'runtime identity history entry');
  return {
    catId: requireNonEmptyString(record.catId, 'identity.catId') as CatId,
    model: requireNonEmptyString(record.model, 'identity.model'),
    ...optionalBooleanField(record.modelVerified, 'identity.modelVerified'),
    ...optionalStringField(record.provider, 'identity.provider'),
    from: requireFiniteNumber(record.from, 'identity.from'),
    ...optionalNumberField(record.to, 'identity.to'),
    source: requireOneOf(record.source, RUNTIME_IDENTITY_SOURCES, 'identity.source'),
  };
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

function requireOneOf<const T extends readonly string[]>(value: unknown, allowed: T, name: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value as T[number])) {
    throw new Error(`invalid ${name}`);
  }
  return value as T[number];
}

function optionalStringField(value: unknown, name: string): Record<string, string> {
  if (value === undefined) return {};
  return { [lastPathSegment(name)]: requireNonEmptyString(value, name) };
}

function optionalNumberField(value: unknown, name: string): Record<string, number> {
  if (value === undefined) return {};
  return { [lastPathSegment(name)]: requireFiniteNumber(value, name) };
}

function optionalBooleanField(value: unknown, name: string): Record<string, boolean> {
  if (value === undefined) return {};
  if (typeof value !== 'boolean') {
    throw new Error(`${name} must be a boolean`);
  }
  return { [lastPathSegment(name)]: value };
}

function optionalOneOfField<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  name: string,
): Record<string, T[number]> {
  if (value === undefined) return {};
  return { [lastPathSegment(name)]: requireOneOf(value, allowed, name) };
}

function lastPathSegment(path: string): string {
  return path.split('.').at(-1) ?? path;
}
