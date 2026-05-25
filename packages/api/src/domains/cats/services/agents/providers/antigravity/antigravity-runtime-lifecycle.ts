import {
  RUNTIME_SESSION_DRAIN_RESULTS,
  type RuntimeSessionDrainResult,
} from '../../../runtime-session/RuntimeSessionMetadata.js';

export const ANTIGRAVITY_RUNTIME_SEAL_REASONS = [
  'oversized_retire',
  'user_initiated',
  'model_capacity',
  'empty_response',
  'stream_error',
  'tool_conflict',
  'unsafe_side_effect',
  'runtime_disconnected',
  'runtime_error_reset',
] as const;

export type AntigravityRuntimeSealReason = (typeof ANTIGRAVITY_RUNTIME_SEAL_REASONS)[number];

export interface AntigravitySessionLifecycle {
  runtime: 'antigravity-desktop';
  runtimeSessionId: string;
  previousRuntimeSessionId?: string;
  sealReason?: AntigravityRuntimeSealReason;
  drainResult?: RuntimeSessionDrainResult;
  degraded?: boolean;
  degradedReason?: string;
  continuityBootstrapId?: string;
}

export function buildAntigravitySessionLifecycle(
  input: Omit<AntigravitySessionLifecycle, 'runtime'>,
): AntigravitySessionLifecycle {
  return normalizeAntigravitySessionLifecycle({
    ...input,
    runtime: 'antigravity-desktop',
  });
}

export function normalizeAntigravitySessionLifecycle(input: unknown): AntigravitySessionLifecycle {
  const record = requireRecord(input, 'antigravity session lifecycle');
  const runtime = requireOneOf(record.runtime, ['antigravity-desktop'] as const, 'antigravity runtime');

  return {
    runtime,
    runtimeSessionId: requireNonEmptyString(record.runtimeSessionId, 'runtimeSessionId'),
    ...optionalStringField(record.previousRuntimeSessionId, 'previousRuntimeSessionId'),
    ...optionalOneOfField(record.sealReason, ANTIGRAVITY_RUNTIME_SEAL_REASONS, 'sealReason', {
      errorName: 'antigravity runtime seal reason',
    }),
    ...optionalOneOfField(record.drainResult, RUNTIME_SESSION_DRAIN_RESULTS, 'drainResult', {
      errorName: 'runtime drain result',
    }),
    ...optionalBooleanField(record.degraded, 'degraded'),
    ...optionalStringField(record.degradedReason, 'degradedReason'),
    ...optionalStringField(record.continuityBootstrapId, 'continuityBootstrapId'),
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

function requireOneOf<const T extends readonly string[]>(value: unknown, allowed: T, name: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value as T[number])) {
    throw new Error(`invalid ${name}`);
  }
  return value as T[number];
}

function optionalStringField(value: unknown, name: string): Record<string, string> {
  if (value === undefined) return {};
  return { [name]: requireNonEmptyString(value, name) };
}

function optionalBooleanField(value: unknown, name: string): Record<string, boolean> {
  if (value === undefined) return {};
  if (typeof value !== 'boolean') {
    throw new Error(`${name} must be a boolean`);
  }
  return { [name]: value };
}

function optionalOneOfField<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  name: string,
  options: { errorName?: string } = {},
): Record<string, T[number]> {
  if (value === undefined) return {};
  return { [name]: requireOneOf(value, allowed, options.errorName ?? name) };
}
