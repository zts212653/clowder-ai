'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { useActiveExecutionProjection } from '@/hooks/useActiveExecutionProjection';
import { useAgentHookHealth } from '@/hooks/useAgentHookHealth';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import { useConnectionStatus } from '@/hooks/useConnectionStatus';
import { godAction, submitAction } from '@/hooks/useGameApi';
import { reconnectGame } from '@/hooks/useGameReconnect';
import { useGovernanceStatus } from '@/hooks/useGovernanceStatus';
import { useIndexState } from '@/hooks/useIndexState';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { usePersistedState } from '@/hooks/usePersistedState';
import { useSplitPaneKeys } from '@/hooks/useSplitPaneKeys';
import { useTeleport } from '@/hooks/useTeleport';
import { useThreadLiveness, useThreadMessages } from '@/hooks/useThreadScopedSelectors';
import { useVadInterrupt } from '@/hooks/useVadInterrupt';
import { useVoiceAutoPlay } from '@/hooks/useVoiceAutoPlay';
import { useVoiceStream } from '@/hooks/useVoiceStream';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { type ChatMessage, type Thread, useChatStore } from '@/stores/chatStore';
import { useGameStore } from '@/stores/gameStore';
import { useGuideStore } from '@/stores/guideStore';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { useSidebarStore } from '@/stores/sidebarStore';
import { useTaskStore } from '@/stores/taskStore';
import { apiFetch } from '@/utils/api-client';
import { invalidateSidebarProjection } from '@/utils/sidebar-thread-snapshot';
import { AgentHookHealthNotice, shouldRenderAgentHookHealthNotice } from './AgentHookHealthNotice';
import { BootcampListModal } from './BootcampListModal';
import { BootstrapOrchestrator } from './BootstrapOrchestrator';
import { ChatContainerHeader } from './ChatContainerHeader';
import { useConciergeConfirmations } from './concierge/useConciergeConfirmations';
import { FirstRunQuestWizard } from './FirstRunQuestWizard';
import { BootcampGuideOverlay } from './first-run-quest/BootcampGuideOverlay';
import { QuestBanner } from './first-run-quest/QuestBanner';
import { syncLocalBootcampState } from './first-run-quest/syncLocalBootcampState';
import { useFirstProjectMistakeTipGate } from './first-run-quest/useFirstProjectMistakeTipGate';
import { useFirstProjectPreviewAutoOpen } from './first-run-quest/useFirstProjectPreviewAutoOpen';
import { GameOverlayConnector } from './game/GameOverlayConnector';
import { BootcampIcon } from './icons/BootcampIcon';
import { GameIcon } from './icons/GameIcon';
import { PawIcon } from './icons/PawIcon';
import { MobileApprovalSheet } from './MobileApprovalSheet';
import { ParallelStatusBar } from './ParallelStatusBar';
import { ProjectSetupCard } from './ProjectSetupCard';
import { RightStatusPanel } from './RightStatusPanel';
import { RuntimeUpdateRequiredDialog } from './RuntimeUpdateRequiredDialog';
import { SplitPaneChatView } from './SplitPaneView';
import { ThinkingIndicator } from './ThinkingIndicator';
import { ThreadSidebar } from './ThreadSidebar';
import { assignDocumentRoute, pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';
import { ThreadChatExport, ThreadChatSurface, useThreadChatRuntime } from './thread-chat';
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

function hasConciergeConfirmationActions(messages: readonly ChatMessage[]): boolean {
  return messages.some((message) =>
    message.extra?.rich?.blocks.some(
      (block) =>
        block.kind === 'card' &&
        block.actions?.some(
          (action) => action.action === 'concierge_triage_confirm' || action.action === 'concierge_triage_cancel',
        ),
    ),
  );
}

export function ChatContainer({ threadId }: ChatContainerProps) {
  const searchParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  if (searchParams?.get('export') === 'true') {
    return <ThreadChatExport threadId={threadId} messageIds={searchParams.getAll('messageId')} />;
  }
  return <InteractiveChatContainer threadId={threadId} />;
}

function InteractiveChatContainer({ threadId }: ChatContainerProps) {
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
  const messages = allMessages;
  const needsConciergeConfirmations = useMemo(() => hasConciergeConfirmationActions(messages), [messages]);
  const { confirmations: messageConfirmations } = useConciergeConfirmations(needsConciergeConfirmations);
  const [documentVisible, setDocumentVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible',
  );
  const {
    hasActive: hasActiveInvocation,
    activeInvocations,
    catStatuses,
    catInvocations,
    intentMode,
    targetCats,
  } = useThreadLiveness(threadId);
  const navigateToThread = useCallback((tid: string) => {
    pushThreadRouteWithHistory(tid, typeof window !== 'undefined' ? window : undefined);
  }, []);
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

  const searchParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  // AC-6: research=multi hint from Signal study "多猫研究" button
  const isResearchMode = searchParams?.get('research') === 'multi';
  const { clearTasks } = useTaskStore();
  const { cats, isLoading, hasFetched } = useCatData();
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

  const splitPaneThreadIds = useChatStore((s) => s.splitPaneThreadIds);
  const runtimeThreadIds = useMemo(
    () =>
      viewMode === 'split' && splitPaneThreadIds.length > 0
        ? [...new Set([...splitPaneThreadIds, threadId])]
        : [threadId],
    [viewMode, splitPaneThreadIds, threadId],
  );
  const { socketConnected, resetAgentMessageRefs, registerIndexEventHandler } = useThreadChatRuntime(runtimeThreadIds);
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
        window.dispatchEvent(
          new CustomEvent('cat-cafe:interactive-send', {
            detail: { text: notifyMsg, targetThreadId: threadId },
          }),
        );
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
    [threadId, setShowVoteModal, addMessageToThread],
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
      // F173 A.12 — resetRefs no longer touches suppression markers (invocation-driven cleanup).
      // It still clears activeRefs / finalizedStreamRef / sawStreamData per the original purpose.
      resetAgentMessageRefs();
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
    resetAgentMessageRefs, // First mount — sync threadId to store without save/restore
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

  // F302: read project facts; governance is never a readiness gate.
  const currentProjectPath = useChatStore((s) => s.currentProjectPath);
  const { status: govStatus, refetch: govRefetch } = useGovernanceStatus(currentProjectPath);
  const isProjectThread = !!currentProjectPath && currentProjectPath !== 'default' && currentProjectPath !== 'lobby';
  const agentHookHealth = useAgentHookHealth({ enabled: isProjectThread, projectPath: currentProjectPath });
  const [setupDone, setSetupDone] = useState(false);
  // Only blank repos get the automatic setup offer. Existing repos stay zero-write and quiet.
  const showSetupCard = !!((govStatus?.isEmptyDir || setupDone) && messages.length === 0);
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

  useEffect(
    () => registerIndexEventHandler(handleIndexSocketEvent),
    [handleIndexSocketEvent, registerIndexEventHandler],
  );
  useActiveExecutionProjection(threadId, socketConnected);
  const connectionStatus = useConnectionStatus(socketConnected);
  const hasProjectedExecution = useActiveExecutionStore((state) => Object.keys(state.executionsByKey).length > 0);

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
        <SplitPaneChatView isReadonly={connectionStatus.isReadonly} onZoomToThread={handleZoomToThread} />
      </>
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

        <ThreadChatSurface
          threadId={threadId}
          density="full"
          messageConfirmations={messageConfirmations}
          acceptUnscopedInteractiveSend
          footerRef={attachBottomChromeRef}
          timelineLead={
            showAgentHookNotice ? (
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
            ) : undefined
          }
          emptyState={
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
                      governanceDone={setupDone}
                      onStartBootstrap={startBootstrap}
                      onSnooze={snoozeBootstrap}
                      onSearchKnowledge={handleSearchKnowledge}
                      onGoToMemoryHub={handleGoToMemoryHub}
                    />
                  </div>
                )}
              {(() => {
                const isCurrentBootcamp = storeThreads.find((thread) => thread.id === threadId)?.bootcampState;
                if (isCurrentBootcamp) return null;
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
          }
          footerLead={
            <>
              {!showFirstRunQuestPrompt &&
                !showQuestWizard &&
                (() => {
                  const currentThread = storeThreads.find((thread) => thread.id === threadId);
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
            </>
          }
          composerClassName={(() => {
            if (showFirstRunQuestPrompt || showQuestWizard) return '';
            const currentThread = storeThreads.find((thread) => thread.id === threadId);
            const bootcampState = currentThread?.bootcampState as { phase: string } | undefined;
            if (bootcampState?.phase === 'phase-1-intro' && messages.length === 0) {
              return 'relative z-[70] quest-input-highlight rounded-xl mx-1';
            }
            const questState = (currentThread as Record<string, unknown> | undefined)?.firstRunQuestState as
              | { phase: string }
              | undefined;
            return questState?.phase === 'quest-2-cat-intro' ? 'quest-input-highlight rounded-xl mx-1' : '';
          })()}
          footerTail={
            isGameActive && overlayMinimized && gameView?.threadId === threadId ? (
              <button
                type="button"
                onClick={() => useGameStore.getState().restoreOverlay()}
                className="mx-4 mb-2 flex items-center justify-center gap-2 rounded-lg border border-[var(--color-cafe-accent)] bg-[var(--accent-50)] px-3 py-2 text-sm text-[var(--color-cafe-accent)] hover:bg-[var(--color-cocreator-surface)] transition-colors"
              >
                <GameIcon />
                返回游戏
              </button>
            ) : undefined
          }
        />

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
                  statusSurface={
                    <RightStatusPanel
                      intentMode={intentMode}
                      targetCats={targetCats}
                      catStatuses={catStatuses}
                      catInvocations={catInvocations}
                      activeInvocations={activeInvocations}
                      hasActiveInvocation={hasActiveInvocation}
                      threadId={threadId}
                      messageSummary={messageSummary}
                      width="100%"
                    />
                  }
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
