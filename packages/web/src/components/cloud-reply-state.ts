import { type CloudBridgeOutboundReceiptV1, isCloudBridgeReturnV1 } from '@cat-cafe/shared';
import type { ChatMessage } from '@/stores/chat-types';

export type CloudReplyIdentity = Pick<
  CloudBridgeOutboundReceiptV1,
  'sourceMessageId' | 'targetCatId' | 'dispatchInvocationId'
>;
export type CloudReplyState = { state: 'unverified' } | { state: 'replied' | 'source_replied'; replyMessageId: string };

export function cloudReplyCandidates(identity: CloudReplyIdentity, messages: readonly ChatMessage[]) {
  return messages.filter(
    (message) => message.replyTo === identity.sourceMessageId && message.catId === identity.targetCatId,
  );
}

function isCompletedReply(answer: ChatMessage, targetCatId: string): boolean {
  return (
    answer.type === 'assistant' &&
    answer.from?.kind === 'agent' &&
    answer.from.catId === targetCatId &&
    Boolean(answer.content.trim()) &&
    !answer.isStreaming &&
    !answer.extra?.recall &&
    answer.visibility !== 'whisper' &&
    (answer.lifecycle?.kind !== 'response' || answer.lifecycle.status === 'completed')
  );
}

/** Exact proof settles an attempt; an unproven source reply never becomes native delivery evidence. */
export function projectCloudReply(
  identity: CloudReplyIdentity,
  threadId: string,
  messages: readonly ChatMessage[],
): CloudReplyState {
  if (!messages.some((m) => m.id === identity.sourceMessageId && !m.extra?.recall && m.visibility !== 'whisper'))
    return { state: 'unverified' };
  let sourceReply: string | undefined;
  for (const answer of cloudReplyCandidates(identity, messages)) {
    if (!isCompletedReply(answer, identity.targetCatId)) continue;
    const proof = answer.extra?.cloudBridgeReturn;
    if (isCloudBridgeReturnV1(proof)) {
      if (
        proof.threadId === threadId &&
        proof.sourceMessageId === identity.sourceMessageId &&
        proof.targetCatId === identity.targetCatId &&
        proof.dispatchInvocationId === identity.dispatchInvocationId
      )
        return { state: 'replied', replyMessageId: answer.id };
    } else if (proof === undefined && answer.origin === 'callback' && answer.extra?.isExplicitPost)
      sourceReply = answer.id;
  }
  return sourceReply ? { state: 'source_replied', replyMessageId: sourceReply } : { state: 'unverified' };
}

export function cloudReplyHeading(targetCatId: string): string {
  return targetCatId === 'gpt-pro' ? '已收到 Pro 回复' : '已收到回复';
}
