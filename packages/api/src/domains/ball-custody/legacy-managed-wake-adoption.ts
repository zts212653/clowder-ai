import type { InvocationQueue } from '../cats/services/agents/invocation/InvocationQueue.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import type { ActionSuccessorLeaseStore } from './ActionSuccessorLeaseStore.js';
import {
  hasManagedCommandWakeActionLeaseRef,
  resolveManagedCommandWakeActionLeaseAdmission,
} from './managed-command-wake-action-lease-admission.js';
import type { ManagedCommandWakeLegacyAdoption } from './managed-command-wake-lifecycle.js';
import { waitContinuationCarrierFromStoredMessage } from './wait-continuation-carrier.js';

/**
 * Adopt a wake that a pre-atomic deployment left half-committed: a durable Message with no Queue
 * row behind it. New wakes never take this path — the fence commits both halves together — but
 * tasks persisted as `message_written` / `dispatch_pending` before that change still have to
 * recover, or those owners are never woken at all.
 *
 * The lease is re-verified here, and that placement is the whole point. The two-phase path checked
 * it inside the trigger, i.e. at exactly this step, so adopting without the check would admit a
 * generation that has since moved on — on the one path where stale carriers actually live. A stale
 * generation throws `ManagedCommandWakeActionLeaseAdmissionError`, which the recovery engine
 * already turns into cancel-the-message-and-retire-the-task; an active one puts its exact fence on
 * the row, so the admitted work stays bound to the generation that authorised it.
 */
export interface LegacyManagedWakeAdoptionDeps {
  readonly messageStore: Pick<IMessageStore, 'getById'>;
  readonly invocationQueue: Pick<InvocationQueue, 'enqueueExistingMessageDurable'>;
  readonly messageStoreForQueue: IMessageStore;
  readonly actionSuccessorLeaseStore?: Pick<ActionSuccessorLeaseStore, 'get'>;
  readonly notifyAdmitted: (threadId: string, userId: string) => Promise<void>;
}

export function createLegacyManagedWakeAdoption(
  deps: LegacyManagedWakeAdoptionDeps,
): (input: ManagedCommandWakeLegacyAdoption) => Promise<{ adopted: boolean }> {
  return async (input) => {
    const sourceMessage = await deps.messageStore.getById(input.messageId);
    const leaseAdmission = hasManagedCommandWakeActionLeaseRef(sourceMessage)
      ? await resolveManagedCommandWakeActionLeaseAdmission(
          sourceMessage,
          { threadId: input.threadId, catId: input.catId, tenantScope: input.userId },
          deps.actionSuccessorLeaseStore,
        )
      : undefined;
    const waitContinuationCarrier = waitContinuationCarrierFromStoredMessage(sourceMessage);
    const adopted = await deps.invocationQueue.enqueueExistingMessageDurable(
      deps.messageStoreForQueue,
      input.messageId,
      {
        threadId: input.threadId,
        userId: input.userId,
        sourceId: input.messageId,
        kind: 'conversation_input',
        ownerAuthProvenance: 'unknown',
        content: input.content,
        messageId: input.messageId,
        from: { kind: 'system', service: 'managed-command-wake' },
        targetCats: [input.catId],
        intent: 'execute',
        priority: 'urgent',
        sourceCategory: 'scheduled',
        ...(leaseAdmission?.actionSuccessorFence ? { actionSuccessorFence: leaseAdmission.actionSuccessorFence } : {}),
        ...(waitContinuationCarrier ? { waitContinuationCarrier } : {}),
      },
    );
    if (adopted.outcome === 'full') return { adopted: false };
    await deps.notifyAdmitted(input.threadId, input.userId);
    return { adopted: true };
  };
}
