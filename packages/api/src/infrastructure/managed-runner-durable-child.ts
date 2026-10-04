import { type ChildProcess, spawn } from 'node:child_process';
import type { DurableManagedGateJob } from '../domains/ball-custody/durable-managed-gate-job.js';
import type { DurableGateFrozenIdentity } from '../domains/ball-custody/durable-managed-gate-recovery.js';
import {
  cleanupDurableManagedGateAttempt,
  createDurableManagedGateAttempt,
  type DurableManagedGateCleanupSignal,
} from './managed-runner-durable-attempt.js';

export interface DurableManagedGateChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: string;
}

export interface DurableManagedGateChildExit {
  readonly result: DurableManagedGateChildResult;
  readonly observedAt: number;
}

export interface DurableManagedGateAttemptProcess {
  readonly child: ChildProcess;
  readonly attemptToken: string;
  readonly exited: Promise<DurableManagedGateChildExit>;
  readonly closed: Promise<void>;
  readonly currentExit: () => DurableManagedGateChildExit | null;
}

export interface DurableManagedGateAttemptCleanupReport {
  readonly proven: boolean;
  readonly processCleanupProven: boolean;
  readonly pipesDrained: boolean;
  readonly signals: readonly DurableManagedGateCleanupSignal[];
}

export function spawnDurableManagedGateAttempt(input: {
  readonly job: DurableManagedGateJob;
  readonly command: string;
  readonly cwd: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly resumeEpoch: number | null;
  readonly frozenIdentity: DurableGateFrozenIdentity | null;
  readonly reconcileFrom: number | null;
  readonly capture: (chunk: Buffer) => void;
}): DurableManagedGateAttemptProcess {
  const attempt = createDurableManagedGateAttempt(
    input.job,
    input.resumeEpoch,
    input.frozenIdentity,
    input.reconcileFrom,
  );
  const child = spawn(input.command, {
    shell: true,
    cwd: input.cwd,
    env: { ...input.environment, ...attempt.environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', input.capture);
  child.stderr.on('data', input.capture);

  let exitObservation: DurableManagedGateChildExit | null = null;
  let resolveExit: (value: DurableManagedGateChildExit) => void = () => undefined;
  const exited = new Promise<DurableManagedGateChildExit>((resolve) => {
    resolveExit = resolve;
  });
  const observeExit = (result: DurableManagedGateChildResult) => {
    if (exitObservation) return;
    exitObservation = { result, observedAt: Date.now() };
    resolveExit(exitObservation);
  };
  child.on('error', (error) => {
    input.capture(Buffer.from(`managed command spawn error: ${error.message}\n`));
    observeExit({ code: 1, signal: null, error: error.message });
  });
  child.on('exit', (code, signal) => observeExit({ code, signal }));
  const closed = new Promise<void>((resolve) => {
    child.on('close', (code, signal) => {
      observeExit({ code, signal });
      resolve();
    });
  });

  return {
    child,
    attemptToken: attempt.attemptToken,
    exited,
    closed,
    currentExit: () => exitObservation,
  };
}

export async function waitForDurableManagedGateAttemptClose(
  attempt: DurableManagedGateAttemptProcess,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      attempt.closed.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function cleanupAndDrainDurableManagedGateAttempt(
  attempt: DurableManagedGateAttemptProcess,
  budgetMs: number,
  pollMs: number,
): Promise<DurableManagedGateAttemptCleanupReport> {
  const startedAt = Date.now();
  const cleanup = await cleanupDurableManagedGateAttempt(attempt.attemptToken, budgetMs, pollMs);
  const remainingMs = Math.max(1, budgetMs - (Date.now() - startedAt));
  const pipesDrained = await waitForDurableManagedGateAttemptClose(attempt, remainingMs);
  const proven = cleanup.proven && pipesDrained;
  if (!proven) releaseDurableManagedGateAttemptHandles(attempt);
  return { proven, processCleanupProven: cleanup.proven, pipesDrained, signals: cleanup.signals };
}

export function durableManagedGateOutcomeApartFromCleanup(
  attempt: DurableManagedGateAttemptProcess,
  rawOutcome: DurableManagedGateChildResult | null,
  exitWasObservedBeforeCleanup: boolean,
  cleanupSignals: readonly DurableManagedGateCleanupSignal[] = [],
): DurableManagedGateChildResult | null {
  const exit = attempt.currentExit();
  const settledOutcome = rawOutcome ?? exit?.result ?? null;
  const childPid = attempt.child?.pid;
  const cleanupSignal =
    rawOutcome === null &&
    exit !== null &&
    !exitWasObservedBeforeCleanup &&
    settledOutcome?.code === null &&
    settledOutcome.error === undefined &&
    settledOutcome.signal !== null &&
    cleanupSignals.some(
      (evidence) =>
        evidence.processIdentity.pid === childPid &&
        evidence.signal === settledOutcome.signal &&
        evidence.sentAt <= exit.observedAt,
    );
  return cleanupSignal ? null : settledOutcome;
}

export function durableManagedGateFailureOrProtocolError(
  result: DurableManagedGateChildResult | null,
): DurableManagedGateChildResult {
  return result && result.code !== 0 ? result : { code: 70, signal: null };
}

function releaseDurableManagedGateAttemptHandles(attempt: DurableManagedGateAttemptProcess): void {
  attempt.child.stdout?.removeAllListeners('data');
  attempt.child.stderr?.removeAllListeners('data');
  attempt.child.stdout?.destroy();
  attempt.child.stderr?.destroy();
  attempt.child.unref();
}
