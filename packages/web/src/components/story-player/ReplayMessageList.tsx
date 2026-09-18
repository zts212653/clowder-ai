'use client';

/**
 * F252 Phase E — Replay Message List
 *
 * Renders bridged replay events through the same ChatMessage component used by
 * the live thread timeline. This keeps member bubble styling, tokens, headers,
 * thinking blocks, and CLI output behavior on one implementation path.
 */

import { memo, useEffect, useRef } from 'react';
import { ChatMessage } from '@/components/ChatMessage';
import { useCatData } from '@/hooks/useCatData';
import type { ReplayChatMessage } from '@/lib/story-player/replay-chat-bridge';
import type { ChatMessage as ChatMessageType, ToolEvent } from '@/stores/chat-types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ReplayMessageListProps {
  /** Visible messages (up to currentIndex from engine) */
  messages: ReplayChatMessage[];
  /** Auto-scroll to bottom on new messages */
  autoScroll?: boolean;
  /** Empty-state copy for contexts where playback has no replayable events */
  emptyStateLabel?: string;
  /**
   * Display mode from replay engine.
   * - 'cinematic' (default): hide thinking blocks for immersive viewing
   * - 'faithful': show full thinking content alongside text
   */
  displayMode?: 'cinematic' | 'faithful';
}

// ---------------------------------------------------------------------------
// Helpers — bridge ReplayChatMessage fields to ChatMessage props
// ---------------------------------------------------------------------------

function toChatToolEvents(msg: ReplayChatMessage): ToolEvent[] | undefined {
  if (!msg.toolEvents?.length) return undefined;
  const result: ToolEvent[] = [];
  for (const te of msg.toolEvents) {
    result.push({
      id: `${te.id}_use`,
      type: 'tool_use',
      label: te.name,
      detail: te.input,
      timestamp: msg.timestamp,
    });
    if (te.output != null) {
      result.push({
        id: `${te.id}_result`,
        type: 'tool_result',
        label: te.status === 'error' ? 'Error' : 'Result',
        detail: te.output,
        timestamp: msg.timestamp,
      });
    }
  }
  return result.length > 0 ? result : undefined;
}

function toChatMessage(msg: ReplayChatMessage, showThinking: boolean): ChatMessageType | null {
  const toolEvents = toChatToolEvents(msg);
  const thinking = showThinking ? msg.thinking : undefined;
  const hasVisibleContent =
    msg.content.trim().length > 0 || !!thinking || !!toolEvents?.length || !!msg.cliStdout?.trim();

  if (msg.type === 'assistant' && !hasVisibleContent) {
    return null;
  }

  // User (owner) messages in transcripts carry the *session* catId (which cat
  // recorded the event), not the speaker. ChatMessage renders user bubbles only
  // when `type === 'user' && !catId`, so strip catId for user messages to avoid
  // them falling through to the cat/assistant rendering path.
  const chatCatId = msg.type === 'user' ? undefined : msg.catId;

  return {
    id: msg.id,
    type: msg.type,
    catId: chatCatId,
    content: msg.type === 'system' ? msg.content || '── system ──' : msg.content,
    timestamp: msg.timestamp,
    isStreaming: false,
    toolEvents,
    thinking,
    ...(msg.cliStdout ? { extra: { stream: { cliStdout: msg.cliStdout } } } : {}),
    variant: toolEvents && msg.toolEvents?.some((te) => te.status === 'error') ? 'error' : undefined,
  };
}

function messageScrollSignature(msg: ReplayChatMessage): string {
  let toolPayloadLength = 0;
  if (msg.toolEvents) {
    for (const tool of msg.toolEvents) {
      toolPayloadLength += (tool.input?.length ?? 0) + (tool.output?.length ?? 0);
    }
  }
  return [
    msg.id,
    msg.content.length,
    msg.thinking?.length ?? 0,
    msg.cliStdout?.length ?? 0,
    msg.toolEvents?.length ?? 0,
    toolPayloadLength,
  ].join(':');
}

function buildScrollSignature(messages: ReplayChatMessage[]): string {
  return messages.map(messageScrollSignature).join('|');
}

// ---------------------------------------------------------------------------
// Single message renderer
// ---------------------------------------------------------------------------

const ReplayMessage = memo(function ReplayMessage({
  msg,
  displayMode = 'cinematic',
}: {
  msg: ReplayChatMessage;
  displayMode?: 'cinematic' | 'faithful';
}) {
  const { getCatById } = useCatData();
  const showThinking = displayMode === 'faithful';
  const chatMessage = toChatMessage(msg, showThinking);
  if (!chatMessage) return null;
  return <ChatMessage message={chatMessage} getCatById={getCatById} />;
});

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ReplayMessageList({
  messages,
  autoScroll = true,
  emptyStateLabel = 'Press play to start replay',
  displayMode = 'cinematic',
}: ReplayMessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll when visible replay content grows. Same assistant turns are
  // merged into one chat bubble, so message count alone misses appended text/tool output.
  const scrollSignature = buildScrollSignature(messages);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrollSignature intentionally tracks merged-message content growth.
  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [scrollSignature, autoScroll]);

  if (messages.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--console-text-tertiary,#888)]">
        <p className="text-sm">{emptyStateLabel}</p>
      </div>
    );
  }

  return (
    <div className="space-y-1" data-auto-scroll={autoScroll ? 'true' : 'false'}>
      {messages.map((msg) => (
        <ReplayMessage key={msg.id} msg={msg} displayMode={displayMode} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
