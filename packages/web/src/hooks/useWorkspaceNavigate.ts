import { useEffect, useRef } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';

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

export function handleNavigateEvent(
  data: NavigateEvent,
  currentWorktreeId: string | null,
  actions: {
    setWorkspaceWorktreeId: (id: string | null) => void;
    setWorkspaceRevealPath: (path: string | null) => void;
    setWorkspaceOpenFile: (path: string | null, line: number | null, targetWorktreeId?: string | null) => void;
    setWorkspaceMode?: (mode: 'dev' | 'knowledge') => void;
  },
  recentOpen?: { path: string; worktreeId?: string; ts: number } | null,
): boolean {
  // Phase H: Switch workspace to knowledge feed mode
  if (data.action === 'knowledge-feed') {
    actions.setWorkspaceMode?.('knowledge');
    return true;
  }

  // File-oriented actions: auto-switch back to dev mode so the file is visible
  if (data.action === 'open') {
    actions.setWorkspaceMode?.('dev');
    actions.setWorkspaceOpenFile(data.path, data.line ?? null, data.worktreeId ?? null);
    return true;
  }

  if (
    recentOpen &&
    recentOpen.path === data.path &&
    recentOpen.worktreeId === (data.worktreeId ?? undefined) &&
    Date.now() - recentOpen.ts < OPEN_REVEAL_GRACE_MS
  ) {
    return false;
  }

  if (data.worktreeId && data.worktreeId !== currentWorktreeId) {
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
      if (worktreeId) {
        socket.emit('join_room', `worktree:${worktreeId}`);
      }

      const handler = (data: NavigateEvent) => {
        if (!shouldAcceptNavigate(threadId, data.threadId)) return;
        if (data.eventId && data.eventId === lastEventIdRef.current) return;
        if (data.eventId) lastEventIdRef.current = data.eventId;
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
  }, [worktreeId, threadId, setWorkspaceWorktreeId, setWorkspaceRevealPath, setWorkspaceOpenFile, setWorkspaceMode]);
}
