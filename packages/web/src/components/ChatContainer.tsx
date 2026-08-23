'use client';

import type { CapabilityTipContext, MessageBundleSelectionItem } from '@cat-cafe/shared';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { useActiveExecutionProjection } from '@/hooks/useActiveExecutionProjection';
import { useAgentHookHealth } from '@/hooks/useAgentHookHealth';
import { useAgentMessages } from '@/hooks/useAgentMessages';
import { useAuthorization } from '@/hooks/useAuthorization';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import { useChatHistory } from '@/hooks/useChatHistory';
import { useChatSocketCallbacks } from '@/hooks/useChatSocketCallbacks';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { useConnectionStatus } from '@/hooks/useConnectionStatus';
import { godAction, submitAction } from '@/hooks/useGameApi';
import { reconnectGame } from '@/hooks/useGameReconnect';
import { useGovernanceStatus } from '@/hooks/useGovernanceStatus';
import { useIndexState } from '@/hooks/useIndexState';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { usePersistedState } from '@/hooks/usePersistedState';
import { useSendMessage } from '@/hooks/useSendMessage';
import { useSocket } from '@/hooks/useSocket';
import { useSplitPaneKeys } from '@/hooks/useSplitPaneKeys';
import { useTeleport } from '@/hooks/useTeleport';
import { useThreadLiveness, useThreadMessages } from '@/hooks/useThreadScopedSelectors';
import { useVadInterrupt } from '@/hooks/useVadInterrupt';
import { useVoiceAutoPlay } from '@/hooks/useVoiceAutoPlay';
import { useVoiceStream } from '@/hooks/useVoiceStream';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { type ChatMessage as ChatMessageData, type Thread, useChatStore } from '@/stores/chatStore';
import { useGameStore } from '@/stores/gameStore';
import { useGuideStore } from '@/stores/guideStore';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { useSidebarStore } from '@/stores/sidebarStore';
import { useTaskStore } from '@/stores/taskStore';
import { apiFetch } from '@/utils/api-client';
import { computeCliDiagnosticsDedup } from '@/utils/cli-diagnostics-dedup';
import { computeScrollRecomputeSignal } from '@/utils/scrollRecomputeSignal';
import { invalidateSidebarProjection } from '@/utils/sidebar-thread-snapshot';
import { getUserId } from '@/utils/userId';
import { AgentHookHealthNotice, shouldRenderAgentHookHealthNotice } from './AgentHookHealthNotice';
import { AuthorizationCard } from './AuthorizationCard';
import { BootcampListModal } from './BootcampListModal';
import { BootstrapOrchestrator } from './BootstrapOrchestrator';
import { ChatContainerHeader } from './ChatContainerHeader';
import { ChatInput } from './ChatInput';
import { ChatMessage } from './ChatMessage';
import { ChatMessageRow } from './ChatMessageRow';
import { ConnectionStatusBar } from './ConnectionStatusBar';
import {
  getSilentActiveTurnDeadline,
  getStreamingTipContexts,
  isStreamingTipSuppressed,
} from './capability-tip-placement';
import { buildChatTimelineProjectionKey } from './chat-timeline-projection-key';
import { FirstRunQuestWizard } from './FirstRunQuestWizard';
import { BootcampGuideOverlay } from './first-run-quest/BootcampGuideOverlay';
import { QuestBanner } from './first-run-quest/QuestBanner';
import { syncLocalBootcampState } from './first-run-quest/syncLocalBootcampState';
import { useFirstProjectMistakeTipGate } from './first-run-quest/useFirstProjectMistakeTipGate';
import { useFirstProjectPreviewAutoOpen } from './first-run-quest/useFirstProjectPreviewAutoOpen';
import { GameOverlayConnector } from './game/GameOverlayConnector';
import { HubCatEditor } from './HubCatEditor';
import { HubCoCreatorEditor } from './HubCoCreatorEditor';
import { BootcampIcon } from './icons/BootcampIcon';
import { PawIcon } from './icons/PawIcon';
import { MessageNavigator } from './MessageNavigator';
import { MessageSelectionToolbar } from './MessageSelectionToolbar';
import { MobileApprovalSheet } from './MobileApprovalSheet';
import { loadExportThreadTitle, selectMessagesForExport } from './message-export-selection';
import { messageMountPolicy } from './message-mount-policy';
import { isMessageSelectableForBundle, MAX_SELECTED_MESSAGES, normalizeSelectedMessageIds } from './message-selection';
import { ParallelStatusBar } from './ParallelStatusBar';
import { PendingMemberBubble } from './PendingMemberBubble';
import { ProjectSetupCard } from './ProjectSetupCard';
import { derivePendingMemberInvocations } from './pending-member-projection';
import { QueuePanel } from './QueuePanel';
import { collectExactLiveInvocationIds } from './queue-receipt-projection';
import { RightStatusPanel } from './RightStatusPanel';
import { RuntimeUpdateRequiredDialog } from './RuntimeUpdateRequiredDialog';
import { ScrollToBottomButton } from './ScrollToBottomButton';
import { SplitPaneView } from './SplitPaneView';
import { ThinkingIndicator } from './ThinkingIndicator';
import { ThreadExecutionBar } from './ThreadExecutionBar';
import { ThreadSidebar } from './ThreadSidebar';
import { assignDocumentRoute, pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';
import { TransferTargetPicker } from './TransferTargetPicker';
import { VoteActiveBar } from './VoteActiveBar';
import { type VoteConfig, VoteConfigModal } from './VoteConfigModal';

import { WorkspacePanel } from './WorkspacePanel';
import { ContextualWorkspaceChrome } from './workspace/ContextualWorkspaceChrome';
import { FloatingTranscriptContainer } from './workspace/FloatingTranscriptContainer';
import { ResizeHandle } from './workspace/ResizeHandle';
import { TranscriptPanel } from './workspace/TranscriptPanel';
import { hydrateInvocationTrajectoryFromCurrentUrl } from './workspace/trajectory/trajectory-navigation';

interface ChatContainerProps {
  threadId: string;
}

export function ChatContainer({ threadId }: ChatContainerProps) {
  const bottomChromeRef = useRef<HTMLDivElement | null>(null);
  const bottomChromeObserverRef = useRef<ResizeObserver | null>(null);
  const bottomChromeObserverRafRef = useRef<number | null>(null);
  const {
    setCurrentThread,
    viewMode,
    setViewMode,
    isLoading: chatIsLoading,
    clearUnread,
    settleUnreadAck,
    armUnreadSuppression,
    rightPanelMode,
    workspaceMode,
    workspaceSurface,
    presentationLock,
    setWorkspaceMode,
    setWorkspaceSurface,
    setRightPanelMode,
    closeRightPanel,
    showVoteModal,
    setShowVoteModal,
    addMessageToThread,
  } = useChatStore(
    useShallow((s) => ({
      setCurrentThread: s.setCurrentThread,
      viewMode: s.viewMode,
      setViewMode: s.setViewMode,
      isLoading: s.isLoading,
      clearUnread: s.clearUnread,
      settleUnreadAck: s.settleUnreadAck,
      armUnreadSuppression: s.armUnreadSuppression,
      rightPanelMode: s.rightPanelMode,
      workspaceMode: s.workspaceMode,
      workspaceSurface: s.workspaceSurface,
      presentationLock: s.presentationLock,
      setWorkspaceMode: s.setWorkspaceMode,
      setWorkspaceSurface: s.setWorkspaceSurface,
      setRightPanelMode: s.setRightPanelMode,
      closeRightPanel: s.closeRightPanel,
      showVoteModal: s.showVoteModal,
      setShowVoteModal: s.setShowVoteModal,
      addMessageToThread: s.addMessageToThread,
    })),
  );
  // F173 Phase C Task 3 — full read-side migration. All thread liveness +
  // messages now flow through thread-scoped selectors keyed off this
  // component's `threadId` prop, not the flat current-thread mirror. Closes
  // AC-C6 race window for the entire ChatContainer surface (Task 2 only
  // covered hasActiveInvocation; this finishes the job).
  const allMessages = useThreadMessages(threadId);

  // F264: the timeline is the durable authoring history. QueuePanel presents
  // custody/actions for the same message, but must not erase its user bubble.
  const messages = allMessages;
  const [documentVisible, setDocumentVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible',
  );
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(() => new Set());
  const [selectionForwardOpen, setSelectionForwardOpen] = useState(false);
  const normalizedSelectedMessageIds = useMemo(
    () => normalizeSelectedMessageIds(messages, selectedMessageIds),
    [messages, selectedMessageIds],
  );
  const selectedBundleItems = useMemo<MessageBundleSelectionItem[]>(
    () => normalizedSelectedMessageIds.map((messageId) => ({ kind: 'message', messageId })),
    [normalizedSelectedMessageIds],
  );

  const clearMessageSelection = useCallback(() => {
    setSelectionForwardOpen(false);
    setSelectionMode(false);
    setSelectedMessageIds(new Set());
  }, []);

  const enterMessageSelection = useCallback(
    (messageId: string) => {
      const candidate = messages.find((message) => message.id === messageId);
      if (!candidate || !isMessageSelectableForBundle(candidate)) return;
      setSelectedMessageIds(new Set([messageId]));
      setSelectionMode(true);
    },
    [messages],
  );

  const toggleMessageSelection = useCallback((messageId: string) => {
    setSelectedMessageIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else if (next.size < MAX_SELECTED_MESSAGES) {
        next.add(messageId);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    setSelectedMessageIds((current) => {
      const selectableIds = new Set(messages.filter(isMessageSelectableForBundle).map((message) => message.id));
      const next = new Set([...current].filter((messageId) => selectableIds.has(messageId)));
      if (next.size === current.size && [...next].every((messageId) => current.has(messageId))) return current;
      return next;
    });
  }, [messages]);
  const {
    hasActive: hasActiveInvocation,
    activeInvocations,
    catStatuses,
    catInvocations,
    intentMode,
    targetCats,
  } = useThreadLiveness(threadId);
  const activeInvocationIds = useMemo(
    () => collectExactLiveInvocationIds(activeInvocations, catInvocations),
    [activeInvocations, catInvocations],
  );
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
  const exportMessageIds = searchParams?.getAll('messageId') ?? [];
  const [exportThreadTitle, setExportThreadTitle] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!isExport) {
      setExportThreadTitle(undefined);
      return;
    }
    let active = true;
    setExportThreadTitle(undefined);
    loadExportThreadTitle(threadId)
      .then((title) => {
        if (active) setExportThreadTitle(title);
      })
      .catch(() => {
        if (active) setExportThreadTitle(null);
      });
    return () => {
      active = false;
    };
  }, [isExport, threadId]);
  // AC-6: research=multi hint from Signal study "多猫研究" button
  const isResearchMode = searchParams?.get('research') === 'multi';
  const { clearTasks } = useTaskStore();
  const { cats, getCatById, refresh: refreshCats, isLoading, hasFetched } = useCatData();
  const workspaceWorktreeId = useChatStore((s) => s.workspaceWorktreeId);
  useTeleport(); // F227: drive the Hub to a teleport target message (thread:teleport)
  const { isOpen: sidebarOpen, open: openSidebar, close: closeSidebar, toggle: toggleSidebar } = useSidebarStore();
  // F284: Chat is the calm default. Typed workspace/transcript actions still
  // open the contextual shell through the existing rightPanelMode effect.
  // F284 × F120 review P1: panel visibility is canonical per-thread store
  // state (snapshotted in ThreadState), not route-local component state.
  const statusPanelOpen = useChatStore((s) => s.rightPanelOpen);
  const setRightPanelOpen = useChatStore((s) => s.setRightPanelOpen);
  const [workspacePanelMounted, setWorkspacePanelMounted] = useState(rightPanelMode === 'workspace');
  const [activityPanelMounted, setActivityPanelMounted] = useState(false);
  const [showBootcampList, setShowBootcampList] = useState(false);
  const [editingCatId, setEditingCatId] = useState<string | null>(null);
  const editingCat = editingCatId ? (getCatById(editingCatId) ?? null) : null;
  const [coCreatorEditorOpen, setCoCreatorEditorOpen] = useState(false);
  const coCreator = useCoCreatorConfig();
  const [showFirstRunQuestPrompt, setShowFirstRunQuestPrompt] = useState(false);
  const [showQuestWizard, setShowQuestWizard] = useState(false);
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
  // clowder-ai#28: drag-to-resize for right status panel (negative delta = panel wider)
  const handleStatusPanelResize = useCallback(
    (delta: number) => {
      setStatusPanelWidth((prev) => Math.min(480, Math.max(200, prev - delta)));
    },
    [setStatusPanelWidth],
  );

  // F063/F195: auto-open panel when workspace or transcript mode is set
  useEffect(() => {
    if ((rightPanelMode === 'workspace' || rightPanelMode === 'transcript') && !statusPanelOpen) {
      setRightPanelOpen(true);
    }
    if (rightPanelMode === 'workspace') setWorkspacePanelMounted(true);
    if (rightPanelMode === 'status' && statusPanelOpen) setActivityPanelMounted(true);
  }, [rightPanelMode, statusPanelOpen, setRightPanelOpen]);

  // F232 P2（云端 round 5）：显式关闭右侧 panel——先退出 workspace/transcript mode（否则上面的 auto-open
  // effect 立即重开，关不掉），再关闭。所有 close 入口（header toggle / ResizeHandle 折叠）统一走这里。
  // F284 × F120: closeRightPanel 同时退出 mode 并关闭 canonical visibility。
  const closeStatusPanel = useCallback(() => {
    closeRightPanel();
  }, [closeRightPanel]);

  const openStatusPanel = useCallback(() => {
    setActivityPanelMounted(true);
    setRightPanelMode('status');
    setRightPanelOpen(true);
  }, [setRightPanelMode, setRightPanelOpen]);

  const openWorkspaceLauncher = useCallback(() => {
    setWorkspacePanelMounted(true);
    setWorkspaceMode('dev');
    setWorkspaceSurface('home');
    setRightPanelMode('workspace');
    setRightPanelOpen(true);
  }, [setRightPanelMode, setWorkspaceMode, setWorkspaceSurface, setRightPanelOpen]);

  const isDesktop = useIsDesktop();

  useEffect(() => {
    if (isDesktop || !statusPanelOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeStatusPanel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeStatusPanel, isDesktop, statusPanelOpen]);

  // Desktop: open sidebar before first paint (useLayoutEffect avoids false→true flicker).
  useLayoutEffect(() => {
    if (isDesktop) {
      openSidebar();
    }
  }, [isDesktop, openSidebar]);

  const { handleAgentMessage, resetRefs, resetTimeout, clearDoneTimeout } = useAgentMessages();
  const { handleScroll, scrollContainerRef, messagesEndRef, isLoadingHistory, hasMore } = useChatHistory(threadId);
  const { handleSend, uploadStatus, uploadError } = useSendMessage(threadId);
  const {
    pending: authPending,
    respond: authRespond,
    handleAuthRequest,
    handleAuthResponse,
  } = useAuthorization(threadId);

  // F096: Listen for interactive block send events
  // F229 Bug 2 fix: ignore events tagged with sendContext (e.g. 'concierge')
  // to prevent InteractiveBlock clicks in the concierge panel from leaking
  // "确认"/"取消" text as messages to the main thread.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ text: string; sendContext?: string }>).detail;
      if (detail.sendContext) return; // belongs to another panel, not main thread
      if (detail.text) handleSend(detail.text);
    };
    window.addEventListener('cat-cafe:interactive-send', handler);
    return () => window.removeEventListener('cat-cafe:interactive-send', handler);
  }, [handleSend]);

  // F079: Vote modal
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
          addMessageToThread(threadId, {
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
        addMessageToThread(threadId, {
          id: `vote-${Date.now()}`,
          type: 'system',
          variant: 'error',
          content: `发起投票失败: ${err instanceof Error ? err.message : 'Unknown'}`,
          timestamp: Date.now(),
        });
      }
    },
    [threadId, handleSend, setShowVoteModal, addMessageToThread],
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
  const sidebarRows = useSidebarProjectionStore((state) => state.rows);
  const setThreads = useChatStore((s) => s.setThreads);
  const handleSkipFirstRunQuest = useCallback(() => {
    // #707: Persist skip to localStorage so refreshing doesn't re-trigger
    try {
      localStorage.setItem('cat-cafe:first-run-quest-skipped', '1');
    } catch {
      /* localStorage may be unavailable in some contexts */
    }
    setShowFirstRunQuestPrompt(false);
  }, []);
  const handleStartFirstRunQuest = useCallback(() => {
    setShowFirstRunQuestPrompt(false);
    setShowQuestWizard(true);
  }, []);
  const currentBootcampState = storeThreads.find((thread) => thread.id === threadId)?.bootcampState;
  const currentBootcampPhase = currentBootcampState?.phase;
  const showFirstProjectMistakeTip = useFirstProjectMistakeTipGate({
    threadId,
    phase: currentBootcampPhase,
    messageCount: messages.length,
    hasActiveInvocation,
  });
  useFirstProjectPreviewAutoOpen({
    threadId,
    phase: currentBootcampPhase,
    messageCount: messages.length,
    hasActiveInvocation,
    worktreeId: workspaceWorktreeId,
  });
  const mistakeTipAdvanceKeyRef = useRef<string | null>(null);
  const handleMistakeTipVisible = useCallback(() => {
    // Read threads fresh from store to keep callback ref stable (avoids resetting
    // DelayedMistakeTip's 1500ms onVisible timer on every storeThreads change).
    const currentThread = useChatStore.getState().threads.find((thread) => thread.id === threadId);
    const raw = currentThread?.bootcampState;
    if (!raw || raw.phase !== 'phase-7-dev') return;

    const key = `${threadId}:${String(raw.startedAt ?? 'unknown')}:phase-4`;
    if (mistakeTipAdvanceKeyRef.current === key) return;
    const nextBootcampState: NonNullable<Thread['bootcampState']> = {
      ...raw,
      phase: 'phase-7.5-add-teammate',
    };

    void apiFetch(`/api/threads/${threadId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bootcampState: nextBootcampState,
      }),
    }).then((res) => {
      if (res.ok) {
        mistakeTipAdvanceKeyRef.current = key;
        syncLocalBootcampState(threadId, nextBootcampState);
      }
      return res;
    });
  }, [threadId]);
  // When gate fires (invocation ended with new Phase 4 output), advance immediately
  useEffect(() => {
    if (showFirstProjectMistakeTip) {
      handleMistakeTipVisible();
    }
  }, [showFirstProjectMistakeTip, handleMistakeTipVisible]);
  useEffect(() => {
    if (currentBootcampPhase !== 'phase-7-dev') {
      mistakeTipAdvanceKeyRef.current = null;
    }
  }, [currentBootcampPhase, threadId]);
  useEffect(() => {
    // Pure backend-driven: show prompt only when no cats AND no bootcamp thread
    const isCurrentBootcamp = Boolean(storeThreads.find((thread) => thread.id === threadId)?.bootcampState);
    const hasAnyBootcamp = storeThreads.some((t) => t.bootcampState);
    if (isCurrentBootcamp || hasAnyBootcamp || cats.length > 0 || isLoading) {
      setShowFirstRunQuestPrompt(false);
      return;
    }
    // Wait for thread store to populate before deciding — prevents flash on page refresh
    if (storeThreads.length === 0) return;
    // Only show first-run prompt after a successful cat fetch — prevents false
    // positives when /api/cats fails transiently (returns [] on network error).
    if (!hasFetched) return;
    // #707: Don't re-show if user previously skipped
    try {
      if (localStorage.getItem('cat-cafe:first-run-quest-skipped') === '1') return;
    } catch {
      /* localStorage unavailable */
    }
    setShowFirstRunQuestPrompt(true);
  }, [cats.length, isLoading, hasFetched, storeThreads, threadId]);

  // ── Data sync: re-fetch thread state ──
  // MCP callbacks update Redis directly; the companion WebSocket `thread_updated`
  // may not reach this frontend (e.g. worktree port isolation). Re-fetching the
  // thread ensures the store stays in sync.
  const syncThreadState = useCallback(() => {
    apiFetch(`/api/threads/${threadId}`)
      .then((res) =>
        res.ok
          ? (res.json() as Promise<{
              bootcampState?: Thread['bootcampState'];
              firstRunQuestState?: { phase: string; firstCatName?: string };
            }>)
          : null,
      )
      .then((thread) => {
        if (!thread) return;
        const local = useChatStore.getState().threads.find((t) => t.id === threadId);
        if (thread.bootcampState || local?.bootcampState) {
          syncLocalBootcampState(threadId, thread.bootcampState);
        }
        const localQuest = (local as Record<string, unknown> | undefined)?.firstRunQuestState;
        if (thread.firstRunQuestState || localQuest) {
          useChatStore.setState((state) => ({
            threads: state.threads.map((t) =>
              t.id === threadId ? { ...t, firstRunQuestState: thread.firstRunQuestState } : t,
            ),
          }));
        }
      })
      .catch(() => {});
  }, [threadId]);

  // Sync on invocation end (active → inactive transition)
  const prevInvocationRef = useRef(hasActiveInvocation);
  useEffect(() => {
    const wasActive = prevInvocationRef.current;
    prevInvocationRef.current = hasActiveInvocation;
    if (!wasActive || hasActiveInvocation) return;
    syncThreadState();
  }, [hasActiveInvocation, syncThreadState]);

  // Sync on mount / thread switch — sidebar may not have loaded yet
  useEffect(() => {
    syncThreadState();
  }, [syncThreadState]);

  // ── Bootcamp add-teammate: trigger guide engine when user interacts with input ──
  // Subscribe reactively so the effect re-runs when guide exits (session cleared).
  const activeGuideFlowId = useGuideStore((s) => s.session?.flow.id ?? null);
  useEffect(() => {
    if (currentBootcampPhase !== 'phase-7.5-add-teammate') return;
    // Guide already running — don't re-register
    if (activeGuideFlowId === 'bootcamp-add-teammate') return;
    // Prevent re-triggering a guide that already completed for this thread
    if (useGuideStore.getState().completedGuides.has(`${threadId}::bootcamp-add-teammate`)) return;

    const startGuide = () => {
      const { session: s, completedGuides: cg } = useGuideStore.getState();
      if (s?.flow.id === 'bootcamp-add-teammate') return;
      if (cg.has(`${threadId}::bootcamp-add-teammate`)) return;
      useGuideStore.getState().reduceServerEvent({
        action: 'start',
        guideId: 'bootcamp-add-teammate',
        threadId,
      });
    };

    // Wait for user to type in chat input before starting guide
    const handler = (e: Event) => {
      if ((e.target as HTMLElement)?.closest('[data-guide-id="chat.input"]')) {
        startGuide();
        document.removeEventListener('input', handler, true);
      }
    };
    document.addEventListener('input', handler, true);
    return () => {
      document.removeEventListener('input', handler, true);
    };
  }, [currentBootcampPhase, threadId, activeGuideFlowId]);

  // ── Bootcamp farewell: auto-trigger guide after agent finishes at phase-10-retro ──
  // Guard with both hasActiveInvocation AND chatIsLoading:
  // - hasActiveInvocation tracks per-slot presence (can briefly go false during A2A handoff)
  // - chatIsLoading stays true for the entire serial chain (cleared only on isFinal=true)
  const farewellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (farewellTimerRef.current) {
      clearTimeout(farewellTimerRef.current);
      farewellTimerRef.current = null;
    }
    if (currentBootcampPhase !== 'phase-10-retro') return;
    if (hasActiveInvocation || chatIsLoading) return;
    if (activeGuideFlowId === 'bootcamp-farewell') return;
    if (useGuideStore.getState().completedGuides.has(`${threadId}::bootcamp-farewell`)) return;

    farewellTimerRef.current = setTimeout(() => {
      farewellTimerRef.current = null;
      const s = useChatStore.getState();
      if (s.hasActiveInvocation || s.isLoading) return;
      useGuideStore.getState().reduceServerEvent({
        action: 'start',
        guideId: 'bootcamp-farewell',
        threadId,
      });
    }, 800);
    return () => {
      if (farewellTimerRef.current) {
        clearTimeout(farewellTimerRef.current);
        farewellTimerRef.current = null;
      }
    };
  }, [currentBootcampPhase, threadId, activeGuideFlowId, hasActiveInvocation, chatIsLoading]);

  const prevThreadRef = useRef(threadId);
  useEffect(() => {
    if (prevThreadRef.current !== threadId) {
      // Thread switch: store saves/restores per-thread state automatically
      setCurrentThread(threadId);
      clearMessageSelection();
      // F173 A.12 — resetRefs no longer touches suppression markers (invocation-driven cleanup).
      // It still clears activeRefs / finalizedStreamRef / sawStreamData per the original purpose.
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
    clearMessageSelection,
    clearTasks, // Clean up non-thread-scoped refs
    resetRefs, // First mount — sync threadId to store without save/restore
    setCurrentThread,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    hydrateInvocationTrajectoryFromCurrentUrl();
  }, []);

  // Restore projectPath from the canonical Sidebar projection; the legacy store
  // remains only as a compatibility fallback for non-Sidebar flows.
  useEffect(() => {
    const cached = sidebarRows.find((row) => row.id === threadId) ?? storeThreads?.find((t) => t.id === threadId);
    if (cached) {
      setCurrentProject(cached.projectPath || 'default');
    }
  }, [threadId, sidebarRows, storeThreads, setCurrentProject]);

  // F113-E: Fetch governance status for the current project (drives ProjectSetupCard)
  const currentProjectPath = useChatStore((s) => s.currentProjectPath);
  const { status: govStatus, refetch: govRefetch } = useGovernanceStatus(currentProjectPath);
  const isProjectThread = !!currentProjectPath && currentProjectPath !== 'default' && currentProjectPath !== 'lobby';
  const agentHookHealth = useAgentHookHealth({ enabled: isProjectThread, projectPath: currentProjectPath });
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
  const showAgentHookNotice =
    isProjectThread &&
    !showSetupCard &&
    shouldRenderAgentHookHealthNotice({
      health: agentHookHealth.health,
      error: agentHookHealth.error,
      syncing: agentHookHealth.syncing,
      synced: agentHookHealth.synced,
      syncAttempted: agentHookHealth.syncAttempted,
    });

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
  const splitPaneThreadIds = useChatStore((s) => s.splitPaneThreadIds);
  const socketThreadIds = useMemo(
    () =>
      viewMode === 'split' && splitPaneThreadIds.length > 0
        ? [...new Set([...splitPaneThreadIds, threadId])]
        : [threadId],
    [viewMode, splitPaneThreadIds, threadId],
  );
  const { socketConnected } = useSocket(socketCallbacks, threadId, socketThreadIds);
  useActiveExecutionProjection(threadId, socketConnected);
  const connectionStatus = useConnectionStatus(socketConnected);
  const hasProjectedExecution = useActiveExecutionStore((state) => Object.keys(state.executionsByKey).length > 0);

  const handleEditCat = useCallback((catId: string) => setEditingCatId(catId), []);
  const handleEditCoCreator = useCallback(() => setCoCreatorEditorOpen(true), []);
  // F212 follow-up — UI-layer dedup for adjacent identical CliDiagnostics panels.
  // Compute once per messages change; map is keyed by messageId.
  const cliDedupMap = useMemo(() => computeCliDiagnosticsDedup(messages), [messages]);
  const timelineProjectionKey = useMemo(() => buildChatTimelineProjectionKey(messages), [messages]);
  // Keep the previous message-array identity while only stream text/tool events
  // change. Cross-message projections do not consume those fields.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the projection key intentionally represents the consumed message fields
  const timelineProjectionMessages = useMemo(
    () => messages,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timelineProjectionKey],
  );
  const renderSingleMessage = useCallback(
    (msg: ChatMessageData, index: number) => {
      const dedupInfo = cliDedupMap.get(msg.id);
      const selected = selectedMessageIds.has(msg.id);
      const mountPolicy = messageMountPolicy(index, messages.length);
      const selectionEligible =
        isMessageSelectableForBundle(msg) &&
        (!selectionMode || selected || selectedMessageIds.size < MAX_SELECTED_MESSAGES);
      return (
        <ChatMessageRow
          key={msg.id}
          message={msg}
          threadId={threadId}
          timelineMessages={timelineProjectionMessages}
          activeInvocationIds={msg.extra?.queueReceipt ? activeInvocationIds : undefined}
          getCatById={getCatById}
          onEditCat={handleEditCat}
          onEditCoCreator={handleEditCoCreator}
          hideDiagnosticsPanel={dedupInfo?.hideDiagnosticsPanel}
          dedupCount={dedupInfo?.dedupCount}
          selectionMode={selectionMode}
          selected={selected}
          selectionEligible={selectionEligible}
          onEnterSelection={enterMessageSelection}
          onToggleSelection={toggleMessageSelection}
          forwardingDisabled={connectionStatus.forwardingBlocked}
          eager={mountPolicy.eager}
          backgroundMountDelayMs={mountPolicy.backgroundMountDelayMs}
        />
      );
    },
    [
      threadId,
      messages.length,
      activeInvocationIds,
      getCatById,
      handleEditCat,
      handleEditCoCreator,
      cliDedupMap,
      timelineProjectionMessages,
      enterMessageSelection,
      selectedMessageIds,
      selectionMode,
      toggleMessageSelection,
      connectionStatus.forwardingBlocked,
    ],
  );

  const pendingInvocations = useMemo(
    () => (hasActiveInvocation ? derivePendingMemberInvocations(activeInvocations, messages, threadId) : []),
    [hasActiveInvocation, activeInvocations, messages, threadId],
  );
  const pendingTipContexts = useMemo<readonly CapabilityTipContext[]>(
    () => getStreamingTipContexts(intentMode),
    [intentMode],
  );
  const [, bumpPendingTipLiveness] = useState(0);
  useEffect(() => {
    const now = Date.now();
    const futureDeadlines = new Set<number>();
    for (const invocation of pendingInvocations) {
      const deadline = getSilentActiveTurnDeadline(catInvocations[invocation.catId]?.appServerLifecycle);
      if (deadline !== null && deadline > now) futureDeadlines.add(deadline);
    }
    if (futureDeadlines.size === 0) return;

    const timers = [...futureDeadlines].map((deadline) =>
      window.setTimeout(() => bumpPendingTipLiveness((epoch) => epoch + 1), Math.max(1, deadline - now + 1)),
    );
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [pendingInvocations, catInvocations]);
  const pendingTipInvocationId =
    pendingInvocations.find(
      (invocation) =>
        !isStreamingTipSuppressed(catStatuses[invocation.catId], catInvocations[invocation.catId]?.appServerLifecycle),
    )?.invocationId ?? null;

  useVoiceAutoPlay();
  useVoiceStream();
  useVadInterrupt();

  useSplitPaneKeys();
  const setSplitPaneThreadIds = useChatStore((s) => s.setSplitPaneThreadIds);
  const setSplitPaneTarget = useChatStore((s) => s.setSplitPaneTarget);

  useEffect(() => {
    if (viewMode === 'split' && splitPaneThreadIds.length === 0 && threadId !== 'default') {
      setSplitPaneThreadIds([threadId]);
      setSplitPaneTarget(threadId);
    }
  }, [viewMode, splitPaneThreadIds.length, threadId, setSplitPaneThreadIds, setSplitPaneTarget]);

  useEffect(() => {
    clearUnread(threadId);
  }, [threadId, clearUnread]);

  useEffect(() => {
    const syncVisibility = () => setDocumentVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', syncVisibility);
    return () => document.removeEventListener('visibilitychange', syncVisibility);
  }, []);

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
  // Fires on visible thread entry, new bubbles, and queued -> delivered
  // transitions. A mutable stream keeps one bubble, so message count alone
  // cannot observe its final delivery boundary.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _messageCount = messages.length;
  const _deliveredMessageCount = messages.reduce(
    (count, message) => count + (message.deliveredAt === undefined ? 0 : 1),
    0,
  );
  useEffect(() => {
    if (!documentVisible) return;
    armUnreadSuppression(threadId);
    apiFetch(`/api/threads/${encodeURIComponent(threadId)}/read/latest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
      .then(async (res) => {
        if (!res.ok) {
          settleUnreadAck(threadId, false);
          useSidebarProjectionStore.getState().clearSidebarCommand(threadId, 'attention');
          return;
        }
        const payload = (await res.json()) as { caughtUp?: unknown };
        const caughtUp = payload.caughtUp === true;
        settleUnreadAck(threadId, caughtUp);
        if (!caughtUp) useSidebarProjectionStore.getState().clearSidebarCommand(threadId, 'attention');
        void invalidateSidebarProjection();
      })
      .catch((err) => {
        settleUnreadAck(threadId, false);
        useSidebarProjectionStore.getState().clearSidebarCommand(threadId, 'attention');
        console.debug('[F069] read ack failed:', err);
      });
  }, [threadId, _messageCount, _deliveredMessageCount, documentVisible, settleUnreadAck, armUnreadSuppression]);

  const handleZoomToThread = useCallback(
    (tid: string) => {
      setViewMode('single');
      navigateToThread(tid);
    },
    [setViewMode, navigateToThread],
  );

  const handleQuestCreated = useCallback(
    async (questThreadId: string) => {
      setShowQuestWizard(false);
      try {
        const res = await apiFetch('/api/threads');
        if (res.ok) {
          const data = (await res.json()) as { threads: Thread[] };
          setThreads(data.threads);
        }
      } catch {
        // Ignore refresh errors — navigation is the priority
      }
      void invalidateSidebarProjection();
      navigateToThread(questThreadId);
    },
    [navigateToThread, setThreads],
  );

  const handleSearchKnowledge = useCallback(() => {
    const fromParam = threadId ? `?from=${encodeURIComponent(threadId)}` : '';
    assignDocumentRoute(`/memory/search${fromParam}`, typeof window !== 'undefined' ? window : undefined);
  }, [threadId]);

  const handleGoToMemoryHub = useCallback(() => {
    const fromParam = threadId ? `?from=${encodeURIComponent(threadId)}` : '';
    assignDocumentRoute(`/memory${fromParam}`, typeof window !== 'undefined' ? window : undefined);
  }, [threadId]);

  if (viewMode === 'split') {
    return (
      <>
        {connectionStatus.updateRequired && <RuntimeUpdateRequiredDialog onReload={() => window.location.reload()} />}
        <SplitPaneView
          isReadonly={connectionStatus.isReadonly}
          onSend={handleSend}
          uploadStatus={uploadStatus}
          uploadError={uploadError}
          onZoomToThread={handleZoomToThread}
        />
      </>
    );
  }

  // Export mode: print-friendly layout — no sidebars, no scroll containers.
  // data-export-ready signals to Puppeteer that messages + cat data are fully loaded and rendered.
  if (isExport) {
    const exportSelection = selectMessagesForExport(messages, exportMessageIds);
    const exportReady = !isLoadingHistory && !isLoading && exportSelection.ready && exportThreadTitle !== undefined;
    return (
      <div
        className="bg-[var(--console-shell-bg)]"
        data-export-root
        {...(exportReady ? { 'data-export-ready': 'true' } : {})}
        data-export-message-count={exportSelection.messages.length}
      >
        <div className="max-w-4xl mx-auto p-4">
          <header className="mb-4 border-b border-cafe-divider pb-3">
            <h1 className="text-lg font-semibold text-cafe-primary">{exportThreadTitle ?? '未命名对话'}</h1>
            <p className="mt-1 text-xs text-cafe-muted">来源 Thread: {threadId}</p>
          </header>
          {exportSelection.messages.map((msg) => {
            const dedupInfo = cliDedupMap.get(msg.id);
            return (
              <ChatMessage
                key={msg.id}
                message={msg}
                threadId={threadId}
                activeInvocationIds={activeInvocationIds}
                getCatById={getCatById}
                onEditCat={handleEditCat}
                onEditCoCreator={handleEditCoCreator}
                hideDiagnosticsPanel={dedupInfo?.hideDiagnosticsPanel}
                dedupCount={dedupInfo?.dedupCount}
                forwardingDisabled
              />
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex h-screen h-dvh">
      {connectionStatus.updateRequired && <RuntimeUpdateRequiredDialog onReload={() => window.location.reload()} />}
      {/* Mobile-only sidebar overlay — desktop sidebar is in AppShell */}
      {sidebarOpen && !isDesktop && (
        <>
          <div
            className="fixed inset-0 bg-[var(--console-overlay-backdrop)] backdrop-blur-sm z-20"
            onClick={closeSidebar}
            aria-hidden="true"
          />
          <div className="fixed inset-y-0 left-0 z-30 w-[240px]">
            <ThreadSidebar onClose={closeSidebar} className="w-full" routeThreadId={threadId} />
          </div>
        </>
      )}

      <div
        className="flex flex-col min-w-0"
        style={
          statusPanelOpen && isDesktop && (rightPanelMode === 'workspace' || rightPanelMode === 'transcript')
            ? { flexBasis: `${chatBasis}%`, flexGrow: 0, flexShrink: 0 }
            : { flex: '1 1 0%' }
        }
      >
        <ChatContainerHeader
          sidebarOpen={sidebarOpen}
          onToggleSidebar={toggleSidebar}
          threadId={threadId}
          authPendingCount={authPending.length}
          viewMode={viewMode}
          onToggleViewMode={() => setViewMode(viewMode === 'single' ? 'split' : 'single')}
          statusPanelOpen={statusPanelOpen && rightPanelMode === 'workspace'}
          hasWorkspaceActivity={hasProjectedExecution || workspaceSurface !== 'home' || presentationLock !== null}
          onToggleStatusPanel={() => {
            if (statusPanelOpen && rightPanelMode === 'workspace') {
              closeStatusPanel();
            } else {
              setWorkspacePanelMounted(true);
              setRightPanelMode('workspace');
              setRightPanelOpen(true);
            }
          }}
        />

        {intentMode === 'ideate' && <ParallelStatusBar threadId={threadId} />}
        <ThinkingIndicator threadId={threadId} />

        <div className="flex-1 relative overflow-hidden">
          <main
            ref={scrollContainerRef}
            onScroll={handleScroll}
            className="h-full overflow-y-auto p-4"
            data-guide-id="bootcamp.preview-result"
            data-bootcamp-host="chat-messages"
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
            {showAgentHookNotice && (
              <div className="mb-3 flex justify-center text-left">
                <div className="max-w-[85%] w-full">
                  <AgentHookHealthNotice
                    health={agentHookHealth.health}
                    error={agentHookHealth.error}
                    syncing={agentHookHealth.syncing}
                    synced={agentHookHealth.synced}
                    syncAttempted={agentHookHealth.syncAttempted}
                    onSync={agentHookHealth.sync}
                  />
                </div>
              </div>
            )}
            {!hasMore && messages.length > 0 && (
              <div className="text-center py-3 text-xs text-cafe-muted">没有更多消息了</div>
            )}
            {messages.length === 0 && !isLoadingHistory ? (
              <div className="text-center mt-20">
                <PawIcon className="w-12 h-12 text-cafe-muted mx-auto mb-4" />
                <p className="text-lg text-cafe-secondary mb-1">欢迎来到 Clowder AI!</p>
                <p className="text-sm text-cafe-muted" suppressHydrationWarning>
                  {cats.length > 0 ? '输入 @布偶 召唤布偶猫开始聊天' : '还没有可用成员，先开始新手教程创建第一只猫猫'}
                </p>
                {showSetupCard && govStatus && (
                  <div className="mt-6 text-left">
                    <ProjectSetupCard
                      key={threadId}
                      projectPath={currentProjectPath}
                      isEmptyDir={govStatus.isEmptyDir}
                      isGitRepo={govStatus.isGitRepo}
                      gitAvailable={govStatus.gitAvailable}
                      agentHookHealth={agentHookHealth.health}
                      agentHookHealthError={agentHookHealth.error}
                      agentHookSyncing={agentHookHealth.syncing}
                      agentHookSynced={agentHookHealth.synced}
                      agentHookSyncAttempted={agentHookHealth.syncAttempted}
                      onSyncAgentHooks={agentHookHealth.sync}
                      onComplete={() => {
                        setSetupDone(true);
                        govRefetch();
                        void agentHookHealth.refresh();
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
                        className="mt-6 inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-cafe-accent/20 bg-accent-50 text-cafe-accent hover:bg-accent-100 transition-colors text-sm font-medium"
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
                      className="mt-6 inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-cafe-accent/20 bg-accent-50 text-cafe-accent hover:bg-accent-100 transition-colors text-sm font-medium"
                      data-testid="empty-state-bootcamp"
                    >
                      <BootcampIcon className="w-4 h-4" />
                      第一次来？开始猫猫训练营
                    </button>
                  );
                })()}
              </div>
            ) : (
              <>
                {messages.map(renderSingleMessage)}
                {pendingInvocations.map((invocation) => (
                  <PendingMemberBubble
                    key={`pending-${invocation.invocationId}`}
                    catId={invocation.catId}
                    invocationId={invocation.invocationId}
                    catStatus={catStatuses[invocation.catId]}
                    appServerLifecycle={catInvocations[invocation.catId]?.appServerLifecycle}
                    tipContexts={pendingTipContexts}
                    showCapabilityTip={invocation.invocationId === pendingTipInvocationId}
                  />
                ))}
              </>
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
            <div className="border-t border-conn-amber-ring bg-conn-amber-bg/40 py-2">
              {authPending.map((req) => (
                <AuthorizationCard key={req.requestId} request={req} onRespond={authRespond} />
              ))}
            </div>
          )}

          <ThreadExecutionBar threadId={threadId} />
          <QueuePanel threadId={threadId} />
          <VoteActiveBar threadId={threadId} onEnd={() => {}} />

          {!showFirstRunQuestPrompt &&
            !showQuestWizard &&
            (() => {
              const currentThread = storeThreads.find((t) => t.id === threadId);
              const questState = (currentThread as Record<string, unknown> | undefined)?.firstRunQuestState as
                | { phase: string; firstCatName?: string }
                | undefined;
              if (!questState) return null;
              return (
                <QuestBanner
                  phase={questState.phase}
                  firstCatName={questState.firstCatName}
                  onAddSecondCat={() => setShowQuestWizard(true)}
                  onStartBootcamp={() => setShowBootcampList(true)}
                  onComplete={() => assignDocumentRoute('/hub', typeof window !== 'undefined' ? window : undefined)}
                />
              );
            })()}

          {isResearchMode && (
            <div className="mx-4 mb-2 rounded-lg border border-[var(--semantic-success)] bg-[var(--semantic-success-surface)] px-3 py-2 text-xs text-conn-emerald-text">
              多猫研究模式 — 文章上下文已注入。请输入研究问题，猫猫会自动调用 multi_mention 邀请其他猫参与分析。
            </div>
          )}
          {selectionMode ? (
            <MessageSelectionToolbar
              threadId={threadId}
              selectedMessageIds={normalizedSelectedMessageIds}
              onCancel={clearMessageSelection}
              onExportSuccess={clearMessageSelection}
              forwardingDisabled={connectionStatus.forwardingBlocked}
              onForward={() => setSelectionForwardOpen(true)}
            />
          ) : (
            <div
              className={(() => {
                if (showFirstRunQuestPrompt || showQuestWizard) return '';
                const ct = storeThreads.find((t) => t.id === threadId);
                // Bootcamp phase-1 with no messages: highlight + punch through overlay
                const bs = ct?.bootcampState as { phase: string } | undefined;
                if (bs?.phase === 'phase-1-intro' && messages.length === 0) {
                  return 'relative z-[70] quest-input-highlight rounded-xl mx-1';
                }
                // Legacy quest support
                const qs = (ct as Record<string, unknown> | undefined)?.firstRunQuestState as
                  | { phase: string }
                  | undefined;
                return qs?.phase === 'quest-2-cat-intro' ? 'quest-input-highlight rounded-xl mx-1' : '';
              })()}
            >
              <ChatInput
                key={threadId}
                threadId={threadId}
                onSend={(content, images, whisper, deliveryMode, replyToId, messageDisposition, contextAttachments) =>
                  handleSend(
                    content,
                    images,
                    undefined,
                    whisper,
                    deliveryMode,
                    replyToId,
                    messageDisposition,
                    contextAttachments,
                  )
                }
                disabled={connectionStatus.isReadonly}
                hasActiveInvocation={hasActiveInvocation}
                uploadStatus={uploadStatus}
                uploadError={uploadError}
              />
            </div>
          )}

          {/* F101: "Return to game" banner when overlay is minimized */}
          {isGameActive && overlayMinimized && gameView?.threadId === threadId && (
            <button
              onClick={() => useGameStore.getState().restoreOverlay()}
              className="mx-4 mb-2 flex items-center justify-center gap-2 rounded-lg border border-[var(--color-cafe-accent)] bg-[var(--accent-50)] px-3 py-2 text-sm text-[var(--color-cafe-accent)] hover:bg-[var(--color-cocreator-surface)] transition-colors"
            >
              🎮 返回游戏
            </button>
          )}
          <TransferTargetPicker
            open={selectionForwardOpen && !connectionStatus.forwardingBlocked}
            admissionBlocked={connectionStatus.forwardingBlocked}
            sourceThreadId={threadId}
            items={selectedBundleItems}
            onClose={() => setSelectionForwardOpen(false)}
            onSuccess={clearMessageSelection}
          />
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

      {/* F284: visited Workspace/Activity panels stay mounted across fold and sibling-host switches.
          At 768px+ they use the split host; below 768px the same host becomes a full-screen overlay. */}
      {statusPanelOpen &&
        isDesktop &&
        (rightPanelMode === 'status' ? (
          <ResizeHandle
            direction="horizontal"
            label="右侧面板"
            onResize={handleStatusPanelResize}
            onCollapse={closeStatusPanel}
            onDoubleClick={resetStatusPanelWidth}
          />
        ) : (
          <ResizeHandle
            direction="horizontal"
            label="右侧面板"
            onResize={handleHorizontalResize}
            onCollapse={closeStatusPanel}
            onDoubleClick={resetChatBasis}
          />
        ))}
      {(statusPanelOpen || workspacePanelMounted || activityPanelMounted) && (
        <div
          className={
            !statusPanelOpen || (!isDesktop && rightPanelMode === 'workspace' && workspaceMode === 'approval')
              ? 'hidden'
              : isDesktop
                ? 'flex min-h-0 flex-col overflow-hidden'
                : 'fixed inset-0 z-50 flex min-h-0 flex-col overflow-hidden bg-[var(--console-panel-bg)]'
          }
          style={
            statusPanelOpen && isDesktop
              ? rightPanelMode === 'status'
                ? { width: statusPanelWidth, flexShrink: 0 }
                : { flex: '1 1 0%', minWidth: 0 }
              : undefined
          }
          role="region"
          aria-label="上下文侧栏"
          aria-hidden={!statusPanelOpen}
          data-testid="contextual-workspace-host"
        >
          <ContextualWorkspaceChrome
            mode={rightPanelMode}
            onFold={closeStatusPanel}
            onNavigateHome={rightPanelMode === 'workspace' ? undefined : openWorkspaceLauncher}
          >
            {activityPanelMounted && (
              <div className={rightPanelMode === 'status' ? 'flex min-h-0 flex-1' : 'hidden'}>
                <RightStatusPanel
                  intentMode={intentMode}
                  targetCats={targetCats}
                  catStatuses={catStatuses}
                  catInvocations={catInvocations}
                  activeInvocations={activeInvocations}
                  hasActiveInvocation={hasActiveInvocation}
                  threadId={threadId}
                  messageSummary={messageSummary}
                  width={isDesktop ? statusPanelWidth : '100%'}
                />
              </div>
            )}
            {workspacePanelMounted && (
              <div
                className={rightPanelMode === 'workspace' ? 'flex min-h-0 min-w-0 flex-1' : 'hidden'}
                data-testid="workspace-host-pane"
              >
                <WorkspacePanel
                  threadId={threadId}
                  defaultCatId={targetCats[0] || 'opus'}
                  onOpenStatus={openStatusPanel}
                />
              </div>
            )}
            {rightPanelMode === 'transcript' && statusPanelOpen && <TranscriptPanel />}
          </ContextualWorkspaceChrome>
        </div>
      )}
      <FloatingTranscriptContainer />
      <MobileApprovalSheet
        open={!isDesktop && rightPanelMode === 'workspace' && workspaceMode === 'approval'}
        onClose={closeStatusPanel}
      />
      {showFirstRunQuestPrompt &&
        createPortal(
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-[var(--console-overlay-medium)] px-4 backdrop-blur-sm">
            <div
              className="w-full max-w-md rounded-2xl border border-conn-amber-ring bg-[var(--console-card-bg)] p-6 shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <h3 className="text-lg font-semibold text-cafe">开始猫猫新手教程？</h3>
              <p className="mt-2 text-sm text-cafe-secondary">
                当前还没有可用成员。我们可以先带你创建第一只猫猫，再开始首个协作任务。
              </p>
              <div className="mt-5 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={handleSkipFirstRunQuest}
                  className="rounded-lg border border-[var(--console-border-soft)] px-3 py-2 text-sm text-cafe-secondary hover:bg-[var(--console-hover-bg)]"
                >
                  跳过
                </button>
                <button
                  type="button"
                  onClick={handleStartFirstRunQuest}
                  className="rounded-lg bg-cafe-accent px-3 py-2 text-sm font-medium text-[var(--cafe-surface)] hover:opacity-90"
                >
                  开始教程
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
      <FirstRunQuestWizard
        open={showQuestWizard}
        onClose={() => setShowQuestWizard(false)}
        onCreated={handleQuestCreated}
      />
      <BootcampListModal open={showBootcampList} onClose={handleBootcampModalClose} currentThreadId={threadId} />
      {showVoteModal && <VoteConfigModal onSubmit={handleVoteSubmit} onCancel={() => setShowVoteModal(false)} />}
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
      {/* Bootcamp guide overlay: intro phase tips + lifecycle tips (phase-7.5 uses guide engine) */}
      {(() => {
        if (showFirstRunQuestPrompt || showQuestWizard) return null;
        const bt = storeThreads.find((t) => t.id === threadId);
        const raw = bt?.bootcampState;
        if (!raw) return null;
        const phase = raw.phase;
        // Guide engine handles phase-7.5 and phase-10 — no custom overlay needed
        if (phase === 'phase-7.5-add-teammate' || phase === 'phase-10-retro') return null;
        const isLifecyclePhase = /^phase-(5|6|7|8|9|10|11)-/.test(phase);
        if (!isLifecyclePhase && messages.length > 0) return null;
        const leadCat = cats.find((c) => c.id === raw.leadCat) ?? cats[0];
        const catName = leadCat ? formatCatName(leadCat) : undefined;
        if (!catName) return null;
        return <BootcampGuideOverlay phase={phase} catName={catName} hasMessages={messages.length > 0} />;
      })()}
    </div>
  );
}
