import type { SendAttempt } from '@/utils/send-attempt-db';
import type { ChatMessage, QueueEntry } from './chat-types';

export function withSendAttempts(
  messages: readonly ChatMessage[],
  attempts: readonly SendAttempt[],
  threadId: string,
  queue: readonly QueueEntry[] = [],
): readonly ChatMessage[] {
  const remaining = attempts.filter((attempt) => attempt.threadId === threadId && !attempt.removed);
  const projected = messages.flatMap((message) => {
    const attempt = remaining.find(
      (item) => item.id === message.clientMessageId || item.serverMessageId === message.id,
    );
    if (!attempt) return [message];
    // Until the recalled draft is recovered, the owner's local copy supplies
    // the body and recovery actions instead of an empty History recall stub.
    if (attempt.status === 'recalled') return [];
    remaining.splice(remaining.indexOf(attempt), 1);
    // A canonical message has its own execution/read receipts; Queue is still a view.
    return [
      {
        ...message,
        clientMessageId: attempt.id,
        ...(message.queuedEntryId
          ? {
              ...(attempt.whisper ?? {}),
              sendAttempt: {
                id: attempt.id,
                status: attempt.status === 'canceled' ? attempt.status : ('accepted' as const),
              },
            }
          : {}),
      },
    ];
  });
  remaining.forEach((attempt) => {
    const entry = queue.find(
      (candidate) => candidate.clientMessageId === attempt.id || candidate.messageId === attempt.serverMessageId,
    );
    const blocks =
      attempt.contentBlocks ??
      (attempt.files.length || attempt.contextAttachments?.length
        ? [
            ...(attempt.content ? [{ type: 'text' as const, text: attempt.content }] : []),
            ...(attempt.contextAttachments ?? []).map((attachment) => ({
              type: 'context_attachment' as const,
              attachment,
            })),
            ...attempt.files.map((file, index) =>
              file.type.startsWith('image/')
                ? { type: 'image' as const, url: attempt.previewUrls?.[index] ?? '', alt: file.name }
                : {
                    type: 'file' as const,
                    url: attempt.previewUrls?.[index] ?? '',
                    fileName: file.name,
                    mimeType: file.type || 'application/octet-stream',
                    fileSize: file.size,
                  },
            ),
          ]
        : undefined);
    projected.push({
      id: entry?.messageId ?? attempt.serverMessageId ?? `send-attempt:${attempt.id}`,
      clientMessageId: attempt.id,
      from: { kind: 'user', userId: attempt.ownerUserId },
      type: 'user',
      content: attempt.content,
      timestamp: attempt.timestamp,
      contentBlocks: blocks,
      ...(attempt.replyTo ? { replyTo: attempt.replyTo } : {}),
      ...(attempt.whisper ?? {}),
      ...(entry ? { queuedEntryId: entry.id } : {}),
      sendAttempt: {
        id: attempt.id,
        status:
          attempt.status === 'canceled' || attempt.status === 'recalled'
            ? attempt.status
            : entry
              ? 'accepted'
              : attempt.status,
        error: attempt.error,
        persistenceError: attempt.persistenceError,
        retryable: attempt.retryable,
      },
    });
  });
  return remaining.length || projected.some((message, index) => message !== messages[index]) ? projected : messages;
}
export function sendAttemptViewKey(message: ChatMessage) {
  return message.clientMessageId ? `send-attempt:${message.clientMessageId}` : message.id;
}
