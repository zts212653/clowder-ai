'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_URL } from '@/utils/api-client';

interface WorkspaceFileChangeOptions {
  enabled?: boolean;
  worktreeId: string | null;
  path: string | null;
  currentSha: string | null;
  onReload: (path: string) => Promise<void> | void;
}

interface WorkspaceFileChangedEvent {
  worktreeId: string;
  path: string;
  sha256: string;
}

/**
 * One worktree/path-scoped watcher shared by the legacy workspace hook and
 * F307's retained file owner. It keeps dirty editor state authoritative while
 * still catching up external changes for the exact resource.
 */
export function useWorkspaceFileChange({
  enabled = true,
  worktreeId,
  path,
  currentSha,
  onReload,
}: WorkspaceFileChangeOptions) {
  const [pendingExternalSha, setPendingExternalSha] = useState<string | null>(null);
  const pendingExternalShaRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const currentShaRef = useRef<string | null>(currentSha);
  const onReloadRef = useRef(onReload);
  currentShaRef.current = currentSha;
  onReloadRef.current = onReload;

  const clearPendingExternalSha = useCallback(() => {
    pendingExternalShaRef.current = null;
    setPendingExternalSha(null);
  }, []);

  const onDirtyChange = useCallback(
    (dirty: boolean) => {
      dirtyRef.current = dirty;
      if (!dirty && pendingExternalShaRef.current && path) {
        clearPendingExternalSha();
        void onReloadRef.current(path);
      }
    },
    [clearPendingExternalSha, path],
  );

  const applyExternalChange = useCallback(() => {
    clearPendingExternalSha();
    if (path) void onReloadRef.current(path);
  }, [clearPendingExternalSha, path]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: resource identity changes must reset pending draft conflict state
  useEffect(() => {
    dirtyRef.current = false;
    clearPendingExternalSha();
  }, [clearPendingExternalSha, path, worktreeId]);

  useEffect(() => {
    if (!enabled || !worktreeId || !path) return;
    let active = true;
    let cleanup: (() => void) | null = null;

    void import('socket.io-client').then(({ io }) => {
      if (!active) return;
      const apiUrl = new URL(API_URL);
      const socket = io(`${apiUrl.protocol}//${apiUrl.host}`, {
        transports: ['websocket'],
        forceNew: true,
      });

      socket.on('connect', () => {
        socket.emit('workspace:watch-file', {
          worktreeId,
          path,
          sha256: currentShaRef.current,
        });
      });

      socket.on('workspace:file-changed', (event: WorkspaceFileChangedEvent) => {
        if (event.worktreeId !== worktreeId || event.path !== path || event.sha256 === currentShaRef.current) return;
        if (dirtyRef.current) {
          pendingExternalShaRef.current = event.sha256;
          setPendingExternalSha(event.sha256);
          return;
        }
        void onReloadRef.current(path);
      });

      cleanup = () => {
        socket.emit('workspace:unwatch-file');
        socket.disconnect();
      };
    });

    return () => {
      active = false;
      cleanup?.();
    };
  }, [enabled, path, worktreeId]);

  return {
    pendingExternalSha,
    onDirtyChange,
    applyExternalChange,
    dismissExternalChange: clearPendingExternalSha,
  };
}
