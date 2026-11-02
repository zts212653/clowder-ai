import { isDeepStrictEqual } from 'node:util';
import type { InvocationQueue } from '../../cats/services/agents/invocation/InvocationQueue.js';
import { queueOwner } from '../../cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import type { AgentRouter } from '../../cats/services/agents/routing/AgentRouter.js';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { MessagingIngressWakeDeps } from '../../messaging/ingress-wake.js';

/** Plugin identity changes the source; ordinary conversation admission owns all routing. */
export function createPluginConversationDelivery(deps: {
  messageStore: IMessageStore;
  queue: Pick<
    InvocationQueue,
    'enqueueExistingMessageDurable' | 'getDurableEntriesForMessages' | 'adoptCommittedAdmission'
  >;
  router: Pick<AgentRouter, 'resolveConversationTargetsAtAdmission' | 'resolveSendTargets'>;
}): MessagingIngressWakeDeps['invokeTrigger'] {
  return {
    async trigger(threadId, catId, userId, content, messageId, _blocks, policy) {
      const exact =
        policy !== null && typeof policy === 'object' && 'exactTarget' in policy && policy.exactTarget === true;
      if (exact && catId === undefined) throw new Error('exact plugin recipient is required');
      const stored = await deps.messageStore.getById(messageId);
      if (
        !stored ||
        stored.from?.kind !== 'plugin' ||
        stored.threadId !== threadId ||
        stored.userId !== userId ||
        stored.content !== content
      ) {
        throw new Error('plugin ingress source does not match its execution work item');
      }
      const rows = (await deps.queue.getDurableEntriesForMessages(threadId, [messageId])).get(messageId) ?? [];
      const owner = queueOwner({ userId });
      if (
        rows.some(
          (row) =>
            row.kind !== 'conversation_input' ||
            row.threadId !== threadId ||
            !isDeepStrictEqual(row.owner, owner) ||
            !isDeepStrictEqual(row.from, stored.from) ||
            row.payload.sourceRecordId !== messageId ||
            row.payload.messageId !== messageId ||
            row.payload.content !== content,
        )
      ) {
        throw new Error('plugin Queue source identity conflict');
      }
      if (rows.length > 0 || stored.lifecycle?.kind === 'input') {
        const originalTargets =
          rows.length > 0
            ? rows.flatMap((row) => row.payload.requestedTargetCats ?? row.targets)
            : (stored.lifecycle?.dispatchRefs ?? []).map((ref) => ref.targetId);
        if (exact && originalTargets.length > 0 && !originalTargets.includes(catId!)) {
          throw new Error('explicit plugin recipient does not match its original admission');
        }
        // A retry acknowledges this source's first admission. It does not grant
        // another target or rebuild work already consumed, canceled or retired.
        if (rows.length > 0) await deps.queue.adoptCommittedAdmission(rows, stored);
        return 'enqueued';
      }
      const targetCats =
        catId === undefined
          ? await deps.router.resolveSendTargets([], threadId, content)
          : await deps.router.resolveConversationTargetsAtAdmission([catId], threadId, exact ? '' : content);
      if (exact && catId !== undefined && (targetCats.length !== 1 || targetCats[0] !== catId))
        throw new Error('explicit plugin recipient is unavailable');
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
