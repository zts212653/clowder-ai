import type { ChatMessage } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { findRecallReply } from './recall-feed-model';
import type { RecallEvent } from './recall-types';
export interface RecallReplyCursor {
  timestamp: number;
  messageId: string;
}
export interface RecallReplyCoordinate {
  messageId: string;
  catId: string;
  invocationId: string;
  parentInvocationId?: string;
  timestamp: number;
}
export function recallReplyMessage(reply: RecallReplyCoordinate): ChatMessage {
  return {
    id: reply.messageId,
    type: 'assistant',
    content: '',
    catId: reply.catId,
    timestamp: reply.timestamp,
    extra: { stream: { turnInvocationId: reply.invocationId, invocationId: reply.parentInvocationId } },
  };
}
export async function lookupRecallReply(input: {
  threadId: string;
  event: RecallEvent;
  messages: readonly ChatMessage[];
  cursor: RecallReplyCursor | null;
  signal: AbortSignal;
  isCurrent: () => boolean;
  onPage: (messages: ChatMessage[], cursor: RecallReplyCursor | null) => void;
}): Promise<string | undefined> {
  let cursor = input.cursor;
  let messages = [...input.messages];
  const seen = new Set<string>();
  const present = findRecallReply(input.event, messages);
  if (present) return present.id;
  while (cursor && input.isCurrent() && !input.signal.aborted) {
    const key = JSON.stringify(cursor);
    if (seen.has(key)) throw new Error('Reply cursor did not advance');
    seen.add(key);
    const response = await apiFetch(
      `/api/recall/events?threadId=${encodeURIComponent(input.threadId)}&replyBeforeTs=${cursor.timestamp}&replyBeforeId=${encodeURIComponent(cursor.messageId)}`,
      { signal: input.signal },
    );
    if (!response.ok) throw new Error('Reply lookup unavailable');
    const page = (await response.json()) as {
      replies?: RecallReplyCoordinate[];
      replyCursor?: RecallReplyCursor | null;
    };
    if (!Array.isArray(page.replies)) throw new Error('Reply projection unavailable');
    if (!input.isCurrent() || input.signal.aborted) return undefined;
    const ids = new Set(messages.map((message) => message.id));
    messages = [...messages, ...page.replies.map(recallReplyMessage).filter((message) => !ids.has(message.id))];
    cursor = page.replyCursor ?? null;
    input.onPage(messages, cursor);
    const reply = findRecallReply(input.event, messages);
    if (reply) return reply.id;
  }
  return undefined;
}
