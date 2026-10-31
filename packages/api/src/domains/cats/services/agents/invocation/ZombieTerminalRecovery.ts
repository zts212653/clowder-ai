import type { TurnExecutionRecord } from '../../stores/ports/TurnExecutionStore.js';
import type { ExactExecutionOwnerState } from './InvocationTracker.js';
import type { ReconciledZombieEvent } from './reconcileZombies.js';

interface FailedQueueRecovery {
  onReconciledZombieComplete(
    threadId: string,
    targetCats: readonly string[],
    invocationId: string,
  ): Promise<{
    recoveredCatIds: string[];
    replacementCatIds: string[];
    ownerStates: Record<string, ExactExecutionOwnerState>;
  }>;
}

/**
 * F117 KD-21: each child turn's response R ends with the body its draft streamed. A settlement that
 * throws is retried at the next startup: an ended turn waits in the response-pending ledger, and a
 * turn still recorded running is interrupted into it first.
 */
interface ChildResponseSettlement {
  listChildTurns(executionId: string): readonly TurnExecutionRecord[] | Promise<readonly TurnExecutionRecord[]>;
  settle(turn: TurnExecutionRecord): Promise<unknown>;
}

interface RecoveryLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export function createZombieTerminalRecovery(deps: {
  queueProcessor: FailedQueueRecovery;
  log: RecoveryLogger;
  childResponses?: ChildResponseSettlement;
}): (event: ReconciledZombieEvent) => Promise<void> {
  return async (event) => {
    // Before the queue moves on, so the reclaimed turn's R is terminal ahead of the next turn.
    if (deps.childResponses) await settleChildResponses(deps.childResponses, deps.log, event);

    if (event.targetCats.length === 0) {
      deps.log.warn(
        { invocationId: event.invocationId, threadId: event.threadId, detectorCatId: event.catId },
        '[F194] zombie terminal recovery skipped: parent has no durable target cats',
      );
      return;
    }

    await deps.queueProcessor.onReconciledZombieComplete(event.threadId, event.targetCats, event.invocationId);
  };
}

async function settleChildResponses(
  childResponses: ChildResponseSettlement,
  log: RecoveryLogger,
  event: ReconciledZombieEvent,
): Promise<void> {
  let turns: readonly TurnExecutionRecord[];
  try {
    turns = await childResponses.listChildTurns(event.invocationId);
  } catch (err) {
    log.warn(
      { invocationId: event.invocationId, threadId: event.threadId, err },
      '[F117] zombie reclaim could not list child turns; their responses stay processing',
    );
    return;
  }
  for (const turn of turns) {
    if (turn.threadId !== event.threadId || turn.userId !== event.userId) continue;
    try {
      await childResponses.settle(turn);
    } catch (err) {
      log.warn(
        { invocationId: turn.invocationId, parentInvocationId: event.invocationId, threadId: event.threadId, err },
        '[F117] zombie reclaim could not settle a child response; its draft is kept and the next startup settles it',
      );
    }
  }
}
