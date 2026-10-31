import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  readUnixProcessSnapshotSync,
  resolveCatCafeDataRoot,
  sameUnixProcess,
  type UnixProcessIdentity,
  type UnixProcessSnapshotEntry,
} from '../../utils/cli-process-ownership.js';
import {
  admitDurableGateCancellationRequest,
  type DurableGateCancellationRequest,
  readDurableGateCancellationRequest,
} from '../ball-custody/durable-managed-gate-cancellation.js';
import { DURABLE_MANAGED_GATE_CHILD_TERMINATION_GRACE_MS } from '../ball-custody/durable-managed-gate-child-contract.js';
import type { ManagedCommandTerminalResult } from '../ball-custody/managed-command-wake-task-projection.js';
import { classifyManagedCommandActivity } from '../cats/services/agents/invocation/managed-command-activity.js';
import {
  claimDurableGateTerminal,
  type DurableGateRecord,
  readDurableGateRecord,
  readDurableTerminalReceipt,
  readExternalGateTerminal,
  terminalRecordFromReceipt,
  terminalResult,
  writeDurableGateRecord,
} from './durable-managed-gate-job-store.js';
import {
  CURRENT_DURABLE_GATE_SUPERVISOR_EPOCH,
  claimDurableGateSupervisor,
} from './durable-managed-gate-supervisor.js';
import { managedJobLogReceipt, readManagedJobLogTail } from './managed-job-log.js';

export const DURABLE_GATE_WALL_SLA_MS = 3 * 60 * 60_000;

export type * from './managed-job-types.js';

import type {
  DurableGateCancellationOutcome,
  DurableGateInspection,
  DurableManagedGateJob,
} from './managed-job-types.js';

type ReadSnapshot = (options: { pids: readonly number[] }) => Map<number, UnixProcessSnapshotEntry> | null;
type KillProcess = (pid: number, signal: NodeJS.Signals) => void;

export { validateDurableManagedGateJob } from './durable-managed-gate-job-validation.js';

export function isDurableManagedGateCommand(command: string): boolean {
  return classifyManagedCommandActivity(command) === 'full_gate';
}

export function createDurableManagedGateJob(
  originTaskId: string,
  executionSlaMs: number,
  wakeTarget: DurableManagedGateJob['wakeTarget'],
  dataRoot = resolveCatCafeDataRoot(),
): DurableManagedGateJob {
  const jobId = `managed-gate-${randomUUID()}`;
  return {
    kind: 'full_gate',
    jobId,
    originTaskId,
    supervisorEpoch: CURRENT_DURABLE_GATE_SUPERVISOR_EPOCH,
    recordPath: join(dataRoot, 'managed-gate-jobs', `${jobId}.json`),
    gateReceiptPath: join(dataRoot, 'managed-gate-jobs', `${jobId}.gate.json`),
    logPath: join(dataRoot, 'managed-gate-jobs', `${jobId}.log`),
    executionSlaMs,
    wallSlaMs: DURABLE_GATE_WALL_SLA_MS,
    wakeTarget,
  };
}

export {
  initializeDurableManagedGateJob,
  recordDurableManagedGateProcess,
  settleDurableManagedGateJobFromRunner,
} from './durable-managed-gate-job-store.js';

function writeDeadRecord(
  job: DurableManagedGateJob,
  previous: DurableGateRecord | null,
  now: number,
  cancellationRequest: DurableGateCancellationRequest | null = null,
): DurableGateRecord {
  const observed = job.recordStorage === 'sqlite_v1' && previous?.cleanupProven ? previous.pendingResult : undefined;
  const terminalStatus =
    cancellationRequest?.jobId === job.jobId
      ? 'cancelled'
      : (previous?.terminationIntent ??
        (previous?.state === 'cancelling'
          ? 'cancelled'
          : observed
            ? observed.exitCode === 0
              ? 'green'
              : 'failed'
            : 'lost'));
  const result =
    observed && !cancellationRequest && !previous?.terminationIntent ? observed : terminalResult(terminalStatus);
  return claimDurableGateTerminal(
    job,
    previous,
    terminalStatus,
    {
      ...result,
      durationMs: previous ? Math.max(0, now - previous.createdAt) : 0,
      ...(job.recordStorage === 'sqlite_v1' && existsSync(job.logPath)
        ? {
            log: managedJobLogReceipt(job.logPath),
            tailOutput: [result.tailOutput, readManagedJobLogTail(job.logPath)].filter(Boolean).join('\n'),
          }
        : {}),
    },
    now,
  ).record;
}

function deadInspection(record: DurableGateRecord): DurableGateInspection {
  return {
    state: record.terminalStatus === 'lost' ? 'lost' : 'terminal',
    record,
    result: record.result ?? terminalResult(record.terminalStatus),
  };
}

