'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useHubSocket } from '@/components/thread-chat/hub-socket-context';

interface WorkspaceFileChangeOptions {
  enabled?: boolean;
  worktreeId: string | null;
  path: string | null;
  currentSha: string | null;
  onReload: (path: string) => Promise<void> | void;
}

interface WorkspaceFileChangedEvent {
  /** Echoes the watchId this subscription sent; a change for another watch is ignored. */
  watchId?: string;
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
  const hub = useHubSocket();
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
    // The server keys watches by (socket, watchId), so this subscription releases only its own watch.
    const watchId = crypto.randomUUID();
    const watch = () => hub.emit('workspace:watch-file', { watchId, worktreeId, path, sha256: currentShaRef.current });

    const releaseChanges = hub.on('workspace:file-changed', (event: WorkspaceFileChangedEvent) => {
      if (event.watchId !== watchId) return;
      if (event.worktreeId !== worktreeId || event.path !== path || event.sha256 === currentShaRef.current) return;
      if (dirtyRef.current) {
        pendingExternalShaRef.current = event.sha256;
        setPendingExternalSha(event.sha256);
        return;
      }
      void onReloadRef.current(path);
    });
    // A watch belongs to one server connection: it is sent now and again on every reconnect.
    const releaseConnection = hub.onConnected(watch);

    return () => {
      releaseConnection();
      releaseChanges();
      hub.emit('workspace:unwatch-file', { watchId });
    };
  }, [enabled, hub, path, worktreeId]);

  return {
    pendingExternalSha,
    onDirtyChange,
    applyExternalChange,
    dismissExternalChange: clearPendingExternalSha,
  };
}
