import { readAlphaRecoveryObservation } from '../domains/ball-custody/durable-managed-alpha-observation.js';
import type { DurableManagedGateJob } from '../domains/ball-custody/durable-managed-gate-job.js';
import {
  acknowledgeDurableGateSelfRecovery,
  blockDurableGateSelfRecovery,
  type DurableGateFrozenIdentity,
  evaluateDurableGateMutation,
} from '../domains/ball-custody/durable-managed-gate-recovery.js';
import { hasDurableGateRecoveryReadyReceipt } from '../domains/ball-custody/durable-managed-gate-recovery-child-contract.js';
import { durableGateRawOutcomeIsAmbiguous } from '../domains/ball-custody/durable-managed-gate-recovery-policy.js';
import type { UnixProcessIdentity } from '../utils/cli-process-ownership.js';
import {
  type DurableManagedGateAttemptProcess,
  type DurableManagedGateChildResult,
  durableManagedGateFailureOrProtocolError,
  durableManagedGateOutcomeApartFromCleanup,
} from './managed-runner-durable-child.js';
import { cleanupManagedRecoveryAttempt } from './managed-runner-durable-cleanup.js';
import { durableManagedGateTerminalSnapshotResult } from './managed-runner-durable-recovery-fence.js';

export type RecoveryAttemptOutcome =
  | { kind: 'final'; result: DurableManagedGateChildResult }
  | { kind: 'resume'; pauseEpoch: number; frozenIdentity: DurableGateFrozenIdentity; reconcileFrom: number };

interface RecoveryContext {
  readonly job: DurableManagedGateJob;
  readonly capture: (chunk: Buffer) => void;
  readonly readFence: () => RecoveryAttemptOutcome | null;
  readonly terminationSignal: () => NodeJS.Signals | null;
}

export async function finalOutcomeAfterCleanup(
  context: RecoveryContext,
  attempt: DurableManagedGateAttemptProcess,
  result: DurableManagedGateChildResult,
  reconciliationBudgetMs: number,
  pollMs: number,
): Promise<RecoveryAttemptOutcome> {
  const cleanup = await cleanupManagedRecoveryAttempt(context.job, attempt, reconciliationBudgetMs, pollMs);
  if (cleanup.proven) {
    return { kind: 'final', result };
  }
  context.capture(Buffer.from('durable managed attempt cleanup could not be proven before terminal publication\n'));
  return { kind: 'final', result: { code: 70, signal: null } };
}

export async function selfRecoveryOutcome(
  context: RecoveryContext,
  owner: UnixProcessIdentity,
  attempt: DurableManagedGateAttemptProcess,
  pauseEpoch: number,
  reconcileFrom: number,
  frozenIdentity: DurableGateFrozenIdentity | null,
  rawOutcome: DurableManagedGateChildResult | null,
  reconciliationBudgetMs: number,
  pollMs: number,
): Promise<RecoveryAttemptOutcome> {
  const alphaObservation =
    context.job.kind === 'alpha_revision_v1' ? readAlphaRecoveryObservation(context.job, attempt.attemptToken) : null;
  if (alphaObservation?.kind === 'failed') {
    context.capture(Buffer.from(`Alpha observed failure at ${alphaObservation.firstFailureAt}; no automatic replay\n`));
    evaluateDurableGateMutation(context.job, {
      ownerIdentity: owner,
      mutation: 'exit',
      rawOutcome: { code: 1, signal: null },
    });
    return finalOutcomeAfterCleanup(context, attempt, { code: 1, signal: null }, reconciliationBudgetMs, pollMs);
  }
  if (alphaObservation?.kind === 'unknown') {
    const cleanup = await cleanupManagedRecoveryAttempt(context.job, attempt, reconciliationBudgetMs, pollMs);
    blockDurableGateSelfRecovery(
      context.job,
      owner,
      pauseEpoch,
      cleanup.proven ? 'child_protocol_unavailable' : 'cleanup_unproven',
    );
    context.capture(Buffer.from(`Alpha automatic replay unavailable: ${alphaObservation.reason}\n`));
    return { kind: 'final', result: { code: 70, signal: null } };
  }
  if (!frozenIdentity || !hasDurableGateRecoveryReadyReceipt(context.job, attempt.attemptToken, frozenIdentity)) {
    const cleanup = await cleanupManagedRecoveryAttempt(context.job, attempt, reconciliationBudgetMs, pollMs);
    blockDurableGateSelfRecovery(
      context.job,
      owner,
      pauseEpoch,
      cleanup.proven ? 'child_protocol_unavailable' : 'cleanup_unproven',
    );
    context.capture(Buffer.from('durable live-owner recovery child protocol was not acknowledged\n'));
    return {
      kind: 'final',
      result: cleanup.proven ? durableManagedGateFailureOrProtocolError(rawOutcome) : { code: 70, signal: null },
    };
  }
  const exitWasObservedBeforeCleanup = attempt.currentExit() !== null;
  const cleanup = await cleanupManagedRecoveryAttempt(context.job, attempt, reconciliationBudgetMs, pollMs);
  if (!cleanup.proven) {
    blockDurableGateSelfRecovery(context.job, owner, pauseEpoch, 'cleanup_unproven');
    context.capture(Buffer.from('durable live-owner recovery cleanup could not be proven\n'));
    return { kind: 'final', result: { code: 70, signal: null } };
  }
  const settledOutcome = durableManagedGateOutcomeApartFromCleanup(
    attempt,
    rawOutcome,
    exitWasObservedBeforeCleanup,
    cleanup.signals,
  );
  if (context.job.kind === 'alpha_revision_v1') {
    const observed = readAlphaRecoveryObservation(context.job, attempt.attemptToken, cleanup.signals);
    if (observed.kind === 'failed' || observed.kind === 'unknown') {
      context.capture(Buffer.from(`Alpha recovery stopped after cleanup: ${observed.kind}\n`));
      const result = { code: observed.kind === 'failed' ? 1 : 70, signal: null };
      evaluateDurableGateMutation(context.job, { ownerIdentity: owner, mutation: 'exit', rawOutcome: result });
      return { kind: 'final', result };
    }
  }
  if (settledOutcome && durableGateRawOutcomeIsAmbiguous('exit', settledOutcome)) {
    evaluateDurableGateMutation(context.job, { ownerIdentity: owner, mutation: 'exit', rawOutcome: settledOutcome });
    return { kind: 'final', result: settledOutcome };
  }
  const fence = context.readFence();
  if (fence) return fence;
  if (!acknowledgeDurableGateSelfRecovery(context.job, owner, pauseEpoch)) {
    context.capture(Buffer.from('durable live-owner recovery acknowledgement was fenced\n'));
    const result = durableManagedGateTerminalSnapshotResult(context.job, context.terminationSignal());
    return { kind: 'final', result: result ?? { code: 70, signal: null } };
  }
  context.capture(Buffer.from(`[managed-gate-recovery] resumed pauseEpoch=${pauseEpoch}\n`));
  return { kind: 'resume', pauseEpoch, frozenIdentity, reconcileFrom };
}
