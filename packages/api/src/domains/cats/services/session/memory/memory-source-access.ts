import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import type { IThreadStore } from '../../stores/ports/ThreadStore.js';
import { canQuoteInPublicReply, isEligibleReplyParent, type Viewer } from '../../stores/visibility.js';
import { resolveThreadAccess } from '../thread-access-policy.js';

export interface MemorySourceActor {
  userId: string;
  viewer: Viewer;
  publicReply?: boolean;
  signal?: AbortSignal;
}

export interface MemorySourceReaders {
  messageStore: Pick<IMessageStore, 'getById'>;
  threadStore: Pick<IThreadStore, 'get' | 'list'>;
}

export async function canReadMemorySourceThread(
  readers: MemorySourceReaders,
  actor: MemorySourceActor,
  threadId: string,
): Promise<boolean> {
  actor.signal?.throwIfAborted();
  const thread = await readers.threadStore.get(threadId);
  if (!thread || thread.deletedAt) return false;
  const access = await resolveThreadAccess({
    threadStore: readers.threadStore,
    thread,
    userId: actor.userId,
    request: { resource: 'transcript', action: 'read' },
  });
  return access.status === 200;
}

/** Verify the canonical original with the current Host viewer and thread policy. */
export async function readMemorySourceMessage(
  readers: MemorySourceReaders,
  actor: MemorySourceActor,
  coordinate: { threadId: string; messageId: string },
): Promise<StoredMessage | null> {
  actor.signal?.throwIfAborted();
  if (!(await canReadMemorySourceThread(readers, actor, coordinate.threadId))) return null;
  const message = await readers.messageStore.getById(coordinate.messageId);
  actor.signal?.throwIfAborted();
  if (
    !message ||
    message.id !== coordinate.messageId ||
    message.threadId !== coordinate.threadId ||
    message.userId !== actor.userId ||
    message.recall ||
    message._tombstone ||
    message.deletedAt
  )
    return null;
  if (!isEligibleReplyParent(message, { threadId: coordinate.threadId, viewer: actor.viewer })) return null;
  if (actor.publicReply && !canQuoteInPublicReply(message)) return null;
  return message;
}