function signalExactProcessGroup(
  job: DurableManagedGateJob,
  identity: UnixProcessIdentity,
  signal: NodeJS.Signals,
  killProcess: KillProcess,
): void {
  try {
    killProcess(
      signal === 'SIGTERM' && (job.recovery || job.recordStorage === 'sqlite_v1') ? identity.pid : -identity.pgid,
      signal,
    );
  } catch {
    // Exact birth identity remains the fence; a later sweep retries or observes terminal truth.
  }
}

function inspectLiveProcess(
  job: DurableManagedGateJob,
  record: DurableGateRecord | null,
  identity: UnixProcessIdentity,
  killProcess: KillProcess,
  now: number,
  cancellationRequest: DurableGateCancellationRequest | null,
): DurableGateInspection {
  if (!record) {
    if (cancellationRequest) {
      signalExactProcessGroup(
        job,
        identity,
        now - cancellationRequest.requestedAt >= DURABLE_MANAGED_GATE_CHILD_TERMINATION_GRACE_MS
          ? 'SIGKILL'
          : 'SIGTERM',
        killProcess,
      );
      return { state: 'pending' };
    }
    return { state: 'adopted' };
  }
  if (cancellationRequest && record.state !== 'cancelling') {
    const cancelling = {
      ...record,
      state: 'cancelling' as const,
      terminationIntent: 'cancelled' as const,
      cancel: cancellationRequest,
      updatedAt: now,
    };
    if (!writeDurableGateRecord(job, cancelling, { now })) return { state: 'pending', record };
    signalExactProcessGroup(job, identity, 'SIGTERM', killProcess);
    return { state: 'pending', record: cancelling };
  }
  if (record.state === 'cancelling') {
    if (now - record.updatedAt >= DURABLE_MANAGED_GATE_CHILD_TERMINATION_GRACE_MS)
      signalExactProcessGroup(job, identity, 'SIGKILL', killProcess);
    return { state: 'pending', record };
  }
  if (now - record.createdAt < job.wallSlaMs) return { state: 'adopted', record };

  const timedOut = {
    ...record,
    state: 'cancelling' as const,
    terminationIntent: 'timed_out' as const,
    updatedAt: now,
  };
  if (!writeDurableGateRecord(job, timedOut, { now })) return { state: 'pending', record };
  signalExactProcessGroup(job, identity, 'SIGTERM', killProcess);
  return { state: 'pending', record: timedOut };
}

function inspectIdentifiedProcess(
  job: DurableManagedGateJob,
  record: DurableGateRecord | null,
  identity: UnixProcessIdentity,
  readSnapshot: ReadSnapshot,
  killProcess: KillProcess,
  now: number,
  cancellationRequest: DurableGateCancellationRequest | null,
): DurableGateInspection {
  const snapshot = readSnapshot({ pids: [identity.pid] });
  if (snapshot === null) return { state: 'pending', ...(record ? { record } : {}) };
  if (sameUnixProcess(identity, snapshot.get(identity.pid)))
    return inspectLiveProcess(job, record, identity, killProcess, now, cancellationRequest);
  if (job.recordStorage === 'sqlite_v1' && record?.attemptToken && !record.cleanupProven)
    return { state: 'pending', record };
  return deadInspection(writeDeadRecord(job, record, now, cancellationRequest));
}

function inspectOwnerlessJob(
  job: DurableManagedGateJob,
  record: DurableGateRecord | null,
  now: number,
  queuedOrphanGraceMs: number,
  cancellationRequest: DurableGateCancellationRequest | null,
): DurableGateInspection {
  // Cancellation before birth registration wins the same record fence; no worker can subsequently start it.
  if (job.recordStorage === 'sqlite_v1' && record?.state === 'queued' && cancellationRequest) {
    return deadInspection(writeDeadRecord(job, record, now, cancellationRequest));
  }
  if (!record) {
    // A pre-handshake legacy worker may still be live without any process identity.
    // The immutable request is retryable, but absence of a record is not proof of death.
    if (cancellationRequest) return { state: 'pending' };
    return deadInspection(writeDeadRecord(job, null, now));
  }
  if (record?.state !== 'queued' || now - record.updatedAt < queuedOrphanGraceMs) {
    return { state: 'pending', ...(record ? { record } : {}) };
  }
  return deadInspection(writeDeadRecord(job, record, now, cancellationRequest));
}

function reconcileImmutableTerminal(
  job: DurableManagedGateJob,
  record: DurableGateRecord | null,
  now: number,
  supervisorLeaseMs?: number,
): DurableGateRecord | null {
  if (record?.state === 'terminal') return record;
  const receipt = readDurableTerminalReceipt(job);
  if (!receipt) return record;
  const terminal = terminalRecordFromReceipt(job, record, receipt);
  if (claimDurableGateSupervisor(job, { now, leaseMs: supervisorLeaseMs })) {
    writeDurableGateRecord(job, terminal, { now });
  }
  return terminal;
}

