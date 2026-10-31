import type { CatId, CloudBridgeOutboundReceiptV1 } from '@cat-cafe/shared';
import { messageFrom } from '../stores/message-from.js';
import type { IMessageStore } from '../stores/ports/MessageStore.js';
import { canQuoteInPublicReply, canViewMessage, isInternalNonQuotableParent } from '../stores/visibility.js';

/** Recheck the exact durable source before issuing return authority or sending to Host. */
export async function cloudDispatchSourceMatches(input: {
  messageStore: Pick<IMessageStore, 'getById'> | undefined;
  sourceMessageId: string;
  sourceSender: CloudBridgeOutboundReceiptV1['sourceSender'];
  threadId: string;
  userId: string;
  targetCatId: CatId;
}): Promise<boolean> {
  const source = await input.messageStore?.getById(input.sourceMessageId);
  if (
    !source ||
    source.id !== input.sourceMessageId ||
    source.threadId !== input.threadId ||
    source.userId !== input.userId ||
    source.deletedAt ||
    source._tombstone ||
    isInternalNonQuotableParent(source) ||
    !canQuoteInPublicReply(source) ||
    !canViewMessage(source, { type: 'cat', catId: input.targetCatId })
  )
    return false;
  const from = messageFrom(source);
  const senderMatches =
    input.sourceSender.kind === 'user'
      ? from.kind === 'user' && from.userId === input.sourceSender.id
      : from.kind === 'agent' && from.catId === input.sourceSender.id;
  if (!senderMatches) return false;
  const invocationId = input.sourceSender.invocationId;
  if (!invocationId) return true;
  return [
    source.lifecycle?.kind === 'response' ? source.lifecycle.invocationId : undefined,
    source.extra?.stream?.turnInvocationId,
    source.extra?.stream?.invocationId,
  ].includes(invocationId);
}
