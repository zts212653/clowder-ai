import type { InvocationQueue } from '../../cats/services/agents/invocation/InvocationQueue.js';
import type { AgentRouter } from '../../cats/services/agents/routing/AgentRouter.js';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { MessagingIngressWakeDeps } from '../../messaging/ingress-wake.js';

/** Plugin identity changes the source; ordinary conversation admission owns all routing. */
export function createPluginConversationDelivery(deps: {
  messageStore: IMessageStore;
  queue: Pick<InvocationQueue, 'enqueueExistingMessageDurable'>;
  router: Pick<AgentRouter, 'resolveConversationTargetsAtAdmission' | 'resolveSendTargets'>;
}): MessagingIngressWakeDeps['invokeTrigger'] {
  return {
    async trigger(threadId, catId, userId, content, messageId) {
      const stored = await deps.messageStore.getById(messageId);
      if (!stored || stored.from?.kind !== 'plugin') throw new Error('plugin ingress message is unavailable');
      const targetCats =
        catId === undefined
          ? await deps.router.resolveSendTargets([], threadId, content)
          : await deps.router.resolveConversationTargetsAtAdmission([catId], threadId, content);
      const admitted = await deps.queue.enqueueExistingMessageDurable(deps.messageStore, messageId, {
        threadId,
        userId,
        content,
        from: stored.from,
        sourceId: messageId,
        idempotencyKey: `plugin-ingress:${messageId}`,
        kind: 'conversation_input',
        intent: 'execute',
        targetCats,
        ownerAuthProvenance: 'unknown',
      });
      return admitted.outcome === 'full' ? 'full' : 'enqueued';
    },
  };
}
