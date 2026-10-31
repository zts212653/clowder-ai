import type { DurableManagedGateJob } from '../domains/ball-custody/durable-managed-gate-job.js';
import {
  evaluateDurableGateMutation,
  readDurableGateRecovery,
} from '../domains/ball-custody/durable-managed-gate-recovery.js';
import type { UnixProcessIdentity } from '../utils/cli-process-ownership.js';
import type { DurableManagedGateChildResult } from './managed-runner-durable-child.js';

export type DurableManagedGateWorkerFence =
  | { readonly open: true }
  | { readonly open: false; readonly result: DurableManagedGateChildResult; readonly reason: string };

export function durableManagedGateTerminalResult(
  intent: 'cancelled' | 'timed_out',
  terminationSignal: NodeJS.Signals | null,
): DurableManagedGateChildResult {
  return intent === 'cancelled' ? { code: null, signal: terminationSignal ?? 'SIGTERM' } : { code: 124, signal: null };
}

export function durableManagedGateTerminalSnapshotResult(
  job: DurableManagedGateJob,
  terminationSignal: NodeJS.Signals | null,
): DurableManagedGateChildResult | null {
  const intent = readDurableGateRecovery(job)?.terminalIntent;
  return intent ? durableManagedGateTerminalResult(intent, terminationSignal) : null;
}

export function evaluateDurableManagedGateWorkerFence(input: {
  readonly job: DurableManagedGateJob;
  readonly owner: UnixProcessIdentity;
  readonly cancelRequested: boolean;
  readonly allowCurrentReconciliation: boolean;
  readonly terminationSignal: NodeJS.Signals | null;
}): DurableManagedGateWorkerFence {
  const decision = evaluateDurableGateMutation(input.job, {
    ownerIdentity: input.owner,
    mutation: input.cancelRequested ? 'cancel' : 'heartbeat',
  });
  if (decision.action === 'terminal_intent') {
    return {
      open: false,
      result: durableManagedGateTerminalResult(decision.intent, input.terminationSignal),
      reason: decision.intent,
    };
  }
  if (decision.action === 'blocked') {
    return { open: false, result: { code: 70, signal: null }, reason: 'blocked' };
  }
  if (decision.action !== 'proceed' && !input.allowCurrentReconciliation) {
    return { open: false, result: { code: 70, signal: null }, reason: decision.action };
  }
  return { open: true };
}
