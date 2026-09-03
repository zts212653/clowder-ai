import { createCatId } from '@cat-cafe/shared';
import type { LegacyLocalReviewDispositionServiceDeps } from '../domains/ball-custody/LegacyLocalReviewDispositionService.js';
import type { InvocationQueue } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import { type A2ATriggerDeps, enqueueA2ATargets } from './callback-a2a-trigger.js';

export type LegacyLocalReviewContinuationQueueDeps = Omit<A2ATriggerDeps, 'invocationQueue'> & {
  invocationQueue: InvocationQueue;
  enqueueTargets?: typeof enqueueA2ATargets;
};

export function createLegacyLocalReviewContinuationQueueAdapter(
  deps: LegacyLocalReviewContinuationQueueDeps,
): LegacyLocalReviewDispositionServiceDeps['enqueueContinuation'] {
  const { invocationQueue, enqueueTargets = enqueueA2ATargets, ...a2aDeps } = deps;
  return async ({ decisionMessage, reviewerCatId, predecessorCatId, predecessorThreadId }) => {
    const existingCarrier = invocationQueue.findEntryWithMessageId(predecessorThreadId, decisionMessage.id);
    if (existingCarrier) return { outcome: 'replayed', queueEntryId: existingCarrier.id };

    const persistedBeforeEnqueue = await deps.messageStore?.getById(decisionMessage.id);
    if (
      persistedBeforeEnqueue?.deliveryStatus === 'delivered' ||
      persistedBeforeEnqueue?.queueCustody?.status === 'terminal'
    ) {
      return {
        outcome: 'replayed',
        queueEntryId: `delivered:${decisionMessage.id}`,
      };
    }

    const targetCatId = createCatId(predecessorCatId);
    const enqueueResult = await enqueueTargets(
      { ...a2aDeps, invocationQueue },
      {
        targetCats: [targetCatId],
        content: decisionMessage.content,
        userId: decisionMessage.userId,
        ownerAuthProvenance: 'strict',
        threadId: predecessorThreadId,
        triggerMessage: decisionMessage,
        callerCatId: createCatId(reviewerCatId),
      },
    );
    const accepted = new Set([...enqueueResult.enqueued, ...(enqueueResult.coalesced ?? [])]);
    const carrier = invocationQueue.findEntryWithMessageId(predecessorThreadId, decisionMessage.id);
    if (carrier) {
      return {
        outcome: accepted.has(targetCatId) ? 'enqueued' : 'replayed',
        queueEntryId: carrier.id,
      };
    }

    const persistedAfterEnqueue = await deps.messageStore?.getById(decisionMessage.id);
    if (
      persistedAfterEnqueue?.deliveryStatus === 'delivered' ||
      persistedAfterEnqueue?.queueCustody?.status === 'terminal'
    ) {
      return {
        outcome: 'replayed',
        queueEntryId: `delivered:${decisionMessage.id}`,
      };
    }
    throw new Error('legacy review continuation has no durable Queue carrier');
  };
}
