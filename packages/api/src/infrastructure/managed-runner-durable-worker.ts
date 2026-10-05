import type { ChildProcess } from 'node:child_process';
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
import { readDurableGateRecord } from '../domains/ball-custody/durable-managed-gate-job-store.js';
import {
  acknowledgeDurableGateSelfRecovery,
  blockDurableGateSelfRecovery,
  type DurableGateFrozenIdentity,
  evaluateDurableGateMutation,
  initializeDurableGateRecovery,
  readDurableGateRecovery,
  synchronizeDurableGateFrozenIdentity,
} from '../domains/ball-custody/durable-managed-gate-recovery.js';
import { hasDurableGateRecoveryReadyReceipt } from '../domains/ball-custody/durable-managed-gate-recovery-child-contract.js';
import { durableGateRawOutcomeIsAmbiguous } from '../domains/ball-custody/durable-managed-gate-recovery-policy.js';
import { publishDurableGateStopIntent } from '../domains/ball-custody/durable-managed-gate-stop-intent.js';
import { readUnixProcessSnapshotSync, type UnixProcessIdentity } from '../utils/cli-process-ownership.js';
import {
  cleanupAndDrainDurableManagedGateAttempt,
  type DurableManagedGateAttemptProcess,
  type DurableManagedGateChildResult,
  durableManagedGateFailureOrProtocolError,
  durableManagedGateOutcomeApartFromCleanup,
  spawnDurableManagedGateAttempt,
} from './managed-runner-durable-child.js';
import { openDurableManagedRunnerLog } from './managed-runner-durable-log.js';
import {
  durableManagedGateTerminalResult,
  durableManagedGateTerminalSnapshotResult,
  evaluateDurableManagedGateWorkerFence,
} from './managed-runner-durable-recovery-fence.js';

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

const { capture, finish: finishLog } = openDurableManagedRunnerLog(logPath);
let terminationTimer: ReturnType<typeof setTimeout> | null = null;
let terminationSignal: NodeJS.Signals | null = null;
let activeChild: ChildProcess | null = null;

function failClosedBeforeExecution(message: string): never {
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
  });
  activeChild = attempt.child;
  void attempt.closed.then(() => {
    if (activeChild === attempt.child) activeChild = null;
  });
  return attempt;
}

type RecoveryAttemptOutcome =
  | { kind: 'final'; result: DurableManagedGateChildResult }
  | { kind: 'resume'; pauseEpoch: number; frozenIdentity: DurableGateFrozenIdentity; reconcileFrom: number };

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
  const cleanup = await cleanupAndDrainDurableManagedGateAttempt(attempt, reconciliationBudgetMs, pollMs);
  if (!cleanup.proven) {
    capture(Buffer.from('durable managed attempt cleanup could not be proven before terminal publication\n'));
    return { kind: 'final', result: { code: 70, signal: null } };
  }
  return { kind: 'final', result: durableManagedGateTerminalResult(intent, terminationSignal) };
}

async function finalOutcomeAfterCleanup(
  attempt: DurableManagedGateAttemptProcess,
  result: DurableManagedGateChildResult,
  reconciliationBudgetMs: number,
  pollMs: number,
): Promise<RecoveryAttemptOutcome> {
  const cleanup = await cleanupAndDrainDurableManagedGateAttempt(attempt, reconciliationBudgetMs, pollMs);
  if (cleanup.proven) {
    return { kind: 'final', result };
  }
  capture(Buffer.from('durable managed attempt cleanup could not be proven before terminal publication\n'));
  return { kind: 'final', result: { code: 70, signal: null } };
}

