'use client';

import type { CapabilityTipContext, LifecycleActiveRun } from '@cat-cafe/shared';
import { useRouter } from 'next/navigation';
import type { ReactNode, Ref } from 'react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { useChatHistory } from '@/hooks/useChatHistory';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { useConnectionStatus } from '@/hooks/useConnectionStatus';
import type { ConversationViewPreferenceController } from '@/hooks/useConversationViewPreference';
import { useSendMessage } from '@/hooks/useSendMessage';
import { useThreadLiveness } from '@/hooks/useThreadScopedSelectors';
import type { ChatMessage, QueueEntry } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { readChatScrollState, resolveChatReadingAnchor } from '@/utils/chat-scroll-memory';
import { computeCliDiagnosticsDedup } from '@/utils/cli-diagnostics-dedup';
import { computeScrollRecomputeSignal } from '@/utils/scrollRecomputeSignal';
import { ChatInput } from '../ChatInput';
import { ChatMessageRow } from '../ChatMessageRow';
import { ConnectionStatusBar } from '../ConnectionStatusBar';
import { getStreamingTipContexts, selectLifecycleTipMessageId } from '../capability-tip-placement';
import { buildChatTimelineProjectionKey } from '../chat-timeline-projection-key';
import { useCompanionConversation } from '../concierge/useCompanionConversation';
import { useArtworkLightboxScope } from '../content-review/ArtworkLightboxScope';
import { HubCoCreatorEditor } from '../HubCoCreatorEditor';
import { IdeateHeader } from '../IdeateHeader';
import { PawIcon } from '../icons/PawIcon';
import { MessageSelectionToolbar } from '../MessageSelectionToolbar';
import { messageMountPolicy } from '../message-mount-policy';
import { isMessageSelectableForBundle, MAX_SELECTED_MESSAGES } from '../message-selection';
import { ImportedSessionNotice } from '../new-conversation/ImportedSessionNotice';
import { ReplyRecallRuntimeProvider } from '../reply-layers/ReplyRecallRuntimeProvider';
import type { CardConfirmationEntry } from '../rich/CardBlock';
import { useShellPresentation } from '../shell/shell-presentation';
import { ThreadComposerContext } from '../ThreadComposerContext';
import { TransferTargetPicker } from '../TransferTargetPicker';
import { VoteActiveBar } from '../VoteActiveBar';
import { MessageNavigationProvider } from './MessageNavigationContext';
import { SingleCatConversationTimeline } from './SingleCatConversationTimeline';
import {
  projectSingleCatConversation,
  type SingleCatConversationProjection,
} from './single-cat-conversation-projection';
import { ThreadChatHistoryNavigation } from './ThreadChatHistoryNavigation';
import { useThreadChatRuntime } from './ThreadChatRuntimeProvider';
import { ThreadComposerHost } from './ThreadComposerHost';
import { ThreadExecutionLayer } from './ThreadExecutionLayer';
import { type RegisterChatReadingPort, useThreadChatReadingPort } from './useThreadChatReadingPort';
import { useThreadChatSelection } from './useThreadChatSelection';

export type ThreadChatDensity = 'full' | 'compact';
export type ThreadChatPresentation = 'conversation' | 'composer-only';

function useThreadChatHistoryPresentation(presentation: ThreadChatPresentation) {
  const historyHostRef = useRef<HTMLDivElement>(null);
  const composerOnly = presentation === 'composer-only';
  useEffect(() => {
    const historyHost = historyHostRef.current;
    if (!historyHost) return;
    if (composerOnly) historyHost.setAttribute('inert', '');
    else historyHost.removeAttribute('inert');
  }, [composerOnly]);
  return { historyHostRef, composerOnly };
}

function historyHostClassName(composerOnly: boolean, v2: boolean): string {
  return `relative min-h-0 flex-1 overflow-hidden ${v2 ? 'flex flex-col' : ''} ${composerOnly ? 'invisible pointer-events-none' : ''}`;
}

