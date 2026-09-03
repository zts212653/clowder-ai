import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { UnixProcessIdentity } from '../../utils/cli-process-ownership.js';
import type { DurableManagedGateJob } from './durable-managed-gate-job.js';
import {
  claimDurableGateSupervisor,
  DurableGateSupervisorFenceError,
  writeDurableGateRecordFenced,
} from './durable-managed-gate-supervisor.js';
import type { ManagedCommandTerminalResult } from './managed-command-wake-task-projection.js';

const TERMINAL_STATUSES = new Set(['green', 'failed', 'cancelled', 'timed_out', 'lost', 'partial']);

export type DurableGateTerminalStatus = 'green' | 'failed' | 'cancelled' | 'timed_out' | 'lost' | 'partial';

export interface DurableGateRecord {
  readonly version: 1;
  readonly jobId: string;
  readonly originTaskId: string;
  readonly supervisorEpoch: string;
  readonly supervisorFence?: number;
  readonly runId?: string;
  readonly state: 'queued' | 'running' | 'waiting' | 'cancelling' | 'terminal';
  readonly terminalStatus?: DurableGateTerminalStatus | null;
  readonly terminationIntent?: 'cancelled' | 'timed_out';
  readonly cancel?: {
    readonly requestedAt: number;
    readonly cancelledBy: string;
    readonly reason: string;
  };
  readonly ownerIdentity?: UnixProcessIdentity;
  readonly result?: ManagedCommandTerminalResult;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface DurableTerminalReceipt {
  readonly version: 1;
  readonly jobId: string;
  readonly supervisorEpoch: string;
  readonly terminalStatus: DurableGateTerminalStatus;
  readonly result: ManagedCommandTerminalResult;
  readonly settledAt: number;
}

export function writeDurableGateRecord(
  job: DurableManagedGateJob,
  value: object,
  options: { now?: number; exclusive?: boolean } = {},
): boolean {
  if (!claimDurableGateSupervisor(job, { now: options.now })) return false;
  return writeDurableGateRecordFenced(job, value, options);
}

export function rawDurableGateRecord(job: DurableManagedGateJob): Record<string, unknown> | null {
  if (!existsSync(job.recordPath)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(job.recordPath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function initializeDurableManagedGateJob(job: DurableManagedGateJob, now = Date.now()): void {
  const initialized = writeDurableGateRecord(
    job,
    {
      version: 1,
      kind: job.kind,
      jobId: job.jobId,
      originTaskId: job.originTaskId,
      supervisorEpoch: job.supervisorEpoch,
      gateReceiptPath: job.gateReceiptPath,
      logPath: job.logPath,
      executionSlaMs: job.executionSlaMs,
      wallSlaMs: job.wallSlaMs,
      wakeTarget: job.wakeTarget,
      state: 'queued',
      terminalStatus: null,
      createdAt: now,
      updatedAt: now,
    },
    { now, exclusive: true },
  );
  if (!initialized) throw new Error(`durable gate supervisor lease unavailable: ${job.jobId}`);
}

export function recordDurableManagedGateProcess(
  job: DurableManagedGateJob,
  processIdentity: UnixProcessIdentity,
  now = Date.now(),
): boolean {
  const current = readDurableGateRecord(job);
  const raw = rawDurableGateRecord(job);
  if (!current || !raw || current.state === 'terminal') return false;
  return writeDurableGateRecord(
    job,
    { ...raw, state: 'running', ownerIdentity: processIdentity, updatedAt: now },
    { now },
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function parseIdentity(value: unknown): UnixProcessIdentity | undefined {
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

function parseTerminalStatus(value: unknown): DurableGateTerminalStatus | undefined {
  return typeof value === 'string' && TERMINAL_STATUSES.has(value) ? (value as DurableGateTerminalStatus) : undefined;
}

function parseTerminalResult(value: unknown): ManagedCommandTerminalResult | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
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
  };
}

function parseCancellation(value: unknown): DurableGateRecord['cancel'] | undefined {
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

export function readDurableGateRecord(job: DurableManagedGateJob): DurableGateRecord | null {
  const value = rawDurableGateRecord(job);
  if (
    !value ||
    value.version !== 1 ||
    value.jobId !== job.jobId ||
    value.originTaskId !== job.originTaskId ||
    typeof value.supervisorEpoch !== 'string' ||
    !['queued', 'running', 'waiting', 'cancelling', 'terminal'].includes(String(value.state))
  )
    return null;
  return {
    version: 1,
    jobId: job.jobId,
    originTaskId: job.originTaskId,
    supervisorEpoch: value.supervisorEpoch,
    ...(typeof value.supervisorFence === 'number' ? { supervisorFence: value.supervisorFence } : {}),
    ...(typeof value.runId === 'string' ? { runId: value.runId } : {}),
    state: value.state as DurableGateRecord['state'],
    ...(parseTerminalStatus(value.terminalStatus) || value.terminalStatus === null
      ? { terminalStatus: parseTerminalStatus(value.terminalStatus) ?? null }
      : {}),
    ...(value.terminationIntent === 'cancelled' || value.terminationIntent === 'timed_out'
      ? { terminationIntent: value.terminationIntent }
      : {}),
    ...(parseCancellation(value.cancel) ? { cancel: parseCancellation(value.cancel) } : {}),
    ...(parseIdentity(value.ownerIdentity) ? { ownerIdentity: parseIdentity(value.ownerIdentity) } : {}),
    ...(parseTerminalResult(value.result) ? { result: parseTerminalResult(value.result) } : {}),
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
  };
}

export function terminalResult(status: DurableGateRecord['terminalStatus']): ManagedCommandTerminalResult {
  return {
    exitCode: status === 'green' ? 0 : status === 'cancelled' || status === 'lost' || status === 'timed_out' ? null : 1,
    timedOut: status === 'timed_out',
    ...(status === 'cancelled' ? { cancelled: true } : {}),
    durationMs: 0,
    tailOutput:
      status === 'lost'
        ? 'durable full-gate process identity was proven dead before terminal settlement'
        : `durable full-gate terminal receipt: ${status ?? 'partial'}`,
  };
}

function terminalReceiptPath(job: DurableManagedGateJob): string {
  return `${job.recordPath}.terminal`;
}

export function readDurableTerminalReceipt(job: DurableManagedGateJob): DurableTerminalReceipt | null {
  const receiptPath = terminalReceiptPath(job);
  if (!existsSync(receiptPath)) return null;
  try {
    const value = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    const terminalStatus = parseTerminalStatus(value.terminalStatus);
    const result = parseTerminalResult(value.result);
    if (
      value.version !== 1 ||
      value.jobId !== job.jobId ||
      typeof value.supervisorEpoch !== 'string' ||
      !terminalStatus ||
      !result ||
      typeof value.settledAt !== 'number'
    )
      return null;
    return {
      version: 1,
      jobId: job.jobId,
      supervisorEpoch: value.supervisorEpoch,
      terminalStatus,
      result,
      settledAt: value.settledAt,
    };
  } catch {
    return null;
  }
}

export function terminalRecordFromReceipt(
  job: DurableManagedGateJob,
  previous: DurableGateRecord | null,
  receipt: DurableTerminalReceipt,
): DurableGateRecord {
  return {
    version: 1,
    jobId: job.jobId,
    originTaskId: job.originTaskId,
    supervisorEpoch: receipt.supervisorEpoch,
    ...(previous?.runId ? { runId: previous.runId } : {}),
    state: 'terminal',
    terminalStatus: receipt.terminalStatus,
    ...((previous?.ownerIdentity ?? job.processIdentity)
      ? { ownerIdentity: previous?.ownerIdentity ?? job.processIdentity }
      : {}),
    result: receipt.result,
    createdAt: previous?.createdAt ?? receipt.settledAt,
    updatedAt: receipt.settledAt,
  };
}

export function claimDurableGateTerminal(
  job: DurableManagedGateJob,
  previous: DurableGateRecord | null,
  terminalStatus: DurableGateTerminalStatus,
  result: ManagedCommandTerminalResult,
  now: number,
): { claimed: boolean; record: DurableGateRecord } {
  if (!claimDurableGateSupervisor(job, { now })) {
    const winner = readDurableTerminalReceipt(job);
    if (!winner) throw new DurableGateSupervisorFenceError(job.jobId);
    return { claimed: false, record: terminalRecordFromReceipt(job, previous, winner) };
  }
  const receiptPath = terminalReceiptPath(job);
  mkdirSync(dirname(receiptPath), { recursive: true });
  const candidate = {
    version: 1 as const,
    jobId: job.jobId,
    supervisorEpoch: job.supervisorEpoch,
    terminalStatus,
    result,
    settledAt: now,
  };
  let claimed = false;
  let winner: DurableTerminalReceipt = candidate;
  try {
    writeFileSync(receiptPath, `${JSON.stringify(candidate)}\n`, { flag: 'wx' });
    claimed = true;
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
    const existing = readDurableTerminalReceipt(job);
    if (!existing) throw new Error(`invalid durable terminal receipt: ${receiptPath}`);
    winner = existing;
  }
  const record = terminalRecordFromReceipt(job, previous, winner);
  if (!writeDurableGateRecord(job, record, { now })) {
    throw new Error(`durable gate supervisor fence lost during terminal projection: ${job.jobId}`);
  }
  return { claimed, record };
}

export function settleDurableManagedGateJobFromRunner(
  job: DurableManagedGateJob,
  result: ManagedCommandTerminalResult,
  now = Date.now(),
): boolean {
  const current = readDurableGateRecord(job);
  if (current?.state === 'terminal') return false;
  const status = result.cancelled
    ? 'cancelled'
    : result.timedOut
      ? 'timed_out'
      : result.exitCode === 0
        ? 'green'
        : 'failed';
  try {
    return claimDurableGateTerminal(job, current, status, result, now).claimed;
  } catch (error) {
    if (error instanceof DurableGateSupervisorFenceError) return false;
    throw error;
  }
}

export function readExternalGateTerminal(job: DurableManagedGateJob): {
  status: DurableGateTerminalStatus;
  result: ManagedCommandTerminalResult;
} | null {
  if (!existsSync(job.gateReceiptPath)) return null;
  try {
    const value = JSON.parse(readFileSync(job.gateReceiptPath, 'utf8')) as Record<string, unknown>;
    const status = parseTerminalStatus(value.terminalStatus);
    if (value.jobId !== job.jobId || value.state !== 'terminal' || !status) return null;
    return { status, result: parseTerminalResult(value.result) ?? terminalResult(status) };
  } catch {
    return null;
  }
}
