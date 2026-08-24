import type { InvocationPromptInputProjection } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../stores/ports/MessageStore.js';
import type { ITurnExecutionStore } from '../stores/ports/TurnExecutionStore.js';

export interface PromptReadableSession {
  threadId: string;
  catId: string;
}

export interface InvocationPromptInputProjectorDeps {
  messageStore?: Pick<IMessageStore, 'getById'>;
  turnExecutionStore?: Pick<ITurnExecutionStore, 'get'>;
}

function messageAuthor(message: StoredMessage): 'user' | 'assistant' | 'system' {
  if (message.catId === null) return 'user';
  return message.catId === 'system' ? 'system' : 'assistant';
}

function excerpt(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  return normalized.length <= 280 ? normalized : `${normalized.slice(0, 279)}…`;
}

export async function projectInvocationPromptInput(
  deps: InvocationPromptInputProjectorDeps,
  session: PromptReadableSession,
  invocationId: string,
  userId: string,
): Promise<InvocationPromptInputProjection> {
  const { turnExecutionStore, messageStore } = deps;
  if (!turnExecutionStore || !messageStore) {
    return { status: 'unavailable', reason: 'prompt_message_ids_unavailable', messages: [] };
  }
  const execution = await turnExecutionStore.get(invocationId);
  const coveredMessageIds = execution?.causal?.coveredMessageIds;
  if (!execution || !coveredMessageIds || coveredMessageIds.length === 0) {
    return { status: 'unavailable', reason: 'prompt_message_ids_unavailable', messages: [] };
  }
  if (execution.threadId !== session.threadId || execution.catId !== session.catId || execution.userId !== userId) {
    return { status: 'unavailable', reason: 'execution_scope_mismatch', messages: [] };
  }
  const triggerMessageId = execution.causal?.triggerMessageId;
  if (!triggerMessageId || !coveredMessageIds.includes(triggerMessageId)) {
    return { status: 'unavailable', reason: 'trigger_message_not_covered', messages: [] };
  }
  const messages = await Promise.all(
    [triggerMessageId].map(async (messageId) => {
      const message = await messageStore.getById(messageId);
      if (!message) return { messageId, status: 'missing' as const };
      if (message.threadId !== execution.threadId || message.userId !== execution.userId) {
        return { messageId, status: 'invisible' as const };
      }
      if (message.deletedAt || message._tombstone || message.recall) {
        return { messageId, status: 'deleted' as const };
      }
      return {
        messageId,
        status: 'available' as const,
        author: messageAuthor(message),
        excerpt: excerpt(message.content),
      };
    }),
  );
  return { status: 'available', messages };
}
