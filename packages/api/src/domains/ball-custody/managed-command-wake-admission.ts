import type { InvocationQueue } from '../cats/services/agents/invocation/InvocationQueue.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import type { ManagedCommandWakeRecoveryDeps } from './managed-command-wake-lifecycle.js';

/** The composition port shared by live completion and restart recovery. */
export function createManagedCommandWakeAdmission(deps: {
  queue: Pick<InvocationQueue, 'send'>;
  messageStore: IMessageStore;
  notifyAdmitted: (threadId: string, userId: string) => Promise<void>;
}): ManagedCommandWakeRecoveryDeps['admitWake'] {
  return async (input) => {
    // The producer verified the current lease before this atomic Message + Queue commit.
    // Owner grade and restrictions are private registration facts, never inferred here.
    const admitted = await deps.queue.send(deps.messageStore, input.message, {
      threadId: input.threadId,
      userId: input.userId,
      sourceId: input.message.idempotencyKey,
      kind: 'conversation_input',
      ownerAuthProvenance: input.ownerAuthProvenance,
      ...(input.toolExecutionPolicy ? { readOnlyToolPolicy: input.toolExecutionPolicy } : {}),
      idempotencyKey: input.message.idempotencyKey,
      content: input.content,
      from: input.message.from,
      targetCats: [input.catId],
      intent: 'execute',
      priority: input.priority,
      sourceCategory: input.sourceCategory,
      ...(input.actionSuccessorFence ? { actionSuccessorFence: input.actionSuccessorFence } : {}),
    });
    if (admitted.outcome === 'full') return {};
    await deps.notifyAdmitted(input.threadId, input.userId);
    return { messageId: admitted.message.id };
  };
}