function inspectSupervisedJob(
  job: DurableManagedGateJob,
  record: DurableGateRecord | null,
  options: { readSnapshot?: ReadSnapshot; killProcess?: KillProcess; now: number; queuedOrphanGraceMs?: number },
): DurableGateInspection {
  const externalTerminal = readExternalGateTerminal(job);
  if (externalTerminal) {
    return deadInspection(
      claimDurableGateTerminal(job, record, externalTerminal.status, externalTerminal.result, options.now).record,
    );
  }
  const cancellationRequest = readDurableGateCancellationRequest(job);
  const identity = record?.ownerIdentity ?? job.processIdentity;
  return identity
    ? inspectIdentifiedProcess(
        job,
        record,
        identity,
        options.readSnapshot ?? readUnixProcessSnapshotSync,
        options.killProcess ?? process.kill.bind(process),
        options.now,
        cancellationRequest,
      )
    : inspectOwnerlessJob(job, record, options.now, options.queuedOrphanGraceMs ?? 5_000, cancellationRequest);
}

export function inspectDurableManagedGateJob(
  job: DurableManagedGateJob,
  options: {
    readSnapshot?: ReadSnapshot;
    killProcess?: KillProcess;
    now?: number;
    queuedOrphanGraceMs?: number;
    supervisorEpoch?: string;
    supervisorLeaseMs?: number;
  } = {},
): DurableGateInspection {
  const now = options.now ?? Date.now();
  const supervisedJob = {
    ...job,
    supervisorEpoch: options.supervisorEpoch ?? CURRENT_DURABLE_GATE_SUPERVISOR_EPOCH,
  };
  let record = reconcileImmutableTerminal(supervisedJob, readDurableGateRecord(job), now, options.supervisorLeaseMs);
  if (record?.state === 'terminal') return deadInspection(record);
  // A living independent worker owns its lease and terminal. API watchers only observe or signal exact cancellation.
  if (job.recordStorage === 'sqlite_v1' && record?.ownerIdentity) {
    const identity = record.ownerIdentity;
    const snapshot = (options.readSnapshot ?? readUnixProcessSnapshotSync)({ pids: [identity.pid] });
    if (snapshot === null) return { state: 'pending', record };
    if (sameUnixProcess(identity, snapshot.get(identity.pid))) {
      const cancellation = readDurableGateCancellationRequest(job);
      if (cancellation)
        signalExactProcessGroup(
          job,
          identity,
          now - cancellation.requestedAt >= DURABLE_MANAGED_GATE_CHILD_TERMINATION_GRACE_MS ? 'SIGKILL' : 'SIGTERM',
          options.killProcess ?? process.kill.bind(process),
        );
      return { state: cancellation ? 'pending' : 'adopted', record };
    }
  }
  if (!claimDurableGateSupervisor(supervisedJob, { now, leaseMs: options.supervisorLeaseMs })) {
    return { state: 'pending', ...(record ? { record } : {}) };
  }
  record = readDurableGateRecord(supervisedJob);
  return inspectSupervisedJob(supervisedJob, record, { ...options, now });
}

export function cancelDurableManagedGateJob(
  job: DurableManagedGateJob,
  options: {
    readSnapshot?: ReadSnapshot;
    killProcess?: KillProcess;
    cancelledBy?: string;
    reason?: string;
    now?: number;
    supervisorEpoch?: string;
    supervisorLeaseMs?: number;
  } = {},
): DurableGateCancellationOutcome {
  const requestedAt = options.now ?? Date.now();
  try {
    const existingTerminal = readDurableTerminalReceipt(job);
    const existingRecord = readDurableGateRecord(job);
    if (existingTerminal || existingRecord?.state === 'terminal') {
      const result = existingRecord?.result ?? terminalResult(existingTerminal?.terminalStatus);
      return result.cancelled
        ? { state: 'cancelled', admitted: true, result }
        : { state: 'already_terminal', admitted: false, result };
    }
    admitDurableGateCancellationRequest(job, {
      requestedAt,
      cancelledBy: options.cancelledBy ?? 'authorized_actor',
      reason: options.reason ?? 'explicit_cancel',
    });
    const inspection = inspectDurableManagedGateJob(job, options);
    if ('result' in inspection) {
      return inspection.result.cancelled
        ? { state: 'cancelled', admitted: true, result: inspection.result }
        : { state: 'already_terminal', admitted: false, result: inspection.result };
    }
    return { state: 'pending', admitted: true };
  } catch {
    return { state: 'rejected', admitted: false };
  }
}
