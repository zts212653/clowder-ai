/** Content-free reply coordinates from the existing owner-scoped message reader. */
export interface RecallReplyMessage {
  id: string;
  catId?: string | null;
  timestamp?: number;
  timelineOrderAt?: number;
  extra?: { isExplicitPost?: boolean; stream?: { invocationId?: string; turnInvocationId?: string } };
}
export interface RecallReplyCoordinate {
  messageId: string;
  catId: string;
  invocationId: string;
  parentInvocationId?: string;
  timestamp: number;
}
export interface RecallReplyMessageStore {
  getThreadReplyProjection?(
    threadId: string,
    userId: string,
    limit?: number,
    before?: RecallReplyCursor,
  ): Promise<RecallReplyMessage[]> | RecallReplyMessage[];
  getByThreadBefore?(
    threadId: string,
    timestamp: number,
    limit?: number,
    beforeId?: string,
    userId?: string,
  ): Promise<RecallReplyMessage[]> | RecallReplyMessage[];
  getByThread(threadId: string, limit?: number, userId?: string): Promise<RecallReplyMessage[]> | RecallReplyMessage[];
}
export function projectRecallReplies(messages: RecallReplyMessage[]): RecallReplyCoordinate[] {
  return messages.flatMap((message) => {
    const stream = message.extra?.stream;
    const invocationId = stream?.turnInvocationId ?? stream?.invocationId;
    if (!message.catId || !invocationId || message.timestamp == null || message.extra?.isExplicitPost) return [];
    return [
      {
        messageId: message.id,
        catId: message.catId,
        invocationId,
        parentInvocationId: stream?.invocationId,
        timestamp: message.timestamp,
      },
    ];
  });
}

export interface RecallReplyCursor {
  timestamp: number;
  messageId: string;
}
export function parseRecallReplyCursor(timestamp: unknown, messageId: unknown): RecallReplyCursor | null | 'invalid' {
  if (timestamp === undefined && messageId === undefined) return null;
  if (
    typeof timestamp !== 'string' ||
    !/^\d{1,16}$/.test(timestamp) ||
    !Number.isSafeInteger(Number(timestamp)) ||
    typeof messageId !== 'string' ||
    !messageId.trim() ||
    messageId.length > 256
  )
    return 'invalid';
  return { timestamp: Number(timestamp), messageId };
}
export function nextRecallReplyCursor(messages: RecallReplyMessage[]): RecallReplyCursor | null {
  if (messages.length !== 500) return null;
  const ordered = messages
    .flatMap((message) => {
      const timestamp = message.timelineOrderAt ?? message.timestamp;
      return timestamp == null ? [] : [{ timestamp, messageId: message.id }];
    })
    .sort((a, b) => a.timestamp - b.timestamp || (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0));
  return ordered[0] ?? null;
}
