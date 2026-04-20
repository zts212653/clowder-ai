'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAgentMessages } from '@/hooks/useAgentMessages';
import { useAuthorization } from '@/hooks/useAuthorization';
import { useCatData } from '@/hooks/useCatData';
import { useChatHistory } from '@/hooks/useChatHistory';
import { useChatSocketCallbacks } from '@/hooks/useChatSocketCallbacks';
import { useConnectionStatus } from '@/hooks/useConnectionStatus';
import { godAction, submitAction } from '@/hooks/useGameApi';
import { reconnectGame } from '@/hooks/useGameReconnect';
import { useGovernanceStatus } from '@/hooks/useGovernanceStatus';
import { useIndexState } from '@/hooks/useIndexState';
import { usePersistedState } from '@/hooks/usePersistedState';
import { usePreviewAutoOpen } from '@/hooks/usePreviewAutoOpen';
import { useSendMessage } from '@/hooks/useSendMessage';
import { useSocket } from '@/hooks/useSocket';
import { useSplitPaneKeys } from '@/hooks/useSplitPaneKeys';
import { useVadInterrupt } from '@/hooks/useVadInterrupt';
import { useVoiceAutoPlay } from '@/hooks/useVoiceAutoPlay';
import { useVoiceStream } from '@/hooks/useVoiceStream';
import { useWorkspaceNavigate } from '@/hooks/useWorkspaceNavigate';
import { type ChatMessage as ChatMessageData, useChatStore } from '@/stores/chatStore';
import { useGameStore } from '@/stores/gameStore';
import { useTaskStore } from '@/stores/taskStore';
import { apiFetch } from '@/utils/api-client';
import { computeScrollRecomputeSignal } from '@/utils/scrollRecomputeSignal';
import { getUserId } from '@/utils/userId';
import { AuthorizationCard } from './AuthorizationCard';
import { BootcampListModal } from './BootcampListModal';
import { BootstrapOrchestrator } from './BootstrapOrchestrator';
import { CatCafeHub } from './CatCafeHub';
import { ChatContainerHeader } from './ChatContainerHeader';
import { ChatInput } from './ChatInput';
import { ChatMessage } from './ChatMessage';
import { ConnectionStatusBar } from './ConnectionStatusBar';
import { GameOverlayConnector } from './game/GameOverlayConnector';
import { HubListModal } from './HubListModal';
import { BootcampIcon } from './icons/BootcampIcon';
import { PawIcon } from './icons/PawIcon';
import { MessageActions } from './MessageActions';
import { MessageNavigator } from './MessageNavigator';
import { MobileStatusSheet } from './MobileStatusSheet';
import { ParallelStatusBar } from './ParallelStatusBar';
import { ProjectSetupCard } from './ProjectSetupCard';
import { QueuePanel } from './QueuePanel';
import { RightStatusPanel } from './RightStatusPanel';
import { ScrollToBottomButton } from './ScrollToBottomButton';
import { SplitPaneView } from './SplitPaneView';
import { ThinkingIndicator } from './ThinkingIndicator';
import { ThreadExecutionBar } from './ThreadExecutionBar';
import { ThreadSidebar } from './ThreadSidebar';
import { pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';
import { VoteActiveBar } from './VoteActiveBar';
import { type VoteConfig, VoteConfigModal } from './VoteConfigModal';
import { WorkspacePanel } from './WorkspacePanel';
import { ResizeHandle } from './workspace/ResizeHandle';

interface ChatContainerProps {
  threadId: string;
}

export function ChatContainer({ threadId }: ChatContainerProps) {
  const bottomChromeRef = useRef<HTMLDivElement | null>(null);
  const bottomChromeObserverRef = useRef<ResizeObserver | null>(null);
  const bottomChromeObserverRafRef = useRef<number | null>(null);
  const {
    messages,
    hasActiveInvocation,
    activeInvocations,
    intentMode,
    targetCats,
    catStatuses,
    catInvocations,
    setCurrentThread,
    viewMode,
    setViewMode,
    clearUnread,
    confirmUnreadAck,
    armUnreadSuppression,
    rightPanelMode,
  } = useChatStore();
  const navigateToThread = useCallback((tid: string) => {
    pushThreadRouteWithHistory(tid, typeof window !== 'undefined' ? window : undefined);
  }, []);
  const uiThinkingExpandedByDefault = useChatStore((s) => s.uiThinkingExpandedByDefault);
  const isOfflineSnapshot = useChatStore((s) => s.isOfflineSnapshot);

  // F101: Game state from Zustand store
  const gameView = useGameStore((s) => s.gameView);
  const isGameActive = useGameStore((s) => s.isGameActive);
  const isNight = useGameStore((s) => s.isNight);
  const selectedTarget = useGameStore((s) => s.selectedTarget);
  const godScopeFilter = useGameStore((s) => s.godScopeFilter);
  const myRole = useGameStore((s) => s.myRole);
  const myRoleIcon = useGameStore((s) => s.myRoleIcon);
  const myActionLabel = useGameStore((s) => s.myActionLabel);
  const myActionHint = useGameStore((s) => s.myActionHint);
  const isGodView = useGameStore((s) => s.isGodView);
  const isDetective = useGameStore((s) => s.isDetective);
  const detectiveBoundName = useGameStore((s) => s.detectiveBoundName);
  const godSeats = useGameStore((s) => s.godSeats);
  const godNightSteps = useGameStore((s) => s.godNightSteps);
  const hasTargetedAction = useGameStore((s) => s.hasTargetedAction);
  const altActionName = useGameStore((s) => s.altActionName);
  const overlayMinimized = useGameStore((s) => s.overlayMinimized);

  // Export mode: ?export=true triggers print-friendly layout (no scroll containers)
  const searchParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const isExport = searchParams?.get('export') === 'true';
  // AC-6: research=multi hint from Signal study "多猫研究" button
  const isResearchMode = searchParams?.get('research') === 'multi';
  const { clearTasks } = useTaskStore();
  const { getCatById, isLoading } = useCatData();
  const workspaceWorktreeId = useChatStore((s) => s.workspaceWorktreeId);
  usePreviewAutoOpen(workspaceWorktreeId);
  useWorkspaceNavigate(workspaceWorktreeId, threadId);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [statusPanelOpen, setStatusPanelOpen] = useState(true);
  const [mobileStatusOpen, setMobileStatusOpen] = useState(false);
  const [showBootcampList, setShowBootcampList] = useState(false);
  const [showHubList, setShowHubList] = useState(false);
  // F106: fetch bootcamp count independently of sidebar lifecycle
  // refreshKey increments only on modal close → avoids duplicate fetch on open
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_bootcampRefreshKey, setBootcampRefreshKey] = useState(0);
  const handleBootcampModalClose = useCallback(() => {
    setShowBootcampList(false);
    setBootcampRefreshKey((k) => k + 1);
  }, []);
  const [bootcampCount, setBootcampCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/bootcamp/threads')
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const data = await res.json();
        if (!cancelled) setBootcampCount(data.threads?.length ?? 0);
      })
      .catch(() => {
        if (!cancelled) setBootcampCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // F063: resizable split pane — chatBasis as percentage (20-80), persisted
  const [chatBasis, setChatBasis, resetChatBasis] = usePersistedState('cat-cafe:chatBasis', 50);
  // clowder-ai#28: right status panel width in px, persisted
  const STATUS_PANEL_DEFAULT = 288; // w-72
  const [statusPanelWidth, setStatusPanelWidth, resetStatusPanelWidth] = usePersistedState(
    'cat-cafe:statusPanelWidth',
    STATUS_PANEL_DEFAULT,
  );
  // F063 Gap 6: sidebar width in px, persisted
  const SIDEBAR_DEFAULT = 240;
  const [sidebarWidth, setSidebarWidth, resetSidebarWidth] = usePersistedState(
    'cat-cafe:sidebarWidth',
    SIDEBAR_DEFAULT,
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const handleHorizontalResize = useCallback(
    (delta: number) => {
      if (!containerRef.current) return;
      const totalWidth = containerRef.current.offsetWidth;
      if (totalWidth === 0) return;
      const pct = (delta / totalWidth) * 100;
      setChatBasis((prev) => Math.min(80, Math.max(20, prev + pct)));
    },
    [setChatBasis],
  );
  const handleSidebarResize = useCallback(
    (delta: number) => {
      setSidebarWidth((prev) => Math.min(480, Math.max(180, prev + delta)));
    },
    [setSidebarWidth],
  );
  // clowder-ai#28: drag-to-resize for right status panel (negative delta = panel wider)
  const handleStatusPanelResize = useCallback(
    (delta: number) => {
      setStatusPanelWidth((prev) => Math.min(480, Math.max(200, prev - delta)));
    },
    [setStatusPanelWidth],
  );

  // F063: auto-open panel when message file path click triggers workspace mode
  useEffect(() => {
    if (rightPanelMode === 'workspace' && !statusPanelOpen) {
      setStatusPanelOpen(true);
    }
  }, [rightPanelMode, statusPanelOpen]);

  // Desktop: open sidebar before first paint (useLayoutEffect avoids false→true flicker).
  // SSR parity: both server and client start with false, layoutEffect flips before paint.
  useLayoutEffect(() => {
    if (typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 768px)').matches) {
      setSidebarOpen(true);
    }
  }, []);

  const { handleAgentMessage, handleStop: stopHandler, resetRefs, resetTimeout, clearDoneTimeout } = useAgentMessages();
  const { handleScroll, scrollContainerRef, messagesEndRef, isLoadingHistory, hasMore } = useChatHistory(threadId);
  const { handleSend, uploadStatus, uploadError } = useSendMessage(threadId);
  const {
    pending: authPending,
    respond: authRespond,
    handleAuthRequest,
    handleAuthResponse,
  } = useAuthorization(threadId);

  // F096: Listen for interactive block send events
  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent<{ text: string }>).detail.text;
      if (text) handleSend(text);
    };
    window.addEventListener('cat-cafe:interactive-send', handler);
    return () => window.removeEventListener('cat-cafe:interactive-send', handler);
  }, [handleSend]);

  // F079: Vote modal
  const showVoteModal = useChatStore((s) => s.showVoteModal);
  const setShowVoteModal = useChatStore((s) => s.setShowVoteModal);
  const { addMessage } = useChatStore();
  const handleVoteSubmit = useCallback(
    async (config: VoteConfig) => {
      setShowVoteModal(false);
      try {
        const res = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/vote/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config),
        });
        if (res.status === 409) {
          addMessage({
            id: `vote-${Date.now()}`,
            type: 'system',
            variant: 'error',
            content: '已有活跃投票，请先 /vote end',
            timestamp: Date.now(),
          });
          return;
        }
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? `Server error: ${res.status}`);
        }
        const data = await res.json();
        // Build @mention notification message and send as user message to trigger cats
        const mentions = config.voters.map((v) => `@${v}`).join(' ');
        const optionList = config.options.map((o) => `• ${o}`).join('\n');
        const notifyMsg = `${mentions}\n投票请求：${data.question}\n\n选项：\n${optionList}\n\n请在回复中包含 [VOTE:你的选项]，例如 [VOTE:${config.options[0]}]`;
        handleSend(notifyMsg);
      } catch (err) {
        addMessage({
          id: `vote-${Date.now()}`,
          type: 'system',
          variant: 'error',
          content: `发起投票失败: ${err instanceof Error ? err.message : 'Unknown'}`,
          timestamp: Date.now(),
        });
      }
    },
    [threadId, handleSend, setShowVoteModal, addMessage],
  );

  const messageSummary = useMemo(() => {
    const c = { total: messages.length, assistant: 0, system: 0, evidence: 0, followup: 0 };
    for (const msg of messages) {
      const isAssistant = msg.type === 'assistant' || (msg.type === 'user' && !!msg.catId);
      if (isAssistant) c.assistant++;
      if (msg.type === 'system') {
        c.system++;
        if (msg.variant === 'evidence') c.evidence++;
        if (msg.variant === 'a2a_followup') c.followup++;
      }
    }
    return c;
  }, [messages]);

  // Sync URL-driven threadId to store (store is follower, URL is source of truth)
  // setCurrentThread saves old thread state to map, restores new thread state.
  const setCurrentProject = useChatStore((s) => s.setCurrentProject);
  const storeThreads = useChatStore((s) => s.threads);
  const prevThreadRef = useRef(threadId);
  useEffect(() => {
    if (prevThreadRef.current !== threadId) {
      // Thread switch: store saves/restores per-thread state automatically
      setCurrentThread(threadId);
      // Clean up non-thread-scoped refs
      resetRefs();
      clearTasks();
      prevThreadRef.current = threadId;
    }
    // First mount — sync threadId to store without save/restore
    setCurrentThread(threadId);
    // F101: Recover game state for the new thread (or clear stale game from previous thread)
    reconnectGame(threadId).catch(() => {});
  }, [
    threadId,
    clearTasks, // Clean up non-thread-scoped refs
    resetRefs, // First mount — sync threadId to store without save/restore
    setCurrentThread,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  // B1.1: Restore projectPath when thread or storeThreads change.
  // storeThreads is populated by ThreadSidebar.loadThreads shortly after mount,
  // so this covers both page refresh (threads arrive async) and thread switch.
  useEffect(() => {
    const cached = storeThreads?.find((t) => t.id === threadId);
    if (cached) {
      setCurrentProject(cached.projectPath || 'default');
    }
  }, [threadId, storeThreads, setCurrentProject]);

  // F113-E: Fetch governance status for the current project (drives ProjectSetupCard)
  const currentProjectPath = useChatStore((s) => s.currentProjectPath);
  const { status: govStatus, refetch: govRefetch } = useGovernanceStatus(currentProjectPath);
  const [setupDone, setSetupDone] = useState(false);
  // Show card when: needs setup (idle) OR just completed setup (done) — only in empty threads
  const showSetupCard = !!(
    (govStatus?.needsBootstrap || govStatus?.needsConfirmation || setupDone) &&
    messages.length === 0
  );
  // Reset setupDone on thread switch. Governance status already auto-refetches
  // when projectPath changes inside useGovernanceStatus; same-project thread switches
  // should not trigger an extra network round-trip.
  const prevThreadSetup = useRef(threadId);
  useEffect(() => {
    if (prevThreadSetup.current !== threadId) {
      prevThreadSetup.current = threadId;
      setSetupDone(false);
    }
  }, [threadId]);

  // F152 Phase B: memory bootstrap state
  const {
    state: indexState,
    progress: bootstrapProgress,
    summary: bootstrapSummary,
    durationMs: bootstrapDurationMs,
    isSnoozed,
    startBootstrap,
    snooze: snoozeBootstrap,
    handleSocketEvent: handleIndexSocketEvent,
  } = useIndexState(currentProjectPath);

  const socketCallbacks = useChatSocketCallbacks({
    threadId,
    userId: getUserId(),
    handleAgentMessage,
    resetTimeout,
    clearDoneTimeout,
    handleAuthRequest,
    handleAuthResponse,
    onNavigateToThread: navigateToThread,
    onIndexEvent: handleIndexSocketEvent,
  });

  const renderSingleMessage = useCallback(
    (msg: ChatMessageData) => (
      <MessageActions key={msg.id} message={msg} threadId={threadId}>
        <ChatMessage message={msg} getCatById={getCatById} />
      </MessageActions>
    ),
    [threadId, getCatById],
  );

  const { cancelInvocation, syncRooms, socketConnected } = useSocket(socketCallbacks, threadId);
  const connectionStatus = useConnectionStatus(socketConnected);

  useVoiceAutoPlay();
  useVoiceStream();
  useVadInterrupt();

  useSplitPaneKeys();
  const splitPaneThreadIds = useChatStore((s) => s.splitPaneThreadIds);
  const setSplitPaneThreadIds = useChatStore((s) => s.setSplitPaneThreadIds);
  const setSplitPaneTarget = useChatStore((s) => s.setSplitPaneTarget);

  useEffect(() => {
    if (viewMode === 'split' && splitPaneThreadIds.length === 0 && threadId !== 'default') {
      setSplitPaneThreadIds([threadId]);
      setSplitPaneTarget(threadId);
    }
  }, [viewMode, splitPaneThreadIds.length, threadId, setSplitPaneThreadIds, setSplitPaneTarget]);

  useEffect(() => {
    if (viewMode === 'split' && splitPaneThreadIds.length > 0) {
      // Join rooms for all threads in panes + the current active thread
      const allIds = new Set([...splitPaneThreadIds, threadId]);
      syncRooms([...allIds]);
    }
  }, [viewMode, splitPaneThreadIds, threadId, syncRooms]);

  useEffect(() => {
    clearUnread(threadId);
  }, [threadId, clearUnread]);

  const disconnectBottomChromeObserver = useCallback(() => {
    bottomChromeObserverRef.current?.disconnect();
    bottomChromeObserverRef.current = null;
    if (bottomChromeObserverRafRef.current !== null) {
      cancelAnimationFrame(bottomChromeObserverRafRef.current);
      bottomChromeObserverRafRef.current = null;
    }
  }, []);

  const attachBottomChromeRef = useCallback(
    (node: HTMLDivElement | null) => {
      bottomChromeRef.current = node;
      disconnectBottomChromeObserver();

      if (typeof window === 'undefined' || typeof window.ResizeObserver !== 'function' || !node) return;

      let lastHeight = node.getBoundingClientRect().height;
      const observer = new window.ResizeObserver(([entry]) => {
        const nextHeight = entry?.contentRect.height ?? node.getBoundingClientRect().height;
        if (Math.abs(nextHeight - lastHeight) <= 1) return;
        lastHeight = nextHeight;

        if (bottomChromeObserverRafRef.current !== null) {
          cancelAnimationFrame(bottomChromeObserverRafRef.current);
        }
        bottomChromeObserverRafRef.current = requestAnimationFrame(() => {
          bottomChromeObserverRafRef.current = null;
          window.dispatchEvent(new Event('catcafe:chat-layout-changed'));
        });
      });

      observer.observe(node);
      bottomChromeObserverRef.current = observer;
    },
    [disconnectBottomChromeObserver],
  );

  useEffect(() => {
    return disconnectBottomChromeObserver;
  }, [disconnectBottomChromeObserver]);

  // F069-R5: Ack read cursor server-side. The backend finds the latest real message
  // and acks it atomically — no frontend ID guessing, no timing races with fetchHistory.
  // Fires on thread entry AND when new messages arrive (messages.length changes),
  // so switching away after receiving new messages still acks to the latest.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _messageCount = messages.length;
  useEffect(() => {
    // Re-arm suppression before each ack. /read/latest is idempotent — any
    // successful POST means server cursor is at latest, so any successful ack
    // can safely clear suppression (no generation tracking needed).
    armUnreadSuppression(threadId);
    apiFetch(`/api/threads/${encodeURIComponent(threadId)}/read/latest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
      .then((res) => {
        if (res.ok) {
          confirmUnreadAck(threadId);
        }
      })
      .catch((err) => {
        console.debug('[F069] read ack failed:', err);
      });
  }, [threadId, _messageCount, confirmUnreadAck, armUnreadSuppression]);

  const handleStop = useCallback(
    (overrideThreadId?: unknown) => {
      const targetThreadId = typeof overrideThreadId === 'string' ? overrideThreadId : threadId;
      stopHandler(cancelInvocation, targetThreadId);
    },
    [stopHandler, cancelInvocation, threadId],
  );

  const router = useRouter();

  const handleZoomToThread = useCallback(
    (tid: string) => {
      setViewMode('single');
      navigateToThread(tid);
    },
    [setViewMode, navigateToThread],
  );

  const handleSearchKnowledge = useCallback(() => {
    const fromParam = threadId ? `?from=${encodeURIComponent(threadId)}` : '';
    router.push(`/memory/search${fromParam}`);
  }, [router, threadId]);

  const handleGoToMemoryHub = useCallback(() => {
    const fromParam = threadId ? `?from=${encodeURIComponent(threadId)}` : '';
    router.push(`/memory${fromParam}`);
  }, [router, threadId]);

  if (viewMode === 'split') {
    return (
      <>
        <SplitPaneView
          onSend={handleSend}
          onStop={handleStop}
          uploadStatus={uploadStatus}
          uploadError={uploadError}
          onZoomToThread={handleZoomToThread}
        />
        <CatCafeHub />
      </>
    );
  }

  // Export mode: print-friendly layout — no sidebars, no scroll containers.
  // data-export-ready signals to Puppeteer that messages + cat data are fully loaded and rendered.
  if (isExport) {
    const exportReady = !isLoadingHistory && messages.length > 0 && !isLoading;
    return (
      <div className="min-h-screen bg-cafe-surface" {...(exportReady ? { 'data-export-ready': 'true' } : {})}>
        <div className="max-w-4xl mx-auto p-4">{messages.map(renderSingleMessage)}</div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex h-screen h-dvh">
      {sidebarOpen && (
        <>
          {/* Backdrop — mobile only */}
          <div
            className="fixed inset-0 bg-black/30 z-20 md:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
          <div
            className="fixed inset-y-0 left-0 z-30 md:static md:z-auto flex-shrink-0"
            style={{ width: sidebarWidth }}
          >
            <ThreadSidebar
              onClose={() => setSidebarOpen(false)}
              className="w-full"
              onBootcampClick={() => setShowBootcampList(true)}
              onHubClick={() => setShowHubList(true)}
            />
          </div>
          <div className="hidden md:flex items-center">
            <ResizeHandle direction="horizontal" onResize={handleSidebarResize} onDoubleClick={resetSidebarWidth} />
          </div>
        </>
      )}

      <div
        className="flex flex-col min-w-0"
        style={
          statusPanelOpen && rightPanelMode === 'workspace'
            ? { flexBasis: `${chatBasis}%`, flexGrow: 0, flexShrink: 0 }
            : { flex: '1 1 0%' }
        }
      >
        <ChatContainerHeader
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          threadId={threadId}
          authPendingCount={authPending.length}
          viewMode={viewMode}
          onToggleViewMode={() => setViewMode(viewMode === 'single' ? 'split' : 'single')}
          onOpenMobileStatus={() => setMobileStatusOpen(true)}
          statusPanelOpen={statusPanelOpen}
          onToggleStatusPanel={() => setStatusPanelOpen((v) => !v)}
          defaultCatId={targetCats[0] || 'opus'}
        />

        {intentMode === 'ideate' && <ParallelStatusBar onStop={handleStop} />}
        {intentMode === 'execute' && <ThinkingIndicator onCancel={cancelInvocation} />}

        <div className="flex-1 relative overflow-hidden">
          <main
            ref={scrollContainerRef}
            onScroll={handleScroll}
            className="h-full overflow-y-auto p-4"
            data-chat-container
          >
            {isLoadingHistory && <div className="text-center py-3 text-sm text-cafe-muted">加载历史消息...</div>}
            <ConnectionStatusBar
              api={connectionStatus.api}
              socket={connectionStatus.socket}
              upstream={connectionStatus.upstream}
              isReadonly={connectionStatus.isReadonly}
              checkedAt={connectionStatus.checkedAt}
              isOfflineSnapshot={isOfflineSnapshot}
            />
            {!hasMore && messages.length > 0 && (
              <div className="text-center py-3 text-xs text-cafe-muted">没有更多消息了</div>
            )}
            {messages.length === 0 && !isLoadingHistory ? (
              <div className="text-center mt-20">
                <PawIcon className="w-12 h-12 text-cocreator-light mx-auto mb-4" />
                <p className="text-lg text-cafe-secondary mb-1">欢迎来到 Clowder AI!</p>
                <p className="text-sm text-cafe-muted">输入 @布偶 召唤布偶猫开始聊天</p>
                {showSetupCard && govStatus && (
                  <div className="mt-6 text-left">
                    <ProjectSetupCard
                      key={threadId}
                      projectPath={currentProjectPath}
                      isEmptyDir={govStatus.isEmptyDir}
                      isGitRepo={govStatus.isGitRepo}
                      gitAvailable={govStatus.gitAvailable}
                      onComplete={() => {
                        setSetupDone(true);
                        govRefetch();
                      }}
                    />
                  </div>
                )}
                {/* F152 Phase B: memory bootstrap orchestrator */}
                {!showSetupCard &&
                  currentProjectPath &&
                  currentProjectPath !== 'default' &&
                  currentProjectPath !== 'lobby' && (
                    <div className="mt-4 text-left">
                      <BootstrapOrchestrator
                        projectPath={currentProjectPath}
                        indexState={indexState}
                        isSnoozed={isSnoozed}
                        progress={bootstrapProgress}
                        summary={bootstrapSummary}
                        durationMs={bootstrapDurationMs}
                        isNewProject={setupDone}
                        governanceDone={
                          setupDone || !!(govStatus && !govStatus.needsBootstrap && !govStatus.needsConfirmation)
                        }
                        onStartBootstrap={startBootstrap}
                        onSnooze={snoozeBootstrap}
                        onSearchKnowledge={handleSearchKnowledge}
                        onGoToMemoryHub={handleGoToMemoryHub}
                      />
                    </div>
                  )}
                {(() => {
                  const isCurrentBootcamp = storeThreads.find((t) => t.id === threadId)?.bootcampState;
                  if (isCurrentBootcamp) return null; // already in bootcamp thread
                  if (bootcampCount > 0) {
                    return (
                      <button
                        type="button"
                        onClick={() => setShowBootcampList(true)}
                        className="mt-6 inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 transition-colors text-sm font-medium"
                        data-testid="empty-state-bootcamp-list"
                      >
                        <BootcampIcon className="w-4 h-4" />
                        我的训练营（{bootcampCount}）
                      </button>
                    );
                  }
                  return (
                    <button
                      type="button"
                      onClick={() => setShowBootcampList(true)}
                      className="mt-6 inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 transition-colors text-sm font-medium"
                      data-testid="empty-state-bootcamp"
                    >
                      <BootcampIcon className="w-4 h-4" />
                      第一次来？开始猫猫训练营
                    </button>
                  );
                })()}
              </div>
            ) : (
              messages.map(renderSingleMessage)
            )}
            <div ref={messagesEndRef} />
          </main>
          <ScrollToBottomButton
            scrollContainerRef={scrollContainerRef}
            messagesEndRef={messagesEndRef}
            recomputeSignal={computeScrollRecomputeSignal(threadId, messages, uiThinkingExpandedByDefault ? 1 : 0)}
            observerKey={threadId}
          />
          {messages.length > 5 && <MessageNavigator messages={messages} scrollContainerRef={scrollContainerRef} />}
        </div>

        <div ref={attachBottomChromeRef}>
          {authPending.length > 0 && (
            <div className="border-t border-amber-200 bg-amber-50/40 py-2">
              {authPending.map((req) => (
                <AuthorizationCard key={req.requestId} request={req} onRespond={authRespond} />
              ))}
            </div>
          )}

          <ThreadExecutionBar />
          <QueuePanel threadId={threadId} />
          <VoteActiveBar threadId={threadId} onEnd={() => {}} />

          {isResearchMode && (
            <div className="mx-4 mb-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              多猫研究模式 — 文章上下文已注入。请输入研究问题，猫猫会自动调用 multi_mention 邀请其他猫参与分析。
            </div>
          )}
          <ChatInput
            key={threadId}
            threadId={threadId}
            onSend={(content, images, whisper, deliveryMode) =>
              handleSend(content, images, undefined, whisper, deliveryMode)
            }
            onStop={handleStop}
            disabled={connectionStatus.isReadonly}
            hasActiveInvocation={hasActiveInvocation}
            uploadStatus={uploadStatus}
            uploadError={uploadError}
          />

          {/* F101: "Return to game" banner when overlay is minimized */}
          {isGameActive && overlayMinimized && gameView?.threadId === threadId && (
            <button
              onClick={() => useGameStore.getState().restoreOverlay()}
              className="mx-4 mb-2 flex items-center justify-center gap-2 rounded-lg border border-purple-300 bg-purple-50 px-3 py-2 text-sm text-purple-700 hover:bg-purple-100 transition-colors"
            >
              🎮 返回游戏
            </button>
          )}
        </div>

        {/* F101: Game overlay — renders when a game is active */}
        <GameOverlayConnector
          gameView={gameView}
          isGameActive={isGameActive}
          overlayMinimized={overlayMinimized}
          currentThreadId={threadId}
          isNight={isNight}
          selectedTarget={selectedTarget}
          godScopeFilter={godScopeFilter}
          isGodView={isGodView}
          isDetective={isDetective}
          detectiveBoundName={detectiveBoundName ?? undefined}
          godSeats={godSeats}
          godNightSteps={godNightSteps}
          hasTargetedAction={hasTargetedAction}
          myRole={myRole ?? undefined}
          myRoleIcon={myRoleIcon ?? undefined}
          myActionLabel={myActionLabel ?? undefined}
          myActionHint={myActionHint ?? undefined}
          altActionName={altActionName ?? undefined}
          onClose={() => {
            useGameStore.getState().minimizeOverlay();
          }}
          onSelectTarget={(seatId) => useGameStore.getState().setSelectedTarget(seatId)}
          onGodScopeChange={(scope) => useGameStore.getState().setGodScopeFilter(scope)}
          onGodAction={(action) => godAction(threadId, action)}
          onVote={() => {
            const state = useGameStore.getState();
            if (state.selectedTarget && state.mySeatId) {
              submitAction(threadId, state.mySeatId, 'vote', state.selectedTarget);
              state.setSelectedTarget(null);
            }
          }}
          onSpeak={(content) => {
            const state = useGameStore.getState();
            if (state.mySeatId) {
              submitAction(threadId, state.mySeatId, 'speak', undefined, { content });
            }
          }}
          onConfirmAction={() => {
            const state = useGameStore.getState();
            if (state.selectedTarget && state.mySeatId && state.currentActionName) {
              submitAction(threadId, state.mySeatId, state.currentActionName, state.selectedTarget);
              state.setSelectedTarget(null);
            }
          }}
          onConfirmAltAction={() => {
            const state = useGameStore.getState();
            if (state.selectedTarget && state.mySeatId && state.altActionName) {
              submitAction(threadId, state.mySeatId, state.altActionName, state.selectedTarget);
              state.setSelectedTarget(null);
            }
          }}
        />
      </div>

      {statusPanelOpen && rightPanelMode === 'status' && (
        <>
          <div className="hidden lg:flex">
            <ResizeHandle
              direction="horizontal"
              onResize={handleStatusPanelResize}
              onDoubleClick={resetStatusPanelWidth}
            />
          </div>
          <RightStatusPanel
            intentMode={intentMode}
            targetCats={targetCats}
            catStatuses={catStatuses}
            catInvocations={catInvocations}
            activeInvocations={activeInvocations}
            hasActiveInvocation={hasActiveInvocation}
            threadId={threadId}
            messageSummary={messageSummary}
            width={statusPanelWidth}
          />
        </>
      )}
      {statusPanelOpen && rightPanelMode === 'workspace' && (
        <>
          <ResizeHandle direction="horizontal" onResize={handleHorizontalResize} onDoubleClick={resetChatBasis} />
          <WorkspacePanel />
        </>
      )}
      <MobileStatusSheet
        open={mobileStatusOpen}
        onClose={() => setMobileStatusOpen(false)}
        intentMode={intentMode}
        targetCats={targetCats}
        catStatuses={catStatuses}
        catInvocations={catInvocations}
        activeInvocations={activeInvocations}
        hasActiveInvocation={hasActiveInvocation}
        threadId={threadId}
        messageSummary={messageSummary}
      />
      <CatCafeHub />
      <BootcampListModal open={showBootcampList} onClose={handleBootcampModalClose} currentThreadId={threadId} />
      <HubListModal open={showHubList} onClose={() => setShowHubList(false)} currentThreadId={threadId} />
      {showVoteModal && <VoteConfigModal onSubmit={handleVoteSubmit} onCancel={() => setShowVoteModal(false)} />}
    </div>
  );
}
