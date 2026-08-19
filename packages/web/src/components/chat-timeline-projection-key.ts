import type { ChatMessage } from '@/stores/chat-types';

/**
 * Cross-message projections depend on receipt/execution topology, not on every
 * streamed text or tool-result delta. Keeping this key narrow lets historical
 * bubbles reuse one timeline snapshot while the active bubble is streaming.
 */
export function buildChatTimelineProjectionKey(messages: readonly ChatMessage[]): string {
  return JSON.stringify(
    messages.map((message) => [
      message.id,
      message.type,
      message.catId,
      message.timestamp,
      message.isStreaming === true,
      message.replyTo,
      message.replyPreview?.senderCatId,
      message.replyPreview?.kind,
      message.type === 'user' ? message.content : undefined,
      message.type === 'user' ? message.contentBlocks : undefined,
      message.extra?.queueReceipt,
      message.extra?.recall,
      message.extra?.stream?.invocationId,
      message.extra?.stream?.turnInvocationId,
      message.extra?.supplement?.originalMessageId,
      message.extra?.supplement?.lineageId,
      message.extra?.turnExecution,
      message.extra?.auxiliaryTurnExecutions,
    ]),
  );
}
