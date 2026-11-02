import { createMessagingDomain } from '../../dist/domains/messaging/index.js';
import { createPluginMessagingHost } from '../../dist/domains/plugin/host-surface/plugin-messaging-host.js';
import { MemoryConnectorThreadBindingStore } from '../../dist/infrastructure/connectors/ConnectorThreadBindingStore.js';

/** Exercise the actual SDK send path and its ordinary Queue wake seam. */
export async function sendPluginInput({ messages, queue, threads, threadId, owner, catId, content }) {
  const messaging = createMessagingDomain({
    messageStore: messages,
    threadStore: threads,
    isKnownCatId: (id) => id === catId,
    getDefaultCatId: () => catId,
    getMentionPatterns: () => new Map(),
    invokeTrigger: {
      async trigger(targetThread, targetCat, userId, text, messageId) {
        const stored = await messages.getById(messageId);
        await queue.enqueueExistingMessageDurable(messages, messageId, {
          userId,
          threadId: targetThread,
          from: stored.from,
          sourceId: messageId,
          messageId,
          content: text,
          targetCats: [targetCat],
          kind: 'conversation_input',
          intent: 'execute',
          ownerAuthProvenance: 'unknown',
          idempotencyKey: `plugin-ingress:${messageId}:${targetCat}`,
          autoExecute: true,
        });
        return 'dispatched';
      },
    },
  });
  const host = createPluginMessagingHost({
    pluginId: 'dev.fixture',
    pluginInstanceId: 'instance',
    ownerUserId: owner,
    manifest: {
      pluginId: 'dev.fixture',
      name: 'Fixture',
      contributions: [{ type: 'identity', id: 'fixture', displayName: 'Fixture', icon: 'message' }],
    },
    threadStore: threads,
    messageStore: messages,
    bindingStore: new MemoryConnectorThreadBindingStore(),
    messaging,
  });
  return host.send({
    threadId,
    idempotencyKey: 'plugin-policy',
    wake: { catId },
    payload: {
      provenance: { epistemicStatus: 'observation' },
      elements: [{ elementId: 'input', kind: 'text', payload: { text: content } }],
    },
  });
}
