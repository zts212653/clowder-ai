import type { InvocationQueue } from '../cats/services/agents/invocation/InvocationQueue.js';
import type { IInvocationRecordStore } from '../cats/services/stores/ports/InvocationRecordStore.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import {
  type ManagedCommandWakeRecoveryDeps,
  resolveManagedCommandWakeEventCarrier,
} from './managed-command-wake-lifecycle.js';

interface ManagedCommandWakeCarrierAdapterDeps {
  readonly messageStore: Pick<IMessageStore, 'getById'>;
  readonly invocationRecordStore: Pick<IInvocationRecordStore, 'get'>;
  readonly invocationQueue: Pick<InvocationQueue, 'getDurableEntriesForMessages'>;
}

/**
 * Resolve managed-command delivery from its canonical owners:
 * Queue only proves an exact target is still pending; once delivered, the
 * source dispatchRef and response bubble in History own every later state.
 */
export function createManagedCommandWakeCarrierAdapter(
  deps: ManagedCommandWakeCarrierAdapterDeps,
): Pick<ManagedCommandWakeRecoveryDeps, 'getEventCarrier'> {
  return {
    getEventCarrier: async ({ threadId, userId, catId, messageId }) => {
      const message = await deps.messageStore.getById(messageId);
      const refs =
        message?.lifecycle && 'dispatchRefs' in message.lifecycle ? (message.lifecycle.dispatchRefs ?? []) : [];
      const matchingRef = refs.find((ref) => ref.targetId === catId);
      const response = matchingRef ? await deps.messageStore.getById(matchingRef.statusMessageId) : null;
      let pendingTarget = false;
      if (!matchingRef) {
        const entries = (await deps.invocationQueue.getDurableEntriesForMessages(threadId, [messageId])).get(messageId);
        pendingTarget =
          entries?.some(
            (entry) =>
              entry.owner.kind === 'user' &&
              entry.owner.userId === userId &&
              entry.threadId === threadId &&
              entry.targets.includes(catId),
          ) ?? false;
      }
      const carrier = resolveManagedCommandWakeEventCarrier(message, response, pendingTarget, {
        threadId,
        userId,
        catId,
      });
      if (carrier.state !== 'failed' || !carrier.invocationId) return carrier;
      const invocation = await deps.invocationRecordStore.get(carrier.invocationId);
      return {
        ...carrier,
        ...(invocation?.status === 'failed' && invocation.error ? { errorCode: invocation.error } : {}),
      };
    },
  };
}
