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

interface RecoveryLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export function createZombieTerminalRecovery(deps: {
  queueProcessor: FailedQueueRecovery;
  log: RecoveryLogger;
}): (event: ReconciledZombieEvent) => Promise<void> {
  return async (event) => {
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
