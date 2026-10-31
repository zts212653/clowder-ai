import type { LifecycleDispatchRef } from '@cat-cafe/shared';
import type { ChatMessage, QueueEntry } from '@/stores/chat-types';
import type { SingleCatConversationBlock } from '../single-cat-conversation-projection';

const THREAD_ID = 'thread-single-cat';
export const CAT_ID = 'opus';

export function inputMessage({
  id,
  timestamp,
  from = { kind: 'user' as const, userId: 'owner' },
  dispatchRefs,
  visibility,
}: {
  id: string;
  timestamp: number;
  from?: ChatMessage['from'];
  dispatchRefs?: readonly LifecycleDispatchRef[];
  visibility?: 'whisper';
}): ChatMessage {
  return {
    id,
    type: from?.kind === 'agent' ? 'assistant' : 'user',
    ...(from?.kind === 'agent' ? { catId: from.catId } : {}),
    from,
    content: id,
    timestamp,
    ...(visibility ? { visibility, whisperTo: [CAT_ID] } : {}),
    lifecycle: { kind: 'input', orderKey: `${timestamp}:${id}`, ...(dispatchRefs ? { dispatchRefs } : {}) },
  };
}

export function responseMessage({
  id,
  catId = CAT_ID,
  startedAt,
  timestamp = startedAt,
  inputMessageIds = [],
  invocationId = `invocation-${id}`,
}: {
  id: string;
  catId?: string;
  startedAt: number;
  timestamp?: number;
  inputMessageIds?: readonly string[];
  invocationId?: string;
}): ChatMessage {
  return {
    id,
    type: 'assistant',
    catId,
    from: { kind: 'agent', catId },
    content: id,
    timestamp,
    lifecycle: {
      kind: 'response',
      orderKey: `${startedAt}:${id}`,
      invocationId,
      targetId: catId,
      inputEntryIds: inputMessageIds.map((messageId) => `entry-${messageId}`),
      inputMessageIds,
      status: 'completed',
      startedAt,
      completedAt: startedAt + 10,
    },
  };
}

export function standaloneOutput(id: string, catId: string, timestamp: number): ChatMessage {
  return {
    id,
    type: 'assistant',
    catId,
    from: { kind: 'agent', catId },
    content: id,
    timestamp,
  };
}

export function queueEntry(
  messageId: string,
  targetCats: string[],
  createdAt: number,
  id = `queue-${messageId}`,
): QueueEntry {
  return {
    id,
    threadId: THREAD_ID,
    userId: 'owner',
    content: messageId,
    messageId,
    mergedMessageIds: [],
    from: { kind: 'user', userId: 'owner' },
    targetCats,
    intent: 'execute',
    status: 'queued',
    createdAt,
  };
}

export function executionAt(blocks: readonly SingleCatConversationBlock[], index = 0) {
  const block = blocks[index];
  if (!block || block.kind !== 'execution') throw new Error(`expected execution at ${index}`);
  return {
    response: block.response.id,
    startedAt: block.startedAt,
    invocationId: block.invocationId,
    read: block.readInputs.map((input) => [input.message.id, input.readAt, input.source]),
    unconfirmed: block.unconfirmedInputs.map((input) => [input.message.id, input.source]),
  };
}

export function markInputRead(source: ChatMessage, at: number): ChatMessage {
  if (source.lifecycle?.kind !== 'input') throw new Error('expected input lifecycle');
  const ref = source.lifecycle.dispatchRefs?.[0];
  if (!ref) throw new Error('expected one dispatch ref');
  return {
    ...source,
    lifecycle: {
      ...source.lifecycle,
      dispatchRefs: [{ ...ref, inputRead: { status: 'read', at } }],
    },
  };
}
