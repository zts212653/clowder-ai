'use client';

import { memo } from 'react';
import type { CatData } from '@/hooks/useCatData';
import type { ChatMessage as ChatMessageData } from '@/stores/chat-types';
import { ChatMessage } from './ChatMessage';
import { MessageActions } from './MessageActions';
import { MessageViewportBoundary } from './MessageViewportBoundary';
import type { CardConfirmationEntry } from './rich/CardBlock';

interface ChatMessageRowProps {
  message: ChatMessageData;
  compact?: boolean;
  threadId: string;
  timelineMessages: readonly ChatMessageData[];
  activeInvocationIds?: ReadonlySet<string>;
  settlingInvocationIds?: ReadonlySet<string>;
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
  /** Routes interactive rich-block sends back to the surface that rendered this row. */
  sendContext?: string;
  confirmations?: CardConfirmationEntry[];
}

/**
 * One memo boundary covers the full historical row, including its selection
 * hooks and annotation observers. Stream deltas then update only the changed
 * bubble unless receipt/execution topology changes.
 */
export const ChatMessageRow = memo(function ChatMessageRow({
  message,
  compact = false,
  threadId,
  timelineMessages,
  activeInvocationIds,
  settlingInvocationIds,
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
  sendContext,
  confirmations,
}: ChatMessageRowProps) {
  return (
    <MessageViewportBoundary
      messageId={message.id}
      eager={eager}
      backgroundMountDelayMs={backgroundMountDelayMs}
      navigationError={message.variant === 'error'}
    >
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
          compact={compact}
          threadId={threadId}
          timelineMessages={timelineMessages}
          activeInvocationIds={activeInvocationIds}
          settlingInvocationIds={settlingInvocationIds}
          getCatById={getCatById}
          onEditCat={onEditCat}
          onEditCoCreator={onEditCoCreator}
          hideDiagnosticsPanel={hideDiagnosticsPanel}
          dedupCount={dedupCount}
          forwardingDisabled={forwardingDisabled}
          sendContext={sendContext}
          confirmations={confirmations}
        />
      </MessageActions>
    </MessageViewportBoundary>
  );
});
