import { hasDurableGateCancellationRequestArtifact } from '../domains/ball-custody/durable-managed-gate-cancellation.js';
import type { ManagedCommandTerminalResult } from '../domains/ball-custody/managed-command-wake-task-projection.js';
import type { DurableManagedGateJob } from '../domains/managed-job/durable-managed-gate-job.js';
import {
  rawDurableGateRecord,
  recordManagedJobAttempt,
  settleDurableManagedGateJobFromRunner,
  writeDurableGateRecord,
} from '../domains/managed-job/durable-managed-gate-job-store.js';
import { managedJobLogReceipt, readManagedJobLogTail } from '../domains/managed-job/managed-job-log.js';
import {
  cleanupAndDrainDurableManagedGateAttempt,
  spawnDurableManagedGateAttempt,
} from './managed-runner-durable-child.js';
import { recordManagedAttemptCleanup } from './managed-runner-durable-cleanup.js';

/** Ordinary commands use the same detached worker, attempt token, cleanup proof and bounded log as full gates. */
export async function runManagedCommandWorker(input: {
  job: DurableManagedGateJob;
  environment: NodeJS.ProcessEnv;
  capture: (chunk: Buffer) => void;
  finishLog: () => void;
  cancelled: () => boolean;
  cleanupAttempt?: typeof cleanupAndDrainDurableManagedGateAttempt;
}): Promise<number> {
  const { job } = input;
  if (!job.definition) throw new Error('managed_job_definition_missing');
  const startedAt = Date.now();
  const deadline = startedAt + job.executionSlaMs;
  const attempt = spawnDurableManagedGateAttempt({
    job,
    command: job.definition.command,
    cwd: job.definition.cwd,
    environment: input.environment,
    resumeEpoch: null,
    frozenIdentity: null,
    reconcileFrom: null,
    capture: input.capture,
    beforeSpawn: (attemptToken) => {
      recordManagedJobAttempt(job, attemptToken);
    },
  });
  let nextHeartbeat = Date.now() + 5000;
  let terminal: 'cancelled' | 'timed_out' | null = null;
  let lostExecutionFence = false;
  while (!attempt.currentExit()) {
    const now = Date.now();
    if (input.cancelled() || hasDurableGateCancellationRequestArtifact(job)) {
      terminal = 'cancelled';
      break;
    }
    if (now >= deadline) {
      terminal = 'timed_out';
      break;
    }
    if (now >= nextHeartbeat) {
      const current = rawDurableGateRecord(job);
      if (!current || !writeDurableGateRecord(job, { ...current, updatedAt: now })) {
        input.capture(Buffer.from('managed job worker lost its execution fence\n'));
        lostExecutionFence = true;
        break;
      }
      nextHeartbeat = now + 5000;
    }
    await Promise.race([attempt.exited, new Promise((resolve) => setTimeout(resolve, 100))]);
  }
  // The shell's exit is not proof that its children stopped; settle only after the shared token census is empty.
  const raw = attempt.currentExit()?.result;
  // Keep the observed outcome before cleanup: a temporary census failure or
  // worker death must not turn an already observed exit into an unknown one.
  // This is pending evidence, never permission to publish terminal success.
  const observedResult: ManagedCommandTerminalResult = {
    exitCode: terminal ? null : (raw?.code ?? null),
    timedOut: terminal === 'timed_out',
    cancelled: terminal === 'cancelled',
    durationMs: Date.now() - startedAt,
    signal: raw?.signal ?? null,
    terminationReason:
      terminal === 'cancelled' ? 'explicit_cancel' : terminal === 'timed_out' ? 'runtime_deadline' : 'command_exit',
  };
  // A fenced worker may stop its own attempt, but cannot invent a cancellation
  // or reacquire authority while publishing a result over its successor.
  const recorded =
    !lostExecutionFence &&
    writeDurableGateRecord(job, {
      ...rawDurableGateRecord(job),
      ...(terminal ? { state: 'cancelling', terminationIntent: terminal } : {}),
      pendingResult: observedResult,
      updatedAt: Date.now(),
    });
  const cleanup = await (input.cleanupAttempt ?? cleanupAndDrainDurableManagedGateAttempt)(attempt, 3000, 100);
  if (!cleanup.proven)
    input.capture(Buffer.from('managed job cleanup is unproven; recovery must retain responsibility\n'));
  const cleanupRecorded =
    cleanup.proven && recorded && recordManagedAttemptCleanup(job, attempt.attemptToken, cleanup.proven);
  input.finishLog();
  if (!cleanupRecorded) return 70;
  const result: ManagedCommandTerminalResult = {
    ...observedResult,
    durationMs: Date.now() - startedAt,
    tailOutput: readManagedJobLogTail(job.logPath),
    signal: raw?.signal ?? attempt.currentExit()?.result.signal ?? null,
    log: managedJobLogReceipt(job.logPath),
  };
  settleDurableManagedGateJobFromRunner(job, result);
  return terminal === 'cancelled' ? 143 : terminal === 'timed_out' ? 124 : (result.exitCode ?? 1);
}