async function selfRecoveryOutcome(
  owner: UnixProcessIdentity,
  attempt: DurableManagedGateAttemptProcess,
  pauseEpoch: number,
  reconcileFrom: number,
  frozenIdentity: DurableGateFrozenIdentity | null,
  rawOutcome: DurableManagedGateChildResult | null,
  reconciliationBudgetMs: number,
  pollMs: number,
): Promise<RecoveryAttemptOutcome> {
  if (!frozenIdentity || !hasDurableGateRecoveryReadyReceipt(durableJob, attempt.attemptToken, frozenIdentity)) {
    const cleanup = await cleanupAndDrainDurableManagedGateAttempt(attempt, reconciliationBudgetMs, pollMs);
    blockDurableGateSelfRecovery(
      durableJob,
      owner,
      pauseEpoch,
      cleanup.proven ? 'child_protocol_unavailable' : 'cleanup_unproven',
    );
    capture(Buffer.from('durable live-owner recovery child protocol was not acknowledged\n'));
    return {
      kind: 'final',
      result: cleanup.proven ? durableManagedGateFailureOrProtocolError(rawOutcome) : { code: 70, signal: null },
    };
  }
  const exitWasObservedBeforeCleanup = attempt.currentExit() !== null;
  const cleanup = await cleanupAndDrainDurableManagedGateAttempt(attempt, reconciliationBudgetMs, pollMs);
  if (!cleanup.proven) {
    blockDurableGateSelfRecovery(durableJob, owner, pauseEpoch, 'cleanup_unproven');
    capture(Buffer.from('durable live-owner recovery cleanup could not be proven\n'));
    return { kind: 'final', result: { code: 70, signal: null } };
  }
  const settledOutcome = durableManagedGateOutcomeApartFromCleanup(
    attempt,
    rawOutcome,
    exitWasObservedBeforeCleanup,
    cleanup.signals,
  );
  if (settledOutcome && durableGateRawOutcomeIsAmbiguous('exit', settledOutcome)) {
    evaluateDurableGateMutation(durableJob, { ownerIdentity: owner, mutation: 'exit', rawOutcome: settledOutcome });
    return { kind: 'final', result: settledOutcome };
  }
  const fence = recoveryFenceOutcome(owner, true);
  if (fence) return fence;
  if (!acknowledgeDurableGateSelfRecovery(durableJob, owner, pauseEpoch)) {
    capture(Buffer.from('durable live-owner recovery acknowledgement was fenced\n'));
    const result = durableManagedGateTerminalSnapshotResult(durableJob, terminationSignal);
    return { kind: 'final', result: result ?? { code: 70, signal: null } };
  }
  capture(Buffer.from(`[managed-gate-recovery] resumed pauseEpoch=${pauseEpoch}\n`));
  return { kind: 'resume', pauseEpoch, frozenIdentity, reconcileFrom };
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
  if (decision.action === 'wait') return null;
  if (decision.action === 'blocked') {
    return finalOutcomeAfterCleanup(attempt, rawOutcome ?? { code: 70, signal: null }, reconciliationBudgetMs, pollMs);
  }
  if (decision.action === 'terminal_intent') {
    return terminalIntentOutcome(owner, attempt, reconciliationBudgetMs, pollMs, decision.intent);
  }
  if (decision.action === 'self_reconcile') {
    return selfRecoveryOutcome(
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
  return rawOutcome ? finalOutcomeAfterCleanup(attempt, rawOutcome, reconciliationBudgetMs, pollMs) : null;
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

const workerIdentity = readUnixProcessSnapshotSync({ pids: [process.pid] })?.get(process.pid);
if (!workerIdentity || !recordDurableManagedGateProcess(durableJob, workerIdentity)) {
  failClosedBeforeExecution('durable worker birth registration failed; command was not executed');
}
if (durableJob.recovery) {
  const createdAt = readDurableGateRecord(durableJob)?.createdAt ?? Date.now();
  initializeDurableGateRecovery(durableJob, workerIdentity, createdAt);
}
if (hasDurableGateCancellationRequestArtifact(durableJob)) {
  failClosedBeforeExecution('durable worker cancellation was requested before execution; command was not executed');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    terminationSignal ??= signal;
    if (!durableJob.recovery) activeChild?.kill(signal);
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
  process.exitCode = exitCodeFor(outcome.result);
  break;
}
