'use client';

import { type ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useChatStore } from '@/stores/chatStore';
import { worktreeBasename } from '@/utils/worktree-label';
import { useF307ExperienceWorkbenchStore } from './workbench/experience-workbench-store';
import { F307ExperienceWorkbench } from './workbench/F307ExperienceWorkbench';
import { createBrowserSurface, createFileSurface } from './workbench/real-surface-adapters';

export function WorkspacePanel({
  threadId,
  defaultCatId = 'opus',
  statusSurface,
}: {
  threadId?: string;
  defaultCatId?: string;
  statusSurface?: ReactNode;
}) {
  const {
    worktrees,
    worktreesLoading,
    worktreesError,
    worktreeId,
    searchResults,
    searchLoading,
    searchError,
    search,
    resetSearch,
  } = useWorkspace();
  const setOpenFile = useChatStore((state) => state.setWorkspaceOpenFile);
  const openFilePath = useChatStore((state) => state.workspaceOpenFilePath);
  const openFileLine = useChatStore((state) => state.workspaceOpenFileLine);
  const workspaceFileSetAt = useChatStore((state) => state._workspaceFileSetAt);
  const currentThreadId = useChatStore((state) => state.currentThreadId);
  const pendingPreviewAutoOpen = useChatStore((state) => state.pendingPreviewAutoOpen);
  const consumePreviewAutoOpen = useChatStore((state) => state.consumePreviewAutoOpen);
  const workspaceMode = useChatStore((state) => state.workspaceMode);
  const teamWorkspaceSubject = useChatStore((state) => state.teamWorkspaceSubject);
  const workspaceOpenRequest = useChatStore((state) => state.workspaceOpenRequest);
  const consumeWorkspaceOpenRequest = useChatStore((state) => state.consumeWorkspaceOpenRequest);
  const viewMode = useChatStore((state) => state.workspaceSurface);
  const setViewMode = useChatStore((state) => state.setWorkspaceSurface);
  const workspacePreview = useChatStore((state) => state.workspacePreview);
  const setWorkspacePreview = useChatStore((state) => state.setWorkspacePreview);
  const lastWorkspaceFileSetAtRef = useRef(workspaceFileSetAt.ts);

  useEffect(() => {
    if (!pendingPreviewAutoOpen) return;
    const preview = consumePreviewAutoOpen();
    if (!preview) return;
    setWorkspacePreview(preview);
    useF307ExperienceWorkbenchStore.getState().dispatch({
      type: 'open-surface',
      surface: createBrowserSurface({ ownerKey: worktreeId ?? 'current-project', ...preview }),
      entitlement: { kind: 'background', reason: 'owner-background' },
    });
  }, [consumePreviewAutoOpen, pendingPreviewAutoOpen, setWorkspacePreview, worktreeId]);

  useEffect(() => {
    if (workspaceFileSetAt.ts === lastWorkspaceFileSetAtRef.current) return;
    lastWorkspaceFileSetAtRef.current = workspaceFileSetAt.ts;
    if (!openFilePath || !worktreeId) return;
    if (workspaceFileSetAt.threadId && workspaceFileSetAt.threadId !== currentThreadId) return;
    setViewMode('files');
    useF307ExperienceWorkbenchStore.getState().dispatch({
      type: 'open-surface',
      surface: createFileSurface({ worktreeId, path: openFilePath, scrollToLine: openFileLine }),
      entitlement: { kind: 'user', reason: 'open-from-chat' },
    });
  }, [
    currentThreadId,
    openFileLine,
    openFilePath,
    setViewMode,
    workspaceFileSetAt.threadId,
    workspaceFileSetAt.ts,
    worktreeId,
  ]);

  const handleSearchResultClick = useCallback(
    (path: string, line: number) => {
      setOpenFile(path, line);
      setViewMode('files');
      resetSearch();
    },
    [resetSearch, setOpenFile, setViewMode],
  );
  const handleLauncherSearch = useCallback(
    async (query: string) => {
      await search(query, 'all');
    },
    [search],
  );
  const launcherWorkspaceSearch = useMemo(
    () => ({
      enabled: !!worktreeId,
      results: searchResults,
      loading: searchLoading,
      error: searchError,
      onSearch: handleLauncherSearch,
      onReset: resetSearch,
      onOpenResult: handleSearchResultClick,
      onViewAll: handleLauncherSearch,
    }),
    [handleLauncherSearch, handleSearchResultClick, resetSearch, searchError, searchLoading, searchResults, worktreeId],
  );
  const currentWorktree = worktrees.find((worktree) => worktree.id === worktreeId);
  const activeWorktreeId = currentWorktree?.id ?? null;

  return (
    <F307ExperienceWorkbench
      threadId={threadId}
      defaultCatId={defaultCatId}
      statusSurface={statusSurface}
      onSelectDevSurface={setViewMode}
      worktreeId={activeWorktreeId}
      worktreeLoading={worktreesLoading}
      worktreeError={worktreesError}
      openFilePath={openFilePath}
      preview={workspacePreview}
      repository={
        currentWorktree ? { name: worktreeBasename(currentWorktree.root), branch: currentWorktree.branch } : undefined
      }
      workspaceSearch={launcherWorkspaceSearch}
      f284WorkspaceState={
        workspaceMode === 'team' ||
        (viewMode === 'files' && openFilePath) ||
        (viewMode === 'browser' && workspacePreview.port)
          ? {
              threadId,
              workspaceMode,
              workspaceSurface: viewMode,
              workspaceOpenFilePath: openFilePath,
              workspaceOpenFileLine: openFileLine,
              workspaceWorktreeId: worktreeId,
              workspacePreview,
              teamWorkspaceSubject,
              rightPanelOpen: true,
            }
          : undefined
      }
      workspaceOpenRequest={workspaceOpenRequest}
      onWorkspaceOpenRequestConsumed={consumeWorkspaceOpenRequest}
    />
  );
}
