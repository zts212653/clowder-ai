import type { TurnExecutionRecord } from '@cat-cafe/shared';
import type { ITurnExecutionStore } from '../../stores/ports/TurnExecutionStore.js';
import type { OwnerCandidate } from './InvocationOwnerLeaseCandidates.js';

export interface ExitedChildRecovery {
  getChildProcessExit?: (child: TurnExecutionRecord) => { exitedAt: number; origins?: readonly string[] } | undefined;
  log?: { info(bindings: unknown, message?: string): void };
  /** Synchronous exact-owner fence. Missing/ambiguous control must return false. */
  fenceExitedExecution?: (candidate: OwnerCandidate, children: readonly TurnExecutionRecord[]) => boolean;
  turnExecutionStore: Pick<ITurnExecutionStore, 'listByParent'> &
    Partial<Pick<ITurnExecutionStore, 'transitionTerminal'>>;
}

const FINALIZATION_GRACE_MS = 5 * 60 * 1_000;

/** Serialized reaper only. Readers never invoke recovery or manufacture successful receipts. */
export async function retireExitedChildExecutions(
  candidate: OwnerCandidate,
  deps: ExitedChildRecovery,
  now: number,
): Promise<boolean> {
  if (!deps.getChildProcessExit || !deps.fenceExitedExecution || !deps.turnExecutionStore.transitionTerminal)
    return false;
  const children = await deps.turnExecutionStore.listByParent(candidate.executionId);
  if (
    children.some(
      (child) =>
        child.parentInvocationId !== candidate.executionId ||
        child.threadId !== candidate.threadId ||
        child.userId !== candidate.userId,
    )
  )
    return false;
  const running = children.filter((child) => child.status === 'running');
  if (!running.length) return false;
  const exits = new Map<string, { exitedAt: number; origins?: readonly string[] }>();
  for (const child of running) {
    const exit = deps.getChildProcessExit(child);
    if (
      !exit ||
      !Number.isFinite(exit.exitedAt) ||
      exit.exitedAt < child.startedAt ||
      now - exit.exitedAt < FINALIZATION_GRACE_MS
    )
      return false;
    exits.set(child.invocationId, exit);
  }
  // Fence continued actor work before durable retirement. A fresh process observed since the read vetoes this.
  if (!deps.fenceExitedExecution(candidate, running)) return false;
  for (const child of running) {
    const outcome = await deps.turnExecutionStore.transitionTerminal(child.invocationId, {
      status: 'interrupted',
      endedAt: now,
      terminalReason: 'provider_exited_without_terminal',
      providerTeardownAt: exits.get(child.invocationId)?.exitedAt,
    });
    if (!outcome.record || outcome.record.status === 'running') throw new Error('exited_child_terminal_not_committed');
    deps.log?.info(
      {
        event: 'provider_stop_proof_recovered',
        invocationId: child.invocationId,
        parentInvocationId: candidate.executionId,
        origins: exits.get(child.invocationId)?.origins ?? ['process_exit_event'],
        providerTeardownAt: exits.get(child.invocationId)?.exitedAt,
      },
      'Exact stopped-provider evidence retired child',
    );
  }
  return true;
}
