import type { ChatMessage } from '@/stores/chat-types';
import { isMessageTimelineActive } from '@/stores/message-timeline';
import { doesAssistantMessageRenderBubble } from './assistant-message-renderability';

/**
 * Cross-message projections depend on execution topology, not on every
 * streamed text or tool-result delta. Keeping this key narrow lets historical
 * bubbles reuse one timeline snapshot while the active bubble is streaming.
 */
export function buildChatTimelineProjectionKey(messages: readonly ChatMessage[], currentThreadId?: string): string {
  return JSON.stringify(
    messages.map((message) => [
      message.id,
      message.type,
      message.catId,
      // Streaming activity changes the row's own clock/content, not the
      // cross-row reply/execution topology. Keep historical rows memoized.
      message.type === 'assistant' && isMessageTimelineActive(message) ? undefined : message.timestamp,
      message.isStreaming === true,
      doesAssistantMessageRenderBubble(message, { currentThreadId }),
      message.replyTo,
      message.replyPreview?.senderCatId,
      message.replyPreview?.kind,
      message.lifecycle,
      message.type === 'user' ? message.content : undefined,
      message.type === 'user' ? message.contentBlocks : undefined,
      message.extra?.recall,
      message.extra?.stream?.invocationId,
      message.extra?.stream?.turnInvocationId,
      message.extra?.a2aRouting,
      message.extra?.a2aRouting ? message.content : undefined,
      message.extra?.liveCompanion?.identity,
      message.extra?.turnExecution,
      message.extra?.auxiliaryTurnExecutions,
    ]),
  );
}
