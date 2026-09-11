'use client';

import type { CapabilityTipContext, LifecycleActiveRun } from '@cat-cafe/shared';
import type { ReactNode, Ref } from 'react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { useChatHistory } from '@/hooks/useChatHistory';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { useConnectionStatus } from '@/hooks/useConnectionStatus';
import { useSendMessage } from '@/hooks/useSendMessage';
import { useThreadLiveness, useThreadMessages } from '@/hooks/useThreadScopedSelectors';
import { useChatStore } from '@/stores/chatStore';
import { computeCliDiagnosticsDedup } from '@/utils/cli-diagnostics-dedup';
import { computeScrollRecomputeSignal } from '@/utils/scrollRecomputeSignal';
import { ChatInput } from '../ChatInput';
import { ChatMessageRow } from '../ChatMessageRow';
import { ConnectionStatusBar } from '../ConnectionStatusBar';
import { getStreamingTipContexts, selectLifecycleTipMessageId } from '../capability-tip-placement';
import { buildChatTimelineProjectionKey } from '../chat-timeline-projection-key';
import { HubCatEditor } from '../HubCatEditor';
import { HubCoCreatorEditor } from '../HubCoCreatorEditor';
import { PawIcon } from '../icons/PawIcon';
import { MessageNavigator } from '../MessageNavigator';
import { MessageSelectionToolbar } from '../MessageSelectionToolbar';
import { messageMountPolicy } from '../message-mount-policy';
import { isMessageSelectableForBundle, MAX_SELECTED_MESSAGES } from '../message-selection';
import { QueuePanel } from '../QueuePanel';
import type { CardConfirmationEntry } from '../rich/CardBlock';
import { ScrollToBottomButton } from '../ScrollToBottomButton';
import { ThreadExecutionBar } from '../ThreadExecutionBar';
import { TransferTargetPicker } from '../TransferTargetPicker';
import { VoteActiveBar } from '../VoteActiveBar';
import { useThreadChatRuntime } from './ThreadChatRuntimeProvider';
import { useThreadChatSelection } from './useThreadChatSelection';

export type ThreadChatDensity = 'full' | 'compact';

export type ThreadChatActivity = {
  threadId: string;
  messageCount: number;
  hasActiveInvocation: boolean;
};

export interface ThreadChatSurfaceProps {
  threadId: string;
  density: ThreadChatDensity;
  emptyState?: ReactNode;
  timelineLead?: ReactNode;
  footerLead?: ReactNode;
  footerTail?: ReactNode;
  footerRef?: Ref<HTMLDivElement>;
  composerClassName?: string;
  composerPlaceholder?: string;
  composerSeed?: { id: string; text: string };
  messageConfirmations?: ReadonlyMap<string, CardConfirmationEntry[]>;
  acceptUnscopedInteractiveSend?: boolean;
  onComposerFocusChange?: (focused: boolean) => void;
  onActivity?: (activity: ThreadChatActivity) => void;
}

