'use client';

import type { CapabilityTipContext, LifecycleActiveRun } from '@cat-cafe/shared';
import { memo } from 'react';
import type { CatData } from '@/hooks/useCatData';
import type { ChatMessage as ChatMessageData } from '@/stores/chat-types';
import { ChatMessage } from './ChatMessage';
import { MessageActions } from './MessageActions';
import { MessageViewportBoundary } from './MessageViewportBoundary';
import type { CardConfirmationEntry } from './rich/CardBlock';

interface ChatMessageRowProps {
  message: ChatMessageData;
  threadId: string;
  timelineMessages: readonly ChatMessageData[];
  activeRuns?: readonly LifecycleActiveRun[];
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
  showCapabilityTip?: boolean;
  capabilityTipContexts?: readonly CapabilityTipContext[];
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
  threadId,
  timelineMessages,
  activeRuns,
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
  showCapabilityTip,
  capabilityTipContexts,
  sendContext,
  confirmations,
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
          activeRuns={activeRuns}
          getCatById={getCatById}
          onEditCat={onEditCat}
          onEditCoCreator={onEditCoCreator}
          hideDiagnosticsPanel={hideDiagnosticsPanel}
          dedupCount={dedupCount}
          forwardingDisabled={forwardingDisabled}
          showCapabilityTip={showCapabilityTip}
          capabilityTipContexts={capabilityTipContexts}
          sendContext={sendContext}
          confirmations={confirmations}
        />
      </MessageActions>
    </MessageViewportBoundary>
  );
});
