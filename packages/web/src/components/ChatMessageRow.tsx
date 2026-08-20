'use client';

import { memo } from 'react';
import type { CatData } from '@/hooks/useCatData';
import type { ChatMessage as ChatMessageData } from '@/stores/chat-types';
import { ChatMessage } from './ChatMessage';
import { MessageActions } from './MessageActions';
import { MessageViewportBoundary } from './MessageViewportBoundary';

interface ChatMessageRowProps {
  message: ChatMessageData;
  threadId: string;
  timelineMessages: readonly ChatMessageData[];
  activeInvocationIds?: ReadonlySet<string>;
  getCatById: (id: string) => CatData | undefined;
  onEditCat: (catId: string) => void;
  onEditCoCreator: () => void;
  hideDiagnosticsPanel?: boolean;
  dedupCount?: number;
  selectionMode: boolean;
  selected: boolean;
  selectionEligible: boolean;
  onEnterSelection: (messageId: string) => void;
  onToggleSelection: (messageId: string) => void;
  forwardingDisabled: boolean;
  eager?: boolean;
  backgroundMountDelayMs?: number;
}

/**
 * One memo boundary covers the full historical row, including its selection
 * hooks and annotation observers. Stream deltas then update only the changed
 * bubble unless receipt/execution topology changes.
 */
export const ChatMessageRow = memo(function ChatMessageRow({
  message,
  threadId,
  timelineMessages,
  activeInvocationIds,
  getCatById,
  onEditCat,
  onEditCoCreator,
  hideDiagnosticsPanel,
  dedupCount,
  selectionMode,
  selected,
  selectionEligible,
  onEnterSelection,
  onToggleSelection,
  forwardingDisabled,
  eager,
  backgroundMountDelayMs,
}: ChatMessageRowProps) {
  return (
    <MessageViewportBoundary messageId={message.id} eager={eager} backgroundMountDelayMs={backgroundMountDelayMs}>
      <MessageActions
        message={message}
        threadId={threadId}
        selectionMode={selectionMode}
        selected={selected}
        selectionEligible={selectionEligible}
        onEnterSelection={onEnterSelection}
        onToggleSelection={onToggleSelection}
        forwardingDisabled={forwardingDisabled}
      >
        <ChatMessage
          message={message}
          threadId={threadId}
          timelineMessages={timelineMessages}
          activeInvocationIds={activeInvocationIds}
          getCatById={getCatById}
          onEditCat={onEditCat}
          onEditCoCreator={onEditCoCreator}
          hideDiagnosticsPanel={hideDiagnosticsPanel}
          dedupCount={dedupCount}
          forwardingDisabled={forwardingDisabled}
        />
      </MessageActions>
    </MessageViewportBoundary>
  );
});
