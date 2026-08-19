import { useCallback, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import {
  areWorktreeIdsEquivalent,
  resolveNavigateTargetWorktreeId,
  scopeWorktreeAliases,
  type WorktreeAliasMap,
} from '@/utils/worktree-id-alias';
import {
  consumePendingWorkspaceNavigation,
  deliverWorkspaceNavigateEvent,
  queuePendingWorkspaceNavigation,
  type WorkspaceNavigationReceipt,
  type WorkspaceNavigationStorage,
} from './workspace-navigation-pending';

export interface NavigateEvent {
  path: string;
  worktreeId?: string;
  action?: 'reveal' | 'open' | 'knowledge-feed';
  line?: number;
  threadId?: string;
  eventId?: string;
}

const OPEN_REVEAL_GRACE_MS = 2000;
const WORKSPACE_NAVIGATION_ACK_ROOM = 'workspace:navigate:ack';

function shouldSuppressReveal(
  data: NavigateEvent,
  recentOpen: { path: string; worktreeId?: string; ts: number } | null | undefined,
  worktreeAliases?: WorktreeAliasMap,
): boolean {
  return (
    recentOpen != null &&
    recentOpen.path === data.path &&
    areWorktreeIdsEquivalent(recentOpen.worktreeId ?? null, data.worktreeId ?? null, worktreeAliases) &&
    Date.now() - recentOpen.ts < OPEN_REVEAL_GRACE_MS
  );
}

function shouldProcessNavigateEvent(data: NavigateEvent, lastEventIdRef: { current: string | null }): boolean {
  if (data.eventId && data.eventId === lastEventIdRef.current) return false;
  if (data.eventId) lastEventIdRef.current = data.eventId;
  return true;
}

export function handleNavigateEvent(
  data: NavigateEvent,
  currentWorktreeId: string | null,
  actions: {
    setWorkspaceWorktreeId: (id: string | null) => void;
    setWorkspaceRevealPath: (path: string | null, originThreadId?: string) => void;
    setWorkspaceOpenFile: (
      path: string | null,
      line: number | null,
      targetWorktreeId?: string | null,
      originThreadId?: string,
    ) => void;
    setWorkspaceMode?: (mode: 'dev' | 'recall') => void;
  },
  recentOpen?: { path: string; worktreeId?: string; ts: number } | null,
  presentationLocked?: boolean,
  worktreeAliases?: WorktreeAliasMap,
): boolean {
  // Phase H: Switch workspace to knowledge feed mode (allowed even when locked)
  if (data.action === 'knowledge-feed') {
    actions.setWorkspaceMode?.('recall');
    return true;
  }

  // F063 Presentation Lock: suppress file-oriented auto-navigation (AC-PL5)
  if (presentationLocked) return false;

  // File-oriented actions: auto-switch back to dev mode so the file is visible
  if (data.action === 'open') {
    actions.setWorkspaceMode?.('dev');
    const targetWorktreeId = resolveNavigateTargetWorktreeId(
      currentWorktreeId,
      data.worktreeId ?? null,
      worktreeAliases,
    );
    if (data.threadId) {
      actions.setWorkspaceOpenFile(data.path, data.line ?? null, targetWorktreeId, data.threadId);
    } else {
      actions.setWorkspaceOpenFile(data.path, data.line ?? null, targetWorktreeId);
    }
    return true;
  }

  if (shouldSuppressReveal(data, recentOpen, worktreeAliases)) {
    return false;
  }

  if (data.worktreeId && !areWorktreeIdsEquivalent(data.worktreeId, currentWorktreeId, worktreeAliases)) {
    actions.setWorkspaceWorktreeId(data.worktreeId);
  }
  actions.setWorkspaceMode?.('dev');
  if (data.threadId) {
    actions.setWorkspaceRevealPath(data.path, data.threadId);
  } else {
    actions.setWorkspaceRevealPath(data.path);
  }
  return true;
}

function sessionNavigationStorage(): WorkspaceNavigationStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function useWorkspaceNavigate(
  threadId: string | null,
  options: { isChatRoute: boolean; isWorkspaceVisible?: boolean; enabled?: boolean } = { isChatRoute: true },
) {
  const setWorkspaceWorktreeId = useChatStore((s) => s.setWorkspaceWorktreeId);
  const setWorkspaceRevealPath = useChatStore((s) => s.setWorkspaceRevealPath);
  const setWorkspaceOpenFile = useChatStore((s) => s.setWorkspaceOpenFile);
  const setWorkspaceMode = useChatStore((s) => s.setWorkspaceMode);
  const worktreeAliases = useChatStore((s) => s.workspaceWorktreeAliases);
  const worktreeAliasesProjectPath = useChatStore((s) => s.workspaceWorktreeAliasesProjectPath);
  const currentProjectPath = useChatStore((s) => s.currentProjectPath);
  const presentationLocked = useChatStore((s) => s.presentationLock != null);
  const scopedWorktreeAliases = scopeWorktreeAliases(worktreeAliases, worktreeAliasesProjectPath, currentProjectPath);
  const lastEventIdRef = useRef<string | null>(null);
  const recentOpenRef = useRef<{ path: string; worktreeId?: string; ts: number } | null>(null);
  const isWorkspaceVisible = options.isWorkspaceVisible ?? true;

  const applyNavigate = useCallback(
    (data: NavigateEvent): boolean => {
      const state = useChatStore.getState();
      const processed = handleNavigateEvent(
        data,
        state.workspaceWorktreeId,
        {
          setWorkspaceWorktreeId,
          setWorkspaceRevealPath,
          setWorkspaceOpenFile,
          setWorkspaceMode,
        },
        recentOpenRef.current,
        state.presentationLock != null,
        scopedWorktreeAliases,
      );
      if (processed && data.action === 'open') {
        recentOpenRef.current = { path: data.path, worktreeId: data.worktreeId, ts: Date.now() };
      }
      return processed;
    },
    [scopedWorktreeAliases, setWorkspaceMode, setWorkspaceOpenFile, setWorkspaceRevealPath, setWorkspaceWorktreeId],
  );
  const deliveryStateRef = useRef({
    threadId,
    isChatRoute: options.isChatRoute,
    isWorkspaceVisible,
    applyNavigate,
  });
  deliveryStateRef.current = {
    threadId,
    isChatRoute: options.isChatRoute,
    isWorkspaceVisible,
    applyNavigate,
  };

  useEffect(() => {
    if (options.enabled === false || !options.isChatRoute || !threadId || !isWorkspaceVisible) return;
    const storage = sessionNavigationStorage();
    if (!storage) return;
    consumePendingWorkspaceNavigation({
      storage,
      threadId,
      canDisplay: true,
      presentationLocked,
      apply: applyNavigate,
    });
  }, [applyNavigate, isWorkspaceVisible, options.enabled, options.isChatRoute, presentationLocked, threadId]);

  useEffect(() => {
    if (options.enabled === false) return;
    const apiUrl = new URL(API_URL);
    const socket = io(`${apiUrl.protocol}//${apiUrl.host}`, { transports: ['websocket'] });

    socket.emit('join_room', WORKSPACE_NAVIGATION_ACK_ROOM);

    const handler = (data: NavigateEvent, acknowledge?: (receipt: WorkspaceNavigationReceipt) => void) => {
      if (!shouldProcessNavigateEvent(data, lastEventIdRef)) return;
      const deliveryState = deliveryStateRef.current;
      const storage = sessionNavigationStorage();
      const queuedData =
        data.threadId || !deliveryState.threadId ? data : { ...data, threadId: deliveryState.threadId };
      const receipt = deliverWorkspaceNavigateEvent({
        data,
        activeThreadId: deliveryState.threadId,
        isChatRoute: deliveryState.isChatRoute,
        isWorkspaceVisible: deliveryState.isWorkspaceVisible,
        presentationLocked: useChatStore.getState().presentationLock != null,
        apply: deliveryState.applyNavigate,
        persist: () => (storage ? queuePendingWorkspaceNavigation(storage, queuedData) : false),
      });
      if (acknowledge) {
        acknowledge(receipt);
      }
    };

    socket.on('workspace:navigate', handler);

    return () => {
      socket.off('workspace:navigate', handler);
      socket.disconnect();
    };
  }, [options.enabled]);
}
