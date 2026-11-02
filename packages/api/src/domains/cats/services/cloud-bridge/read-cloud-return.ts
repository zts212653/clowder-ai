import { type CloudBridgeReturnV1, createCatId, isCloudBridgeReturnV1 } from '@cat-cafe/shared';
import { messageFrom } from '../stores/message-from.js';
import type { IMessageStore } from '../stores/ports/MessageStore.js';
import { resolveVisibleReplyParent } from '../stores/visibility.js';
import { buildCloudReturnMessageIdempotencyKey } from './cloud-return-message.js';

export interface CloudReturnReadScope {
  threadId: string;
  userId: string;
  sourceMessageId: string;
  targetCatId: string;
  dispatchInvocationId: string;
  replyMessageId?: string;
}

/** No writes, grant claim, TTL refresh, native receipt repair or replacement message. */
export async function readCloudReturn(
  messages: IMessageStore,
  scope: CloudReturnReadScope,
): Promise<
  | { status: 'matched'; replyMessageId: string; proof: CloudBridgeReturnV1 }
  | { status: 'source_replied'; replyMessageId: string }
  | null
> {
  const visibility = {
    threadId: scope.threadId,
    viewer: { type: 'cat' as const, catId: createCatId(scope.targetCatId) },
    publicReply: true,
  };
  const source = await resolveVisibleReplyParent(messages, scope.sourceMessageId, visibility);
  if (!source || source.userId !== scope.userId || source.recall) return null;
  const grantScope = {
    threadId: scope.threadId,
    userId: scope.userId,
    sourceMessageId: scope.sourceMessageId,
    targetCatId: scope.targetCatId,
  };
  const winner = await messages.getByIdempotencyKey(
    scope.userId,
    scope.threadId,
    buildCloudReturnMessageIdempotencyKey(grantScope),
  );
  const replyId = scope.replyMessageId ?? winner?.id;
  if (!replyId) return null;
  const answer = await resolveVisibleReplyParent(messages, replyId, visibility);
  if (
    !answer ||
    answer.userId !== scope.userId ||
    answer.replyTo !== source.id ||
    answer.recall ||
    messageFrom(answer).kind !== 'agent' ||
    answer.catId !== scope.targetCatId ||
    !answer.content.trim() ||
    answer.origin !== 'callback' ||
    answer.extra?.isExplicitPost !== true ||
    (answer.lifecycle?.kind === 'response' && answer.lifecycle.status !== 'completed')
  )
    return null;

  const proof = answer.extra?.cloudBridgeReturn;
  if (!isCloudBridgeReturnV1(proof)) {
    if (proof !== undefined) return null;
    // A canonical same-source callback proves a reply exists. Historical grants do not
    // bind their consumed record to this message id; neither their time nor a new grant
    // may manufacture missing attempt provenance. Keep this uncertainty after paging too.
    return { status: 'source_replied', replyMessageId: answer.id };
  }
  return proof.threadId === scope.threadId &&
    proof.sourceMessageId === scope.sourceMessageId &&
    proof.targetCatId === scope.targetCatId &&
    proof.dispatchInvocationId === scope.dispatchInvocationId
    ? { status: 'matched', replyMessageId: answer.id, proof }
    : null;
}