export function ThreadChatSurface({
  threadId,
  density,
  emptyState,
  timelineLead,
  footerLead,
  footerTail,
  footerRef,
  composerClassName,
  composerPlaceholder,
  composerSeed,
  messageConfirmations,
  acceptUnscopedInteractiveSend = false,
  onComposerFocusChange,
  onActivity,
}: ThreadChatSurfaceProps) {
  const messages = useThreadMessages(threadId);
  const liveness = useThreadLiveness(threadId);
  const { hasActive: hasActiveInvocation, catStatuses, catInvocations, intentMode } = liveness;
  const { socketConnected } = useThreadChatRuntime([threadId]);
  const { handleScroll, jumpToLatest, scrollContainerRef, messagesEndRef, isLoadingHistory, hasMore } =
    useChatHistory(threadId);
  const { handleSend, uploadStatus, uploadError } = useSendMessage(threadId);
  const interactiveSendContext = `thread-chat-surface:${useId()}`;
  const { getCatById, refresh: refreshCats } = useCatData();
  const coCreator = useCoCreatorConfig();
  const [editingCatId, setEditingCatId] = useState<string | null>(null);
  const [coCreatorEditorOpen, setCoCreatorEditorOpen] = useState(false);
  const editingCat = editingCatId ? (getCatById(editingCatId) ?? null) : null;
  const connectionStatus = useConnectionStatus(socketConnected);
  const uiThinkingExpandedByDefault = useChatStore((state) => state.uiThinkingExpandedByDefault);
  const isOfflineSnapshot = useChatStore((state) => state.isOfflineSnapshot);

  const lifecycleActiveRuns = useMemo<readonly LifecycleActiveRun[]>(
    () => Object.values(catInvocations).flatMap((invocation) => (invocation.activeRun ? [invocation.activeRun] : [])),
    [catInvocations],
  );
  const capabilityTipContexts = useMemo<readonly CapabilityTipContext[]>(
    () => getStreamingTipContexts(intentMode),
    [intentMode],
  );
  const lifecycleTipMessageId = useMemo(
    () => selectLifecycleTipMessageId(messages, catStatuses, catInvocations),
    [messages, catStatuses, catInvocations],
  );
  const cliDedupMap = useMemo(() => computeCliDiagnosticsDedup(messages), [messages]);
  const timelineProjectionKey = useMemo(() => buildChatTimelineProjectionKey(messages), [messages]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: projection key captures the cross-message fields consumed by rows.
  const timelineProjectionMessages = useMemo(
    () => messages,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timelineProjectionKey],
  );
  const selection = useThreadChatSelection(messages);
  const handleEditCat = useCallback((catId: string) => setEditingCatId(catId), []);
  const handleEditCoCreator = useCallback(() => setCoCreatorEditorOpen(true), []);
  const projectedEmptyState = emptyState ?? (
    <div className={density === 'compact' ? 'mt-4 text-center' : 'mt-20 text-center'}>
      <PawIcon className="mx-auto mb-3 h-10 w-10 text-cafe-muted" />
      <p className="text-sm text-cafe-secondary">还没有消息，发一句试试吧</p>
    </div>
  );

  useEffect(() => {
    onActivity?.({ threadId, messageCount: messages.length, hasActiveInvocation });
  }, [hasActiveInvocation, messages.length, onActivity, threadId]);

  useEffect(() => {
    const handleInteractiveSend = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string; sendContext?: string; targetThreadId?: string }>).detail;
      const ownsContext = detail.sendContext === interactiveSendContext;
      const ownsUnscoped =
        acceptUnscopedInteractiveSend &&
        !detail.sendContext &&
        (!detail.targetThreadId || detail.targetThreadId === threadId);
      if ((!ownsContext && !ownsUnscoped) || !detail.text) return;
      handleSend(detail.text);
    };
    window.addEventListener('cat-cafe:interactive-send', handleInteractiveSend);
    return () => window.removeEventListener('cat-cafe:interactive-send', handleInteractiveSend);
  }, [acceptUnscopedInteractiveSend, handleSend, interactiveSendContext, threadId]);

  const compact = density === 'compact';

  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      data-thread-chat-surface
      data-thread-chat-density={density}
      data-thread-id={threadId}
    >
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <main
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className={compact ? 'h-full overflow-y-auto px-3 py-3' : 'h-full overflow-y-auto p-4'}
          aria-label="对话内容"
          data-guide-id="bootcamp.preview-result"
          data-bootcamp-host="chat-messages"
          data-chat-container
        >
          {isLoadingHistory && <div className="py-3 text-center text-sm text-cafe-muted">加载历史消息...</div>}
          <ConnectionStatusBar
            api={connectionStatus.api}
            socket={connectionStatus.socket}
            upstream={connectionStatus.upstream}
            isReadonly={connectionStatus.isReadonly}
            checkedAt={connectionStatus.checkedAt}
            isOfflineSnapshot={isOfflineSnapshot}
          />
          {timelineLead}
          {!hasMore && messages.length > 0 && (
            <div className="py-3 text-center text-xs text-cafe-muted">没有更多消息了</div>
          )}
          {messages.length === 0 && !isLoadingHistory
            ? projectedEmptyState
            : messages.map((message, index) => {
                const dedupInfo = cliDedupMap.get(message.id);
                const mountPolicy = messageMountPolicy(index, messages.length);
                const selected = selection.selectedMessageIds.has(message.id);
                const selectionEligible =
                  isMessageSelectableForBundle(message) &&
                  (!selection.selectionMode || selected || selection.selectedMessageIds.size < MAX_SELECTED_MESSAGES);
                return (
                  <ChatMessageRow
                    key={message.id}
                    message={message}
                    threadId={threadId}
                    timelineMessages={timelineProjectionMessages}
                    activeRuns={message.lifecycle?.dispatchRefs?.length ? lifecycleActiveRuns : undefined}
                    getCatById={getCatById}
                    onEditCat={handleEditCat}
                    onEditCoCreator={handleEditCoCreator}
                    hideDiagnosticsPanel={dedupInfo?.hideDiagnosticsPanel}
                    dedupCount={dedupInfo?.dedupCount}
                    selectionMode={selection.selectionMode}
                    selected={selected}
                    selectionEligible={selectionEligible}
                    onEnterSelection={selection.enterMessageSelection}
                    onToggleSelection={selection.toggleMessageSelection}
                    forwardingDisabled={connectionStatus.forwardingBlocked}
                    eager={mountPolicy.eager}
                    backgroundMountDelayMs={mountPolicy.backgroundMountDelayMs}
                    sendContext={interactiveSendContext}
                    confirmations={messageConfirmations?.get(message.id)}
                    showCapabilityTip={message.id === lifecycleTipMessageId}
                    capabilityTipContexts={capabilityTipContexts}
                  />
                );
              })}
          <div ref={messagesEndRef} />
        </main>
        <ScrollToBottomButton
          scrollContainerRef={scrollContainerRef}
          messagesEndRef={messagesEndRef}
          onJumpToLatest={jumpToLatest}
          recomputeSignal={computeScrollRecomputeSignal(threadId, messages, uiThinkingExpandedByDefault ? 1 : 0)}
          observerKey={`${threadId}:${density}`}
        />
        {messages.length > 5 && <MessageNavigator messages={messages} scrollContainerRef={scrollContainerRef} />}
      </div>

      <div ref={footerRef} className={compact ? 'border-t border-cafe-divider bg-cafe-surface' : undefined}>
        <ThreadExecutionBar threadId={threadId} />
        <QueuePanel threadId={threadId} />
        <VoteActiveBar threadId={threadId} onEnd={() => {}} />
        {footerLead}
        {selection.selectionMode ? (
          <MessageSelectionToolbar
            threadId={threadId}
            selectedMessageIds={selection.normalizedSelectedMessageIds}
            onCancel={selection.clearMessageSelection}
            onExportSuccess={selection.clearMessageSelection}
            forwardingDisabled={connectionStatus.forwardingBlocked}
            onForward={selection.openSelectionForward}
          />
        ) : (
          <div className={composerClassName}>
            <ChatInput
              key={threadId}
              threadId={threadId}
              onSend={(
                content,
                images,
                whisper,
                postAdmissionAction,
                replyToId,
                messageDisposition,
                contextAttachments,
                explicitTargetCats,
              ) =>
                handleSend(
                  content,
                  images,
                  undefined,
                  whisper,
                  postAdmissionAction,
                  replyToId,
                  messageDisposition,
                  contextAttachments,
                  explicitTargetCats,
                )
              }
              disabled={connectionStatus.isReadonly}
              hasActiveInvocation={hasActiveInvocation}
              uploadStatus={uploadStatus}
              uploadError={uploadError}
              placeholder={composerPlaceholder}
              seed={composerSeed}
              onFocusChange={onComposerFocusChange}
            />
          </div>
        )}
        {footerTail}
        <TransferTargetPicker
          open={selection.selectionForwardOpen && !connectionStatus.forwardingBlocked}
          admissionBlocked={connectionStatus.forwardingBlocked}
          sourceThreadId={threadId}
          items={selection.selectedBundleItems}
          onClose={selection.closeSelectionForward}
          onSuccess={selection.clearMessageSelection}
        />
      </div>
      {editingCat && (
        <HubCatEditor
          open
          cat={editingCat}
          draft={null}
          onClose={() => setEditingCatId(null)}
          onSaved={async () => {
            await refreshCats();
            setEditingCatId(null);
          }}
        />
      )}
      <HubCoCreatorEditor
        open={coCreatorEditorOpen}
        coCreator={coCreator}
        onClose={() => setCoCreatorEditorOpen(false)}
        onSaved={() => setCoCreatorEditorOpen(false)}
      />
    </section>
  );
}
