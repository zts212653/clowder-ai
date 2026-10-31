import type { MessageContent } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';

/**
 * What the sender's local copy of a just-sent message cannot know: the stored time and the stored
 * content blocks (uploaded images become `/uploads/...` URLs only on the server). The client settles
 * its preview into these, so a just-sent image opens as a publication without a reload.
 */
export interface UserMessageReceipt {
  readonly id: string;
  readonly timestamp: number;
  readonly contentBlocks?: readonly MessageContent[];
}

interface ReceiptOwner {
  readonly userId: string;
  readonly threadId: string;
}

type ReceiptSource = Pick<StoredMessage, 'id' | 'userId' | 'threadId' | 'timestamp' | 'contentBlocks'>;

/** Spread into a send response. Empty unless the message is the requester's own in this thread. */
export function userMessageReceipt(
  message: ReceiptSource | null | undefined,
  owner: ReceiptOwner,
): { userMessage: UserMessageReceipt } | Record<string, never> {
  if (!message || message.userId !== owner.userId || message.threadId !== owner.threadId) return {};
  return {
    userMessage: {
      id: message.id,
      timestamp: message.timestamp,
      ...(message.contentBlocks ? { contentBlocks: message.contentBlocks } : {}),
    },
  };
}

/**
 * Uses the message this request just appended when there is one; a replay only knows the id, so the
 * stored message is read back before it is described.
 */
export async function readUserMessageReceipt(
  store: Pick<IMessageStore, 'getById'>,
  messageId: string | null | undefined,
  owner: ReceiptOwner,
  appended?: ReceiptSource | null,
): Promise<{ userMessage: UserMessageReceipt } | Record<string, never>> {
  if (!messageId) return {};
  const message = appended?.id === messageId ? appended : await store.getById(messageId);
  return message?.id === messageId ? userMessageReceipt(message, owner) : {};
}
