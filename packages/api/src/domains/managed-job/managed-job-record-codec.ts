import type { UnixProcessIdentity } from '../../utils/cli-process-ownership.js';
import type { ManagedCommandTerminalResult } from '../ball-custody/managed-command-wake-task-projection.js';
import type { DurableGateRecord, DurableGateTerminalStatus } from './durable-managed-gate-job-store.js';

const TERMINAL_STATUSES = new Set(['green', 'failed', 'cancelled', 'timed_out', 'lost', 'partial']);

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function parseIdentity(value: unknown): UnixProcessIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !isPositiveInteger(record.pid) ||
    !isPositiveInteger(record.ppid) ||
    !isPositiveInteger(record.pgid) ||
    typeof record.startedAt !== 'string' ||
    !record.startedAt
  )
    return undefined;
  return { pid: record.pid, ppid: record.ppid, pgid: record.pgid, startedAt: record.startedAt };
}

export function parseTerminalStatus(value: unknown): DurableGateTerminalStatus | undefined {
  return typeof value === 'string' && TERMINAL_STATUSES.has(value) ? (value as DurableGateTerminalStatus) : undefined;
}

export function parseTerminalResult(value: unknown): ManagedCommandTerminalResult | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const log = record.log && typeof record.log === 'object' ? (record.log as Record<string, unknown>) : null;
  if (
    (record.exitCode !== null && typeof record.exitCode !== 'number') ||
    typeof record.timedOut !== 'boolean' ||
    typeof record.durationMs !== 'number'
  )
    return undefined;
  return {
    exitCode: record.exitCode,
    timedOut: record.timedOut,
    ...(typeof record.cancelled === 'boolean' ? { cancelled: record.cancelled } : {}),
    durationMs: record.durationMs,
    ...(typeof record.tailOutput === 'string' ? { tailOutput: record.tailOutput } : {}),
    ...(record.signal === null || typeof record.signal === 'string' ? { signal: record.signal } : {}),
    ...(['command_exit', 'explicit_cancel', 'runtime_deadline', 'worker_lost'].includes(
      String(record.terminationReason),
    )
      ? { terminationReason: record.terminationReason as ManagedCommandTerminalResult['terminationReason'] }
      : {}),
    ...(log &&
    typeof log.path === 'string' &&
    typeof log.sha256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(log.sha256) &&
    typeof log.bytes === 'number'
      ? { log: { path: log.path, sha256: log.sha256, bytes: log.bytes } }
      : {}),
  };
}

export function parseCancellation(value: unknown): DurableGateRecord['cancel'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.requestedAt !== 'number' ||
    !Number.isFinite(record.requestedAt) ||
    typeof record.cancelledBy !== 'string' ||
    !record.cancelledBy ||
    typeof record.reason !== 'string' ||
    !record.reason
  )
    return undefined;
  return {
    requestedAt: record.requestedAt,
    cancelledBy: record.cancelledBy,
    reason: record.reason,
  };
}
