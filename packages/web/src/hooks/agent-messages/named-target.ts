import type { NamedMessageStore, NamedMessageTarget, StreamTextWrite } from '@/hooks/named-message-writer';
import type { ChatMessage } from '@/stores/chat-types';
import { isMessageTimelineActive } from '@/stores/message-timeline';
import type { AgentEventFields } from './types';

type NamedEvent = Pick<AgentEventFields, 'catId' | 'messageId' | 'invocationId' | 'turnInvocationId'> & {
  timestamp?: number;
};

/**
 * The stored message an event writes into — exactly the one it names. An event without
 * `messageId` is status-only: there is no fallback lookup of a "live" bubble.
 */
export function namedTarget(msg: NamedEvent, threadId: string): NamedMessageTarget | undefined {
  if (!msg.messageId) return undefined;
  return {
    threadId,
    messageId: msg.messageId,
    catId: msg.catId,
    ...(msg.timestamp !== undefined ? { timestamp: msg.timestamp } : {}),
    ...(msg.invocationId ? { invocationId: msg.invocationId } : {}),
    ...(msg.turnInvocationId ? { turnInvocationId: msg.turnInvocationId } : {}),
  };
}

/** Body output that names no message has nowhere to go; it is dropped, never routed to a guessed bubble. */
export function dropUnnamedBodyWrite(
  kind: string,
  msg: Pick<AgentEventFields, 'catId' | 'invocationId'>,
  threadId: string,
) {
  if (process.env.NODE_ENV !== 'development') return;
  console.warn('[agent_message] body event without messageId dropped', {
    kind,
    catId: msg.catId,
    threadId,
    invocationId: msg.invocationId,
  });
}

export function streamTextWrite(msg: AgentEventFields): StreamTextWrite {
  const turnExecution = msg.extra?.turnExecution;
  const auxiliaryTurnExecutions = msg.extra?.auxiliaryTurnExecutions;
  return {
    content: msg.content ?? '',
    ...(msg.textMode ? { textMode: msg.textMode } : {}),
    ...(msg.metadata ? { metadata: msg.metadata } : {}),
    ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
    ...(msg.replyPreview ? { replyPreview: msg.replyPreview } : {}),
    ...(msg.mentionsUser ? { mentionsUser: true } : {}),
    ...(turnExecution || auxiliaryTurnExecutions
      ? {
          execution: {
            ...(turnExecution ? { turnExecution } : {}),
            ...(auxiliaryTurnExecutions ? { auxiliaryTurnExecutions } : {}),
          },
        }
      : {}),
  };
}

/**
 * A committed (non-processing) response is its turn's final truth. A late stream event (not a post)
 * that names it changes nothing — not its body, not the cat's status, liveness or invocation slots,
 * not its timeline activity. Callers check this before any side effect of the event.
 */
export function isLateForCommittedResponse(
  msg: Pick<AgentEventFields, 'messageId' | 'origin'>,
  threadId: string,
  store: Pick<NamedMessageStore, 'getThreadState'>,
): boolean {
  if (!msg.messageId || msg.origin === 'callback') return false;
  const named = store.getThreadState(threadId).messages.find((message) => message.id === msg.messageId);
  return named?.lifecycle?.kind === 'response' && named.lifecycle.status !== 'processing';
}

/**
 * A post_message callback is its own persisted message P, whole under its stored id. It never
 * replaces, merges into or waits behind the turn's response. Without an id it cannot be shown.
 */
export function callbackPost(msg: AgentEventFields, timestamp: number): ChatMessage | undefined {
  if (!msg.messageId) return undefined;
  const turn = msg.turnInvocationId && msg.turnInvocationId !== msg.invocationId ? msg.turnInvocationId : undefined;
  const extra: NonNullable<ChatMessage['extra']> = {
    ...(msg.extra?.crossPost ? { crossPost: msg.extra.crossPost } : {}),
    ...(msg.extra?.isExplicitPost ? { isExplicitPost: true } : {}),
    ...(msg.extra?.targetCats ? { targetCats: msg.extra.targetCats } : {}),
    ...(msg.invocationId
      ? { stream: { invocationId: msg.invocationId, ...(turn ? { turnInvocationId: turn } : {}) } }
      : {}),
  };
  return {
    id: msg.messageId,
    type: 'assistant',
    from: { kind: 'agent', catId: msg.catId },
    catId: msg.catId,
    content: msg.content ?? '',
    origin: 'callback',
    ...(msg.metadata ? { metadata: msg.metadata } : {}),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
    ...(msg.mentionsUser ? { mentionsUser: true } : {}),
    ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
    ...(msg.replyPreview ? { replyPreview: msg.replyPreview } : {}),
    timestamp,
  };
}

/**
 * Keep the storage activity clock current while a message is processing. Canonical responses
 * retain their durable presentation position until an input is admitted or the response ends.
 */
export function touchStreamActivity(
  store: Pick<NamedMessageStore, 'getThreadState' | 'patchThreadMessage'>,
  threadId: string,
  messageId: string,
  activityAt = Date.now(),
): void {
  const message = store.getThreadState(threadId).messages.find((candidate) => candidate.id === messageId);
  if (!message || !isMessageTimelineActive(message)) return;
  store.patchThreadMessage(threadId, messageId, { timestamp: activityAt, timelineOrderAt: activityAt });
}

/**
 * A persisted system row (e.g. a routing preflight receipt) keeps its own stored id. An id that
 * names a response — the turn's message stamped on an event that had none of its own — is never
 * a row's identity.
 */
export function ownSystemRowId(messageId: string | undefined, messages: readonly ChatMessage[]): string | undefined {
  if (!messageId) return undefined;
  const named = messages.find((message) => message.id === messageId);
  if (named && (named.type === 'assistant' || named.lifecycle?.kind === 'response')) return undefined;
  return messageId;
}
