import { groupRecallEvents, type RecallGroup, recallReplyInvocationId } from '@/hooks/recall-feed-model';
import type { RecallEvent } from '@/hooks/recall-types';
import type { ChatMessage } from '@/stores/chat-types';

export type ReplyRecallReadState = 'loading' | 'ready' | 'unavailable';

export interface ReplyRecallProjection {
  invocationId: string;
  catId: string;
  status: ReplyRecallReadState;
  events: readonly RecallEvent[];
}

function projectReplyRecall(
  message: ChatMessage,
  group: RecallGroup | undefined,
  status: Exclude<ReplyRecallReadState, 'loading'>,
): ReplyRecallProjection | undefined {
  if (message.type !== 'assistant' || !message.catId) return undefined;
  const invocationId = recallReplyInvocationId(message);
  if (!invocationId) return undefined;
  const events = group?.events ?? [];
  if (status === 'ready' && events.length === 0) return undefined;
  return { invocationId, catId: message.catId, status: events.length ? 'ready' : status, events };
}

export function buildReplyRecallProjections(input: {
  messages: readonly ChatMessage[];
  events: RecallEvent[];
  status: ReplyRecallReadState;
}): ReadonlyMap<string, ReplyRecallProjection> {
  if (input.status === 'loading') return new Map();
  const groups = groupRecallEvents(input.events, [...input.messages]);
  const byMessageId = new Map<string, (typeof groups)[number]>();
  for (const group of groups) {
    if (group.messageId) byMessageId.set(group.messageId, group);
  }
  const result = new Map<string, ReplyRecallProjection>();
  for (const message of input.messages) {
    const projection = projectReplyRecall(message, byMessageId.get(message.id), input.status);
    if (projection) result.set(message.id, projection);
  }
  return result;
}
