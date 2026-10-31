import type { ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { hasDurableGateCancellationRequestArtifact } from '../domains/ball-custody/durable-managed-gate-cancellation.js';
import {
  DURABLE_MANAGED_GATE_CHILD_TERMINATION_GRACE_MS,
  durableManagedGateChildEnvironment,
} from '../domains/ball-custody/durable-managed-gate-child-contract.js';
import {
  type DurableManagedGateJob,
  recordDurableManagedGateProcess,
  validateDurableManagedGateJob,
} from '../domains/ball-custody/durable-managed-gate-job.js';
import {
  rawDurableGateRecord,
  readDurableGateRecord,
  recordManagedJobAttempt,
  settleDurableManagedGateJobFromRunner,
  writeDurableGateRecord,
} from '../domains/ball-custody/durable-managed-gate-job-store.js';
import {
  type DurableGateFrozenIdentity,
  evaluateDurableGateMutation,
  initializeDurableGateRecovery,
  readDurableGateRecovery,
  synchronizeDurableGateFrozenIdentity,
} from '../domains/ball-custody/durable-managed-gate-recovery.js';
import { publishDurableGateStopIntent } from '../domains/ball-custody/durable-managed-gate-stop-intent.js';
import { managedJobLogReceipt, readManagedJobLogTail } from '../domains/managed-job/managed-job-log.js';
import { readUnixProcessSnapshotSync, type UnixProcessIdentity } from '../utils/cli-process-ownership.js';
import { runManagedCommandWorker } from './managed-runner-command-worker.js';
import {
  type DurableManagedGateAttemptProcess,
  type DurableManagedGateChildResult,
  spawnDurableManagedGateAttempt,
} from './managed-runner-durable-child.js';
import { cleanupManagedRecoveryAttempt } from './managed-runner-durable-cleanup.js';
import { openDurableManagedRunnerLog } from './managed-runner-durable-log.js';
import {
  durableManagedGateTerminalResult,
  durableManagedGateTerminalSnapshotResult,
  evaluateDurableManagedGateWorkerFence,
} from './managed-runner-durable-recovery-fence.js';
import {
  finalOutcomeAfterCleanup,
  type RecoveryAttemptOutcome,
  selfRecoveryOutcome,
} from './managed-runner-durable-recovery-outcome.js';

const command = process.env.CAT_CAFE_MANAGED_RUNNER_COMMAND;
const logPath = process.env.CAT_CAFE_MANAGED_JOB_LOG_PATH;
const descriptorJson = process.env.CAT_CAFE_MANAGED_JOB_DESCRIPTOR;
const cwd = process.env.CAT_CAFE_MANAGED_RUNNER_CWD || undefined;
if (!command || !logPath || !descriptorJson) process.exit(64);
const managedCommand: string = command;

let durableJob: DurableManagedGateJob;
try {
  durableJob = JSON.parse(descriptorJson) as DurableManagedGateJob;
} catch {
  process.exit(64);
}
if (
  !durableJob ||
  typeof durableJob.originTaskId !== 'string' ||
  !validateDurableManagedGateJob(durableJob, durableJob.originTaskId) ||
  logPath !== durableJob.logPath
)
  process.exit(64);

const childEnv = { ...process.env, ...durableManagedGateChildEnvironment(durableJob) };
delete childEnv.CAT_CAFE_MANAGED_RUNNER_COMMAND;
delete childEnv.CAT_CAFE_MANAGED_RUNNER_CWD;
delete childEnv.CAT_CAFE_MANAGED_JOB_DESCRIPTOR;

let durableLog: ReturnType<typeof openDurableManagedRunnerLog> | null = null;
const capture = (chunk: Buffer) => durableLog?.capture(chunk);
const finishLog = () => durableLog?.finish();
let terminationTimer: ReturnType<typeof setTimeout> | null = null;
let terminationSignal: NodeJS.Signals | null = null;
let activeChild: ChildProcess | null = null;

function failClosedBeforeExecution(message: string): never {
  if (!durableLog) {
    // A refused duplicate worker must never truncate the live worker's log.
    try {
      writeFileSync(logPath!, `${message}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
    }
  }
  capture(Buffer.from(`${message}\n`));
  finishLog();
  process.exit(70);
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function exitCodeFor(result: DurableManagedGateChildResult): number {
  return result.code ?? (result.signal === 'SIGINT' ? 130 : result.signal === 'SIGTERM' ? 143 : 1);
}

function spawnAttempt(
  resumeEpoch: number | null,
  frozenIdentity: DurableGateFrozenIdentity | null,
  reconcileFrom: number | null,
): DurableManagedGateAttemptProcess {
  const attempt = spawnDurableManagedGateAttempt({
    job: durableJob,
    command: managedCommand,
    cwd,
    environment: childEnv,
    resumeEpoch,
    frozenIdentity,
    reconcileFrom,
    capture,
    beforeSpawn: (attemptToken) => recordManagedJobAttempt(durableJob, attemptToken, resumeEpoch ?? 0),
  });
  activeChild = attempt.child;
  void attempt.closed.then(() => {
    if (activeChild === attempt.child) activeChild = null;
  });
  return attempt;
}

async function cancellationOutcome(
  owner: UnixProcessIdentity,
  attempt: DurableManagedGateAttemptProcess,
  reconciliationBudgetMs: number,
  pollMs: number,
): Promise<RecoveryAttemptOutcome> {
  const decision = evaluateDurableGateMutation(durableJob, {
    ownerIdentity: owner,
    mutation: hasDurableGateCancellationRequestArtifact(durableJob) ? 'cancel' : 'heartbeat',
  });
  const intent = decision.action === 'terminal_intent' ? decision.intent : 'cancelled';
  return terminalIntentOutcome(owner, attempt, reconciliationBudgetMs, pollMs, intent);
}

async function terminalIntentOutcome(
  owner: UnixProcessIdentity,
  attempt: DurableManagedGateAttemptProcess,
  reconciliationBudgetMs: number,
  pollMs: number,
  intent: 'cancelled' | 'timed_out',
): Promise<RecoveryAttemptOutcome> {
  if (intent === 'timed_out' && !publishDurableGateStopIntent(durableJob, owner, attempt.attemptToken, intent)) {
    capture(Buffer.from('managed stop provenance unavailable; retaining non-resumable cancellation\n'));
  }
  const cleanup = await cleanupManagedRecoveryAttempt(durableJob, attempt, reconciliationBudgetMs, pollMs);
  if (!cleanup.proven) {
    capture(Buffer.from('durable managed attempt cleanup could not be proven before terminal publication\n'));
    return { kind: 'final', result: { code: 70, signal: null } };
  }
  return { kind: 'final', result: durableManagedGateTerminalResult(intent, terminationSignal) };
}

function recoveryFenceOutcome(
  owner: UnixProcessIdentity,
  allowCurrentReconciliation = false,
): RecoveryAttemptOutcome | null {
  const fence = evaluateDurableManagedGateWorkerFence({
    job: durableJob,
    owner,
    cancelRequested: Boolean(terminationSignal || hasDurableGateCancellationRequestArtifact(durableJob)),
    allowCurrentReconciliation,
    terminationSignal,
  });
  if (fence.open) return null;
  if (fence.reason !== 'cancelled' && fence.reason !== 'timed_out') {
    capture(Buffer.from(`durable managed successor spawn was fenced by ${fence.reason}\n`));
  }
  return { kind: 'final', result: fence.result };
}

async function observeAttempt(
  attempt: DurableManagedGateAttemptProcess,
  rawOutcome: DurableManagedGateChildResult | null,
  pollMs: number,
): Promise<DurableManagedGateChildResult | null> {
  if (rawOutcome !== null) {
    await sleep(pollMs);
    return rawOutcome;
  }
  const event = await Promise.race([
    attempt.exited.then((exit) => ({ kind: 'exit' as const, result: exit.result })),
    sleep(pollMs).then(() => ({ kind: 'poll' as const })),
  ]);
  return event.kind === 'exit' ? event.result : null;
}

async function outcomeForRecoveryDecision(
  decision: ReturnType<typeof evaluateDurableGateMutation>,
  rawOutcome: DurableManagedGateChildResult | null,
  owner: UnixProcessIdentity,
  attempt: DurableManagedGateAttemptProcess,
  frozenIdentity: DurableGateFrozenIdentity | null,
  reconciliationBudgetMs: number,
  pollMs: number,
): Promise<RecoveryAttemptOutcome | null> {
  const context = {
    job: durableJob,
    capture,
    readFence: () => recoveryFenceOutcome(owner, true),
    terminationSignal: () => terminationSignal,
  };
  if (decision.action === 'wait') return null;
  if (decision.action === 'blocked') {
    return finalOutcomeAfterCleanup(
      context,
      attempt,
      rawOutcome ?? { code: 70, signal: null },
      reconciliationBudgetMs,
      pollMs,
    );
  }
  if (decision.action === 'terminal_intent') {
    return terminalIntentOutcome(owner, attempt, reconciliationBudgetMs, pollMs, decision.intent);
  }
  if (decision.action === 'self_reconcile') {
    return selfRecoveryOutcome(
      context,
      owner,
      attempt,
      decision.pauseEpoch,
      decision.reconcileFrom,
      frozenIdentity,
      rawOutcome,
      reconciliationBudgetMs,
      pollMs,
    );
  }
  return rawOutcome ? finalOutcomeAfterCleanup(context, attempt, rawOutcome, reconciliationBudgetMs, pollMs) : null;
}

async function runRecoveryAwareAttempt(
  owner: UnixProcessIdentity,
  resumeEpoch: number | null,
  frozenIdentity: DurableGateFrozenIdentity | null,
  reconcileFrom: number | null,
): Promise<RecoveryAttemptOutcome> {
  const recovery = durableJob.recovery;
  if (recovery) {
    const fence = recoveryFenceOutcome(owner);
    if (fence) return fence;
  }
  const attempt = spawnAttempt(resumeEpoch, frozenIdentity, reconcileFrom);
  if (!recovery) {
    await attempt.closed;
    return { kind: 'final', result: (await attempt.exited).result };
  }
  let rawOutcome: DurableManagedGateChildResult | null = null;
  while (true) {
    if (terminationSignal || hasDurableGateCancellationRequestArtifact(durableJob)) {
      return cancellationOutcome(owner, attempt, recovery.reconciliationBudgetMs, recovery.pollMs);
    }
    rawOutcome = await observeAttempt(attempt, rawOutcome, recovery.pollMs);
    const synchronizedIdentity =
      synchronizeDurableGateFrozenIdentity(durableJob) ?? readDurableGateRecovery(durableJob)?.frozenIdentity ?? null;
    const decision = evaluateDurableGateMutation(durableJob, {
      ownerIdentity: owner,
      mutation: rawOutcome ? 'exit' : 'heartbeat',
      ...(rawOutcome ? { rawOutcome } : {}),
    });
    const outcome = await outcomeForRecoveryDecision(
      decision,
      rawOutcome,
      owner,
      attempt,
      synchronizedIdentity,
      recovery.reconciliationBudgetMs,
      recovery.pollMs,
    );
    if (outcome) return outcome;
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    terminationSignal ??= signal;
    if (!durableJob.recovery && durableJob.kind !== 'command') activeChild?.kill(signal);
    if (terminationTimer) return;
    terminationTimer = setTimeout(() => {
      try {
        process.kill(-process.pid, 'SIGKILL');
      } catch {
        process.exit(1);
      }
    }, DURABLE_MANAGED_GATE_CHILD_TERMINATION_GRACE_MS);
  });
}

const workerIdentity = readUnixProcessSnapshotSync({ pids: [process.pid] })?.get(process.pid);
if (!workerIdentity || !recordDurableManagedGateProcess(durableJob, workerIdentity)) {
  failClosedBeforeExecution('durable worker birth registration failed; command was not executed');
}
durableLog = openDurableManagedRunnerLog(logPath);
if (durableJob.recovery) {
  const createdAt = readDurableGateRecord(durableJob)?.createdAt ?? Date.now();
  initializeDurableGateRecovery(durableJob, workerIdentity, createdAt);
}
if (terminationSignal || hasDurableGateCancellationRequestArtifact(durableJob)) {
  if (durableJob.recordStorage === 'sqlite_v1') {
    capture(Buffer.from('Command cancelled before execution\n'));
    finishLog();
    settleDurableManagedGateJobFromRunner(durableJob, {
      exitCode: null,
      timedOut: false,
      cancelled: true,
      durationMs: 0,
      terminationReason: 'explicit_cancel',
      tailOutput: 'Command cancelled before execution',
    });
    process.exit(143);
  }
  failClosedBeforeExecution('durable worker cancellation was requested before execution; command was not executed');
}

if (durableJob.kind === 'command') {
  process.exitCode = await runManagedCommandWorker({
    job: durableJob,
    environment: childEnv,
    capture,
    finishLog,
    cancelled: () => terminationSignal !== null,
  });
  if (terminationTimer) clearTimeout(terminationTimer);
} else {
  let resumeEpoch: number | null = null;
  let resumeIdentity: DurableGateFrozenIdentity | null = null;
  let resumeReconcileFrom: number | null = null;
  while (true) {
    const outcome = await runRecoveryAwareAttempt(workerIdentity, resumeEpoch, resumeIdentity, resumeReconcileFrom);
    if (outcome.kind === 'resume') {
      resumeEpoch = outcome.pauseEpoch;
      resumeIdentity = outcome.frozenIdentity;
      resumeReconcileFrom = outcome.reconcileFrom;
      continue;
    }
    if (terminationTimer) clearTimeout(terminationTimer);
    finishLog();
    if (durableJob.recordStorage === 'sqlite_v1') {
      const record = readDurableGateRecord(durableJob);
      const intent = durableJob.recovery
        ? readDurableGateRecovery(durableJob)?.terminalIntent
        : record?.terminationIntent;
      const terminalResult = {
        exitCode: outcome.result.code,
        timedOut: intent === 'timed_out',
        cancelled: intent === 'cancelled' || terminationSignal !== null,
        durationMs: Date.now() - (record?.createdAt ?? Date.now()),
        tailOutput: readManagedJobLogTail(durableJob.logPath),
        signal: outcome.result.signal,
        log: managedJobLogReceipt(durableJob.logPath),
        terminationReason:
          intent === 'timed_out'
            ? ('runtime_deadline' as const)
            : intent === 'cancelled' || terminationSignal
              ? ('explicit_cancel' as const)
              : ('command_exit' as const),
      };
      if (record?.attemptToken && !record.cleanupProven) {
        const current = rawDurableGateRecord(durableJob);
        if (current)
          writeDurableGateRecord(durableJob, { ...current, pendingResult: terminalResult, updatedAt: Date.now() });
        process.exitCode = 70;
        break;
      }
      settleDurableManagedGateJobFromRunner(durableJob, terminalResult);
    }
    process.exitCode = exitCodeFor(outcome.result);
    break;
  }
}
