import { useEffect, useRef } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import {
  areWorktreeIdsEquivalent,
  getNavigateWorktreeRoomIds,
  resolveNavigateTargetWorktreeId,
  scopeWorktreeAliases,
  type WorktreeAliasMap,
} from '@/utils/worktree-id-alias';

export function shouldAcceptNavigate(sessionThreadId: string | null, eventThreadId: string | undefined): boolean {
  if (!eventThreadId) return true;
  if (!sessionThreadId) return true;
  return eventThreadId === sessionThreadId;
}

export interface NavigateEvent {
  path: string;
  worktreeId?: string;
  action?: 'reveal' | 'open' | 'knowledge-feed';
  line?: number;
  threadId?: string;
  eventId?: string;
}

const OPEN_REVEAL_GRACE_MS = 2000;

function shouldProcessNavigateEvent(
  data: NavigateEvent,
  sessionThreadId: string | null,
  lastEventIdRef: { current: string | null },
): boolean {
  if (!shouldAcceptNavigate(sessionThreadId, data.threadId)) return false;
  if (data.eventId && data.eventId === lastEventIdRef.current) return false;
  if (data.eventId) lastEventIdRef.current = data.eventId;
  return true;
}

export function handleNavigateEvent(
  data: NavigateEvent,
  currentWorktreeId: string | null,
  actions: {
    setWorkspaceWorktreeId: (id: string | null) => void;
    setWorkspaceRevealPath: (path: string | null) => void;
    setWorkspaceOpenFile: (path: string | null, line: number | null, targetWorktreeId?: string | null) => void;
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
    actions.setWorkspaceOpenFile(
      data.path,
      data.line ?? null,
      resolveNavigateTargetWorktreeId(currentWorktreeId, data.worktreeId ?? null, worktreeAliases),
    );
    return true;
  }

  if (
    recentOpen &&
    recentOpen.path === data.path &&
    areWorktreeIdsEquivalent(recentOpen.worktreeId ?? null, data.worktreeId ?? null, worktreeAliases) &&
    Date.now() - recentOpen.ts < OPEN_REVEAL_GRACE_MS
  ) {
    return false;
  }

  if (data.worktreeId && !areWorktreeIdsEquivalent(data.worktreeId, currentWorktreeId, worktreeAliases)) {
    actions.setWorkspaceWorktreeId(data.worktreeId);
  }
  actions.setWorkspaceMode?.('dev');
  actions.setWorkspaceRevealPath(data.path);
  return true;
}

export function useWorkspaceNavigate(worktreeId: string | null, threadId: string | null) {
  const setWorkspaceWorktreeId = useChatStore((s) => s.setWorkspaceWorktreeId);
  const setWorkspaceRevealPath = useChatStore((s) => s.setWorkspaceRevealPath);
  const setWorkspaceOpenFile = useChatStore((s) => s.setWorkspaceOpenFile);
  const setWorkspaceMode = useChatStore((s) => s.setWorkspaceMode);
  const worktreeAliases = useChatStore((s) => s.workspaceWorktreeAliases);
  const worktreeAliasesProjectPath = useChatStore((s) => s.workspaceWorktreeAliasesProjectPath);
  const currentProjectPath = useChatStore((s) => s.currentProjectPath);
  const scopedWorktreeAliases = scopeWorktreeAliases(worktreeAliases, worktreeAliasesProjectPath, currentProjectPath);
  const lastEventIdRef = useRef<string | null>(null);
  const recentOpenRef = useRef<{ path: string; worktreeId?: string; ts: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    import('socket.io-client').then(({ io }) => {
      if (cancelled) return;
      const apiUrl = new URL(API_URL);
      const socket = io(`${apiUrl.protocol}//${apiUrl.host}`, { transports: ['websocket'] });

      socket.emit('join_room', 'workspace:global');
      for (const roomWorktreeId of getNavigateWorktreeRoomIds(worktreeId, scopedWorktreeAliases)) {
        socket.emit('join_room', `worktree:${roomWorktreeId}`);
      }

      const handler = (data: NavigateEvent) => {
        if (!shouldProcessNavigateEvent(data, threadId, lastEventIdRef)) return;
        const locked = useChatStore.getState().presentationLock != null;
        const processed = handleNavigateEvent(
          data,
          worktreeId,
          {
            setWorkspaceWorktreeId,
            setWorkspaceRevealPath,
            setWorkspaceOpenFile,
            setWorkspaceMode,
          },
          recentOpenRef.current,
          locked,
          scopedWorktreeAliases,
        );
        if (processed && data.action === 'open') {
          recentOpenRef.current = { path: data.path, worktreeId: data.worktreeId, ts: Date.now() };
        }
      };

      socket.on('workspace:navigate', handler);

      cleanup = () => {
        socket.off('workspace:navigate', handler);
        socket.disconnect();
      };
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [
    worktreeId,
    threadId,
    scopedWorktreeAliases,
    setWorkspaceWorktreeId,
    setWorkspaceRevealPath,
    setWorkspaceOpenFile,
    setWorkspaceMode,
  ]);
}
