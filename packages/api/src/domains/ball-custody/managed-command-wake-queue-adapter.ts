import type { DynamicTaskStore } from '../../infrastructure/scheduler/DynamicTaskStore.js';
import type { InvocationQueue } from '../cats/services/agents/invocation/InvocationQueue.js';
import type { QueueProcessor } from '../cats/services/agents/invocation/QueueProcessor.js';
import type { IInvocationRecordStore } from '../cats/services/stores/ports/InvocationRecordStore.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import {
  type ManagedCommandWakeRecoveryDeps,
  parseManagedCommandWakeTask,
  resolveManagedCommandWakeEventCarrier,
} from './managed-command-wake-lifecycle.js';

interface ManagedCommandWakeQueueAdapterDeps {
  readonly dynamicTaskStore: Pick<DynamicTaskStore, 'getById'>;
  readonly messageStore: Pick<IMessageStore, 'getById' | 'transitionQueueCustody'>;
  readonly invocationRecordStore: Pick<IInvocationRecordStore, 'get'>;
  readonly invocationQueue: Pick<InvocationQueue, 'getEntrySnapshot'>;
  readonly queueProcessor: Pick<QueueProcessor, 'retryFailedTarget'>;
}

export function createManagedCommandWakeQueueAdapter(
  deps: ManagedCommandWakeQueueAdapterDeps,
): Pick<ManagedCommandWakeRecoveryDeps, 'getEventCarrier' | 'retryEventCarrier'> {
  return {
    getEventCarrier: async ({ threadId, userId, catId, messageId }) => {
      const message = await deps.messageStore.getById(messageId);
      const custodyEntryId = message?.queueCustody?.entryId;
      const activeQueueEntryId = custodyEntryId
        ? (deps.invocationQueue.getEntrySnapshot(threadId, userId, custodyEntryId)?.id ?? null)
        : null;
      const carrier = resolveManagedCommandWakeEventCarrier(message, { threadId, catId, activeQueueEntryId });
      if (carrier.state !== 'failed' || !carrier.invocationId) return carrier;
      const invocation = await deps.invocationRecordStore.get(carrier.invocationId);
      return {
        ...carrier,
        ...(invocation?.status === 'failed' && invocation.error ? { errorCode: invocation.error } : {}),
      };
    },

    retryEventCarrier: async ({ taskId, threadId, userId, catId, messageId, attemptId }) => {
      const task = parseManagedCommandWakeTask(deps.dynamicTaskStore.getById(taskId));
      const message = await deps.messageStore.getById(messageId);
      if (
        !task ||
        task.threadId !== threadId ||
        task.userId !== userId ||
        task.catId !== catId ||
        task.command.messageId !== messageId ||
        message?.threadId !== threadId ||
        message.source?.connector !== 'hold-ball' ||
        message.source.meta?.taskId !== taskId ||
        message.source.meta?.wakeWhen !== true ||
        !message.queueCustody ||
        (message.queueCustody.ownerUserId !== undefined && message.queueCustody.ownerUserId !== userId)
      ) {
        return 'not_retryable';
      }
      const result = await deps.queueProcessor.retryFailedTarget(
        threadId,
        userId,
        message.queueCustody.entryId,
        catId,
        attemptId,
        async (transitions) => {
          if (transitions.length !== 1 || transitions[0]?.messageId !== messageId) {
            return { outcome: 'unavailable' };
          }
          const currentTask = parseManagedCommandWakeTask(deps.dynamicTaskStore.getById(taskId));
          if (!currentTask || currentTask.command.messageId !== messageId) {
            return { outcome: 'authority_stale', reason: 'outcome_mismatch' };
          }
          const transition = transitions[0];
          const committed = await deps.messageStore.transitionQueueCustody(transition.messageId, {
            expectedRevision: transition.current.revision,
            next: transition.next,
          });
          return committed.kind === 'updated' ? { outcome: 'committed' } : { outcome: 'custody_conflict' };
        },
      );
      if (result.outcome === 'retried') return 'retried';
      return result.outcome === 'unavailable' ? 'unavailable' : 'not_retryable';
    },
  };
}
