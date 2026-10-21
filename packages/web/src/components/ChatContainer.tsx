'use client';

import Link from 'next/link';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useActiveExecutionProjection } from '@/hooks/useActiveExecutionProjection';
import { useAgentHookHealth } from '@/hooks/useAgentHookHealth';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { useConnectionStatus } from '@/hooks/useConnectionStatus';
import { useConversationViewPreference } from '@/hooks/useConversationViewPreference';
import { useConversationViewReadingCheckpoint } from '@/hooks/useConversationViewReadingCheckpoint';
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
import { useGuideStore } from '@/stores/guideStore';
import { withQueuedInputPreviews } from '@/stores/queued-input-preview';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { useSidebarStore } from '@/stores/sidebarStore';
import { useTaskStore } from '@/stores/taskStore';
import { apiFetch } from '@/utils/api-client';
import { captureChatReadingBeforeLayoutChange } from '@/utils/chat-layout-change';
import { notifyHandledMentionRead } from '@/utils/mention-read-receipt';
import { invalidateSidebarProjection } from '@/utils/sidebar-thread-snapshot';
import { AgentHookHealthNotice, shouldRenderAgentHookHealthNotice } from './AgentHookHealthNotice';
import { BootcampListModal } from './BootcampListModal';
import { BootstrapOrchestrator } from './BootstrapOrchestrator';
import { ChatContainerHeader } from './ChatContainerHeader';
import { hydrateEvolutionFromCurrentUrl } from './capability-evolution/evolution-navigation';
import { useConciergeConfirmations } from './concierge/useConciergeConfirmations';
import { ArtworkLightboxHost } from './content-review/ArtworkLightboxHost';
import { ArtworkLightboxProvider, useArtworkLightboxScope } from './content-review/ArtworkLightboxScope';
import { ArtworkWorkModeScope } from './content-review/ArtworkWorkModeScope';
import { scopedQueue } from './execution-row/thread-queue';
import { BootcampGuideOverlay } from './first-run-quest/BootcampGuideOverlay';
import { FirstRunEntryReminder } from './first-run-quest/FirstRunEntryReminder';
import { restoreJourneyState } from './first-run-quest/onboarding-journey';
import { QuestBanner } from './first-run-quest/QuestBanner';
import { syncLocalBootcampState } from './first-run-quest/syncLocalBootcampState';
import { useFirstProjectMistakeTipGate } from './first-run-quest/useFirstProjectMistakeTipGate';
import { useFirstProjectPreviewAutoOpen } from './first-run-quest/useFirstProjectPreviewAutoOpen';
import { useFirstRealMessageSync } from './first-run-quest/useFirstRealMessageSync';
import { BootcampIcon } from './icons/BootcampIcon';
import { PawIcon } from './icons/PawIcon';
import { MessageSearchOverlay } from './message-search/MessageSearchOverlay';
import { useMessageSearchHost } from './message-search/useMessageSearchHost';
import { NewConversationPage } from './new-conversation/NewConversationPage';
import { DEMO_SETTINGS_URL } from './onboarding-demo/demo-story';
import { GuidedOnboarding } from './onboarding-demo/GuidedOnboarding';
import { useDemoAdmission } from './onboarding-demo/useDemoAdmission';
import { ProjectSetupCard } from './ProjectSetupCard';
import { RuntimeUpdateRequiredDialog } from './RuntimeUpdateRequiredDialog';
import { SplitPaneChatView } from './SplitPaneView';
import { useShellPresentation } from './shell/shell-presentation';
import { useSettingsReadingPort } from './shell/useSettingsSourceReturn';
import { ThreadSidebar } from './ThreadSidebar';
import { assignDocumentRoute, pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';
import { ThreadChatExport, ThreadChatSurface, useThreadChatRuntime } from './thread-chat';
import type { RegisterChatReadingPort } from './thread-chat/useThreadChatReadingPort';
import { type VoteConfig, VoteConfigModal } from './VoteConfigModal';
import { WorkspacePanel } from './WorkspacePanel';
import { DEFAULT_ARTIFACT_WORK_CHAT_BASIS } from './workbench/artifact-work-presentation';
import { toggleArtifactWorkFullWindow } from './workbench/artifact-work-presentation-actions';
import { useF307ExperienceWorkbenchStore } from './workbench/experience-workbench-store';
import { useArtifactWorkHostPresentation } from './workbench/useArtifactWorkHostPresentation';
import { WorkspaceChatRevealProvider } from './workbench/WorkspaceChatReveal';
import { WorkspaceChatWorkScopeProvider } from './workbench/WorkspaceChatWorkScope';
import type { MainAreaAttentionPresentation } from './workbench/workspace-work-host-projection';
import { ContextualWorkspaceChrome } from './workspace/ContextualWorkspaceChrome';
import { FloatingTranscriptContainer } from './workspace/FloatingTranscriptContainer';
import { ResizeHandle } from './workspace/ResizeHandle';
import { TranscriptPanel } from './workspace/TranscriptPanel';
import { hydrateInvocationTrajectoryFromCurrentUrl } from './workspace/trajectory/trajectory-navigation';
import { StatusPresentation } from './workspace-status/StatusPresentation';

interface ChatContainerProps {
  threadId: string;
}

const EMPTY_CONVERSATION_QUEUE = [] as const;

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

function coversChatHistory(presentation: MainAreaAttentionPresentation): boolean {
  if (presentation.kind === 'overlay') return true;
  return presentation.mode === 'full-window';
}

export function ChatContainer({ threadId }: ChatContainerProps) {
  return (
    <ArtworkLightboxProvider threadId={threadId}>
      <ChatContainerContent threadId={threadId} />
    </ArtworkLightboxProvider>
  );
}

function ChatContainerContent({ threadId }: ChatContainerProps) {
  const searchParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  if (searchParams?.get('export') === 'true') {
    return <ThreadChatExport threadId={threadId} messageIds={searchParams.getAll('messageId')} />;
  }
  return <InteractiveChatContainer threadId={threadId} />;
}

function InteractiveChatContainer({ threadId }: ChatContainerProps) {
  const artworkLightbox = useArtworkLightboxScope();
  const bottomChromeRef = useRef<HTMLDivElement | null>(null);
  const bottomChromeObserverRef = useRef<ResizeObserver | null>(null);
  const bottomChromeObserverRafRef = useRef<number | null>(null);
  const [bottomChromeHeight, setBottomChromeHeight] = useState(0);
  const {
    setCurrentThread,
    viewMode,
    setViewMode,
    isLoading: chatIsLoading,
    clearUnread,
    settleUnreadAck,
    armUnreadSuppression,
    rightPanelMode,
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
  const searchParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  // AC-6: research=multi hint from Signal study "多猫研究" button
  const isResearchMode = searchParams?.get('research') === 'multi';
  const { clearTasks } = useTaskStore();
  const { cats, hasFetched: registryKnown, isLoading: registryRefreshing } = useCatData();
  const isV2 = useShellPresentation() === 'v2';
  const conversationViewQueue = useChatStore((state) => scopedQueue(state, threadId)) ?? EMPTY_CONVERSATION_QUEUE;
  const conversationViewMessages = useMemo(
    () => withQueuedInputPreviews(allMessages, conversationViewQueue, threadId),
    [allMessages, conversationViewQueue, threadId],
  );
  const conversationViewController = useConversationViewPreference(threadId, isV2 && threadId !== 'default');
  const conversationViewReading = useConversationViewReadingCheckpoint({
    threadId,
    controller: conversationViewController,
    messages: conversationViewMessages,
    queue: conversationViewQueue,
  });
  const coCreator = useCoCreatorConfig();
  const workspaceWorktreeId = useChatStore((s) => s.workspaceWorktreeId);
  useTeleport(); // F227: drive the Hub to a teleport target message (thread:teleport)
  const { isOpen: sidebarOpen, open: openSidebar, close: closeSidebar, toggle: toggleSidebar } = useSidebarStore();
  // F284: Chat is the calm default. Typed workspace/transcript actions still
  // open the contextual shell through the existing rightPanelMode effect.
  // F284 × F120 review P1: panel visibility is canonical per-thread store
  // state (snapshotted in ThreadState), not route-local component state.
  const statusPanelOpen = useChatStore((s) => s.rightPanelOpen);
  const setRightPanelOpen = useChatStore((s) => s.setRightPanelOpen);
  const mainAreaAttentionSurfaceId = useF307ExperienceWorkbenchStore((state) => state.mainAreaAttentionSurfaceId);
  const attentionPresentation = useF307ExperienceWorkbenchStore((state) => state.mainAreaAttentionPresentation);
  const setAttentionChatBasis = useF307ExperienceWorkbenchStore((state) => state.setMainAreaAttentionChatBasis);
  const exitMainAreaAttention = useF307ExperienceWorkbenchStore((state) => state.exitMainAreaAttention);
  const [workspacePanelMounted, setWorkspacePanelMounted] = useState(rightPanelMode === 'workspace');
  const [activityPanelMounted, setActivityPanelMounted] = useState(false);
  const [showBootcampList, setShowBootcampList] = useState(false);
  const [showOnboardingHint, setShowOnboardingHint] = useState(false);
  const [onboardingSyncError, setOnboardingSyncError] = useState(false);
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
    apiFetch(`/api/threads/${encodeURIComponent(threadId)}`)
      .then(async (res) =>
        res.ok ? ((await res.json()) as { bootcampState?: { journeyId?: string; completedAt?: number } }) : null,
      )
      .then((thread) => {
        if (cancelled) return;
        try {
          const journey = restoreJourneyState(localStorage.getItem('cat-cafe:onboarding-journey'));
          setShowOnboardingHint(
            Boolean(
              thread?.bootcampState?.journeyId &&
                thread.bootcampState.completedAt === undefined &&
                journey?.threadId === threadId &&
                journey.stage === 'ready' &&
                journey.completedAt === undefined,
            ),
          );
        } catch {
          setShowOnboardingHint(false);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [threadId]);
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
  const isDesktop = useIsDesktop();
  const currentWorkspaceThreadId = useChatStore((state) =>
    state.currentThreadId === threadId && (!state.presentationLock || state.presentationLock.ownerThreadId === threadId)
      ? threadId
      : null,
  );
  const [mediaComposerSurfaceId, setMediaComposerSurfaceId] = useState<string | null>(null);
  const workModeRequest = useChatStore((state) => state.workspaceOpenRequest);
  const registeredWorkId = useRef<string | null>(null);
  const onRegisteredWorkChange = useCallback((id: string | null) => {
    if (registeredWorkId.current === id) return;
    captureChatReadingBeforeLayoutChange();
    registeredWorkId.current = id;
    setMediaComposerSurfaceId(id);
  }, []);
  const {
    splitPreferenceActive: artifactSplitPreferenceActive,
    fullWindowActive: artifactFullWindowActive,
    narrowWorkComposerActive,
    workspaceWideActive,
    workModeActive,
    chatBasis: artifactWorkChatBasis,
    invalidateHost: invalidateArtifactWorkHost,
    resizeChatBasis: resizeArtifactWorkChatBasis,
    resetChatBasis: resetArtifactWorkChatBasis,
  } = useArtifactWorkHostPresentation({
    threadId,
    currentThreadId: currentWorkspaceThreadId,
    mediaComposerSurfaceId,
    viewMode,
    isDesktop,
    statusPanelOpen,
    rightPanelMode,
    workModeRequested: workModeRequest?.threadId === threadId && workModeRequest.presentation === 'work-mode',
  });
  const workComposerOnlyActive = artifactFullWindowActive || narrowWorkComposerActive;
  const activeChatBasis =
    workspaceWideActive && attentionPresentation.kind === 'chat-workspace'
      ? attentionPresentation.chatBasis
      : artifactSplitPreferenceActive
        ? artifactWorkChatBasis
        : chatBasis;
  const containerRef = useRef<HTMLDivElement>(null);
  const handleHorizontalResize = useCallback(
    (delta: number) => {
      if (!containerRef.current) return;
      const totalWidth = containerRef.current.offsetWidth;
      if (totalWidth === 0) return;
      const pct = (delta / totalWidth) * 100;
      if (workspaceWideActive && attentionPresentation.kind === 'chat-workspace') {
        captureChatReadingBeforeLayoutChange();
        setAttentionChatBasis(attentionPresentation.chatBasis + pct);
        return;
      }
      if (artifactSplitPreferenceActive) {
        resizeArtifactWorkChatBasis(pct);
        return;
      }
      setChatBasis((previous) => Math.min(80, Math.max(20, previous + pct)));
    },
    [
      artifactSplitPreferenceActive,
      resizeArtifactWorkChatBasis,
      setChatBasis,
      workspaceWideActive,
      attentionPresentation,
      setAttentionChatBasis,
    ],
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
    if (isV2) captureChatReadingBeforeLayoutChange();
    exitMainAreaAttention();
    invalidateArtifactWorkHost();
    closeRightPanel();
  }, [closeRightPanel, exitMainAreaAttention, invalidateArtifactWorkHost, isV2]);

  const openWorkspaceLauncher = useCallback(() => {
    if (isV2) captureChatReadingBeforeLayoutChange();
    setWorkspacePanelMounted(true);
    setWorkspaceMode('dev');
    setWorkspaceSurface('home');
    setRightPanelMode('workspace');
    setRightPanelOpen(true);
  }, [isV2, setRightPanelMode, setWorkspaceMode, setWorkspaceSurface, setRightPanelOpen]);

  const mainAreaAttentionActive =
    viewMode === 'single' &&
    isDesktop &&
    statusPanelOpen &&
    rightPanelMode === 'workspace' &&
    mainAreaAttentionSurfaceId !== null &&
    (attentionPresentation.kind !== 'chat-workspace' || attentionPresentation.threadId === threadId);
  const mainAreaOverlayActive = mainAreaAttentionActive && coversChatHistory(attentionPresentation);
  const revealWorkspaceChat = useCallback(() => {
    if (!isV2 || useChatStore.getState().currentThreadId !== threadId) return;
    // Full-window Artifact work leaves room for the original composer; the other overlay hosts cover it.
    if (
      statusPanelOpen &&
      rightPanelMode === 'workspace' &&
      !narrowWorkComposerActive &&
      (!isDesktop || (mainAreaOverlayActive && !artifactFullWindowActive))
    )
      closeStatusPanel();
  }, [
    isV2,
    threadId,
    statusPanelOpen,
    rightPanelMode,
    isDesktop,
    mainAreaOverlayActive,
    artifactFullWindowActive,
    narrowWorkComposerActive,
    closeStatusPanel,
  ]);
  const messageSearchAvailable =
    isV2 &&
    viewMode === 'single' &&
    !artworkLightbox?.work &&
    !workComposerOnlyActive &&
    !mainAreaOverlayActive &&
    (isDesktop || !statusPanelOpen);
  const messageSearch = useMessageSearchHost({
    threadId,
    pushThreadRoute: navigateToThread,
    available: messageSearchAvailable,
  });

  useEffect(() => {
    if (
      mainAreaAttentionSurfaceId !== null &&
      (viewMode !== 'single' ||
        !isDesktop ||
        !statusPanelOpen ||
        rightPanelMode !== 'workspace' ||
        (attentionPresentation.kind === 'chat-workspace' && attentionPresentation.threadId !== threadId))
    ) {
      exitMainAreaAttention();
    }
  }, [
    exitMainAreaAttention,
    isDesktop,
    mainAreaAttentionSurfaceId,
    rightPanelMode,
    statusPanelOpen,
    viewMode,
    attentionPresentation,
    threadId,
  ]);

  useEffect(() => {
    if (isDesktop || !statusPanelOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
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
  const { socketConnected, registerIndexEventHandler } = useThreadChatRuntime(runtimeThreadIds);
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
  const sourceThread = sidebarRows.find((row) => row.id === threadId) ?? storeThreads.find((t) => t.id === threadId);
  const originTitle = sourceThread?.title?.trim() ? sourceThread.title : null;
  const registerSettingsReadingPort = useSettingsReadingPort(originTitle);
  const registerShellReadingPort = useCallback<RegisterChatReadingPort>(
    (port) => {
      conversationViewReading.setReadingPort(port);
      const releaseSearch = messageSearchAvailable ? messageSearch.registerReadingPort(port) : () => {};
      const releaseSettings = isV2 && viewMode === 'single' ? registerSettingsReadingPort(port) : () => {};
      return () => {
        conversationViewReading.setReadingPort(null);
        releaseSettings();
        releaseSearch();
      };
    },
    [
      conversationViewReading.setReadingPort,
      isV2,
      viewMode,
      registerSettingsReadingPort,
      messageSearchAvailable,
      messageSearch.registerReadingPort,
    ],
  );

  // The virtual default conversation uses the startup repository; a real route
  // waits for its own metadata instead of borrowing another thread's root.
  const workspaceProjectPath = sourceThread
    ? sourceThread.projectPath || 'default'
    : threadId === 'default'
      ? 'default'
      : null;
  const handleStartFirstRunQuest = useCallback(() => {
    setShowQuestWizard(true);
  }, []);
  const demoAdmission = useDemoAdmission(
    threadId === 'default',
    handleStartFirstRunQuest,
    registryKnown && !registryRefreshing,
  );
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
          if (thread.bootcampState?.completedAt !== undefined) setShowOnboardingHint(false);
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
    if (!showOnboardingHint || showQuestWizard || activeGuideFlowId) return;
    if (useGuideStore.getState().completedGuides.has(`${threadId}::first-run-entry`)) return;
    useGuideStore.getState().reduceServerEvent({ action: 'start', guideId: 'first-run-entry', threadId });
  }, [activeGuideFlowId, showOnboardingHint, showQuestWizard, threadId]);
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
  useLayoutEffect(() => {
    if (prevThreadRef.current !== threadId) {
      // Thread switch: store saves/restores per-thread state automatically
      setCurrentThread(threadId);
      clearTasks();
      prevThreadRef.current = threadId;
    }
    // First mount — sync threadId to store without save/restore
    setCurrentThread(threadId);
  }, [
    threadId,
    clearTasks, // Clean up non-thread-scoped refs
    setCurrentThread,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    hydrateInvocationTrajectoryFromCurrentUrl();
    hydrateEvolutionFromCurrentUrl();
  }, []);

  // Restore projectPath from the canonical Sidebar projection; the legacy store
  // remains only as a compatibility fallback for non-Sidebar flows.
  useEffect(() => {
    if (workspaceProjectPath !== null) setCurrentProject(workspaceProjectPath);
  }, [workspaceProjectPath, setCurrentProject]);

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
      setBottomChromeHeight(node ? Math.ceil(node.getBoundingClientRect().height) : 0);

      if (typeof window === 'undefined' || typeof window.ResizeObserver !== 'function' || !node) return;

      let lastHeight = node.getBoundingClientRect().height;
      const observer = new window.ResizeObserver(() => {
        const nextHeight = node.getBoundingClientRect().height;
        if (Math.abs(nextHeight - lastHeight) <= 1) return;
        lastHeight = nextHeight;
        setBottomChromeHeight(Math.ceil(nextHeight));

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
    // StrictMode replays effects after the ref callback; reconnect the subscription cleaned up by that replay.
    if (bottomChromeRef.current && !bottomChromeObserverRef.current) attachBottomChromeRef(bottomChromeRef.current);
    return disconnectBottomChromeObserver;
  }, [attachBottomChromeRef, disconnectBottomChromeObserver]);

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
        if (caughtUp) notifyHandledMentionRead(payload);
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

  const { handleRealOnboardingMessage, requestRetry: requestFirstRealMessageRetry } = useFirstRealMessageSync({
    threadId,
    currentBootcampState,
    onboardingSyncError,
    setOnboardingSyncError,
    setShowOnboardingHint,
  });

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

  const showNewConversationLanding = isV2 && threadId === 'default' && !artifactFullWindowActive;

  return (
    <WorkspaceChatWorkScopeProvider
      threadId={threadId}
      onRegisteredWorkChange={onRegisteredWorkChange}
      getActiveSurfaceId={() =>
        artworkLightbox?.work?.surface?.id ?? useF307ExperienceWorkbenchStore.getState().layout.activeSurfaceId
      }
      isHostVisible={() => {
        const chat = useChatStore.getState();
        return (
          isV2 &&
          chat.currentThreadId === threadId &&
          (!chat.presentationLock || chat.presentationLock.ownerThreadId === threadId) &&
          (!!artworkLightbox?.work || (chat.rightPanelOpen && chat.rightPanelMode === 'workspace')) &&
          document.visibilityState === 'visible'
        );
      }}
    >
      <div ref={containerRef} className="relative flex h-screen h-dvh">
        <ArtworkLightboxHost />
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
          className={`flex min-w-0 flex-col ${mainAreaOverlayActive ? 'invisible pointer-events-none' : ''} ${
            workComposerOnlyActive ? 'absolute inset-0 z-50 pointer-events-none' : 'relative'
          }`}
          aria-hidden={mainAreaOverlayActive || undefined}
          data-testid="thread-chat-host"
          data-presentation={
            narrowWorkComposerActive
              ? 'narrow-work-composer'
              : artifactFullWindowActive
                ? 'artifact-full-window'
                : 'conversation'
          }
          style={
            !workComposerOnlyActive &&
            statusPanelOpen &&
            isDesktop &&
            (rightPanelMode === 'workspace' || rightPanelMode === 'transcript')
              ? { flexBasis: `${activeChatBasis}%`, flexGrow: 0, flexShrink: 0 }
              : { flex: '1 1 0%' }
          }
        >
          <MessageSearchOverlay
            threadId={threadId}
            host={messageSearch}
            available={messageSearchAvailable}
            resolveSpeaker={(speaker) => {
              if (speaker === 'user') return coCreator.name;
              const cat = cats.find((candidate) => candidate.id === speaker);
              return cat ? formatCatName(cat) : speaker;
            }}
          />
          {!workComposerOnlyActive && !showNewConversationLanding && (
            <ChatContainerHeader
              sidebarOpen={sidebarOpen}
              onToggleSidebar={toggleSidebar}
              threadId={threadId}
              viewMode={viewMode}
              onOpenMessageSearch={messageSearchAvailable ? messageSearch.openSearch : undefined}
              messageSearchOpen={messageSearch.open}
              onToggleViewMode={() => setViewMode(viewMode === 'single' ? 'split' : 'single')}
              statusPanelOpen={statusPanelOpen && rightPanelMode === 'workspace'}
              hasWorkspaceActivity={hasProjectedExecution || workspaceSurface !== 'home' || presentationLock !== null}
              onToggleStatusPanel={() => {
                if (statusPanelOpen && rightPanelMode === 'workspace') {
                  closeStatusPanel();
                } else {
                  if (isV2) captureChatReadingBeforeLayoutChange();
                  setWorkspacePanelMounted(true);
                  setRightPanelMode('workspace');
                  setRightPanelOpen(true);
                }
              }}
              conversationViewController={conversationViewController}
              conversationViewMessages={conversationViewMessages}
              conversationViewQueue={conversationViewQueue}
            />
          )}

          {showNewConversationLanding ? (
            <NewConversationPage
              sidebarOpen={sidebarOpen}
              statusPanelOpen={statusPanelOpen && rightPanelMode === 'workspace'}
              hasWorkspaceActivity={hasProjectedExecution || workspaceSurface !== 'home' || presentationLock !== null}
              onToggleSidebar={toggleSidebar}
              onToggleStatusPanel={() => {
                if (statusPanelOpen && rightPanelMode === 'workspace') {
                  closeStatusPanel();
                } else {
                  captureChatReadingBeforeLayoutChange();
                  setWorkspacePanelMounted(true);
                  setRightPanelMode('workspace');
                  setRightPanelOpen(true);
                }
              }}
              onNavigate={navigateToThread}
              onShowCollaboration={handleStartFirstRunQuest}
            />
          ) : (
            <>
              <ThreadChatSurface
                threadId={threadId}
                density="full"
                presentation={workComposerOnlyActive ? 'composer-only' : 'conversation'}
                onReadingPort={isV2 ? registerShellReadingPort : undefined}
                messageConfirmations={messageConfirmations}
                conversationViewController={conversationViewController}
                conversationViewQueue={conversationViewQueue}
                acceptUnscopedInteractiveSend
                onRealMessageSent={() => handleRealOnboardingMessage(threadId)}
                footerRef={attachBottomChromeRef}
                timelineLead={
                  <>
                    {showOnboardingHint && (
                      <div className="mb-3 rounded-lg border border-conn-amber-ring bg-conn-amber-bg px-3 py-2 text-sm text-conn-amber-text">
                        团队已创建。发送第一条消息后，首启旅程就完成了。成员和账号已固定在设置中。
                        {onboardingSyncError && (
                          <button
                            type="button"
                            className="ml-2 underline"
                            onClick={() => {
                              requestFirstRealMessageRetry();
                            }}
                          >
                            重试同步
                          </button>
                        )}
                      </div>
                    )}
                    {showAgentHookNotice ? (
                      <div className="mb-3 flex justify-center text-left">
                        <div className="max-w-[85%] w-full">
                          <AgentHookHealthNotice
                            configurationOnly={
                              cats.length > 0 && cats.every((cat) => cat.configurationSource === 'native_tool')
                            }
                            health={agentHookHealth.health}
                            error={agentHookHealth.error}
                            syncing={agentHookHealth.syncing}
                            synced={agentHookHealth.synced}
                            syncAttempted={agentHookHealth.syncAttempted}
                            onSync={agentHookHealth.sync}
                          />
                        </div>
                      </div>
                    ) : undefined}
                  </>
                }
                emptyState={
                  <div className="text-center mt-20">
                    <PawIcon className="w-12 h-12 text-cafe-muted mx-auto mb-4" />
                    <p className="text-lg text-cafe-secondary mb-1">欢迎来到 Clowder AI!</p>
                    <p className="text-sm text-cafe-muted" suppressHydrationWarning>
                      {cats.length > 0 ? '选择一位伙伴，开始你的下一个目标' : '先看看猫猫如何协作，再创建自己的伙伴'}
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
                        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                          <button
                            type="button"
                            onClick={handleStartFirstRunQuest}
                            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-cafe-accent/20 bg-accent-50 text-cafe-accent hover:bg-accent-100 transition-colors text-sm font-medium"
                            data-testid="empty-state-bootcamp"
                          >
                            <BootcampIcon className="w-4 h-4" />
                            看看团队如何协作
                          </button>
                          <Link href={DEMO_SETTINGS_URL} className="px-4 py-2 text-sm text-cafe-accent">
                            创建我的猫猫
                          </Link>
                        </div>
                      );
                    })()}
                  </div>
                }
                footerLead={
                  <>
                    {!showQuestWizard &&
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
                            onAddSecondCat={() => assignDocumentRoute(DEMO_SETTINGS_URL, window)}
                            onStartBootcamp={() => setShowBootcampList(true)}
                            onComplete={() =>
                              assignDocumentRoute('/hub', typeof window !== 'undefined' ? window : undefined)
                            }
                          />
                        );
                      })()}
                    {isResearchMode && (
                      <div className="mx-4 mb-2 rounded-lg border border-[var(--semantic-success)] bg-[var(--semantic-success-surface)] px-3 py-2 text-xs text-conn-emerald-text">
                        多猫研究模式 — 文章上下文已注入。请输入研究问题，猫猫会自动调用 multi_mention
                        邀请其他猫参与分析。
                      </div>
                    )}
                  </>
                }
                composerClassName={(() => {
                  if (showQuestWizard) return '';
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
              />
            </>
          )}
        </div>

        {/* F284: visited Workspace/Activity panels stay mounted across fold and sibling-host switches.
          At 768px+ they use the split host; below 768px the same host becomes a full-screen overlay. */}
        {statusPanelOpen &&
          isDesktop &&
          !mainAreaOverlayActive &&
          !artifactFullWindowActive &&
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
              onDoubleClick={() => {
                if (workspaceWideActive) {
                  captureChatReadingBeforeLayoutChange();
                  setAttentionChatBasis(DEFAULT_ARTIFACT_WORK_CHAT_BASIS);
                  return;
                }
                if (artifactSplitPreferenceActive) {
                  resetArtifactWorkChatBasis();
                  return;
                }
                resetChatBasis();
              }}
            />
          ))}
        {(statusPanelOpen || workspacePanelMounted || activityPanelMounted) && (
          <div
            className={
              !statusPanelOpen
                ? 'hidden'
                : workComposerOnlyActive
                  ? 'absolute inset-x-0 top-0 z-40 flex min-h-0 flex-col overflow-hidden bg-[var(--console-panel-bg)]'
                  : mainAreaOverlayActive
                    ? 'absolute inset-0 z-40 flex min-h-0 flex-col overflow-hidden bg-[var(--console-panel-bg)]'
                    : isDesktop
                      ? 'flex min-h-0 flex-col overflow-hidden'
                      : 'fixed inset-0 z-50 flex min-h-0 flex-col overflow-hidden bg-[var(--console-panel-bg)]'
            }
            style={
              workComposerOnlyActive
                ? { bottom: bottomChromeHeight }
                : statusPanelOpen && isDesktop && !mainAreaOverlayActive
                  ? rightPanelMode === 'status'
                    ? { width: statusPanelWidth, flexShrink: 0 }
                    : { flex: '1 1 0%', minWidth: 0 }
                  : undefined
            }
            role="region"
            aria-label={
              workComposerOnlyActive ? '整窗 Workspace' : mainAreaOverlayActive ? '主区 Workspace' : '上下文侧栏'
            }
            aria-hidden={!statusPanelOpen}
            data-testid="contextual-workspace-host"
            data-presentation={
              narrowWorkComposerActive
                ? 'narrow-work-composer'
                : artifactFullWindowActive
                  ? 'artifact-full-window'
                  : workspaceWideActive
                    ? 'wide-workspace'
                    : workModeActive
                      ? 'artwork-work-mode'
                      : mainAreaOverlayActive
                        ? 'main-area-attention'
                        : 'right-rail'
            }
            data-attention-surface={mainAreaAttentionActive ? mainAreaAttentionSurfaceId : undefined}
          >
            <ArtworkWorkModeScope
              onReturn={workModeActive ? closeStatusPanel : null}
              fullWindowAction={
                isDesktop
                  ? {
                      active: artifactFullWindowActive,
                      onToggle: () => {
                        const { layout } = useF307ExperienceWorkbenchStore.getState();
                        const surface = layout.surfaces.find((item) => item.id === layout.activeSurfaceId);
                        if (surface) toggleArtifactWorkFullWindow(threadId, surface);
                      },
                    }
                  : undefined
              }
            >
              <ContextualWorkspaceChrome
                mode={rightPanelMode}
                onFold={closeStatusPanel}
                onNavigateHome={rightPanelMode === 'workspace' ? undefined : openWorkspaceLauncher}
                showFold={rightPanelMode === 'workspace' && (isV2 || !isDesktop)}
              >
                {activityPanelMounted && (
                  <div className={rightPanelMode === 'status' ? 'flex min-h-0 flex-1' : 'hidden'}>
                    <StatusPresentation
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
                    <WorkspaceChatRevealProvider threadId={threadId} onReveal={revealWorkspaceChat}>
                      <WorkspacePanel
                        threadId={threadId}
                        projectPath={isV2 ? workspaceProjectPath : undefined}
                        defaultCatId={targetCats[0] || 'opus'}
                        visible={statusPanelOpen && rightPanelMode === 'workspace' && documentVisible}
                        artifactWorkHostAvailable
                        statusSurface={
                          <StatusPresentation
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
                    </WorkspaceChatRevealProvider>
                  </div>
                )}
                {rightPanelMode === 'transcript' && statusPanelOpen && <TranscriptPanel />}
              </ContextualWorkspaceChrome>
            </ArtworkWorkModeScope>
          </div>
        )}
        <FloatingTranscriptContainer />
        <GuidedOnboarding
          open={showQuestWizard}
          storageScope={demoAdmission.storageScope}
          onCompleted={demoAdmission.complete}
          onClose={() => {
            setShowQuestWizard(false);
            demoAdmission.dismiss();
          }}
        />
        {demoAdmission.error && (
          <p role="status" className="text-sm text-cafe-secondary">
            {demoAdmission.error}{' '}
            <button type="button" onClick={demoAdmission.retry}>
              重试保存引导记录
            </button>
          </p>
        )}
        <FirstRunEntryReminder
          enabled={
            threadId === 'default' && registryKnown && !registryRefreshing && cats.length > 0 && !showQuestWizard
          }
          threadId={threadId}
        />
        <BootcampListModal open={showBootcampList} onClose={handleBootcampModalClose} currentThreadId={threadId} />
        {showVoteModal && <VoteConfigModal onSubmit={handleVoteSubmit} onCancel={() => setShowVoteModal(false)} />}
        {/* Bootcamp guide overlay: intro phase tips + lifecycle tips (phase-7.5 uses guide engine) */}
        {(() => {
          if (showQuestWizard) return null;
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
    </WorkspaceChatWorkScopeProvider>
  );
}
