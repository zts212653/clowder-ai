import type { ObservationWorkSummary, SealCaller } from '../diagnostics/observation-work.js';
import { type SafeErrorProjection, safeErrorProjection } from '../diagnostics/safe-error-projection.js';
import type { StaticFeatureRunDiagnostics, StaticFeatureRunStage } from '../host-broker/static-feature-authority.js';
import { HostBrokerError } from '../host-broker/types.js';
import { ObservationCosts } from './observation-costs.js';

export interface ObservationError {
  readonly origin: 'host' | 'unverified';
  readonly type?: string;
  readonly code?: string;
  readonly cause?: ObservationError;
  readonly reason?: string;
  readonly sessionCloseReason?: string;
}

type Stage = StaticFeatureRunStage | 'poll' | 'poll-refresh' | 'lease-renew' | 'authority' | 'observation-publish';
export interface ObservationStage {
  readonly stage: Stage;
  readonly elapsedMs: number;
  readonly status: 'pending' | 'ok' | 'failed';
  readonly error?: ObservationError;
}

const BROKER_CODES = new Set([
  'HANDSHAKE_REJECTED',
  'INSTANCE_NOT_READY',
  'SESSION_NOT_FOUND',
  'SESSION_NOT_ACTIVE',
  'METHOD_NOT_READY',
  'METHOD_NOT_REGISTERED',
  'INVALID_CALL_INPUT',
  'INVALID_CALL_RESULT',
  'CAPABILITY_DENIED',
  'AUTHORITY_CHANGED',
  'CALL_CONFLICT',
  'CALL_IN_FLIGHT',
  'CORRUPT_SNAPSHOT',
  'UNSUPPORTED_SCHEMA',
  'BROKER_INVARIANT',
]);
const SYSTEM_CODES = new Set([
  'EIO',
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOTDIR',
  'EMFILE',
  'ENFILE',
  'ENOSPC',
  'EBUSY',
  'EINVAL',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ERR_STREAM_PREMATURE_CLOSE',
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_IOERR',
  'SQLITE_CORRUPT',
  'SQLITE_CANTOPEN',
]);
const TYPES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AggregateError', 'HostBrokerError']);
const CLOSE_REASONS = new Set(['runtime_lease_expired', 'authority_changed', 'session_not_active']);
const REASONS = new Map([
  ['desktop heartbeat expired', 'heartbeat_expired'],
  ['desktop observation expired', 'observation_expired'],
  ['desktop window ended', 'window_ended'],
  ['desktop ended during package verification', 'window_ended'],
  ['desktop package unavailable', 'package_unavailable'],
  ['desktop authority without contribution', 'contribution_missing'],
  ['static feature has no current Host authority', 'static_authority_changed'],
  ['feature authority changed', 'feature_authority_changed'],
  ['feature lease is revoked or unknown', 'feature_lease_revoked'],
  ['package integrity is untrusted', 'package_integrity_untrusted'],
  ['static package generation changed', 'static_package_changed'],
  ['static package generation is damaged', 'static_package_damaged'],
  ['static package changed during verification', 'static_package_changed'],
]);

function compact(value: SafeErrorProjection, depth = 0): ObservationError {
  return {
    origin: value.origin === 'host' ? 'host' : 'unverified',
    ...(value.type && TYPES.has(value.type) ? { type: value.type } : {}),
    ...(typeof value.code === 'string' && (BROKER_CODES.has(value.code) || SYSTEM_CODES.has(value.code))
      ? { code: value.code }
      : {}),
    ...(value.cause && depth < 2 ? { cause: compact(value.cause, depth + 1) } : {}),
  };
}

/** Reuse the defensive error reader, then discard all open text, paths and stack locations. */
function observationError(error: unknown): ObservationError {
  const projected = compact(
    safeErrorProjection(error, {
      hostCode: (value) => (value instanceof HostBrokerError && BROKER_CODES.has(value.code) ? value.code : undefined),
    }),
  );
  try {
    const reason = error instanceof Error ? REASONS.get(error.message) : undefined;
    const close = error instanceof HostBrokerError ? error.sessionCloseReason : undefined;
    return {
      ...projected,
      ...(reason ? { reason } : {}),
      ...(close && CLOSE_REASONS.has(close) ? { sessionCloseReason: close } : {}),
    };
  } catch {
    return projected;
  }
}

const duration = (started: number) => Math.min(86_400_000, Math.max(0, Math.round(performance.now() - started)));

/** One attempt, at most ten fixed stages; no sampling loop, global buffer or success logging. */
export class ObservationDiagnostics implements StaticFeatureRunDiagnostics {
  readonly costs: ObservationCosts;
  constructor(caller: SealCaller = 'observer') {
    this.costs = new ObservationCosts(caller);
  }
  get snapshotDiagnostics() {
    return this.costs.snapshotDiagnostics;
  }
  get packageDiagnostics() {
    return this.costs.packageDiagnostics;
  }
  private readonly stages = new Map<Stage, { started: number; result?: ObservationStage }>();
  private error?: ObservationError;

  async measure<T>(stage: Stage, operation: () => Promise<T>): Promise<T> {
    const entry: { started: number; result?: ObservationStage } = { started: performance.now() };
    this.stages.set(stage, entry);
    try {
      const value = await operation();
      entry.result = { stage, elapsedMs: duration(entry.started), status: 'ok' };
      return value;
    } catch (error) {
      this.error = observationError(error);
      entry.result = { stage, elapsedMs: duration(entry.started), status: 'failed', error: this.error };
      throw error;
    }
  }

  checkAuthority(operation: () => void): void {
    const stage = 'authority-check';
    const entry: { started: number; result?: ObservationStage } = { started: performance.now() };
    this.stages.set(stage, entry);
    try {
      operation();
      entry.result = { stage, elapsedMs: duration(entry.started), status: 'ok' };
    } catch (error) {
      this.error = observationError(error);
      entry.result = { stage, elapsedMs: duration(entry.started), status: 'failed', error: this.error };
      throw error;
    }
  }

  snapshot(error?: unknown): { stages: ObservationStage[]; error?: ObservationError; costs: ObservationWorkSummary } {
    const failure = error === undefined ? this.error : observationError(error);
    return {
      costs: this.costs.snapshot(),
      stages: [...this.stages].map(([stage, entry]) =>
        structuredClone(entry.result ?? { stage, elapsedMs: duration(entry.started), status: 'pending' as const }),
      ),
      ...(failure ? { error: failure } : {}),
    };
  }
}
