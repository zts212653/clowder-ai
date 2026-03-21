import { useEffect } from 'react';
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
  action?: 'reveal' | 'open';
  line?: number;
  threadId?: string;
}

export function handleNavigateEvent(
  data: NavigateEvent,
  currentWorktreeId: string | null,
  actions: {
    setWorkspaceWorktreeId: (id: string | null) => void;
    setWorkspaceRevealPath: (path: string | null) => void;
    setWorkspaceOpenFile: (path: string | null, line: number | null, targetWorktreeId?: string | null) => void;
  },
) {
  if (data.action === 'open') {
    actions.setWorkspaceOpenFile(data.path, data.line ?? null, data.worktreeId ?? null);
  } else {
    if (data.worktreeId && data.worktreeId !== currentWorktreeId) {
      actions.setWorkspaceWorktreeId(data.worktreeId);
    }
    actions.setWorkspaceRevealPath(data.path);
  }
}

export function useWorkspaceNavigate(worktreeId: string | null, threadId: string | null) {
  const setWorkspaceWorktreeId = useChatStore((s) => s.setWorkspaceWorktreeId);
  const setWorkspaceRevealPath = useChatStore((s) => s.setWorkspaceRevealPath);
  const setWorkspaceOpenFile = useChatStore((s) => s.setWorkspaceOpenFile);

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
        handleNavigateEvent(data, worktreeId, {
          setWorkspaceWorktreeId,
          setWorkspaceRevealPath,
          setWorkspaceOpenFile,
        });
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
  }, [worktreeId, threadId, setWorkspaceWorktreeId, setWorkspaceRevealPath, setWorkspaceOpenFile]);
}
