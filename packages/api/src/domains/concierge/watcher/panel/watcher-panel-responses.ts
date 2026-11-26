import type {
  TurnExecutionRecord,
  WatcherPanelResponseRef,
  WatcherPanelResponseRefs,
  WatcherPanelRound,
} from '@cat-cafe/shared';
import type { ITurnExecutionStore } from '../../../cats/services/stores/ports/TurnExecutionStore.js';

function ref(record: TurnExecutionRecord): WatcherPanelResponseRef {
  const settlement = record.responseSettlement;
  return {
    invocationId: record.invocationId,
    ...(settlement?.kind === 'message' ? { responseMessageId: settlement.messageId } : {}),
    ...(settlement ? { settledAt: settlement.settledAt } : {}),
  };
}

/** Read-time join: where the worker answered the delivery, and what it did on its following turn. */
export async function watcherPanelResponses(
  executions: Pick<ITurnExecutionStore, 'listSettled'>,
  round: WatcherPanelRound,
): Promise<WatcherPanelResponseRefs | undefined> {
  const delivery = round.delivery;
  if (!delivery || !('messageId' in delivery)) return undefined;
  const page = await executions.listSettled({
    userId: round.userId,
    threadId: round.threadId,
    afterSequence: round.sourceSettledSequence,
    limit: 100,
  });
  const worker = page.records.filter(
    (record) => record.executionKind === 'ordinary' && record.catId === round.workerCatId,
  );
  const byTrigger = worker.findIndex((record) => record.causal?.triggerMessageId === delivery.messageId);
  const index = byTrigger >= 0 ? byTrigger : worker.findIndex((record) => record.startedAt >= delivery.deliveredAt);
  if (index < 0) return undefined;
  const following = worker[index + 1];
  return {
    woken: { ...ref(worker[index]!), matchedBy: byTrigger >= 0 ? 'trigger' : 'after_delivery' },
    ...(following ? { next: ref(following) } : {}),
  };
}
