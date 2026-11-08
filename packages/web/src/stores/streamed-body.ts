import type { ChatMessage } from './chat-types';

/**
 * PR-3a2 (#6727 R4): the part of a response its stream writes — text, tool events, thinking and
 * streamed blocks. A page holding the stream from position 0 (`streamPrefix: 'complete'`) owns this
 * part up to `streamNextIndex`; the two describe one prefix. A processing copy from the server (a
 * History draft, a lifecycle snapshot) has no stream position, so it can neither fill nor extend
 * that prefix — an empty text or tool list belongs to it too. Only a terminal replaces it.
 */
export function withStreamedBodyOf(target: ChatMessage, source: ChatMessage): ChatMessage {
  const extra = target.extra || source.extra?.rich ? { ...target.extra, rich: source.extra?.rich } : undefined;
  return {
    ...target,
    content: source.content,
    toolEvents: source.toolEvents,
    thinking: source.thinking,
    thinkingChunks: source.thinkingChunks,
    ...(extra ? { extra } : {}),
  };
}

/** Whether `message` holds its stream from the start and is still running (see above). */
export function ownsStreamedBody(message: ChatMessage): boolean {
  if (message.streamPrefix !== 'complete') return false;
  return !(message.lifecycle?.kind === 'response' && message.lifecycle.status !== 'processing');
}