function footerClassName(compact: boolean, composerOnly: boolean): string | undefined {
  return compact || composerOnly
    ? 'relative z-10 border-t border-cafe-divider bg-cafe-surface pointer-events-auto'
    : undefined;
}

export type ThreadChatActivity = {
  threadId: string;
  messageCount: number;
  hasActiveInvocation: boolean;
};

function flattenConversationProjection(projection: SingleCatConversationProjection): ChatMessage[] {
  return projection.blocks.flatMap((block) => {
    if (block.kind === 'execution') {
      return [...block.readInputs, ...block.unconfirmedInputs].map((input) => input.message).concat(block.response);
    }
    if (block.kind === 'pending-inputs') return block.inputs.map((input) => input.message);
    return [block.message];
  });
}

export interface ThreadChatSurfaceProps {
  threadId: string;
  density: ThreadChatDensity;
  presentation?: ThreadChatPresentation;
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
  onRealMessageSent?: () => void;
  onReadingPort?: RegisterChatReadingPort;
  conversationViewController?: ConversationViewPreferenceController;
  conversationViewQueue?: readonly QueueEntry[];
}

export function ThreadChatSurface({
  threadId,
  density,
  presentation = 'conversation',
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
  onRealMessageSent,
  onReadingPort,
  conversationViewController,
  conversationViewQueue = [],
}: ThreadChatSurfaceProps) {
  const artworkLightbox = useArtworkLightboxScope();
  const companion = useCompanionConversation(threadId);
  // The composer is told it is hosted with the one execution row only in the new shell (see ChatInput `presentation`).
  const composerPresentation = useShellPresentation();
  const [pianoReady, setPianoReady] = useState(false);
  const liveness = useThreadLiveness(threadId);
  const { hasActive: hasActiveInvocation, catStatuses, catInvocations, intentMode } = liveness;
  const { socketConnected } = useThreadChatRuntime([threadId]);
  const history = useChatHistory(threadId);
  const {
    messages,
    handleScroll,
    handleReadingIntent,
    jumpToLatest,
    jumpToMessage,
    beginUserScroll,
    scrollContainerRef,
    messagesEndRef,
    isLoadingHistory,
    hasMore,
  } = history;
  useThreadChatReadingPort(threadId, presentation, onReadingPort, history);
  const { handleSend, uploadStatus, uploadError } = useSendMessage(threadId);
  const interactiveSendContext = `thread-chat-surface:${useId()}`;
  const { getCatById } = useCatData();
  const router = useRouter();
  const coCreator = useCoCreatorConfig();
  const [coCreatorEditorOpen, setCoCreatorEditorOpen] = useState(false);
  const connectionStatus = useConnectionStatus(socketConnected);
  const uiThinkingExpandedByDefault = useChatStore((state) => state.uiThinkingExpandedByDefault);
  const isOfflineSnapshot = useChatStore((state) => state.isOfflineSnapshot);
  const { historyHostRef, composerOnly } = useThreadChatHistoryPresentation(presentation);
  const compact = density === 'compact';

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
  const timelineProjectionKey = useMemo(() => buildChatTimelineProjectionKey(messages, threadId), [messages, threadId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: projection key captures the cross-message fields consumed by rows.
  const timelineProjectionMessages = useMemo(
    () => messages,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timelineProjectionKey],
  );
  const singleCatProjection = useMemo(() => {
    const view = conversationViewController?.snapshot.effective;
    if (composerPresentation !== 'v2' || conversationViewController?.loading || view?.mode !== 'cat') return null;
    const projection = projectSingleCatConversation({ messages, queue: conversationViewQueue, catId: view.catId });
    return projection.hasEvidence ? projection : null;
  }, [
    composerPresentation,
    conversationViewController?.loading,
    conversationViewController?.snapshot.effective,
    conversationViewQueue,
    messages,
  ]);
  const visibleMessages = useMemo(
    () => (singleCatProjection ? flattenConversationProjection(singleCatProjection) : messages),
    [messages, singleCatProjection],
  );
  // Read the history owner's existing anchor. Its row must exist on the first
  // paint of a returning thread, before an observer can mount deferred content.
  const savedReading = readChatScrollState(threadId);
  const readingAnchor =
    savedReading?.anchor === 'offset' && savedReading.messageAnchor
      ? resolveChatReadingAnchor(savedReading.messageAnchor, visibleMessages)
      : undefined;
  const readingAnchorIndex = readingAnchor
    ? visibleMessages.findIndex((message) => message.id === readingAnchor.messageId)
    : -1;
  const conversationViewKey = singleCatProjection
    ? `cat:${conversationViewController?.snapshot.effective.mode === 'cat' ? conversationViewController.snapshot.effective.catId : ''}`
    : 'group';
  const selection = useThreadChatSelection(visibleMessages);
  const handleEditCat = useCallback(
    (catId: string) => router.push(`/settings?s=members&shell=v2&cat=${encodeURIComponent(catId)}`),
    [router],
  );
  const handleEditCoCreator = useCallback(() => setCoCreatorEditorOpen(true), []);
  const projectedEmptyState = emptyState ?? (
    <div className={density === 'compact' ? 'mt-4 text-center' : 'mt-20 text-center'}>
      <PawIcon className="mx-auto mb-3 h-10 w-10 text-cafe-muted" />
      <p className="text-sm text-cafe-secondary">还没有消息，发一句试试吧</p>
    </div>
  );

  const renderTimelineMessage = (message: ChatMessage, index: number, total: number) => {
    const dedupInfo = cliDedupMap.get(message.id);
    const mountPolicy = messageMountPolicy(index, total, readingAnchorIndex);
    const selected = selection.selectedMessageIds.has(message.id);
    const selectionEligible =
      isMessageSelectableForBundle(message) &&
      (!selection.selectionMode || selected || selection.selectedMessageIds.size < MAX_SELECTED_MESSAGES);
    return (
      <ChatMessageRow
        key={message.id}
        message={message}
        compact={compact}
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
  };

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
      void handleSend(detail.text).then((sent) => {
        if (sent) onRealMessageSent?.();
      });
    };
    window.addEventListener('cat-cafe:interactive-send', handleInteractiveSend);
    return () => window.removeEventListener('cat-cafe:interactive-send', handleInteractiveSend);
  }, [acceptUnscopedInteractiveSend, handleSend, interactiveSendContext, threadId]);

  const surface = (
    <section
      className="flex min-h-0 flex-1 flex-col"
      data-thread-chat-surface
      data-thread-chat-density={density}
      data-thread-id={threadId}
    >
      {!composerOnly && companion.header}
      <div
        ref={historyHostRef}
        className={historyHostClassName(composerOnly, composerPresentation === 'v2')}
        aria-hidden={composerOnly || undefined}
        data-thread-chat-history
      >
        {/* The v2 right rail fits the 28px latest control beside the message piano with clear reading separation. */}
        <main
          ref={scrollContainerRef}
          onScroll={handleScroll}
          onClickCapture={handleReadingIntent}
          className={
            composerPresentation === 'v2'
              ? compact
                ? 'min-h-0 flex-1 overflow-y-auto [overflow-anchor:none] py-3 pl-3 pr-[4.5rem]'
                : 'min-h-0 flex-1 overflow-y-auto [overflow-anchor:none] p-4 pr-[4.5rem]'
              : compact
                ? 'h-full overflow-y-auto [overflow-anchor:none] px-3 py-3'
                : 'h-full overflow-y-auto [overflow-anchor:none] p-4'
          }
          tabIndex={composerPresentation === 'v2' ? -1 : undefined}
          data-message-piano-ready={(composerPresentation === 'v2' && pianoReady) || undefined}
          aria-label="对话内容"
          data-guide-id="bootcamp.preview-result"
          data-bootcamp-host="chat-messages"
          data-chat-container
        >
          <div
            data-thread-chat-reading-column
            className={composerPresentation === 'v2' && !compact ? 'mx-auto w-full max-w-[720px]' : ''}
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
            {composerPresentation === 'v2' && !compact && <ImportedSessionNotice threadId={threadId} />}
            {timelineLead}
            {intentMode === 'ideate' ? (
              <IdeateHeader
                members={liveness.targetCats.map((catId) => ({
                  catId,
                  label: getCatById(catId)?.displayName ?? catId,
                  status: catStatuses[catId],
                }))}
              />
            ) : null}
            {!hasMore && messages.length > 0 && (
              <div className="py-3 text-center text-xs text-cafe-muted">没有更多消息了</div>
            )}
            <ReplyRecallRuntimeProvider enabled={composerPresentation === 'v2'} threadId={threadId} messages={messages}>
              {visibleMessages.length === 0 && !isLoadingHistory ? (
                projectedEmptyState
              ) : singleCatProjection ? (
                <SingleCatConversationTimeline projection={singleCatProjection} renderMessage={renderTimelineMessage} />
              ) : (
                messages.map((message, index) => renderTimelineMessage(message, index, messages.length))
              )}
            </ReplyRecallRuntimeProvider>
            <div ref={messagesEndRef} />
          </div>
        </main>
        <ThreadChatHistoryNavigation
          visible={!composerOnly}
          bottomProps={{
            scrollContainerRef,
            messagesEndRef,
            onJumpToLatest: jumpToLatest,
            recomputeSignal: computeScrollRecomputeSignal(
              threadId,
              visibleMessages,
              uiThinkingExpandedByDefault ? 1 : 0,
            ),
            observerKey: `${threadId}:${density}:${conversationViewKey}`,
          }}
          navigatorProps={{
            messages: visibleMessages,
            scrollContainerRef,
            onJumpToMessage: jumpToMessage,
            beginUserScroll,
            compact,
            hasMore,
            observerKey: `${threadId}:${density}:${conversationViewKey}`,
            onTrackReadyChange: setPianoReady,
          }}
        />
      </div>

      <ThreadComposerHost threadId={threadId}>
        <div ref={footerRef} className={footerClassName(compact, composerOnly)} data-thread-chat-footer>
          <ThreadExecutionLayer threadId={threadId} />
          <VoteActiveBar threadId={threadId} onEnd={() => {}} />
          {footerLead}
          <div ref={artworkLightbox?.setToolsSlot} data-artwork-tools-slot />
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
                presentation={composerPresentation}
                composerContext={
                  composerPresentation === 'v2' ? <ThreadComposerContext threadId={threadId} /> : undefined
                }
                threadId={threadId}
                onSend={async (
                  content,
                  images,
                  whisper,
                  replyToId,
                  contextAttachments,
                  explicitTargetCats,
                  messageDisposition,
                ) => {
                  const sent = await handleSend(
                    content,
                    images,
                    undefined,
                    whisper,
                    replyToId,
                    contextAttachments,
                    explicitTargetCats,
                    {
                      consumeComposerDraft: true,
                      ...(messageDisposition ? { messageDisposition } : {}),
                    },
                  );
                  if (sent) onRealMessageSent?.();
                  return sent;
                }}
                disabled={connectionStatus.isReadonly}
                hasActiveInvocation={hasActiveInvocation}
                uploadStatus={uploadStatus}
                uploadError={uploadError}
                placeholder={composerPlaceholder}
                seed={composerSeed ?? companion.composerSeed}
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
      </ThreadComposerHost>
      <HubCoCreatorEditor
        open={coCreatorEditorOpen}
        coCreator={coCreator}
        onClose={() => setCoCreatorEditorOpen(false)}
        onSaved={() => setCoCreatorEditorOpen(false)}
      />
    </section>
  );
  return <MessageNavigationProvider value={jumpToMessage}>{surface}</MessageNavigationProvider>;
}
